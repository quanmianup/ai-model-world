/**
 * 「大模型世界」元数据同步管线。
 *
 *   npx tsx scripts/sync/index.ts
 *
 * 产出：
 *   data/models.json            符合 src/lib/types.ts 的 WorldSnapshot
 *   data/raw/<source>.json      各上游的原始快照（用于上游改字段时回放验证解析逻辑）
 *   data/params-tier.json       闭源模型的 1–5 档规模推定（数据契约里没有位置放，见报告）
 *   data/discovery-pending.json 只有单一源收录、尚未晋升进快照的新模型
 *   data/sync-report.json       本次运行的覆盖率、告警与冲突清单
 *
 * 整条管线不使用任何 API key。
 */
import path from 'node:path';

import {
  BENCHMARK_ATTRIBUTION_PATH,
  DATA_DIR,
  DISCOVERY_QUEUE_PATH,
  PARAMS_TIER_PATH,
  RAW_DIR,
  RUN_REPORT_PATH,
  SNAPSHOT_PATH,
} from './config';
import { todayIso } from './lib/dates';
import { ensureDir, readJsonIfExists, writeFileAtomic } from './lib/fsx';
import { errorMessage, log } from './lib/log';
import { stableStringify } from './lib/stable-json';
import { buildSnapshot, hfTargets } from './merge/build';
import { loadVendorRegistry } from './merge/vendor-registry';
import { fetchEpoch } from './sources/epoch';
import { fetchLiteLlm } from './sources/litellm';
import { fetchLiveBench } from './sources/livebench';
import { fetchLmArena } from './sources/lmarena';
import { fetchModelsDev } from './sources/models-dev';
import { fetchOpenRouter } from './sources/openrouter';
import { fetchVercelGateway } from './sources/vercel-gateway';
import { fetchHuggingFace } from './sources/huggingface';
import { computeCoverage, validateSnapshot } from './validate';
import type { SourceId, WorldSnapshot } from '../../src/lib/types';

function writeRaw(name: string, payload: unknown): void {
  if (payload === null || payload === undefined) return;
  writeFileAtomic(path.join(RAW_DIR, `${name}.json`), stableStringify(payload));
}

async function main(): Promise<number> {
  const startedAt = new Date();
  // 所有源的 fetchedAt 与 generatedAt 用同一个时刻：
  // 一次运行本来就在几十秒内完成，统一时间戳能让「连跑两次除时间戳外字节一致」可被机械验证。
  const runIso = startedAt.toISOString();
  const runDate = todayIso(startedAt);

  ensureDir(DATA_DIR);
  ensureDir(RAW_DIR);

  log.step(`同步开始 ${runIso}`);

  const previous = readJsonIfExists<WorldSnapshot>(SNAPSHOT_PATH);
  log.info(previous ? `读到上一次快照：${previous.models.length} 个模型` : '没有历史快照，本次为首次运行');

  // ── 抓取 ───────────────────────────────────────────────────────────
  const modelsDev = await fetchModelsDev(runIso);
  const [epoch, openrouter, vercel, litellm, livebench, lmarena] = await Promise.all([
    fetchEpoch(runIso),
    fetchOpenRouter(runIso),
    fetchVercelGateway(runIso),
    fetchLiteLlm(runIso),
    fetchLiveBench(runIso),
    fetchLmArena(),
  ]);

  const targets = hfTargets(modelsDev);
  const huggingface = await fetchHuggingFace(runIso, targets);

  // ── 原始快照落盘 ────────────────────────────────────────────────────
  writeRaw('models.dev', {
    _note:
      'models.dev（MIT）。models.json 为模型级事实，api.json 为 provider×model 报价，' +
      'benchmarks[] 为厂商/榜单自报成绩。' +
      '此处保存的是解析后的规范化中间结构，字段名与 models.dev 原始字段一一对应。' +
      'benchmarks[] 只保留口径为「写代码 / 软件工程」的赛制，' +
      '且来源指向 Artificial Analysis 的条目已在解析阶段拦掉（含 openrouter.ai 这一第三跳），' +
      '此处同样不保留。判据与证据见 scripts/sync/lib/compliance.ts。',
    fetchedAt: modelsDev.status.fetchedAt,
    counts: modelsDev.counts,
    facts: Object.fromEntries(
      [...modelsDev.facts.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    pricing: Object.fromEntries(
      [...modelsDev.pricing.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    providers: Object.fromEntries(
      [...modelsDev.providers.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    vendorBenchmarks: Object.fromEntries(
      [...modelsDev.vendorBenchmarks.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([id, m]) => [
          id,
          Object.fromEntries([...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
        ]),
    ),
  });
  writeRaw('epoch.ai', {
    _note:
      'Epoch AI Benchmarking Hub（CC-BY 4.0）。引用要求：' +
      "Epoch AI, 'AI Benchmarking Hub'. Published online at epoch.ai. " +
      "Retrieved from 'https://epoch.ai/benchmarks' [online resource]. " +
      '此处保存的是按厂商+型号归并后的分数索引；0–1 的准确率已统一乘 100 转成百分数，ECI 与 Elo 保持原量纲。' +
      'zip 内每个 CSV 都过了合规闸门（lib/compliance.ts 的 classifyEpochFile）：' +
      'Epoch 自己是 CC-BY 4.0，但它的 *_external.csv 是转载别人的榜单，转载谁就带着谁的条款。' +
      'blockedFiles 里是因血缘指向 Artificial Analysis / LMArena 而被整份丢弃的文件，此处不保留其内容。',
    fetchedAt: epoch.status.fetchedAt,
    counts: epoch.counts,
    codingCounts: epoch.codingCounts,
    blockedFiles: epoch.blockedFiles,
    exemptFiles: epoch.exemptFiles,
    skippedFiles: epoch.skippedFiles,
    leagues: epoch.leagues,
    trainingComputeRows: epoch.trainingComputeRows,
    strict: Object.fromEntries([...epoch.strict.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    loose: Object.fromEntries([...epoch.loose.entries()].sort(([a], [b]) => (a < b ? -1 : 1))),
    vendorCountry: Object.fromEntries(
      [...epoch.vendorCountry.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  });
  writeRaw('livebench', {
    _note:
      'LiveBench 官方榜（Apache-2.0；docs/DATASHEET.md 明文「There are no copyrights on the data.」）。' +
      '**当前是 LiveBench 2.0**：上游 2026-10 整站重写，v1 的 table_<release>.csv / categories_<release>.json ' +
      '两个端点已全部 404，数据改在 data/<release>/breakdown.json 里（一个文件装下七个分类与全部分项）。' +
      '2.0 评的是长程任务（跑几个月的运维、做 PPT/PDF、写研究报告），与 v1 的题目集不是同一把尺子，' +
      '所以赛制 id 一律 livebench2_ 前缀另起一池，v1 的 livebench_coding 原样保留、两者不可比。' +
      'livebench2_overall 是本站按七类等权算的均分，上游不发布这个数。' +
      'v1 时期的老规矩一并记着：只采用题目集换代之后的同期 release，' +
      '实测同一个模型跨 2025-04-02 ↔ 2025-04-25 这个断点，Coding 分中位数差 27.6 分、最大 41.9 分，' +
      '跨断点混算会让档位取决于模型碰巧在哪个 release 被跑过。' +
      '仓库 LICENSE 开头那段 lm-sys/FastChat 版权声明只是代码血缘，题目与分数都是 LiveBench 自己跑的，' +
      '与 LMArena 的众包投票无关，不触发 LMArena 的 ToS。',
    fetchedAt: livebench.status.fetchedAt,
    releaseSource: livebench.releaseSource,
    releasesUsed: livebench.releasesUsed,
    releasesSkipped: livebench.releasesSkipped,
    v2Release: livebench.v2Release,
    counts: livebench.counts,
    byModel: Object.fromEntries(
      [...livebench.byModel.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  });
  writeRaw('openrouter', {
    _note:
      'OpenRouter /api/v1/models。仅用于新模型发现与发布日期投票，不作为展示数据。' +
      'benchmarks.artificial_analysis 子字段已在解析阶段主动剔除（Artificial Analysis ToS 禁止再分发），' +
      '连这份原始快照里也不保留，请勿恢复。',
    fetchedAt: openrouter.status.fetchedAt,
    artificialAnalysisFieldsStripped: openrouter.strippedCount,
    payload: openrouter.rawForSnapshot,
  });
  writeRaw('vercel-gateway', {
    _note: 'Vercel AI Gateway /v1/models。仅用于新模型发现与发布日期投票（released 字段），不作为展示数据。',
    fetchedAt: vercel.status.fetchedAt,
    payload: vercel.rawForSnapshot,
  });
  writeRaw('litellm', {
    _note:
      'LiteLLM model_prices_and_context_window.json（MIT）。发布日期覆盖率实测 0%，' +
      '这里只保留去重后的型号片段，用作新模型的第三方佐证。',
    fetchedAt: litellm.status.fetchedAt,
    counts: litellm.counts,
    bareSlugs: [...litellm.bareSlugs].sort(),
  });
  writeRaw('huggingface', {
    _note: 'Hugging Face Hub API。只对开源模型查询，失败即整段跳过，参数量与许可证留空。',
    fetchedAt: huggingface.status.fetchedAt,
    status: huggingface.status,
    counts: huggingface.counts,
    byModelId: Object.fromEntries(
      [...huggingface.byModelId.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  });

  // ── 合并 ───────────────────────────────────────────────────────────
  const registry = await loadVendorRegistry();
  const built = await buildSnapshot({
    runIso,
    runDate,
    modelsDev,
    epoch,
    openrouter,
    vercel,
    litellm,
    huggingface,
    livebench,
    lmarena,
    registry,
    previous,
  });

  const sources: Record<SourceId, { ok: boolean; fetchedAt: string | null; note?: string }> = {
    'models.dev': modelsDev.status,
    'epoch.ai': epoch.status,
    huggingface: huggingface.status,
    openrouter: openrouter.status,
    'vercel-gateway': vercel.status,
    litellm: litellm.status,
    livebench: livebench.status,
    lmarena: { ok: lmarena.ok, fetchedAt: runIso, note: lmarena.note },
    derived: { ok: true, fetchedAt: runIso, note: '管线内推导的字段（规模档位、缓存能力、退役判定）' },
    override: { ok: true, fetchedAt: null, note: '暂无人工覆盖层' },
  };

  const snapshot: WorldSnapshot = {
    generatedAt: runIso,
    sources,
    vendors: built.vendors,
    models: built.models,
    benchmarks: built.benchmarks,
  };

  // ── 校验闸门 ───────────────────────────────────────────────────────
  const validation = validateSnapshot(snapshot, previous);
  const coverage = computeCoverage(snapshot.models);

  const report = {
    generatedAt: runIso,
    accepted: validation.ok,
    counts: {
      models: snapshot.models.length,
      vendors: snapshot.vendors.length,
      ...built.stats,
    },
    sources: Object.fromEntries(
      Object.entries(sources).map(([k, v]) => [k, { ok: v.ok, note: v.note ?? null }]),
    ),
    coverage: Object.fromEntries(
      Object.entries(coverage).map(([k, v]) => [
        k,
        { filled: v.filled, total: v.total, pct: Math.round(v.ratio * 1000) / 10 },
      ]),
    ),
    coding: {
      _note:
        'ModelRecord.coding[] 的落地情况。一个赛制一条成绩，跨赛制永不混算。' +
        'byLeague 是「该赛制覆盖了几个模型」，各赛制之间会重叠（一个模型可以有多条成绩）。' +
        'flagship 是广场首屏当家门面的命中率——全站覆盖率会被长尾微调模型稀释，' +
        '首屏才是用户真正看到的东西；without 如实列出仍然没有任何编程成绩的门面。' +
        'modelsOnlyElo 是只有 WebDev Arena Elo、没有任何百分数成绩的模型：' +
        '它们能排名，但读不出「解决了几成任务」，前端别把 Elo 塞进百分数的分位池。',
      ...built.codingCoverage,
    },
    codingLeaguesBlocked: {
      _note:
        '通过了合规过滤、但因为口径不是「写代码 / 软件工程」而没有进入 coding[] 的榜单，' +
        '以及因为血缘指向 Artificial Analysis / LMArena 而被拦掉的条数。' +
        '逐条理由写在 scripts/sync/sources/models-dev.ts 的 CODING_LEAGUES 与 sources/epoch.ts 的 CODING_BENCHMARKS 上方。',
      entriesBlockedByCompliance: modelsDev.counts.benchmarkEntriesBlockedAA,
      entriesSkippedOffTopic: modelsDev.counts.benchmarkEntriesOffTopic,
      epochFilesBlocked: epoch.blockedFiles,
      epochFilesExempt: epoch.exemptFiles,
      excludedLeagues: {
        scicode: '口径是科研论文里的科学计算代码，且 30 条里 27 条来自 openrouter.ai（AA 第三跳）',
        'terminal bench hard':
          '口径合格、已登记为赛制，但当前 22 条数据 100% 来自 openrouter.ai，全部被合规拦掉，落地 0 条',
        automationbench: '口径指向工作流/计算机操作自动化，不是软件工程',
        '厂商自造单点评测': 'kimi code bench / cybergym / dsbench / forte 等，赛制内只有一个模型，分位数无意义',
        'epoch: scicode_external.csv': 'Epoch 转载 AA 的榜单，129 行 Source 指向 artificialanalysis.ai，且有一列直接叫 AA model slug',
        'epoch: live_bench_external.csv':
          '整份是 LiveBench-2024-11-25 这一代题目集，与官方源采用的 2025-04-25 起同期相差中位 27.6 分，' +
          '不可同池；LiveBench 改从官方 CSV 接（sources/livebench.ts），那边能精确挑同期',
        'epoch: cybench / exploitbench': '安全攻防，不是写业务代码。不进 coding[]，但作为独立榜单进 scores[]',
        'epoch: osworld / the_agent_company': '计算机操作与办公自动化，同 automationbench 的理由。同样只进 scores[] 不进 coding[]',
      },
    },
    livebench: {
      _note:
        'LiveBench 官方榜（Apache-2.0，本轮调研里许可证最干净的一份）。' +
        '**2026-10 起上游改版成 LiveBench 2.0**，榜单数据在 data/<release>/breakdown.json，' +
        'release 清单从站点 JS bundle 里解析（上游每发一版就把 id 加进那个数组），解析失败才用内置兜底清单——' +
        '写死清单意味着新 release 不会被自动发现，与「发布后无人维护」的承诺相悖。' +
        '2.0 的七个分类与 v1 的两个分组是**不同的赛制**：id 带 livebench2_ 前缀，分数不可互相比较。' +
        'v1 时期的老规矩一并记着：releasesSkipped 里是题目集换代之前的 release，' +
        '跨那个断点分数不可比（中位差 27.6 分）。',
      releaseSource: livebench.releaseSource,
      releasesUsed: livebench.releasesUsed,
      releasesSkipped: livebench.releasesSkipped,
      v2Release: livebench.v2Release,
      rowsByLeague: livebench.counts,
      ...built.liveBenchMatch,
    },
    epochMatch: {
      _note:
        '「上游有多少 / 我们接住多少」。**分母必须用去重后的模型实体，不是 CSV 行数。**' +
        'Epoch 的一个模型会占很多行（每个 reasoning effort 一行、带日期的快照版本各占一行），' +
        '拿行数当分母算出来的 ECI「丢了 69%」是假告警，真实情况见 upstreamModels/matchedModels。' +
        '剩下的未匹配绝大多数是压根不在 models.dev 收录范围里的历史模型（Claude 2、Gemini 1.5、' +
        'Llama 3-70B 这类），不是名称归一化的问题——unmatchedSamples 可以逐条核对。' +
        '另外 matchedModels 与 landedModels 数的是两个不同的群体，两边不相等不是矛盾：' +
        '前者数「上游有多少个模型被我们接住了」，后者数「我们有多少个模型这一列拿到了值」。' +
        'grok-4.20 与 grok-4.20-reasoning 在我们这边是两个模型、在 Epoch 那边是同一个实体，' +
        '于是 landed 会大于 matched；反过来某个实体是靠别的别名键接住的、' +
        '那个键上恰好没有这一项成绩时，matched 又会大于 landed。',
      ...built.epochMatch,
    },
    epochBenchmarkRows: {
      _note: '有分数的 CSV 行数，仅用于确认解析器读到了东西。**不是模型数，不要当覆盖率分母用**，见 epochMatch。',
      ...epoch.counts,
    },
    epochCodingRows: {
      _note:
        'Epoch zip 里各编程 CSV 有分数的行数。同样是行数不是模型数——' +
        '同一个模型会因为不同 reasoning effort / 不同 agent 占多行，聚合时取最好成绩。' +
        '每个榜选了哪一列、量纲怎么判的，逐条写在 scripts/sync/sources/epoch.ts 的 CODING_BENCHMARKS 上。',
      ...epoch.codingCounts,
    },
    epochLeagues: {
      _note:
        'ModelRecord.scores[] 的全部榜单：手写规格的 17 个 + 按 benchmark_metadata.csv 泛化接入的其余榜单。' +
        'rows / scored 是 CSV 行数，landed 是快照里有该榜成绩的模型数（与 benchmarks[].models 一致）。' +
        'multiplier 是原始值到快照分数的倍数（0–1 小数 → 100；已是百分数 → 1；Elo / 分钟 / 美元 → 1）。' +
        'supersededBy 非 null 的榜单照样写进 scores[]，前端决定默认不开榜。' +
        'curated=false 的榜单分数列与量纲由上游 metadata 声明，本管线没有逐个人工核过分布——' +
        '但 pct 越界的行会被丢弃并计入 outOfRange，越界说明 metadata 的 scale 与实际列不符。',
      leagues: Object.fromEntries(
        Object.entries(epoch.leagues)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([league, info]) => [
            league,
            {
              file: info.fileName,
              scoreColumn: info.scoreColumn,
              unit: info.unit,
              multiplier: info.multiplier,
              upstreamName: info.upstreamName,
              inEci: info.inEci,
              supersededBy: info.supersededBy,
              selfRun: info.selfRun,
              curated: info.curated,
              rows: info.rows,
              scored: info.scored,
              outOfRange: info.outOfRange,
              landed: built.leagueLanding[league] ?? 0,
            },
          ]),
      ),
      /** 快照里有成绩、但不来自 Epoch zip 的榜单（models.dev 自报与 LiveBench） */
      nonEpochLeagues: Object.fromEntries(
        Object.entries(built.leagueLanding)
          .filter(([league]) => !epoch.leagues[league])
          .sort(([a], [b]) => (a < b ? -1 : 1)),
      ),
    },
    epochFilesSkipped: {
      _note:
        '泛化路径看过但没接入的 zip 内 CSV 及理由。与 epochFilesBlocked（合规拦截）分开：' +
        '这里是「接不了」（表头认不出分数列 / 量纲判不准 / 方向相反），不是「不能接」。',
      files: epoch.skippedFiles,
    },
    trainingCompute: {
      _note:
        'ModelRecord.trainingComputeFlop 的落地情况，来源 Epoch model_metadata.csv。' +
        '闭源模型从不公布参数量，训练算力是唯一有第三方估算的「体型」代理，' +
        'closedFlagships 数的是 openai / anthropic / google / xai 里有 ECI 的模型。' +
        'without 如实列出没拿到的闭源旗舰——多数是 Epoch 也没估算，不是匹配问题。',
      upstreamRows: epoch.trainingComputeRows,
      ...built.trainingCompute,
    },
    fallbackCoverage: {
      _note:
        'models.dev 缺项时的兜底源贡献（存活模型口径）。before 是只认 models.dev 时的覆盖数，' +
        'after 是兜底之后。仲裁顺序：定价 models.dev → LiteLLM → OpenRouter → Vercel；' +
        '上下文 / 最大输出 / 模态 models.dev → OpenRouter → Vercel → LiteLLM。' +
        'LiteLLM 只在第一方 provider 有条目、或所有托管商条目一致时才采信；图像/语音按张按分钟的价一律不折算。' +
        'OpenRouter 的 benchmarks.* 已整段剔除，兜底只读 pricing / context_length / architecture。',
      ...built.fallbackCoverage,
    },
    quickPromoted: {
      _note:
        '走「注册厂商单源快速晋升」进入快照的模型：厂商在 src/data/vendor-registry.ts 里登记过，' +
        '且被 openrouter 或 vercel-gateway 任一源收录（litellm 单源不算）。' +
        '目的是大厂新模型上线当天就能进站，不必等第二个网关跟上。',
      models: built.quickPromoted,
    },
    vendorRegistrySource: registry.source,
    failures: validation.failures,
    warnings: validation.warnings,
    releaseDateConflicts: validation.releaseDateConflicts,
  };

  writeFileAtomic(RUN_REPORT_PATH, stableStringify(report));
  writeFileAtomic(
    DISCOVERY_QUEUE_PATH,
    stableStringify({
      _note:
        '只有单一上游源收录、尚未达到多源佐证门槛的模型。等到第二个独立源也收录它，' +
        '下一次同步就会自动晋升进 data/models.json。' +
        '例外：厂商已在 src/data/vendor-registry.ts 登记的，openrouter 或 vercel-gateway 单源即晋升，不会出现在这里。',
      generatedAt: runIso,
      pending: built.pendingDiscoveries,
    }),
  );
  writeFileAtomic(
    PARAMS_TIER_PATH,
    stableStringify({
      _note:
        '闭源模型的「体型」代理指标：输出价格档位 × 厂商命名档位合成的 1–5 档规模。' +
        '这份档位已经并进 data/models.json 的 params.sizeTier / params.sizeTierBasis，' +
        '本文件只作为独立索引保留，方便离线核对。',
      generatedAt: runIso,
      tiers: built.sizeTiers,
    }),
  );
  writeFileAtomic(
    BENCHMARK_ATTRIBUTION_PATH,
    stableStringify({
      _note:
        '厂商/榜单自报成绩的归属明细，供前端生成精确的悬停文案。' +
        'attributionType=vendor-self-reported 用「厂商自报，未经第三方复核」，' +
        'attributionType=third-party 用「第三方榜单（来源：xxx），未经 Epoch 复核」。' +
        '注意 swe_bench_pro 混着两类来源，且实测有 18 分的系统性落差' +
        '（Scale AI 官方榜中位数 41.0，厂商系统卡自评中位数 59.0），' +
        '直接套用为 swe_bench_verified 校准的档位阈值会系统性低估被 Scale 测过的模型。' +
        'data/models.json 里 provenance["benchmarks.<key>"] === "models.dev" 已足够判断该不该发光，' +
        '这份文件只在需要精确署名或按来源分档时才用得上。',
      generatedAt: runIso,
      attribution: built.benchmarkAttribution,
    }),
  );

  if (!validation.ok) {
    log.error('合理性校验未通过，拒绝写入 data/models.json，保留旧快照。详见 data/sync-report.json');
    return 1;
  }

  writeFileAtomic(SNAPSHOT_PATH, stableStringify(snapshot));
  log.step(
    `写入 data/models.json：${snapshot.models.length} 个模型 / ${snapshot.vendors.length} 个厂商`,
  );

  const cov = (k: string) => `${(coverage[k]?.ratio * 100).toFixed(1)}%`;
  log.info(
    `覆盖率速览：发布日期 ${cov('releaseDate')} · 定价(输出) ${cov('pricing.outputPerMTok')} · ` +
      `上下文 ${cov('contextWindow')} · 许可证 ${cov('license')} · ECI ${cov('benchmarks.eci')}`,
  );
  log.info(
    `编程维度（旧三列）：Epoch 复跑 ${cov('benchmarks.swe_bench_verified')} + 自报 Verified ${cov('benchmarks.swe_bench_vendor')} ` +
      `+ 自报 Pro ${cov('benchmarks.swe_bench_pro')} → 合计 ${cov('benchmarks.任一编程信号')}`,
  );
  const flagship = built.codingCoverage.flagship;
  log.info(
    `编程维度（coding[] 全赛制）：${cov('coding.任一编程成绩')}，其中有百分数口径的 ${cov('coding.任一百分数成绩')}` +
      (flagship
        ? `；首屏 ${flagship.total} 位当家门面命中 ${flagship.withAnyCoding} 位` +
          `（${((100 * flagship.withAnyCoding) / flagship.total).toFixed(0)}%），` +
          `其中有百分数成绩的 ${flagship.withPercentCoding} 位`
        : ''),
  );
  log.info(
    `全榜单 scores[]：${cov('scores.任一成绩')} 的模型有至少一条成绩，${cov('scores.三条以上榜单')} 有三条以上；` +
      `benchmarks[] 共 ${snapshot.benchmarks?.length ?? 0} 个榜单；训练算力覆盖 ${cov('trainingComputeFlop')}`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    log.error(`管线异常终止：${errorMessage(err)}`);
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exitCode = 1;
  });
