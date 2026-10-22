import { ENDPOINTS } from '../config';
import { isArtificialAnalysisSourced } from '../lib/compliance';
import { parseLooseDate } from '../lib/dates';
import { perMTokAsIs, sanitizePrice } from '../lib/decimal';
import { canonicalizeId } from '../lib/ids';
import { fetchJson } from '../lib/http';
import { errorMessage, log } from '../lib/log';
import type {
  ModelsDevFacts,
  ModelsDevPricing,
  ModelsDevProvider,
  ModelsDevResult,
  VendorBenchmark,
} from './types';

interface RawLimit {
  context?: number;
  output?: number;
}
interface RawCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}
interface RawModality {
  input?: string[];
  output?: string[];
}
interface RawWeight {
  label?: string;
  url?: string;
  type?: string;
}
interface RawBenchmark {
  name?: string;
  score?: number;
  metric?: string;
  source?: string;
}
interface RawModel {
  id?: string;
  name?: string;
  description?: string;
  family?: string;
  release_date?: string;
  last_updated?: string;
  knowledge?: string;
  modalities?: RawModality;
  open_weights?: boolean;
  limit?: RawLimit;
  cost?: RawCost;
  tool_call?: boolean;
  reasoning?: boolean;
  structured_output?: boolean;
  license?: string;
  status?: string;
  weights?: RawWeight[];
  links?: RawWeight[];
  benchmarks?: RawBenchmark[];
}
interface RawProvider {
  id?: string;
  name?: string;
  doc?: string;
  models?: Record<string, RawModel>;
}

const HF_URL = /^https?:\/\/huggingface\.co\/([^/?#]+\/[^/?#]+)/i;

function extractHfRepos(model: RawModel): string[] {
  const out = new Set<string>();
  for (const entry of [...(model.weights ?? []), ...(model.links ?? [])]) {
    const m = entry?.url ? HF_URL.exec(entry.url) : null;
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

/** models.dev 的 license 字段实测出现过 "qwen3.8-max" 这种明显串位的脏值，交给下游 SPDX 归一化判断。 */
function normalizeModalityList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].sort();
}

function positiveOrNull(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 上游同一个榜单有多种写法：'SWE-Bench Pro' / 'SWE Bench Pro'、
 * "Humanity's Last Exam" 与 'Humanity’s Last Exam'（直角撇号 vs 弯撇号）、
 * 'Terminal-Bench 2.1' / 'Terminal Bench 2.1'。先抹平再匹配。
 */
export function normalizeBenchmarkName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 编程赛制白名单：上游榜单名（已归一）→ 本站的赛制 id。
 *
 * 上游 `models.json` 里有 95 个不同榜单名，这张表只收**口径确实是「写代码 / 软件工程」**的那些。
 * 一个赛制一列，永不合并——同一个模型在 Verified 上 75 分、在 Pro 上 45 分是常态，
 * 合并就等于凭空造出一个没人测过的数字（见 docs/HANDOFF.md 4.4）。
 *
 * 键是 normalizeBenchmarkName 之后的形态，所以同一个榜单的多种写法各占一行
 * （`claw eval` / `claweval` 上游两种拼法都出现过，归到同一个赛制）。
 *
 * ── 明确排除的候选，以及排除的理由 ──────────────────────────────────
 *
 * `scicode`（上游 30 个模型，剔除 AA 血缘后只剩 3 个）：两条独立的理由，任一条都足以排除。
 *   其一，口径不是软件工程。SciCode 考的是「照着科研论文把公式实现成代码」，
 *   分数主要由物理/化学/生物的领域知识决定，把它算进「编程能力」会让一个不会写业务代码
 *   但物理很强的模型在广场上摆出电脑，这是在骗人。
 *   其二，30 条里 27 条来自 openrouter.ai，即 AA 第三跳（见 lib/compliance.ts），
 *   本来也留不下来。
 *
 * `terminal bench hard`：口径**是**软件工程，所以它留在下面的表里；
 *   但它当前 22 条数据 100% 来自 openrouter.ai，会被合规过滤全部拦掉，落地 0 条。
 *   保留这一行不是无用代码：哪天 tbench.ai 或某家厂商直接公布 Hard 的成绩，它就自动流进来。
 *
 * `automationbench`（6 个模型）：排除。名字与可得证据都指向「工作流 / 计算机操作自动化」
 *   而不是写代码——它在厂商公告里的同现邻居是 GDPval、Toolathlon、OSWorld Verified 这一簇，
 *   分数区间（17–31）也与计算机操作类一致，而非软件工程类。
 *   若日后确认口径是写代码，在下面加一行即可。
 *
 * 各厂商自造的单点评测（`kimi code bench`、`kimi claw 24/7 bench`、`cybergym`、
 *   `dsbench *`、`mls bench lite`、`spreadsheetbench`、`forte`、`frontier bench`）：排除。
 *   它们只有唯一一家厂商的唯一一条成绩，**在自己的赛制里没有可比人群**，
 *   而前端的电脑档位是按赛制内分位算的——n=1 的分位数没有意义，
 *   给出的档位看起来言之凿凿实则毫无依据。
 */
const CODING_LEAGUES: Record<string, string> = {
  // SWE-bench 家族。Verified 是事实标准，Pro（Scale AI）难度高得多，Multilingual 换了语言集。
  'swe bench verified': 'swe_bench_verified',
  'swe bench pro': 'swe_bench_pro',
  'swe bench multilingual': 'swe_bench_multilingual',
  'swe bench multimodal': 'swe_bench_multimodal',
  // Terminal-Bench 系列。版本之间任务集与脚手架都换过，严格分列。
  'terminal bench': 'terminal_bench',
  'terminal bench 2.0': 'terminal_bench_2_0',
  'terminal bench 2.1': 'terminal_bench_2_1',
  'terminal bench hard': 'terminal_bench_hard',
  // 多语言 diff 编辑，来源是 aider.chat 官方榜（中立第三方）。
  'aider polyglot': 'aider_polyglot',
  // 竞赛题通过率。Pro 与 v6 是独立的题集/版本，不能与主榜混算。
  livecodebench: 'livecodebench',
  'livecodebench pro': 'livecodebench_pro',
  'livecodebench v6': 'livecodebench_v6',
  // 仓库级 agent 任务
  deepswe: 'deepswe',
  nl2repo: 'nl2repo',
  frontiercode: 'frontier_code',
  frontierswe: 'frontier_swe',
  'swe marathon': 'swe_marathon',
  'program bench': 'program_bench',
  'claw eval': 'claw_eval',
  claweval: 'claw_eval',
  // Scale AI 的 SWE-Atlas 三件套：读代码 / 重构 / 写测试，都在软件工程口径内。
  'swe atlas codebase qna': 'swe_atlas_codebase_qna',
  'swe atlas refactoring': 'swe_atlas_refactoring',
  'swe atlas test writing': 'swe_atlas_test_writing',
  // 机器学习工程：让 agent 自己写训练/评估代码去解 Kaggle 式任务，是写代码。
  'mle bench': 'mle_bench',
};

/**
 * 赛制的可信度排序，决定 `coding[]` 的元素顺序（前端可以直接取 `coding[0]`）。
 *
 * 排序依据按重要性递减：**是否第三方统一复跑** → **可比人群有多大** → **口径离「写业务代码」有多近**。
 * 不在这张表里的赛制排在最后，按 id 字典序，保证输出确定性。
 *
 * 这里刻意不按分数高低排——分数高低是模型的属性，不是赛制的可信度。
 */
export const CODING_LEAGUE_ORDER: string[] = [
  // Epoch AI 统一复跑，唯一跨模型真正可比的一列
  'swe_bench_verified',
  // models.dev 转载的 Verified 自报值：口径同上但脚手架各家自己搭，人群最大
  'swe_bench_vendor',
  'swe_bench_pro',
  // Terminal-Bench 2.0 由 Epoch 统一收录官方榜（约 40 个模型），
  // 排在无版本的 terminal_bench（厂商自报混合版本）之前。
  'terminal_bench_2_0',
  'terminal_bench',
  'aider_polyglot',
  'swe_bench_multilingual',
  'deepswe',
  'livebench_coding',
  'livebench_agentic_coding',
  // LiveBench 2.0 的编程分项：换了一套长程任务题集，与 1.x 不可比，单列一档。
  'livebench2_coding',
  'cursorbench',
  'swe_atlas_codebase_qna',
  'swe_atlas_refactoring',
  'swe_atlas_test_writing',
  'terminal_bench_2_1',
  'nl2repo',
  'frontier_code',
  'livecodebench',
  'program_bench',
  'claw_eval',
  'frontier_swe',
  'swe_marathon',
  'mle_bench',
  'livecodebench_pro',
  'terminal_bench_hard',
  'livecodebench_v6',
  'swe_bench_multimodal',
  // 口径明显偏窄的放在后面：算法竞赛与性能调优都不是「会不会写业务代码」。
  'gso',
  'ale_bench',
  'algotune',
  'mirrorcode',
  // WebDev Arena 是 Elo，量纲与上面全都不同，放在最后：
  // 它能回答「谁更强」，但回答不了「解决了几成任务」。
  'webdev_arena_elo',
];

const CODING_LEAGUE_RANK = new Map(CODING_LEAGUE_ORDER.map((league, i) => [league, i]));

/** 赛制在 `coding[]` 里的排序权重。未登记的赛制排在所有已登记赛制之后。 */
export function codingLeagueRank(league: string): number {
  return CODING_LEAGUE_RANK.get(league) ?? CODING_LEAGUE_ORDER.length;
}

/**
 * models.dev 转载的 SWE-bench Verified 在契约里叫 `swe_bench_vendor`，
 * 与 Epoch 统一复跑的 `swe_bench_verified` **分属两个赛制**。
 *
 * 这不是洁癖：Epoch 是同一套脚手架跑所有模型，而自报值是各家用自己的 agent 跑的，
 * 两者只能同列内比较（docs/HANDOFF.md 4.4）。前端按赛制内分位算电脑档位，
 * 混进同一个池子就等于用别人的尺子量自己。
 *
 * 上游榜单名仍然是 "SWE-Bench Verified"，所以这里只在**出口**改名，
 * 不动 vendorBenchmarks 的键——data/benchmark-attribution.json 的键名是前端在读的契约。
 */
const VENDOR_LEAGUE_RENAME: Record<string, string> = {
  swe_bench_verified: 'swe_bench_vendor',
};

/**
 * 上游榜单名 → 写进 `coding[]` 的赛制 id。不是编程口径就返回 null。
 * 抽出来是为了能在 selftest 里单独验，这条判断错了不会报错、只会静默产出脏数据。
 */
export function pickCodingLeague(rawName: string): string | null {
  const key = CODING_LEAGUES[normalizeBenchmarkName(rawName)];
  if (!key) return null;
  return VENDOR_LEAGUE_RENAME[key] ?? key;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * 榜单方/中立第三方自己发布的成绩，区别于厂商系统卡里的自评。
 *
 * 这个区分不是洁癖，是实测出来的：同一列 SWE-Bench Pro 里，
 * Scale AI 官方榜（labs.scale.com）的中位数是 41.0，
 * 而厂商系统卡自报的中位数是 59.0，整整差 18 分——
 * 两边用的 agent 脚手架根本不是一套。同时被两边测过的模型只有 1 个，
 * 没法做校准，所以至少要保证「两边都有时优先采信中立方」。
 */
const NEUTRAL_BENCHMARK_HOSTS = new Set([
  'labs.scale.com',
  'swebench.com',
  'aider.chat',
  'benchlm.ai',
  'llm-stats.com',
  'epoch.ai',
  // 榜单方自己的站点，同样属于中立第三方。当前数据里还没出现，
  // 但 Terminal-Bench Hard 的合规成绩只可能从这里来（见 lib/compliance.ts）。
  'tbench.ai',
  'livecodebench.github.io',
]);
// 刻意不收 arxiv.org：厂商自己发的预印本仍然是自报，署名换了个地方而已。

function attributionTypeOf(host: string | null): 'third-party' | 'vendor-self-reported' {
  return host && NEUTRAL_BENCHMARK_HOSTS.has(host) ? 'third-party' : 'vendor-self-reported';
}

/**
 * 从来源 URL 判定这条成绩算第三方还是厂商自评。
 * 判据只有域名——名字骗不了人但也证明不了什么，`SWE-Bench Pro` 这个名字
 * 既出现在 Scale 官方榜上也出现在厂商系统卡里，中位数差 18 分。
 */
export function attributionOf(sourceUrl: string | null): 'third-party' | 'vendor-self-reported' {
  return attributionTypeOf(hostOf(sourceUrl));
}

/**
 * 解析 models.dev 的 `benchmarks[]`（厂商/榜单自报成绩）。
 *
 * 三件必须做对的事：
 *  1. AA 合规过滤。实测 656 条里有 70 条来自 artificialanalysis.ai、75 条来自
 *     openrouter.ai 的 AA 第三跳，而且多数名字是中性的（"SWE-Bench Pro"、"Terminal-Bench"），
 *     只看 name 认不出来。
 *  2. 口径过滤。只有 CODING_LEAGUES 里登记过的榜单会进入契约，
 *     不是「写代码 / 软件工程」的一律不收——理由逐条写在那张表上面。
 *  3. 同一模型同一赛制可能有多条（不同 agent 脚手架 / 有无工具 / 不同榜单方）。
 *     按 beatsPrevious 取一条，并且是确定性的——不依赖上游数组顺序。
 */
function parseVendorBenchmarks(
  model: RawModel,
): { entries: Map<string, VendorBenchmark>; total: number; blocked: number; offTopic: number } {
  const entries = new Map<string, VendorBenchmark>();
  let total = 0;
  let blocked = 0;
  let offTopic = 0;
  for (const b of model.benchmarks ?? []) {
    total += 1;
    const rawName = b?.name?.trim();
    if (!rawName) continue;
    if (isArtificialAnalysisSourced(rawName, b?.source)) {
      blocked += 1;
      continue;
    }
    const key = CODING_LEAGUES[normalizeBenchmarkName(rawName)];
    if (!key) {
      offTopic += 1;
      continue;
    }
    const score = b?.score;
    if (typeof score !== 'number' || !Number.isFinite(score)) continue;
    // 上游这一列实测全部已经是 0–100 的百分数，越界值当脏数据丢弃。
    if (score < 0 || score > 100) continue;
    const sourceUrl = b?.source?.trim() || null;
    const sourceHost = hostOf(sourceUrl);
    const candidate: VendorBenchmark = {
      key,
      league: VENDOR_LEAGUE_RENAME[key] ?? key,
      rawName,
      score: Math.round(score * 100) / 100,
      metric: b?.metric?.trim() || null,
      sourceHost,
      sourceUrl,
      attributionType: attributionTypeOf(sourceHost),
    };
    const prev = entries.get(key);
    if (!prev || beatsPrevious(candidate, prev)) entries.set(key, candidate);
  }
  return { entries, total, blocked, offTopic };
}

/**
 * 同一模型同一榜单有多条时的取舍顺序：
 *   1. 中立第三方 > 厂商自评（哪怕自评分数更高——尤其是自评分数更高的时候）
 *   2. 同类来源里取最高分（不同 reasoning effort / agent 配置的最好成绩）
 *   3. 仍然并列时按来源域名字典序，保证不依赖上游数组顺序
 */
export function beatsPrevious(candidate: VendorBenchmark, prev: VendorBenchmark): boolean {
  const rank = (v: VendorBenchmark) => (v.attributionType === 'third-party' ? 0 : 1);
  if (rank(candidate) !== rank(prev)) return rank(candidate) < rank(prev);
  if (candidate.score !== prev.score) return candidate.score > prev.score;
  return (candidate.sourceHost ?? '') < (prev.sourceHost ?? '');
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // 偶数个时取偏下的中位数，保证确定性。
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

export async function fetchModelsDev(fetchedAt: string): Promise<ModelsDevResult> {
  const facts = new Map<string, ModelsDevFacts>();
  const pricing = new Map<string, ModelsDevPricing>();
  const providers = new Map<string, ModelsDevProvider>();
  const vendorBenchmarks = new Map<string, Map<string, VendorBenchmark>>();
  const apiModelKeys = new Set<string>();
  const counts = {
    modelsJson: 0,
    apiProviders: 0,
    apiEntries: 0,
    benchmarkEntries: 0,
    benchmarkEntriesBlockedAA: 0,
    benchmarkEntriesOffTopic: 0,
    benchmarkModels: 0,
    /** 每个编程赛制落地了多少个模型，用于同步报告与人工核对 */
    benchmarkLeagueModels: {} as Record<string, number>,
  };

  let modelsOk = false;
  let apiOk = false;
  const notes: string[] = [];

  try {
    const { data } = await fetchJson<Record<string, RawModel>>(ENDPOINTS.modelsDevModels, {
      label: 'models.dev/models.json',
    });
    for (const [rawId, model] of Object.entries(data)) {
      const canon = canonicalizeId(rawId);
      if (!canon) continue;
      counts.modelsJson += 1;

      const bench = parseVendorBenchmarks(model);
      counts.benchmarkEntries += bench.total;
      counts.benchmarkEntriesBlockedAA += bench.blocked;
      counts.benchmarkEntriesOffTopic += bench.offTopic;
      if (bench.entries.size > 0) {
        counts.benchmarkModels += 1;
        vendorBenchmarks.set(canon.id, bench.entries);
        for (const entry of bench.entries.values()) {
          counts.benchmarkLeagueModels[entry.league] =
            (counts.benchmarkLeagueModels[entry.league] ?? 0) + 1;
        }
      }

      facts.set(canon.id, {
        id: canon.id,
        rawId,
        vendorId: canon.vendorId,
        modelSlug: canon.modelSlug,
        name: model.name?.trim() || canon.modelSlug,
        description: model.description?.trim() || null,
        family: model.family?.trim() || null,
        releaseDate: parseLooseDate(model.release_date),
        lastUpdated: parseLooseDate(model.last_updated),
        knowledgeCutoff: model.knowledge?.trim() || null,
        modalities: {
          input: normalizeModalityList(model.modalities?.input),
          output: normalizeModalityList(model.modalities?.output),
        },
        openWeights: typeof model.open_weights === 'boolean' ? model.open_weights : null,
        // 图像/音频类模型在 models.dev 里 limit 写作 0，那是「不适用」而不是「上下文为零」。
        contextWindow: positiveOrNull(model.limit?.context),
        maxOutput: positiveOrNull(model.limit?.output),
        toolCall: typeof model.tool_call === 'boolean' ? model.tool_call : null,
        reasoning: typeof model.reasoning === 'boolean' ? model.reasoning : null,
        structuredOutput:
          typeof model.structured_output === 'boolean' ? model.structured_output : null,
        licenseRaw: model.license?.trim() || null,
        hfRepos: extractHfRepos(model),
      });
    }
    modelsOk = true;
  } catch (err) {
    notes.push(`models.json 抓取失败：${errorMessage(err)}`);
    log.error(`models.dev/models.json 抓取失败：${errorMessage(err)}`);
  }

  // api.json 是 provider × model 的笛卡尔积，用于补齐 models.json 没有的定价。
  const priceBuckets = new Map<
    string,
    { input: number[]; output: number[]; cached: number[]; providerIds: string[] }
  >();
  const firstParty = new Map<string, RawCost>();

  try {
    const { data } = await fetchJson<Record<string, RawProvider>>(ENDPOINTS.modelsDevApi, {
      label: 'models.dev/api.json',
    });
    for (const [providerId, provider] of Object.entries(data)) {
      counts.apiProviders += 1;
      providers.set(providerId, {
        id: providerId,
        name: provider.name?.trim() || providerId,
        doc: provider.doc?.trim() || null,
      });
      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        counts.apiEntries += 1;
        // api.json 的 model id 不带创作者前缀，无法独立判定创作者，
        // 因此只用「型号片段」跟 models.json 的规范 id 对齐。
        const bare = modelId.split('/').pop() ?? modelId;
        const key = bare.trim().toLowerCase();
        apiModelKeys.add(key);
        const cost = model.cost;
        if (!cost) continue;
        let bucket = priceBuckets.get(key);
        if (!bucket) {
          bucket = { input: [], output: [], cached: [], providerIds: [] };
          priceBuckets.set(key, bucket);
        }
        bucket.providerIds.push(providerId);
        const i = sanitizePrice(perMTokAsIs(cost.input));
        const o = sanitizePrice(perMTokAsIs(cost.output));
        const c = sanitizePrice(perMTokAsIs(cost.cache_read));
        if (i !== null) bucket.input.push(i);
        if (o !== null) bucket.output.push(o);
        if (c !== null) bucket.cached.push(c);
      }
    }

    // 第一方报价（创作者自己就是 provider）优先于第三方托管商的加价。
    for (const [providerId, provider] of Object.entries(data)) {
      for (const [modelId, model] of Object.entries(provider.models ?? {})) {
        if (!model.cost) continue;
        const bare = (modelId.split('/').pop() ?? modelId).trim().toLowerCase();
        firstParty.set(`${providerId}::${bare}`, model.cost);
      }
    }
    apiOk = true;
  } catch (err) {
    notes.push(`api.json 抓取失败：${errorMessage(err)}`);
    log.error(`models.dev/api.json 抓取失败：${errorMessage(err)}`);
  }

  for (const fact of facts.values()) {
    const key = fact.modelSlug;
    const bucket = priceBuckets.get(key);
    if (!bucket) continue;
    const own = firstParty.get(`${fact.vendorId}::${key}`);
    if (own) {
      pricing.set(fact.id, {
        inputPerMTok: sanitizePrice(perMTokAsIs(own.input)),
        outputPerMTok: sanitizePrice(perMTokAsIs(own.output)),
        cachedInputPerMTok: sanitizePrice(perMTokAsIs(own.cache_read)),
        providerCount: bucket.providerIds.length,
        chosenProvider: fact.vendorId,
      });
    } else {
      pricing.set(fact.id, {
        inputPerMTok: median(bucket.input),
        outputPerMTok: median(bucket.output),
        cachedInputPerMTok: median(bucket.cached),
        providerCount: bucket.providerIds.length,
        chosenProvider: null,
      });
    }
  }

  const ok = modelsOk && facts.size > 0;
  log.step(
    `models.dev：models.json ${counts.modelsJson} 条 / api.json ${counts.apiProviders} 个 provider ` +
      `${counts.apiEntries} 条，成功配上定价 ${pricing.size} 条`,
  );
  const leagueSummary = Object.entries(counts.benchmarkLeagueModels)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  log.step(
    `models.dev benchmarks[]：${counts.benchmarkEntries} 条自报成绩，` +
      `因血缘指向 Artificial Analysis 拦截 ${counts.benchmarkEntriesBlockedAA} 条，` +
      `因口径不是编程跳过 ${counts.benchmarkEntriesOffTopic} 条，` +
      `晋升进契约的覆盖 ${counts.benchmarkModels} 个模型`,
  );
  log.info(`编程赛制落地情况：${leagueSummary || '（无）'}`);

  return {
    status: {
      ok,
      fetchedAt: ok ? fetchedAt : null,
      note: notes.length
        ? notes.join('；')
        : `models.json ${counts.modelsJson} 条；api.json ${counts.apiProviders} provider / ${counts.apiEntries} 条` +
          `${apiOk ? '' : '（api.json 缺失）'}；` +
          `benchmarks[] ${counts.benchmarkEntries} 条，已拦截 AA 血缘 ${counts.benchmarkEntriesBlockedAA} 条，` +
          `非编程口径跳过 ${counts.benchmarkEntriesOffTopic} 条`,
    },
    facts,
    pricing,
    providers,
    vendorBenchmarks,
    apiModelKeys,
    counts,
  };
}
