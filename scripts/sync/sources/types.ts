import type { LooseDate } from '../lib/dates';
import type { ScoreUnit } from '../../../src/lib/types';

export interface SourceStatus {
  ok: boolean;
  fetchedAt: string | null;
  note?: string;
}

export interface ModelsDevFacts {
  id: string;
  rawId: string;
  vendorId: string;
  modelSlug: string;
  name: string;
  description: string | null;
  family: string | null;
  releaseDate: LooseDate | null;
  lastUpdated: LooseDate | null;
  knowledgeCutoff: string | null;
  modalities: { input: string[]; output: string[] };
  openWeights: boolean | null;
  contextWindow: number | null;
  maxOutput: number | null;
  toolCall: boolean | null;
  reasoning: boolean | null;
  structuredOutput: boolean | null;
  licenseRaw: string | null;
  /** 从 weights[] / links[] 里抽出的 Hugging Face 仓库 id，例如 "Qwen/Qwen3-235B-A22B" */
  hfRepos: string[];
}

/** models.dev `benchmarks[]` 里的一条厂商/榜单自报成绩（已过 AA 合规过滤）。 */
export interface VendorBenchmark {
  /**
   * 归一后的榜单键，例如 swe_bench_verified / swe_bench_pro。
   * 这是 data/benchmark-attribution.json 的键名，前端在读，**不要改**。
   */
  key: string;
  /**
   * 写进 ModelRecord.coding[] 的赛制 id。多数情况与 key 相同，
   * 唯一的例外是 models.dev 转载的 SWE-bench Verified：它的赛制是 `swe_bench_vendor`，
   * 与 Epoch 统一复跑的 `swe_bench_verified` 分列（见 sources/models-dev.ts 的说明）。
   */
  league: string;
  /** 上游原始榜单名，保留下来便于人工核对 */
  rawName: string;
  /** 0–100 */
  score: number;
  /** 上游自报的指标口径，例如 resolved / resolve rate / pass@1 */
  metric: string | null;
  /** 归属域名，前端据此生成「来源：xxx」的悬停文案 */
  sourceHost: string | null;
  sourceUrl: string | null;
  /**
   * 这个分数是榜单方/中立第三方发布的，还是厂商系统卡里的自评。
   * 悬停文案该写「厂商自报」还是「第三方榜单，未经 Epoch 复核」，取决于这一项。
   */
  attributionType: 'third-party' | 'vendor-self-reported';
}

export interface ModelsDevPricing {
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  cachedInputPerMTok: number | null;
  providerCount: number;
  /** 报价被采纳的 provider id，写进溯源说明 */
  chosenProvider: string | null;
}

export interface ModelsDevProvider {
  id: string;
  name: string;
  doc: string | null;
}

export interface ModelsDevResult {
  status: SourceStatus;
  facts: Map<string, ModelsDevFacts>;
  pricing: Map<string, ModelsDevPricing>;
  providers: Map<string, ModelsDevProvider>;
  /** 规范 id → 榜单键 → 该模型这一项的最佳自报成绩 */
  vendorBenchmarks: Map<string, Map<string, VendorBenchmark>>;
  /** api.json 里出现过的规范 id，用于「模型是否仍在上游列表中」的退役判定 */
  apiModelKeys: Set<string>;
  counts: {
    modelsJson: number;
    apiProviders: number;
    apiEntries: number;
    benchmarkEntries: number;
    /** 因血缘指向 Artificial Analysis 而被拦掉的条数 */
    benchmarkEntriesBlockedAA: number;
    /** 通过了合规但口径不是编程、因此没有进入契约的条数 */
    benchmarkEntriesOffTopic: number;
    benchmarkModels: number;
    /** 赛制 id → 落地的模型数 */
    benchmarkLeagueModels: Record<string, number>;
  };
}

export type BenchKey =
  | 'eci'
  | 'swe_bench_verified'
  | 'aime'
  | 'gpqa_diamond'
  | 'arc_agi_2'
  | 'fiction_live'
  | 'webdev_arena_elo';

/** Epoch 编程 CSV 里的一条成绩。量纲随值一起带，因为同一个 zip 里至少混着四种量纲。 */
export interface EpochCodingScore {
  league: string;
  score: number;
  unit: ScoreUnit;
  /** 原榜的官方链接（`*_external.csv` 是 Epoch 转载别人的榜，署名要给到原榜） */
  sourceUrl: string | null;
}

/**
 * zip 里一个榜单的解析结果与元信息，是 `WorldSnapshot.benchmarks[]` 的直接原料。
 *
 * 既覆盖手写规格的 7 + 10 个榜（`curated: true`），也覆盖按 `benchmark_metadata.csv`
 * 泛化接入的其余榜单。两者在这里长得一样，前端不必区分谁是手写的。
 */
export interface EpochLeagueInfo {
  league: string;
  fileName: string;
  /** 实际取分的列（手写规格的榜以规格为准，可能与 metadata 声明的不同） */
  scoreColumn: string;
  unit: ScoreUnit;
  /** 原始值乘这个数就是写进快照的分数：0–1 小数 → 100，0–100 → 1，Elo/时长/美元 → 1 */
  multiplier: number;
  /** 上游 `benchmark_metadata.csv` 的 benchmark 列原文，没有条目就是 null */
  upstreamName: string | null;
  inEci: boolean;
  /** 已换算到本站量纲（pct 的话是 0–100） */
  randomBaseline: number | null;
  scoreCeiling: number | null;
  releaseDate: string | null;
  /** 取代它的榜单的 league id；metadata 里写的是名字，这里已换算成 id */
  supersededBy: string | null;
  /** 文件名不带 `_external`、或有 Log viewer / Logs 列：Epoch 自己复跑的 */
  selfRun: boolean;
  /** 走的是手写规格（BENCHMARKS / CODING_BENCHMARKS）还是 metadata 泛化路径 */
  curated: boolean;
  rows: number;
  /** 有合法分数的行数（行数不是模型数，别拿它当分母） */
  scored: number;
  /** 换算后落在量纲合法区间之外、被丢弃的行数 */
  outOfRange: number;
}

export interface EpochAggregate {
  scores: Partial<Record<BenchKey, number>>;
  releaseDate: LooseDate | null;
  organization: string | null;
  country: string | null;
}

/**
 * 去重后的上游模型实体。一个真实模型一条，Epoch 那边的别名、
 * 带日期的快照版本、不同 reasoning effort 全部归到同一条。
 */
export interface EpochEntity {
  key: string;
  vendorId: string;
  /** 上游给的名字原文，只用于报告里的人工核对 */
  label: string;
  organization: string | null;
  /** 这个实体在哪些榜单上有分数 */
  benchmarks: BenchKey[];
  /** 上游标识里自己带了参数量标记（"Llama 3.1-405B"），不允许走去参数量兜底 */
  sized: boolean;
}

export interface EpochMatch {
  aggregate: EpochAggregate;
  /** 命中的别名键，用 aliasToEntity 可换算成去重后的实体 */
  aliasKey: string;
  tier: 'strict' | 'loose' | 'param-stripped';
}

export interface EpochResult {
  status: SourceStatus;
  /** 严格键：型号原文 / 模型名原文 */
  strict: Map<string, EpochAggregate>;
  /** 宽松键：逐级剥离日期戳与后缀之后的候选 */
  loose: Map<string, EpochAggregate>;
  /**
   * 只含「上游标识里不带参数量」的条目，供去参数量末级兜底使用。
   * 单独一份而不是复用 loose，是因为守卫必须在**上游那一侧**生效。
   */
  unsized: Map<string, EpochAggregate>;
  /**
   * `unsized` 里每个别名键被哪些上游实体注册过。
   * 超过一个就说明这个键上的聚合值是几代模型取 max 的结果，不能归给任何一个模型。
   */
  unsizedAliasOwners: Map<string, Set<string>>;
  /** 去重后的上游模型全集，同步报告的匹配率分母 */
  entities: Map<string, EpochEntity>;
  /**
   * 别名键 → 注册过它的全部实体键。
   * 一个键可能对应多个实体（"Gemini 3 Flash" 与 "gemini-3-flash-preview" 剥完后同键），
   * 只记第一个会让匹配率虚低。
   */
  aliasOwners: Map<string, Set<string>>;
  /** vendorId → 国家（ISO 3166-1 alpha-2），厂商注册表缺席时的兜底 */
  vendorCountry: Map<string, string>;
  /** 每个指标**有分数的 CSV 行数**。注意这是行数不是模型数，别拿它当分母。 */
  counts: Record<string, number>;
  /**
   * 编程 CSV 的索引，**与上面 strict/loose/unsized 三份分开**。
   * 混在一起会让只有编程分的键把 ECI 的匹配提前截断，详见 epoch.ts 的 mergeCodingInto。
   */
  codingStrict: Map<string, Record<string, EpochCodingScore>>;
  codingLoose: Map<string, Record<string, EpochCodingScore>>;
  codingUnsized: Map<string, Record<string, EpochCodingScore>>;
  /** 编程赛制 id → 有分数的 CSV 行数（同样是行数不是模型数） */
  codingCounts: Record<string, number>;
  /** 因血缘指向 AA / LMArena 而被整份丢弃的 zip 内文件 */
  blockedFiles: Array<{ file: string; reason: string }>;
  /** 命中血缘域名但按既有决定放行的文件，如实记录在同步报告里 */
  exemptFiles: Array<{ file: string; reason: string }>;
  /**
   * 泛化路径没能接入的 CSV 及理由（表头认不出分数列、量纲判不准、方向相反……）。
   * 写进同步报告，让下一个人知道这些文件被看过了。
   */
  skippedFiles: Array<{ file: string; reason: string }>;
  /** league id → 榜单解析结果与元信息，含手写规格的 17 个与泛化接入的其余榜单 */
  leagues: Record<string, EpochLeagueInfo>;
  /**
   * 泛化接入榜单的分数索引，与 coding* 三份**再分开一套**：
   * coding[] 契约要求「保持原样」，混进去会让非编程榜流进 coding[]。
   */
  leagueStrict: Map<string, Record<string, EpochCodingScore>>;
  leagueLoose: Map<string, Record<string, EpochCodingScore>>;
  leagueUnsized: Map<string, Record<string, EpochCodingScore>>;
  /**
   * `model_metadata.csv` 的训练算力（FLOP）索引，键同 strict / loose。
   * 同一个键被多条不同数值注册过的记 null——几代模型共用一个别名键时谁都不该拿。
   */
  trainingComputeStrict: Map<string, number | null>;
  trainingComputeLoose: Map<string, number | null>;
  /** model_metadata.csv 里 training_compute_flop 非空的行数 */
  trainingComputeRows: number;
}

/** 网关源自报的元数据事实，只在 models.dev 缺项时兜底使用。 */
export interface GatewayFacts {
  /** 已归一到美元 / 百万 token，非法值（0、负数）已清成 null */
  inputPerMTok: number | null;
  outputPerMTok: number | null;
  cachedInputPerMTok: number | null;
  contextWindow: number | null;
  maxOutput: number | null;
  modalities: { input: string[]; output: string[] };
}

export interface GatewayModel {
  id: string;
  vendorId: string;
  modelSlug: string;
  releaseDate: LooseDate | null;
  /** 该源自报的名字，仅用于日志与人工排查，不写进 data/models.json */
  upstreamName: string | null;
  facts: GatewayFacts;
}

export interface GatewayResult {
  status: SourceStatus;
  models: Map<string, GatewayModel>;
  counts: Record<string, number>;
}

/** LiteLLM 里一条对话类模型的事实。同一个型号在几十个托管商下各有一条，匹配时要看 vendorId。 */
export interface LiteLlmEntry {
  key: string;
  /** litellm_provider 归一成的规范 vendorId；托管商（bedrock / azure / fireworks……）为 null */
  vendorId: string | null;
  facts: GatewayFacts;
}

export interface LiteLlmResult {
  status: SourceStatus;
  /** 只保留去掉分隔符的型号片段，用于「这个模型是否被第三个源佐证」 */
  bareSlugs: Set<string>;
  /** 去分隔符的型号片段 → 该型号在各 provider 下的条目，供定价 / 上下文兜底 */
  byBareSlug: Map<string, LiteLlmEntry[]>;
  counts: Record<string, number>;
}

export interface HuggingFaceFacts {
  repo: string;
  totalB: number | null;
  activeB: number | null;
  licenseRaw: string | null;
}

export interface HuggingFaceResult {
  status: SourceStatus;
  byModelId: Map<string, HuggingFaceFacts>;
  counts: Record<string, number>;
}

/** LiveBench 的一条分组成绩。分数一律是 0–100 的百分数。 */
export interface LiveBenchScore {
  league: string;
  score: number;
  /** 这个分数来自哪个 release，同期内也如实记着，便于人工核对 */
  release: string;
  /** 上游的原始模型名（带 effort 后缀），只用于排查 */
  upstreamModel: string;
  sourceUrl: string;
  /**
   * 是否属于「编程口径」，决定这条成绩进 `coding[]` 还是只进 `scores[]`。
   *
   * v1 只有 Coding / Agentic Coding 两组，全部为 true；LiveBench 2.0 改成七类长程任务，
   * 其中 Research / Design / Browser 这些量与「会不会写代码」无关，塞进 coding[]
   * 会污染编程档位与卡片上那一行标签，所以逐条标记而不是按来源一刀切。
   */
  coding: boolean;
}

export interface LiveBenchResult {
  status: SourceStatus;
  /** 剥掉 effort 后缀的模型名 → 该模型的分组成绩。**没有厂商列，只能按型号名匹配。** */
  byModel: Map<string, LiveBenchScore[]>;
  counts: Record<string, number>;
  releasesUsed: string[];
  /** 因题目集换代而不采用的 release */
  releasesSkipped: string[];
  releaseSource: string;
  /** LiveBench 2.0 采用的 release id（`YYYYMMDD`）。走 v1 或两条都没抓到时为 null。 */
  v2Release: string | null;
}
