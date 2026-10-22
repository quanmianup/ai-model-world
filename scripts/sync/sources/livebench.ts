/**
 * LiveBench 官方榜单（https://livebench.ai）。
 *
 * 许可证是本轮调研里最干净的一份：仓库 Apache-2.0，`docs/DATASHEET.md` 原文
 * 「There are no copyrights on the data.」
 *
 * > 仓库的 LICENSE 开头有一段 lm-sys/FastChat 的版权声明，别被它吓到：
 * > 那是**代码**血缘（LiveBench 沿用了 FastChat 的评测框架），
 * > 而题目与分数都是 LiveBench 自己跑的，与 LMArena 的众包投票数据无关，
 * > 不触发 LMArena 的 ToS。这一条与 lib/compliance.ts 里 LMArena 的判据不冲突：
 * > 那道判据看的是「分数是不是 LMArena 产的」，这里的分数不是。
 *
 * 两件必须做对的事，都不是显而易见的：
 *
 * 1. **CSV 是按 task 的宽表，没有现成的分组平均列。** 分组定义在
 *    `categories_<release>.json` 里，必须按它取平均，而且**每个 release 各取自己的定义**——
 *    task 列名换过（`LCB_generation`/`coding_completion` → `code_generation`/`code_completion`），
 *    写死列名会静默算错。
 *
 * 2. **不同 release 的分数不可比，必须按题目集同期分组。** 见 RELEASE_COHORTS。
 */
import { parse as parseCsv } from 'csv-parse/sync';

import { ENDPOINTS, LIVEBENCH2_FALLBACK_RELEASES, LIVEBENCH_FALLBACK_RELEASES } from '../config';
import { fetchWithCache } from '../lib/http';
import { errorMessage, log } from '../lib/log';
import type { LiveBenchResult, LiveBenchScore } from './types';

/**
 * LiveBench 的题目集换代是**硬断点**，跨断点的分数绝不能进同一个赛制。
 *
 * 实测（2026-09-01，11 个 release 全量）：
 *   同一个模型跨 2025-04-02 ↔ 2025-04-25 这个断点，Coding 分中位数差 **27.6 分**、最大 41.9 分。
 *   典型样例 command-r-08-2024：6.1 → 26.1；claude-3-opus：38.6 → 23.3。
 *   而在断点之后的同期内，同一个模型跨 release 的差值中位 0.0、p90 1.4、**最大只有 5.1**。
 *   断点之前的那一代同期内部反而也很乱（中位 1.9、p90 26.3），所以那一代整体不用。
 *
 * 断点的判据不写死日期，而是看**这个 release 的 Coding 分组用的是哪套 task 名**——
 * 上游换题目集时同时换了 task 名，这是它自己留下的版本标记，比日期可靠。
 *
 * 结论：只采用 `code_generation` 那一代（2025-04-25 起）。代价是丢掉一批 2024 年的老模型，
 * 换来的是这个赛制内部真的可比。**宁可少一批模型，不要一个会随 release 抖动 40 分的档位。**
 */
const MODERN_CODING_TASKS = ['code_generation', 'code_completion'];

/** 分组名 → 我们的赛制 id。只取编程相关的两组，其余分组本管线不用。 */
const CATEGORY_LEAGUES: Array<{ category: string; league: string; note: string }> = [
  {
    category: 'Coding',
    league: 'livebench_coding',
    note: 'code_generation + code_completion 的算术平均，LeetCode / LiveCodeBench 风格的函数合成与补全',
  },
  {
    category: 'Agentic Coding',
    league: 'livebench_agentic_coding',
    note: 'javascript + typescript + python 的算术平均，仓库级真实任务。2025-05-30 起才有这一组',
  },
];

/**
 * LiveBench 的模型名带 reasoning-effort / thinking 后缀，是本源最大的归一化成本：
 *   `claude-opus-4-5-20251101-thinking-64k-high-effort`、`gpt-5.2-2025-12-11-nothinking`、
 *   `gemini-2.5-flash-lite-highthinking`、`grok-4-1-fast-non-reasoning`、`gpt-5.4-xhigh`
 *
 * 刻意**不含裸的 `-max`**：`qwen3.8-max`、`qwen3.7-max` 里的 max 是型号的一部分，
 * 剥掉就把旗舰型号变成了不存在的模型。只认 `-max-effort` 这种带 effort 的写法。
 * 这张表只在本模块用，不放进共享的 lib/ids.ts——那边被 Epoch 与 models.dev 共用，
 * 放宽它会影响另外两条链路的匹配。
 */
const EFFORT_SUFFIX =
  /-(base|thinking|no-?thinking|non-?reasoning|reasoning|auto|minimal|xhigh|high|medium|low|(?:high|medium|low)thinking|\d+k|(?:x?high|medium|low|max|minimal)-effort)$/i;

/**
 * LiveBench 还会把「月-年」形式的日期戳缀在型号后面（`gemini-3-pro-preview-11-2025`），
 * 而共享的 `slugVariants` 只认 `-YYYYMMDD` / `-YYYY-MM-DD` / `-MMDD` 这几种。
 * 这条规则只在本模块用——往共享的那张表里加 `-\d{2}$` 会误伤一批型号名。
 */
const MONTH_YEAR_SUFFIX = /-(?:0?[1-9]|1[0-2])-20\d{2}$/;

export function stripLiveBenchEffort(model: string): string {
  let s = model.trim().toLowerCase();
  for (let i = 0; i < 8; i += 1) {
    const n = s.replace(EFFORT_SUFFIX, '').replace(MONTH_YEAR_SUFFIX, '');
    if (n === s || n.length <= 2) break;
    s = n;
  }
  return s;
}

/** 从上游 `LIVE_BENCH_RELEASES = {"2024-07-26", ...}` 里抽出 release 清单。 */
export function parseLiveBenchReleases(pySource: string): string[] {
  const m = /LIVE_BENCH_RELEASES\s*=\s*\{([^}]*)\}/.exec(pySource);
  if (!m) return [];
  const out = new Set<string>();
  for (const hit of m[1].matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) out.add(hit[0]);
  return [...out].sort();
}

/**
 * LiveBench 2.0 的分类 → 赛制 id（2026-10-14 公布的七个分类）。
 *
 * **必须和 v1 完全分池**：v1 是「按题集打分的宽表」，2.0 换成了「长程任务产物评审」
 * （跑几个月的运维、做 PPT/PDF、写研究报告）。这不是同一把尺子，分数也不在同一个量级，
 * 混进同一个 league 会让排行榜上的名次取决于模型碰巧在哪个版本被测过。
 * 所以 id 一律加 `2_` 前缀，v1 的 `livebench_coding` 保持原样、互不相干。
 *
 * `coding` 决定进不进 `coding[]`：只有 Coding 这类是按「会不会写代码」量的，
 * 其余六类进 `scores[]` 当独立榜单。Research/Design 塞进编程档位会让
 * 「编程能力」这一行突然变成文档排版分，这是必须避免的。
 */
const V2_CATEGORY_LEAGUES: Array<{
  category: string;
  league: string;
  coding: boolean;
  note: string;
}> = [
  {
    category: 'Coding',
    league: 'livebench2_coding',
    coding: true,
    note: 'LLM API 对接 / Agent 循环 / 计费与限额 / 云基础设施 / 产品交互 / 记忆与工具，六项均分',
  },
  {
    category: 'Long Agentic',
    league: 'livebench2_long_agentic',
    coding: false,
    note: '财务合规、运营与电商、长跑运维、系统工程、性能调优五类长程任务',
  },
  {
    category: 'Reasoning',
    league: 'livebench2_reasoning',
    coding: false,
    note: '心理理论、斑马谜题、空间推理、带导航的逻辑题',
  },
  {
    category: 'Browser',
    league: 'livebench2_browser',
    coding: false,
    note: '浏览器里的数据汇总、顺序规划、结构一致性、约束遵守',
  },
  {
    category: 'Data Analysis',
    league: 'livebench2_data_analysis',
    coding: false,
    note: '连续事件识别、表连接、表格格式互转',
  },
  {
    category: 'Research',
    league: 'livebench2_research',
    coding: false,
    note: '监管合规、法律、财税、战略、科学证据五类带引用的检索与研判',
  },
  {
    category: 'Design',
    league: 'livebench2_design',
    coding: false,
    note: 'Word 文档、PDF 排版、PPT 幻灯片三类成品的版式与内容组织',
  },
];

/**
 * 上游型号名与本站 slug 的**已知写法差异**。
 *
 * LiveBench 2.0 把 NVIDIA 那几款的词序写成「产品线 + 档位 + 代数」
 * （`nemotron-ultra-3`），我们目录里是「产品线 + 代数 + 档位」（`nemotron-3-ultra-...`）。
 * 这类差异用通配匹配去猜很危险——`gpt-5.2` 会顺手咬上 `gpt-5.2-pro`，
 * 而错配的分数比缺分数更糟：它看起来是真的。所以只维护一张**精确别名表**，
 * 每条都得能指着具体型号说清楚，匹配不上就如实计进未命中（那本身也是有用的信号）。
 *
 * 不收录 `beam-1.0`：我们目录里只有 Reflection 家的 `reflection-beam-1-0-501b-a23b`，
 * 是另一个型号，不该硬凑。
 */
const V2_NAME_ALIASES: Record<string, string> = {
  // Nemotron 3.5 Lightning 30B A3B —— 我们库里唯一的 lightning。
  'nemotron-lightning-3.5': 'nemotron-3.5-lightning',
  // Nemotron 3.5 Super VL —— 指向不带参数量后缀的基座条目。
  'nemotron-super-vl-3.5': 'nemotron-3.5-super-vl',
  // Nemotron 3 Ultra —— 3 代 Ultra 在我们库里只有 550B-A55B 这一条（老的是 llama-3.1-nemotron-ultra-253b，不同代）。
  'nemotron-ultra-3': 'nemotron-3-ultra-550b-a55b',
};

/**
 * 七类均分。**上游不发布这个数**，是我们按七个分类各等权算出来的，
 * 所以只在本站标为「综合」并在说明里写明口径；缺任何一类就不算——
 * 分母不同还叫同一个名字，等于给自己造了一个不可比的数字。
 */
export const V2_OVERALL_LEAGUE = 'livebench2_overall';

/**
 * 从站点 JS bundle 里抽 LiveBench 2.0 的 release id。
 *
 * v1 的清单在 Python 常量里（`LIVE_BENCH_RELEASES`），2.0 之后那段代码还在、日期却停在
 * 2026-06-25，真正在用的是前端 bundle 里一个 8 位日期数组（`["20261014"]`）。
 * 只认「数组里全是 8 位数字、且落在合理年份区间」的形状：这是自校验的一部分，
 * 抽错了下一步拉 breakdown.json 会直接 404，不会把垃圾写进快照。
 */
export function parseLiveBenchV2Releases(js: string): string[] {
  const out = new Set<string>();
  for (const hit of js.matchAll(/\[\s*((?:"\d{8}"\s*,?\s*)+)\]/g)) {
    for (const d of hit[1].matchAll(/"(\d{8})"/g)) {
      const id = d[1];
      const year = Number(id.slice(0, 4));
      if (year >= 2024 && year <= 2035) out.add(id);
    }
  }
  return [...out].sort().reverse();
}

/** 一个分项的分数集合取算术平均。上游给的是 0–100 的百分数，缺项按「没跑」跳过。 */
function meanParts(scores: Record<string, unknown>): number | null {
  const vals: number[] = [];
  for (const raw of Object.values(scores)) {
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (!Number.isFinite(n)) continue;
    vals.push(n);
  }
  if (vals.length === 0) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

/**
 * 解析 `data/<release>/breakdown.json`。
 * 结构是 `{ "<分类>": { parts: [...], models: { "<型号>": { scores: { "<分项>": 87.5 } } } } }`，
 * 一个文件装下全部七类。返回 型号 → 分类 → 分数。
 */
export function parseV2Breakdown(payload: unknown): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  if (!payload || typeof payload !== 'object') return out;
  const root = payload as Record<string, unknown>;
  for (const { category } of V2_CATEGORY_LEAGUES) {
    const block = root[category];
    if (!block || typeof block !== 'object') continue;
    const models = (block as { models?: unknown }).models;
    if (!models || typeof models !== 'object') continue;
    for (const [name, entry] of Object.entries(models as Record<string, unknown>)) {
      if (!name.trim() || !entry || typeof entry !== 'object') continue;
      const scores = (entry as { scores?: unknown }).scores;
      if (!scores || typeof scores !== 'object') continue;
      const score = meanParts(scores as Record<string, unknown>);
      if (score === null) continue;
      const cats = out.get(name) ?? new Map<string, number>();
      cats.set(category, score);
      out.set(name, cats);
    }
  }
  return out;
}

/** 在站点首页里找打包后的主 bundle。CRA 产物固定是 `static/js/main.<hash>.js`。 */
function pickMainBundle(html: string): string | null {
  const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/gi)].map((m) => m[1]);
  return srcs.find((s) => /main\.[^/]+\.js(\?|$)/.test(s)) ?? srcs[0] ?? null;
}

/**
 * 发现 v2 的 release 清单：首页 → 主 bundle → 抽 8 位日期数组。
 * 任何一步失败都回落到内置清单，让「对方改了打包方式」不至于让整条源哑掉。
 */
async function discoverV2Releases(): Promise<{ releases: string[]; source: string }> {
  try {
    const index = await fetchWithCache(ENDPOINTS.liveBenchIndex, {
      label: 'livebench/index.html',
    });
    const href = pickMainBundle(index.body.toString('utf8'));
    if (href) {
      const url = new URL(href, ENDPOINTS.liveBenchIndex).href;
      const bundle = await fetchWithCache(url, { label: 'livebench/main.js' });
      const parsed = parseLiveBenchV2Releases(bundle.body.toString('utf8'));
      if (parsed.length > 0) return { releases: parsed, source: 'bundle' };
    }
  } catch (err) {
    log.warn(`LiveBench 2.0 release 清单解析失败，用内置兜底：${errorMessage(err)}`);
  }
  return { releases: [...LIVEBENCH2_FALLBACK_RELEASES], source: 'fallback' };
}

/**
 * 抓一个 v2 release。**按发布日期降序取第一个能用的**：2.0 的每个 release 都是
 * 全部 49 个模型的完整快照，不像 v1 那样只重跑一部分，所以不需要跨 release 取并集。
 */
async function fetchV2Release(release: string): Promise<Map<string, Map<string, number>> | null> {
  try {
    const res = await fetchWithCache(ENDPOINTS.liveBenchV2Breakdown(release), {
      label: `livebench/v2/${release}/breakdown.json`,
    });
    const parsed = parseV2Breakdown(JSON.parse(res.body.toString('utf8')));
    return parsed.size > 0 ? parsed : null;
  } catch (err) {
    log.warn(`LiveBench 2.0 ${release} 抓取失败：${errorMessage(err)}`);
    return null;
  }
}

/** LiveBench 2.0 的落地路径。七类全部按分类入库，另有一条本站算的七类均分。 */
async function fetchLiveBenchV2(fetchedAt: string): Promise<LiveBenchResult | null> {
  const { releases, source } = await discoverV2Releases();
  for (const release of releases) {
    const payload = await fetchV2Release(release);
    if (!payload) continue;

    const byModel = new Map<string, LiveBenchScore[]>();
    const counts: Record<string, number> = {};
    for (const [name, cats] of payload) {
      const slug = V2_NAME_ALIASES[name] ?? stripLiveBenchEffort(name);
      if (!slug) continue;
      const list = byModel.get(slug) ?? [];
      for (const { category, league, coding } of V2_CATEGORY_LEAGUES) {
        const score = cats.get(category);
        if (score === undefined) continue;
        list.push({
          league,
          score,
          release,
          upstreamModel: name,
          sourceUrl: `${ENDPOINTS.liveBenchIndex}?release=${release}`,
          coding,
        });
        counts[league] = (counts[league] ?? 0) + 1;
      }
      if (cats.size === V2_CATEGORY_LEAGUES.length) {
        const all = [...cats.values()];
        list.push({
          league: V2_OVERALL_LEAGUE,
          score: Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 100) / 100,
          release,
          upstreamModel: name,
          sourceUrl: `${ENDPOINTS.liveBenchIndex}?release=${release}`,
          coding: false,
        });
        counts[V2_OVERALL_LEAGUE] = (counts[V2_OVERALL_LEAGUE] ?? 0) + 1;
      }
      byModel.set(slug, list);
    }

    log.step(
      `LiveBench 2.0：release ${release}（清单来自 ${source}），` +
        `七类共 ${byModel.size} 个型号，` +
        Object.entries(counts)
          .map(([k, v]) => `${k} ${v}`)
          .join(' · '),
    );

    return {
      status: {
        ok: true,
        fetchedAt,
        note:
          'LiveBench 2.0（2026-10 起）。上游整站重写，v1 的 table_<release>.csv / categories_<release>.json 已全部下线（404），' +
          '数据改从 data/<release>/breakdown.json 取。2.0 是长程任务评测（跑几个月的运维、做 PPT/PDF、写研究报告），' +
          '与 v1 的题目集不是同一把尺子，**两条赛制的分数不可比较**，故赛制 id 一律 `livebench2_` 前缀另起一池。' +
          `release ${release} 是完整快照（七个分类每个都有全部型号），不需要像 v1 那样跨 release 取并集。` +
          `\`${V2_OVERALL_LEAGUE}\` 是本站按七类等权算的均分，上游不发布这个数。`,
      },
      byModel,
      counts,
      releasesUsed: [release],
      releasesSkipped: [],
      releaseSource: `v2/${source}`,
      v2Release: release,
    };
  }
  return null;
}

/**
 * 分组平均。缺任何一个 task 就返回 null——半个分组的平均没有意义。
 *
 * **空串必须单独判掉**：`Number('')` 是 `0` 而且 `Number.isFinite(0)` 为真，
 * 只写 `isFinite` 检查的话，某个 task 没跑的行会被当成「这一项得 0 分」算进平均，
 * 把两项分组的分数直接砍半，而且不会报错。上游确实存在这种空值行。
 */
export function categoryAverage(
  row: Record<string, string>,
  tasks: string[],
): number | null {
  if (tasks.length === 0) return null;
  const vals: number[] = [];
  for (const t of tasks) {
    const raw = (row[t] ?? '').trim();
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    vals.push(n);
  }
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
}

interface ReleasePayload {
  release: string;
  rows: Record<string, string>[];
  /** 分组名 → 这个 release 里实际存在的 task 列 */
  categories: Map<string, string[]>;
}

async function fetchRelease(release: string): Promise<ReleasePayload | null> {
  const key = release.replace(/-/g, '_');
  try {
    const [csv, cat] = await Promise.all([
      fetchWithCache(ENDPOINTS.liveBenchTable(key), { label: `livebench/table_${key}.csv` }),
      fetchWithCache(ENDPOINTS.liveBenchCategories(key), {
        label: `livebench/categories_${key}.json`,
      }),
    ]);
    const rows = parseCsv(csv.body.toString('utf8'), {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
      trim: false,
    }) as Record<string, string>[];
    if (rows.length === 0) return null;
    const groups = JSON.parse(cat.body.toString('utf8')) as Record<string, string[]>;
    const header = new Set(Object.keys(rows[0]));
    const categories = new Map<string, string[]>();
    for (const [name, tasks] of Object.entries(groups)) {
      if (!Array.isArray(tasks)) continue;
      categories.set(name, tasks.filter((t) => header.has(t)));
    }
    return { release, rows, categories };
  } catch (err) {
    log.warn(`LiveBench ${release} 抓取失败，跳过该 release：${errorMessage(err)}`);
    return null;
  }
}

/**
 * LiveBench 1.x 的老路径（按题集的宽表 CSV）。
 *
 * 2026-10 上游整站重写成 LiveBench 2.0 之后，这条路径的端点已全部 404。
 * 保留它不是为了继续用，而是为了**上游回滚**时还能立刻接回去——这套分组平均与同期分池
 * 的逻辑是踩过坑换来的，删了将来重写一遍很容易再踩一遍。
 */
export async function fetchLiveBenchV1(fetchedAt: string): Promise<LiveBenchResult> {
  const byModel = new Map<string, LiveBenchScore[]>();
  const counts: Record<string, number> = {};
  const skippedReleases: string[] = [];

  let releases = LIVEBENCH_FALLBACK_RELEASES;
  let releaseSource = 'fallback';
  try {
    const res = await fetchWithCache(ENDPOINTS.liveBenchReleasesSource, {
      label: 'livebench/common.py',
    });
    const parsed = parseLiveBenchReleases(res.body.toString('utf8'));
    if (parsed.length > 0) {
      releases = parsed;
      releaseSource = 'LIVE_BENCH_RELEASES';
    }
  } catch (err) {
    log.warn(`LiveBench release 清单抓取失败，用内置兜底清单：${errorMessage(err)}`);
  }

  const payloads: ReleasePayload[] = [];
  for (const release of releases) {
    const p = await fetchRelease(release);
    if (!p) continue;
    // 断点判据：这个 release 的 Coding 分组用的是不是新一代 task 名。
    const coding = p.categories.get('Coding') ?? [];
    const modern = MODERN_CODING_TASKS.every((t) => coding.includes(t));
    if (!modern) {
      skippedReleases.push(release);
      continue;
    }
    payloads.push(p);
  }

  if (payloads.length === 0) {
    return {
      status: {
        ok: false,
        fetchedAt: null,
        note: `没有拿到任何可用 release（清单来源 ${releaseSource}，共 ${releases.length} 个）`,
      },
      byModel,
      counts,
      releasesUsed: [],
      releasesSkipped: skippedReleases,
      releaseSource,
      v2Release: null,
    };
  }

  // 新 release 只重跑一部分模型，老模型的分数留在旧 release 里，
  // 所以要取同期内的并集；同一个模型出现在多个 release 时取**最新的那个**
  // （同期内实测最大只差 5.1 分，取最新是为了确定性而不是为了准确性）。
  payloads.sort((a, b) => (a.release < b.release ? 1 : -1));
  const releasesUsed = payloads.map((p) => p.release);

  for (const p of payloads) {
    for (const { category, league } of CATEGORY_LEAGUES) {
      const tasks = p.categories.get(category) ?? [];
      if (tasks.length === 0) continue;
      for (const row of p.rows) {
        const model = (row['model'] ?? '').trim();
        if (!model) continue;
        const score = categoryAverage(row, tasks);
        if (score === null) continue;
        const slug = stripLiveBenchEffort(model);
        if (!slug) continue;
        const list = byModel.get(slug) ?? [];
        // 同一模型同一赛制只留最新 release 的那条；payloads 已按 release 降序，
        // 所以先写入的就是最新的，后面的直接跳过。
        if (list.some((s) => s.league === league)) continue;
        list.push({
          league,
          score,
          release: p.release,
          upstreamModel: model,
          sourceUrl: `https://livebench.ai/#/?release=${p.release}`,
          // v1 只有 Coding / Agentic Coding 两组，都是编程口径。
          coding: true,
        });
        byModel.set(slug, list);
        counts[league] = (counts[league] ?? 0) + 1;
      }
    }
  }

  log.step(
    `LiveBench：release 清单来自 ${releaseSource}（${releases.length} 个），` +
      `采用同期 ${releasesUsed.length} 个（${releasesUsed[releasesUsed.length - 1]} ~ ${releasesUsed[0]}），` +
      `因题目集换代跳过 ${skippedReleases.length} 个；` +
      `归一后 ${byModel.size} 个模型名，` +
      Object.entries(counts)
        .map(([k, v]) => `${k} ${v}`)
        .join(' · '),
  );

  return {
    status: {
      ok: true,
      fetchedAt,
      note:
        `Apache-2.0 / DATASHEET 明文「no copyrights on the data」。` +
        `采用 ${releasesUsed.length} 个同期 release（${releasesUsed.join(', ')}）；` +
        `跳过题目集换代前的 ${skippedReleases.length} 个（${skippedReleases.join(', ')}）——` +
        `实测跨这个断点同一模型的 Coding 分中位差 27.6 分，不可同池。`,
    },
    byModel,
    counts,
    releasesUsed,
    releasesSkipped: skippedReleases,
    releaseSource,
    v2Release: null,
  };
}

/**
 * LiveBench 的总入口。
 *
 * 顺序是「先 2.0、后 1.x」：2.0 是上游现在的样子，1.x 的端点已下线；
 * 只有当 2.0 完全抓不到（上游再改版，或者干脆回滚回 1.x）才回落到老路径。
 * 两条路径的成绩**永远不混池**——它们的赛制 id 不一样，分数也不在同一把尺子上。
 */
export async function fetchLiveBench(fetchedAt: string): Promise<LiveBenchResult> {
  const v2 = await fetchLiveBenchV2(fetchedAt);
  if (v2) return v2;
  log.warn('LiveBench 2.0 没抓到数据，回落到 1.x（上游已下线 1.x 的端点，通常同样拿不到）');
  return fetchLiveBenchV1(fetchedAt);
}
