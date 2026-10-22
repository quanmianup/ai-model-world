import { DISCOVERY_MIN_SOURCES } from '../config';
import {
  alnum,
  displayNameFromSlug,
  paramStrippedVariants,
  slugVariants,
  toSlug,
} from '../lib/ids';
import { log } from '../lib/log';
import {
  arenaMatchCandidates,
  indexArenaScores,
  lookupArenaScores,
  type ArenaResult,
} from '../sources/lmarena';
import {
  epochBenchKeys,
  lookupEpoch,
  lookupEpochCoding,
  lookupEpochLeagueScores,
  lookupEpochParamStripped,
  lookupEpochTrainingCompute,
} from '../sources/epoch';
import { pickLiteLlmField, pickLiteLlmModalities } from '../sources/litellm';
import { codingLeagueRank } from '../sources/models-dev';
import type {
  EpochResult,
  GatewayFacts,
  GatewayModel,
  GatewayResult,
  HuggingFaceResult,
  LiteLlmEntry,
  LiteLlmResult,
  LiveBenchResult,
  ModelsDevResult,
  VendorBenchmark,
} from '../sources/types';
import { normalizeLicense } from './license';
import { resolveParams } from './params';
import { arbitrateReleaseDate, type DateCandidate } from './release-date';
import {
  FALLBACK_ACCENT,
  isRegisteredVendor,
  lookupVendorProfile,
  type LoadedRegistry,
} from './vendor-registry';
import type {
  BenchmarkMeta,
  Benchmarks,
  BenchmarkScore,
  Modality,
  ModelRecord,
  SourceId,
  Vendor,
  WorldSnapshot,
} from '../../../src/lib/types';

/**
 * Epoch AI 的成绩没有逐模型的深链，CC-BY 4.0 要求的署名 URL 就是这个检索地址。
 * 这不是编造的链接——它正是 data/raw/epoch.ai.json 里记录的引用出处。
 */
const EPOCH_CITATION_URL = 'https://epoch.ai/benchmarks';

const MODALITIES: ReadonlySet<string> = new Set(['text', 'image', 'audio', 'video', 'pdf']);

function asModalities(list: string[]): Modality[] {
  return [...new Set(list.filter((m) => MODALITIES.has(m)) as Modality[])].sort();
}

export interface BuildInput {
  runIso: string;
  runDate: string;
  modelsDev: ModelsDevResult;
  epoch: EpochResult;
  openrouter: GatewayResult;
  vercel: GatewayResult;
  litellm: LiteLlmResult;
  huggingface: HuggingFaceResult;
  livebench: LiveBenchResult;
  lmarena: ArenaResult;
  registry: LoadedRegistry;
  previous: WorldSnapshot | null;
}

/** 编程赛制的落地情况，写进同步报告。 */
export interface CodingCoverage {
  /** 至少有一条编程成绩的模型数（存活模型口径） */
  modelsWithAny: number;
  liveModels: number;
  /** 只有 Elo、没有任何百分数成绩的模型数——它们能排名但读不出「解决了几成任务」 */
  modelsOnlyElo: number;
  /** 赛制 id → 落地模型数 */
  byLeague: Record<string, number>;
  byAttribution: Record<string, number>;
  byUnit: Record<string, number>;
  /**
   * 广场首屏「当家门面」的编程命中率。全站覆盖率会被长尾微调模型稀释，
   * 而用户真正看到的是这几十间屋子里有几张桌子摆着电脑。
   * 取不到时为 null（选拔规则住在前端的 src/lib/roster.ts，那边改了签名这里不该把管线拖崩）。
   */
  flagship: {
    total: number;
    withAnyCoding: number;
    withPercentCoding: number;
    /** 仍然没有任何编程成绩的门面，如实列出来 */
    without: string[];
  } | null;
}

/** Epoch 的「上游有多少 / 我们接住多少」——分母是去重后的模型实体，不是 CSV 行数。 */
export interface EpochMatchStats {
  upstreamEntities: number;
  matchedEntities: number;
  matchTiers: Record<string, number>;
  byBenchmark: Record<
    string,
    { upstreamRows: number; upstreamModels: number; matchedModels: number; landedModels: number }
  >;
  /** 没接住的上游实体样例，按榜单数降序，便于人工判断是归一化问题还是压根不在我们的模型全集里 */
  unmatchedSamples: Array<{ key: string; label: string; organization: string | null; benchmarks: string[] }>;
}

/** models.dev 缺项时兜底源的贡献。before / after 是存活模型口径的覆盖数。 */
export interface FallbackCoverage {
  liveModels: number;
  before: Record<string, number>;
  after: Record<string, number>;
  /** 字段 → 兜底源 → 该源补上的模型数 */
  bySource: Record<string, Record<string, number>>;
}

/** 训练算力的落地情况。闭源旗舰是这项数据存在的理由，单独数一遍。 */
export interface TrainingComputeCoverage {
  liveModels: number;
  withFlop: number;
  /** openai / anthropic / google / xai 里有 ECI 的模型 */
  closedFlagships: { total: number; withFlop: number; without: string[] };
}

export interface BuildOutput {
  models: ModelRecord[];
  vendors: Vendor[];
  /** 本快照涉及的全部榜单元信息，只列至少有一个模型命中的 */
  benchmarks: BenchmarkMeta[];
  sizeTiers: Record<string, { tier: number; basis: string }>;
  /** 每个自报成绩的归属来源，供前端生成「厂商自报（来源：xxx）」的悬停文案 */
  benchmarkAttribution: Record<string, Record<string, VendorBenchmark>>;
  pendingDiscoveries: Array<{ id: string; sources: string[] }>;
  /** 走「注册厂商单源快速晋升」进来的模型 id（不在 models.dev、只有一个网关源） */
  quickPromoted: string[];
  codingCoverage: CodingCoverage;
  epochMatch: EpochMatchStats;
  fallbackCoverage: FallbackCoverage;
  trainingCompute: TrainingComputeCoverage;
  /** scores[] 里每个 league 落地的模型数（全部模型口径，与 benchmarks[].models 一致） */
  leagueLanding: Record<string, number>;
  /** LiveBench 的匹配情况。它没有厂商列，只能按型号名匹配，所以单独记一笔。 */
  liveBenchMatch: {
    upstreamModelNames: number;
    matchedModels: number;
    unmatchedSamples: string[];
  };
  stats: {
    fromModelsDev: number;
    promotedDiscoveries: number;
    /** promotedDiscoveries 里走「注册厂商单源快速晋升」的那部分 */
    quickPromotedDiscoveries: number;
    pendingDiscoveries: number;
    retiredThisRun: number;
    retiredTotal: number;
    resurrected: number;
    releaseDateOutliersDropped: number;
    /** 走「去参数量」末级兜底才接上 Epoch 的模型数 */
    epochParamStrippedMatches: number;
  };
}

interface Candidate {
  id: string;
  vendorId: string;
  modelSlug: string;
  inModelsDev: boolean;
  inOpenRouter: boolean;
  inVercel: boolean;
  inLiteLlm: boolean;
  openrouter: GatewayModel | null;
  vercel: GatewayModel | null;
}

/**
 * 非 models.dev 模型能不能进快照。
 *
 * 常规门槛是 ≥ DISCOVERY_MIN_SOURCES 个独立源（网关别名与社区微调多半只在一处出现）。
 * 例外：**厂商已在 src/data/vendor-registry.ts 登记**的，openrouter 或 vercel-gateway
 * 任一源收录即晋升——大厂新模型上线当天往往只有一家网关跟上，等第二家要拖一两天，
 * 而「一眼看懂当下格局」最怕的就是这一两天。LiteLLM 不算：它只按型号片段匹配、没有厂商列，
 * 单独一条不足以证明「这是 xx 家的新模型」。
 */
export function shouldPromoteDiscovery(input: {
  inModelsDev: boolean;
  sources: string[];
  vendorRegistered: boolean;
  /** 剥掉服务档位后缀后撞上了已有模型（gpt-5-fast → gpt-5），见 SERVICE_TIER_SUFFIXES */
  serviceTierAlias: boolean;
}): { promote: boolean; via: 'models.dev' | 'multi-source' | 'registered-vendor' | null } {
  if (input.inModelsDev) return { promote: true, via: 'models.dev' };
  if (input.sources.length >= DISCOVERY_MIN_SOURCES) return { promote: true, via: 'multi-source' };
  if (
    input.vendorRegistered &&
    !input.serviceTierAlias &&
    input.sources.some((s) => s === 'openrouter' || s === 'vercel-gateway')
  ) {
    return { promote: true, via: 'registered-vendor' };
  }
  return { promote: false, via: null };
}

/**
 * 网关的服务档位别名：Vercel 把优先处理档叫 `gpt-5-fast`、免费档叫 `minimax-m3-free`，
 * OpenRouter 有 `-flex` / `-priority` / `-batch`，还把 reasoning effort 拆成 `o4-mini-high` 这种条目。
 * 它们不是新模型，只是同一个模型的另一种计费或另一档推理强度。
 * 单源快速晋升第一次实跑时 62 个「新模型」里 30 个是这种别名——所以这一道守卫不可少。
 * 只约束快速晋升：多源佐证的照旧（那条规则的口径本来就是「两个独立目录都认它是一个条目」）。
 * 刻意不收 `-medium`（mistral-medium 是真型号）与 `-pro`（gpt-5-pro 是真型号）。
 */
export const SERVICE_TIER_SUFFIXES = ['-fast', '-free', '-flex', '-priority', '-batch', '-xhigh', '-high', '-low'];

export function stripServiceTierSuffix(modelSlug: string): string | null {
  for (const suffix of SERVICE_TIER_SUFFIXES) {
    if (modelSlug.endsWith(suffix) && modelSlug.length > suffix.length) {
      return modelSlug.slice(0, -suffix.length);
    }
  }
  return null;
}

export async function buildSnapshot(input: BuildInput): Promise<BuildOutput> {
  const {
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
  } = input;

  const prevModels = new Map((previous?.models ?? []).map((m) => [m.id, m]));

  // ── 1. 组装模型全集 ────────────────────────────────────────────────
  // 各源的分隔符习惯不同：models.dev 写 `seed-1-6-flash`、OpenRouter 写 `seed-1.6-flash`、
  // Vercel 写 `qwen-3-14b` 而 models.dev 写 `qwen3-14b`。
  // 合并键抹掉所有非字母数字字符，但只做「完全相同」的合并——
  // 再宽一点（比如连 -instruct / -2507 后缀一起剥）就会把 models.dev 里本就并列的两个模型合成一个。
  const candidates = new Map<string, Candidate>();
  const keyToId = new Map<string, string>();
  const mergeKey = (vendorId: string, modelSlug: string) => `${vendorId}|${alnum(modelSlug)}`;

  const ensure = (id: string, vendorId: string, modelSlug: string): Candidate => {
    const key = mergeKey(vendorId, modelSlug);
    const existingId = keyToId.get(key);
    if (existingId) return candidates.get(existingId)!;
    const created: Candidate = {
      id,
      vendorId,
      modelSlug,
      inModelsDev: false,
      inOpenRouter: false,
      inVercel: false,
      inLiteLlm: false,
      openrouter: null,
      vercel: null,
    };
    candidates.set(id, created);
    keyToId.set(key, id);
    return created;
  };

  const sortedById = <T extends { id: string }>(items: Iterable<T>): T[] =>
    [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // models.dev 先进，保证规范 id 以主源的写法为准。
  for (const fact of sortedById(modelsDev.facts.values())) {
    ensure(fact.id, fact.vendorId, fact.modelSlug).inModelsDev = true;
  }
  for (const m of sortedById(openrouter.models.values())) {
    const c = ensure(m.id, m.vendorId, m.modelSlug);
    c.inOpenRouter = true;
    c.openrouter ??= m;
  }
  for (const m of sortedById(vercel.models.values())) {
    const c = ensure(m.id, m.vendorId, m.modelSlug);
    c.inVercel = true;
    c.vercel ??= m;
  }
  for (const c of candidates.values()) {
    const variants = slugVariants(c.modelSlug);
    c.inLiteLlm = variants.some((v) => litellm.bareSlugs.has(v));
  }

  // models.dev 之外的模型需要至少两个独立源佐证才进入快照；
  // 已登记厂商的例外见 shouldPromoteDiscovery。
  // 单源发现（常见于社区微调与网关别名）先进待定队列，等到被第二个源收录再晋升。
  const promoted: Candidate[] = [];
  const pending: Array<{ id: string; sources: string[] }> = [];
  const quickPromoted: string[] = [];
  for (const c of [...candidates.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const sources: string[] = [];
    if (c.inOpenRouter) sources.push('openrouter');
    if (c.inVercel) sources.push('vercel-gateway');
    if (c.inLiteLlm) sources.push('litellm');
    const baseSlug = stripServiceTierSuffix(c.modelSlug);
    const verdict = shouldPromoteDiscovery({
      inModelsDev: c.inModelsDev,
      sources,
      vendorRegistered: isRegisteredVendor(registry, c.vendorId),
      serviceTierAlias: baseSlug !== null && keyToId.has(mergeKey(c.vendorId, baseSlug)),
    });
    if (verdict.promote) {
      promoted.push(c);
      if (verdict.via === 'registered-vendor') quickPromoted.push(c.id);
    } else {
      pending.push({ id: c.id, sources });
    }
  }

  // ── 2. 逐字段仲裁 ──────────────────────────────────────────────────
  const models: ModelRecord[] = [];
  const sizeTiers: Record<string, { tier: number; basis: string }> = {};
  const benchmarkAttribution: Record<string, Record<string, VendorBenchmark>> = {};
  let outliersDropped = 0;
  let resurrected = 0;

  /**
   * 「去参数量」兜底的第二道守卫：同一厂商里有多个模型剥完参数量撞在同一个键上时，
   * 这个键作废。`meta|llama31` 同时对应 llama-3.1-70b 和 llama-3.1-8b，
   * 谁先查到就把分数据为己有，那是纯粹的运气，不是匹配。
   */
  const paramStrippedOwners = new Map<string, Set<string>>();
  for (const c of promoted) {
    const md = modelsDev.facts.get(c.id) ?? null;
    for (const basis of [c.modelSlug, md?.name ?? '']) {
      if (!basis) continue;
      for (const v of paramStrippedVariants(basis)) {
        const key = `${c.vendorId}|${v}`;
        const owners = paramStrippedOwners.get(key) ?? new Set<string>();
        owners.add(c.id);
        paramStrippedOwners.set(key, owners);
      }
    }
  }

  /**
   * LiveBench 的匹配索引。
   *
   * **它是唯一一个没有厂商列的源**——CSV 第一列只有型号名（`gpt-5.4-xhigh`），
   * 没有 organization。所以只能按型号名匹配，其他源用的 `vendorId|slug` 复合键在这里用不了。
   *
   * 两级索引，缺一不可：
   *   `exact`  型号名归一后**完全等于**某个模型的 id 或展示名。
   *   `ladder` 逐级剥离后缀之后的宽松候选，只在**唯一命中**时才采信。
   *
   * 为什么必须有 exact 这一级：我们目录里有大量同族模型（`gpt-5.1`、`gpt-5.1-chat-latest`、
   * `gpt-5.1-thinking`）剥完后缀之后都落到 `gpt51` 这个键上。只有 ladder 的话它是「歧义」，
   * 于是 GPT-5.1 这种主力型号一个都匹配不上；而 exact 一眼就能认出
   * `gpt-5.1` 才是那个基座模型——它的 id 归一后**恰好就是** `gpt51`。
   */
  //   匹配分三级，优先级即可信度：
  //     1) 型号名级：上游型号名归一后**完全等于**某个模型的 id 片段（`claude-haiku-4-5`）。
  //        这是最硬的证据——它认的是「型号本身」。
  //     2) 展示名级：等于某个模型的展示名（`Claude Haiku 4.5`）。它认的是「厂商怎么写它」，
  //        会和别人的型号名撞键，所以只能排第二。
  //     3) ladder：逐级剥后缀后的宽松候选，只在唯一命中时采信。
  //
  //   为什么 1 和 2 必须分开：`anthropic/claude-haiku-4-5`（基座，展示名带 "(latest)"）
  //   和 `anthropic/claude-haiku-4-5-20251001`（日期戳快照，展示名就叫 "Claude Haiku 4.5"）
  //   撞在同一个键上——快照的**展示名**正好等于基座的**型号名**。合成一张表时，
  //   这个键会被当成「两人同名」而整个丢掉，于是 LiveBench 的 claude-haiku-4.5 谁都匹配不上。
  //   分开建表后，型号名级认基座（id 就是这个型号），展示名级认快照。
  const liveBenchExactById = new Map<string, string>();
  const liveBenchExactByIdDupes = new Set<string>();
  const liveBenchExactByName = new Map<string, string>();
  const liveBenchExactByNameDupes = new Set<string>();
  const liveBenchLadder = new Map<string, Set<string>>();
  for (const c of promoted) {
    const md = modelsDev.facts.get(c.id) ?? null;
    for (const [basis, exact, dupes] of [
      [c.modelSlug, liveBenchExactById, liveBenchExactByIdDupes],
      [md?.name ?? '', liveBenchExactByName, liveBenchExactByNameDupes],
    ] as const) {
      if (!basis) continue;
      const variants = slugVariants(basis);
      const head = variants[0];
      if (head) {
        if (exact.has(head) && exact.get(head) !== c.id) {
          dupes.add(head);
        } else {
          exact.set(head, c.id);
        }
      }
      for (const v of variants) {
        const owners = liveBenchLadder.get(v) ?? new Set<string>();
        owners.add(c.id);
        liveBenchLadder.set(v, owners);
      }
    }
  }
  for (const dupe of liveBenchExactByIdDupes) liveBenchExactById.delete(dupe);
  for (const dupe of liveBenchExactByNameDupes) liveBenchExactByName.delete(dupe);

  const lookupLiveBench = (slug: string): string | null => {
    for (const v of slugVariants(slug)) {
      const exact = liveBenchExactById.get(v) ?? liveBenchExactByName.get(v);
      if (exact) return exact;
      const owners = liveBenchLadder.get(v);
      if (owners?.size === 1) return [...owners][0];
    }
    return null;
  };

  const liveBenchByModelId = new Map<string, LiveBenchResult['byModel'] extends Map<string, infer V> ? V : never>();
  const liveBenchUnmatchedNames: string[] = [];
  for (const [slug, scores] of livebench.byModel) {
    const id = lookupLiveBench(slug);
    if (!id) {
      liveBenchUnmatchedNames.push(slug);
      continue;
    }
    // 多个上游名字归到同一个模型时（`kimi-k2` 与 `kimi-k2-instruct`），
    // 先到先得；上游遍历顺序由 Map 插入顺序决定，而那是 release 降序，即优先最新。
    if (!liveBenchByModelId.has(id)) liveBenchByModelId.set(id, scores);
  }

  /** 竞技场分的索引与命中记录，后者用于同步报告里的覆盖统计 */
  const arenaByKey = indexArenaScores(lmarena.scores);
  const arenaMatchedLeagues = new Set<string>();

  const matchedEpochEntities = new Set<string>();
  const matchTiers: Record<string, number> = {};
  let paramStrippedMatches = 0;

  // 兜底源的账本：哪个字段被哪个源补了多少次，以及只认 models.dev 时的覆盖数（对比用）。
  const fallbackBefore: Record<string, number> = {
    'pricing.inputPerMTok': 0,
    'pricing.outputPerMTok': 0,
    contextWindow: 0,
    maxOutput: 0,
    modalities: 0,
  };
  const fallbackBySource: Record<string, Record<string, number>> = {};
  const bumpFallback = (field: string, source: SourceId): void => {
    const bucket = fallbackBySource[field] ?? {};
    bucket[source] = (bucket[source] ?? 0) + 1;
    fallbackBySource[field] = bucket;
  };

  for (const c of promoted) {
    const md = modelsDev.facts.get(c.id) ?? null;
    const or = c.openrouter;
    const vc = c.vercel;
    const provenance: Partial<Record<string, SourceId>> = {};

    const epochSlugCandidates = [
      ...slugVariants(c.modelSlug),
      ...(md ? slugVariants(md.name) : []),
    ];
    // 末级兜底用的候选：Epoch 用营销名（"Nemotron 3 Ultra"）而我们用带权重的完整 slug
    // （nemotron-3-ultra-550b-a55b）时，常规阶梯剥不掉参数量。两道守卫见 lib/ids.ts。
    const epochStrippedCandidates = [
      ...paramStrippedVariants(c.modelSlug),
      ...(md ? paramStrippedVariants(md.name) : []),
    ].filter((v) => (paramStrippedOwners.get(`${c.vendorId}|${v}`)?.size ?? 0) === 1);

    let epochMatch = lookupEpoch(epoch, c.vendorId, epochSlugCandidates);
    if (!epochMatch) {
      epochMatch = lookupEpochParamStripped(epoch, c.vendorId, epochStrippedCandidates);
      if (epochMatch) paramStrippedMatches += 1;
    }
    const epochCoding = lookupEpochCoding(
      epoch,
      c.vendorId,
      epochSlugCandidates,
      epochStrippedCandidates,
    );
    const epochHit = epochMatch?.aggregate ?? null;
    if (epochMatch) {
      matchTiers[epochMatch.tier] = (matchTiers[epochMatch.tier] ?? 0) + 1;
      for (const entityKey of epoch.aliasOwners.get(epochMatch.aliasKey) ?? []) {
        matchedEpochEntities.add(entityKey);
      }
    }

    // 发布日期：models.dev → Epoch → Vercel released → OpenRouter created，取 min + 60 天护栏
    const dateCandidates: DateCandidate[] = [];
    if (md?.releaseDate) {
      dateCandidates.push({ source: 'models.dev', value: md.releaseDate, anchor: true });
    }
    if (epochHit?.releaseDate) {
      dateCandidates.push({ source: 'epoch.ai', value: epochHit.releaseDate, anchor: true });
    }
    if (vc?.releaseDate) {
      dateCandidates.push({ source: 'vercel-gateway', value: vc.releaseDate, anchor: false });
    }
    if (or?.releaseDate) {
      dateCandidates.push({ source: 'openrouter', value: or.releaseDate, anchor: false });
    }
    const verdict = arbitrateReleaseDate(dateCandidates);
    if (verdict) {
      provenance.releaseDate = verdict.source;
      provenance.releaseDatePrecision = verdict.source;
      outliersDropped += verdict.candidates.filter((x) => x.dropped).length;
    }

    // ── 上下文 / 最大输出 / 模态 / 定价：models.dev 为主，缺项时按 docs/DATA.md 的仲裁表兜底 ──
    // 定价     models.dev → LiteLLM → OpenRouter → Vercel
    // 上下文   models.dev → OpenRouter → Vercel → LiteLLM
    // 模态     models.dev → OpenRouter → Vercel → LiteLLM
    // 兜底是「第一个有值的源」而不是取并集/众数：并集会把 OpenRouter 某个托管商开放的模态
    // 记到模型头上，众数在只有两个源时没有意义。每个字段各自写 provenance。
    const litellmEntries: LiteLlmEntry[] =
      slugVariants(c.modelSlug)
        .map((v) => litellm.byBareSlug.get(v))
        .find((list): list is LiteLlmEntry[] => Boolean(list && list.length > 0)) ?? [];
    const gatewayFacts = (m: GatewayModel | null): GatewayFacts | null => m?.facts ?? null;
    const orFacts = gatewayFacts(or);
    const vcFacts = gatewayFacts(vc);

    type ScalarField = 'inputPerMTok' | 'outputPerMTok' | 'cachedInputPerMTok' | 'contextWindow' | 'maxOutput';
    const fromLiteLlm = (field: ScalarField): number | null =>
      litellmEntries.length > 0 ? pickLiteLlmField(litellmEntries, c.vendorId, field) : null;
    /** 依次问各源，第一个非 null 的胜出，并记下是谁给的。 */
    const firstOf = (
      primary: number | null | undefined,
      chain: Array<[SourceId, () => number | null]>,
    ): { value: number | null; source: SourceId | null } => {
      if (primary !== null && primary !== undefined) return { value: primary, source: 'models.dev' };
      for (const [source, get] of chain) {
        const v = get();
        if (v !== null) return { value: v, source };
      }
      return { value: null, source: null };
    };

    const ctx = firstOf(md?.contextWindow, [
      ['openrouter', () => orFacts?.contextWindow ?? null],
      ['vercel-gateway', () => vcFacts?.contextWindow ?? null],
      ['litellm', () => fromLiteLlm('contextWindow')],
    ]);
    const contextWindow = ctx.value;
    if (ctx.source) provenance.contextWindow = ctx.source;
    if (ctx.source && ctx.source !== 'models.dev') bumpFallback('contextWindow', ctx.source);

    const maxOut = firstOf(md?.maxOutput, [
      ['openrouter', () => orFacts?.maxOutput ?? null],
      ['vercel-gateway', () => vcFacts?.maxOutput ?? null],
      ['litellm', () => fromLiteLlm('maxOutput')],
    ]);
    const maxOutput = maxOut.value;
    if (maxOut.source) provenance.maxOutput = maxOut.source;
    if (maxOut.source && maxOut.source !== 'models.dev') bumpFallback('maxOutput', maxOut.source);

    let inputModalities = asModalities(md?.modalities.input ?? []);
    let outputModalities = asModalities(md?.modalities.output ?? []);
    if (inputModalities.length || outputModalities.length) {
      provenance.modalities = 'models.dev';
    } else {
      const modalityChain: Array<[SourceId, { input: string[]; output: string[] } | null]> = [
        ['openrouter', orFacts?.modalities ?? null],
        ['vercel-gateway', vcFacts?.modalities ?? null],
        ['litellm', litellmEntries.length > 0 ? pickLiteLlmModalities(litellmEntries, c.vendorId) : null],
      ];
      for (const [source, m] of modalityChain) {
        if (!m) continue;
        const inp = asModalities(m.input);
        const outp = asModalities(m.output);
        if (inp.length === 0 && outp.length === 0) continue;
        inputModalities = inp;
        outputModalities = outp;
        provenance.modalities = source;
        bumpFallback('modalities', source);
        break;
      }
    }

    const mdPricing = modelsDev.pricing.get(c.id) ?? null;
    const priceIn = firstOf(mdPricing?.inputPerMTok, [
      ['litellm', () => fromLiteLlm('inputPerMTok')],
      ['openrouter', () => orFacts?.inputPerMTok ?? null],
      ['vercel-gateway', () => vcFacts?.inputPerMTok ?? null],
    ]);
    const priceOut = firstOf(mdPricing?.outputPerMTok, [
      ['litellm', () => fromLiteLlm('outputPerMTok')],
      ['openrouter', () => orFacts?.outputPerMTok ?? null],
      ['vercel-gateway', () => vcFacts?.outputPerMTok ?? null],
    ]);
    const priceCached = firstOf(mdPricing?.cachedInputPerMTok, [
      ['litellm', () => fromLiteLlm('cachedInputPerMTok')],
      ['openrouter', () => orFacts?.cachedInputPerMTok ?? null],
      ['vercel-gateway', () => vcFacts?.cachedInputPerMTok ?? null],
    ]);
    const pricing = {
      inputPerMTok: priceIn.value,
      outputPerMTok: priceOut.value,
      cachedInputPerMTok: priceCached.value,
    };
    if (priceIn.source) provenance['pricing.inputPerMTok'] = priceIn.source;
    if (priceOut.source) provenance['pricing.outputPerMTok'] = priceOut.source;
    if (priceCached.source) provenance['pricing.cachedInputPerMTok'] = priceCached.source;
    for (const [field, verdictOf] of [
      ['pricing.inputPerMTok', priceIn],
      ['pricing.outputPerMTok', priceOut],
      ['pricing.cachedInputPerMTok', priceCached],
    ] as const) {
      if (verdictOf.source && verdictOf.source !== 'models.dev') bumpFallback(field, verdictOf.source);
    }
    // 覆盖率前后对比的「前」：只认 models.dev 时这一项有没有值
    if (mdPricing?.outputPerMTok != null) fallbackBefore['pricing.outputPerMTok'] += 1;
    if (mdPricing?.inputPerMTok != null) fallbackBefore['pricing.inputPerMTok'] += 1;
    if (md?.contextWindow != null) fallbackBefore.contextWindow += 1;
    if (md?.maxOutput != null) fallbackBefore.maxOutput += 1;
    if ((md?.modalities.input.length ?? 0) > 0) fallbackBefore.modalities += 1;

    if (md?.toolCall !== null && md?.toolCall !== undefined) provenance['capabilities.toolCall'] = 'models.dev';
    if (md?.reasoning !== null && md?.reasoning !== undefined) provenance['capabilities.reasoning'] = 'models.dev';
    if (md?.structuredOutput !== null && md?.structuredOutput !== undefined) {
      provenance['capabilities.structuredOutput'] = 'models.dev';
    }
    // 有任何一项报价才谈得上「有没有缓存价」；一项报价都没有时是 null 而不是 false。
    const hasAnyPrice =
      pricing.inputPerMTok !== null || pricing.outputPerMTok !== null || pricing.cachedInputPerMTok !== null;
    const promptCaching = hasAnyPrice ? pricing.cachedInputPerMTok !== null : null;
    if (promptCaching !== null) provenance['capabilities.promptCaching'] = 'derived';

    if (md?.openWeights !== null && md?.openWeights !== undefined) provenance.openWeights = 'models.dev';

    // 许可证：HF cardData.license → models.dev license，都归一到 SPDX，判不出就是 null
    const hf = huggingface.byModelId.get(c.id) ?? null;
    let license = normalizeLicense(hf?.licenseRaw ?? null);
    if (license) provenance.license = 'huggingface';
    else {
      license = normalizeLicense(md?.licenseRaw ?? null);
      if (license) provenance.license = 'models.dev';
    }

    // 参数量双轨：开源走 HF 精确值，闭源只给 1–5 档规模推定，绝不编造数字
    const resolved = resolveParams({
      modelSlug: c.modelSlug,
      hfTotalB: hf?.totalB ?? null,
      hfActiveB: hf?.activeB ?? null,
      openWeights: md?.openWeights ?? null,
      outputPerMTok: pricing?.outputPerMTok ?? null,
    });
    if (resolved.totalSource) provenance['params.totalB'] = resolved.totalSource;
    if (resolved.activeSource) provenance['params.activeB'] = resolved.activeSource;
    if (resolved.tier) {
      sizeTiers[c.id] = { tier: resolved.tier.tier, basis: resolved.tier.basis };
      provenance['params.sizeTier'] = 'derived';
    }

    const benchmarks: Benchmarks = {
      eci: null,
      swe_bench_verified: null,
      swe_bench_vendor: null,
      swe_bench_pro: null,
      aime: null,
      gpqa_diamond: null,
      arc_agi_2: null,
      fiction_live: null,
      webdev_arena_elo: null,
    };
    if (epochHit) {
      for (const key of epochBenchKeys()) {
        const v = epochHit.scores[key];
        if (v !== undefined) {
          benchmarks[key] = v;
          provenance[`benchmarks.${key}`] = 'epoch.ai';
        }
      }
    }

    // 厂商/榜单自报成绩单独占列，永远不与 Epoch 复跑的分数混算。
    // provenance 里标 'models.dev'（而非 'epoch.ai'）就是前端判断
    // 「屏幕发不发光」的依据，别把这两列的 provenance 写成同一个值。
    const vendorBench = modelsDev.vendorBenchmarks.get(c.id);
    if (vendorBench) {
      const sweVendor = vendorBench.get('swe_bench_verified');
      if (sweVendor) {
        benchmarks.swe_bench_vendor = sweVendor.score;
        provenance['benchmarks.swe_bench_vendor'] = 'models.dev';
      }
      const swePro = vendorBench.get('swe_bench_pro');
      if (swePro) {
        benchmarks.swe_bench_pro = swePro.score;
        provenance['benchmarks.swe_bench_pro'] = 'models.dev';
      }
      const attributed: Record<string, VendorBenchmark> = {};
      for (const [key, entry] of [...vendorBench.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
        attributed[key] = entry;
      }
      if (Object.keys(attributed).length > 0) benchmarkAttribution[c.id] = attributed;
    }

    /**
     * 编程能力的全部可用成绩，一个赛制一条。
     *
     * 这个数组是 benchmarks.swe_bench_* 三列的**超集**，不是替代品——旧的排行榜逻辑还在读那三列。
     * 排序按赛制可信度（CODING_LEAGUE_ORDER），前端可以直接取 coding[0]；
     * 跨赛制的分位数计算靠 league + unit 两个字段在结构上被隔开，
     * 百分数与 Elo 从此不可能相遇（docs/HANDOFF.md 4.4）。
     */
    const coding: BenchmarkScore[] = [];
    const seenLeagues = new Set<string>();
    const pushCoding = (score: BenchmarkScore): void => {
      // 一个赛制只留一条。models.dev 那边的多条已经在 parseVendorBenchmarks 里择优过了，
      // 这里兜住的是「Epoch 与 models.dev 撞上同一个赛制」——Epoch 是统一复跑，优先。
      if (seenLeagues.has(score.league)) return;
      seenLeagues.add(score.league);
      coding.push(score);
    };

    if (benchmarks.swe_bench_verified !== null) {
      pushCoding({
        league: 'swe_bench_verified',
        score: benchmarks.swe_bench_verified,
        unit: 'pct',
        attribution: 'third-party',
        source: 'epoch.ai',
        sourceUrl: EPOCH_CITATION_URL,
      });
    }
    if (benchmarks.webdev_arena_elo !== null) {
      // Elo 不是百分数。它能回答「谁更强」，回答不了「解决了几成任务」，
      // unit 字段就是为了让这两种分数在前端也不可能被放进同一个分位池。
      //
      // 这一条的上游是 LMArena，合规依据是「消费 Epoch 的 CC-BY 再分发」而非直接抓取，
      // 详见 lib/compliance.ts 的 EPOCH_LMARENA_EXEMPT_FILES。署名给 Epoch。
      pushCoding({
        league: 'webdev_arena_elo',
        score: benchmarks.webdev_arena_elo,
        unit: 'elo',
        attribution: 'third-party',
        source: 'epoch.ai',
        sourceUrl: EPOCH_CITATION_URL,
      });
    }
    // Epoch 的编程 CSV。它们排在 models.dev 之前入列，于是同一个赛制两边都有时
    // Epoch 胜出——Epoch 是把各官方榜统一收录整理，比厂商自己在系统卡里报的可信。
    for (const entry of Object.values(epochCoding)) {
      pushCoding({
        league: entry.league,
        score: entry.score,
        unit: entry.unit,
        attribution: 'third-party',
        source: 'epoch.ai',
        // `*_external.csv` 是转载，署名给到原榜；Epoch 自测榜没有逐模型深链，给检索地址。
        sourceUrl: entry.sourceUrl ?? EPOCH_CITATION_URL,
      });
    }
    for (const entry of liveBenchByModelId.get(c.id) ?? []) {
      // LiveBench 2.0 有七类，只有 Coding 是编程口径。
      // Research / Design / Browser 那些塞进 coding[] 会让「编程能力」那一行
      // 变成文档排版分，也会在算档位时和真正的解题率混在一个池子里。
      if (!entry.coding) continue;
      pushCoding({
        league: entry.league,
        score: entry.score,
        unit: 'pct',
        attribution: 'third-party',
        /*
         * 注意这个分数是管线算出来的：上游 CSV 是按 task 的宽表，
         * `livebench_coding` 是按 categories 分组取的算术平均，那个数字在上游并不存在。
         * 尽管如此仍署名 'livebench' 而不是 'derived'——读者要知道的是
         * 「这来自 LiveBench」，均分是我们的呈现方式而不是另一个数据源。
         * 具体 release 的榜单页由 sourceUrl 承载。
         */
        source: 'livebench',
        sourceUrl: entry.sourceUrl,
      });
    }
    for (const entry of vendorBench?.values() ?? []) {
      // models.dev 的 benchmarks[] 实测全是 0–100 的百分数，解析时已经把越界值当脏数据丢了。
      // 这里唯一需要留神的是 frontier_swe：它的 dominance 是池内相对胜率而非解题率，
      // 但标度确实是 0–100，与 Epoch 侧乘 100 之后一致，所以同赛制里只有一种量纲。
      pushCoding({
        league: entry.league,
        score: entry.score,
        unit: 'pct',
        attribution: entry.attributionType,
        source: 'models.dev',
        sourceUrl: entry.sourceUrl,
      });
    }
    coding.sort(
      (a, b) =>
        codingLeagueRank(a.league) - codingLeagueRank(b.league) ||
        (a.league < b.league ? -1 : a.league > b.league ? 1 : 0),
    );
    if (coding.length > 0) provenance.coding = 'derived';

    /**
     * 全部评测成绩，`coding[]` 与 `benchmarks.*` 的超集，一个 league 一条。
     *
     * 入列顺序即优先级：coding[]（已经按 Epoch > LiveBench > models.dev 择优）→
     * benchmarks.* 里剩下的五项 Epoch 固定榜 → metadata 泛化接入的其余榜单。
     * 同一个 league 撞上时第三方胜过自报；同为第三方先到先得（前面的来源更可靠）。
     */
    const scores: BenchmarkScore[] = [];
    const scoreByLeague = new Map<string, number>();
    const pushScore = (s: BenchmarkScore): void => {
      const idx = scoreByLeague.get(s.league);
      if (idx === undefined) {
        scoreByLeague.set(s.league, scores.length);
        scores.push(s);
        return;
      }
      if (scores[idx].attribution === 'vendor-self-reported' && s.attribution === 'third-party') {
        scores[idx] = s;
      }
    };
    for (const s of coding) pushScore(s);
    // LiveBench 2.0 里与编程无关的六类（长程任务、推理、浏览器、数据分析、研究、设计）
    // 只作为独立榜单进 scores[]，不进 coding[]。
    for (const entry of liveBenchByModelId.get(c.id) ?? []) {
      if (entry.coding) continue;
      pushScore({
        league: entry.league,
        score: entry.score,
        unit: 'pct',
        attribution: 'third-party',
        source: 'livebench',
        sourceUrl: entry.sourceUrl,
      });
    }
    if (epochHit) {
      const fixedUnits: Record<string, BenchmarkScore['unit']> = { eci: 'index', webdev_arena_elo: 'elo' };
      for (const key of epochBenchKeys()) {
        const v = epochHit.scores[key];
        if (v === undefined) continue;
        pushScore({
          league: key,
          score: v,
          unit: fixedUnits[key] ?? 'pct',
          attribution: 'third-party',
          source: 'epoch.ai',
          sourceUrl: EPOCH_CITATION_URL,
        });
      }
    }
    const epochLeagueScores = lookupEpochLeagueScores(
      epoch,
      c.vendorId,
      epochSlugCandidates,
      epochStrippedCandidates,
    );
    for (const entry of Object.values(epochLeagueScores)) {
      pushScore({
        league: entry.league,
        score: entry.score,
        unit: entry.unit,
        attribution: 'third-party',
        source: 'epoch.ai',
        // 泛化接入的榜：Source link 列有就写，没有就是 null，不伪造。
        sourceUrl: entry.sourceUrl,
      });
    }
    /*
     * LMArena 的竞技场分。它是站内图像与视频生成模型**唯一**的成绩来源，
     * 其余类型的模型拿它当补充（人类偏好，与学术评测各说各话，所以各自成榜）。
     *
     * 匹配收得很紧：名字归一化之后还要求厂商对得上。竞技场里同名不同家的情况不少
     * （`wan3.0` 挂在 alibaba、`wan2.7-t2v` 挂在 wan），只按名字匹配会张冠李戴。
     */
    for (const s of lookupArenaScores(
      arenaByKey,
      c.vendorId,
      arenaMatchCandidates([c.modelSlug, ...(md?.name ? [md.name] : [])]),
    )) {
      pushScore({
        league: s.league,
        score: s.score,
        unit: s.unit,
        attribution: 'third-party',
        source: 'lmarena',
        sourceUrl: s.sourceUrl,
      });
      arenaMatchedLeagues.add(`${c.id}|${s.league}`);
    }
    scores.sort((a, b) => (a.league < b.league ? -1 : a.league > b.league ? 1 : 0));
    if (scores.length > 0) provenance.scores = 'derived';

    // 训练算力：Epoch model_metadata.csv。闭源模型唯一有第三方估算的「体型」代理。
    const trainingComputeFlop = lookupEpochTrainingCompute(
      epoch,
      c.vendorId,
      epochSlugCandidates,
      epochMatch?.aliasKey ?? null,
    );
    if (trainingComputeFlop !== null) provenance.trainingComputeFlop = 'epoch.ai';

    // 能走到这里说明模型至少还在一个上游列表里，所以一定是存活的。
    // 真正的退役判定在下面的「上一轮有、这一轮全没有」循环里。
    const prev = prevModels.get(c.id);
    if (prev?.retiredAt) resurrected += 1;

    const name = md?.name?.trim() || displayNameFromSlug(c.modelSlug);
    provenance.name = md ? 'models.dev' : 'derived';
    provenance.vendorId = 'derived';
    if (md?.knowledgeCutoff) provenance.knowledgeCutoff = 'models.dev';

    models.push({
      id: c.id,
      slug: toSlug(c.id),
      name,
      vendorId: c.vendorId,
      releaseDate: verdict?.value.iso ?? null,
      releaseDatePrecision: verdict?.value.precision ?? null,
      knowledgeCutoff: md?.knowledgeCutoff ?? null,
      retiredAt: null,
      contextWindow,
      maxOutput,
      pricing: {
        inputPerMTok: pricing?.inputPerMTok ?? null,
        outputPerMTok: pricing?.outputPerMTok ?? null,
        cachedInputPerMTok: pricing?.cachedInputPerMTok ?? null,
      },
      modalities: { input: inputModalities, output: outputModalities },
      capabilities: {
        toolCall: md?.toolCall ?? null,
        reasoning: md?.reasoning ?? null,
        structuredOutput: md?.structuredOutput ?? null,
        promptCaching,
      },
      openWeights: md?.openWeights ?? null,
      license,
      params: {
        totalB: resolved.totalB,
        activeB: resolved.activeB,
        confidence: resolved.confidence,
        ...(resolved.tier
          ? { sizeTier: resolved.tier.tier, sizeTierBasis: resolved.tier.basis }
          : {}),
      },
      benchmarks,
      coding,
      scores,
      trainingComputeFlop,
      provenance,
      firstSeenAt: prev?.firstSeenAt ?? runIso,
    });
  }

  // 上一轮存在、这一轮上游全都没有的模型：保留在快照里并标记退役（角色转幽灵态）
  let retiredThisRun = 0;
  for (const prev of prevModels.values()) {
    if (candidates.has(prev.id)) continue;
    retiredThisRun += 1;
    models.push({
      ...prev,
      // 幽灵是从上一份快照原样搬过来的，而上一份快照里可能压根没有 coding 字段
      // （新字段第一次上线时必然如此）。不补这个默认值，往生堂里的角色就会拿到 undefined，
      // 契约上说好的「空数组表示确实没查到成绩」就成了「字段不存在」。
      coding: prev.coding ?? [],
      // slug 要按当前规则重算，不能照搬。退役模型一样会生成详情页，
      // 而 slug 的生成规则是会演进的（比如后来禁掉了点号）。照搬旧值会留下
      // 一批「规则改了但幽灵没跟上」的页面，在严格静态托管上就是 404。
      slug: toSlug(prev.id),
      retiredAt: prev.retiredAt ?? runDate,
      provenance: { ...prev.provenance, retiredAt: 'derived' },
    });
  }

  models.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ── 2b. 榜单元信息 ─────────────────────────────────────────────────
  // 只列至少有一个模型命中的 league。分四类来源：Epoch zip 里的（元信息直接透传）、
  // models.dev 自报的、LiveBench 的、LMArena 竞技场的——后三类上游没有 metadata，
  // 能填的字段如实填，填不了的一律 null，不拿常识去猜。
  const leagueLanding: Record<string, number> = {};
  const leagueUnit = new Map<string, BenchmarkScore['unit']>();
  for (const m of models) {
    for (const s of m.scores ?? []) {
      leagueLanding[s.league] = (leagueLanding[s.league] ?? 0) + 1;
      if (!leagueUnit.has(s.league)) leagueUnit.set(s.league, s.unit);
    }
  }
  const benchmarkMetas: BenchmarkMeta[] = Object.keys(leagueLanding)
    .sort()
    .map((league) => {
      const info = epoch.leagues[league];
      if (info) {
        return {
          id: league,
          sourceFile: info.fileName,
          scoreColumn: info.scoreColumn,
          unit: info.unit,
          randomBaseline: info.randomBaseline,
          scoreCeiling: info.scoreCeiling,
          releaseDate: info.releaseDate,
          supersededBy: info.supersededBy,
          inEci: info.inEci,
          models: leagueLanding[league],
        };
      }
      const unit = leagueUnit.get(league) ?? 'pct';
      // v1 是 `livebench_`、v2 是 `livebench2_`，两者的上游文件完全不同，标注也要分开。
      const isLiveBench2 = league.startsWith('livebench2_');
      const isLiveBench = /^livebench2?_/.test(league);
      const isArena = league.startsWith('arena_');
      return {
        id: league,
        sourceFile: isArena
          ? 'huggingface.co/datasets/lmarena-ai/leaderboard-dataset'
          : isLiveBench2
            ? 'livebench.ai/data/<release>/breakdown.json'
            : isLiveBench
              ? 'livebench.ai/table_<release>.csv'
              : 'models.dev/models.json#benchmarks[]',
        scoreColumn: isArena
          ? 'rating'
          : isLiveBench2
            ? '分类内分项均分（livebench2_overall 是本站按七类等权算的均分）'
            : isLiveBench
              ? 'categories 分组均值'
              : 'score',
        unit,
        // 上游没有元信息就是 null，不拿「百分数满分是 100」这类常识去填——前端按 unit 自己知道。
        randomBaseline: null,
        scoreCeiling: null,
        releaseDate: null,
        supersededBy: null,
        inEci: false,
        models: leagueLanding[league],
      };
    });

  // ── 3. 厂商注册表 ──────────────────────────────────────────────────
  const vendorIds = [...new Set(models.map((m) => m.vendorId))].sort();
  const vendors: Vendor[] = vendorIds.map((id) => {
    const reg = lookupVendorProfile(registry, id);
    const provider = modelsDev.providers.get(id);
    // 国别优先用人工注册表，其次用 Epoch 的 Country（CC-BY，覆盖到 91 个中国厂商模型）。
    const country = reg?.country ?? epoch.vendorCountry.get(id) ?? 'ZZ';
    const name = provider?.name?.trim() || displayNameFromSlug(id);
    let homepage: string | null = reg?.homepage ?? null;
    if (!homepage && provider?.doc) {
      // 文档地址不是主页，取它的 origin 作为厂商入口。
      try {
        homepage = new URL(provider.doc).origin;
      } catch {
        homepage = null;
      }
    }
    return {
      id,
      name,
      nameZh: reg?.nameZh ?? name,
      country,
      continent:
        reg?.continent ?? registry.continentForCountry(country === 'ZZ' ? null : country),
      motif: reg?.motif ?? registry.fallbackMotif,
      accentColor: reg?.accentColor ?? FALLBACK_ACCENT,
      homepage,
    };
  });

  const retiredTotal = models.filter((m) => m.retiredAt !== null).length;
  log.step(
    `合并完成：${models.length} 个模型 / ${vendors.length} 个厂商；` +
      `models.dev 主源 ${promoted.filter((c) => c.inModelsDev).length} 个，` +
      `多源发现晋升 ${promoted.filter((c) => !c.inModelsDev).length - quickPromoted.length} 个，` +
      `注册厂商单源快速晋升 ${quickPromoted.length} 个` +
      (quickPromoted.length ? `（${quickPromoted.join(', ')}）` : '') +
      `，单源待定 ${pending.length} 个；退役 ${retiredTotal} 个`,
  );

  // ── 3b. 兜底源、训练算力、全榜单的落地账 ─────────────────────────────
  const liveModels = models.filter((m) => m.retiredAt === null);
  const fallbackAfter: Record<string, number> = {
    'pricing.inputPerMTok': liveModels.filter((m) => m.pricing.inputPerMTok !== null).length,
    'pricing.outputPerMTok': liveModels.filter((m) => m.pricing.outputPerMTok !== null).length,
    contextWindow: liveModels.filter((m) => m.contextWindow !== null).length,
    maxOutput: liveModels.filter((m) => m.maxOutput !== null).length,
    modalities: liveModels.filter((m) => m.modalities.input.length > 0).length,
  };
  const fallbackCoverage: FallbackCoverage = {
    liveModels: liveModels.length,
    before: fallbackBefore,
    after: fallbackAfter,
    bySource: fallbackBySource,
  };
  const pctOf = (n: number) => (liveModels.length ? ((100 * n) / liveModels.length).toFixed(1) : '0.0');
  log.step(
    `兜底源接入后的覆盖率（存活模型口径）：` +
      `定价(输出) ${pctOf(fallbackBefore['pricing.outputPerMTok'])}% → ${pctOf(fallbackAfter['pricing.outputPerMTok'])}% · ` +
      `定价(输入) ${pctOf(fallbackBefore['pricing.inputPerMTok'])}% → ${pctOf(fallbackAfter['pricing.inputPerMTok'])}% · ` +
      `上下文 ${pctOf(fallbackBefore.contextWindow)}% → ${pctOf(fallbackAfter.contextWindow)}% · ` +
      `最大输出 ${pctOf(fallbackBefore.maxOutput)}% → ${pctOf(fallbackAfter.maxOutput)}% · ` +
      `模态 ${pctOf(fallbackBefore.modalities)}% → ${pctOf(fallbackAfter.modalities)}%`,
  );
  for (const [field, bySource] of Object.entries(fallbackBySource).sort(([a], [b]) => (a < b ? -1 : 1))) {
    log.info(
      `  兜底 ${field}：` +
        Object.entries(bySource)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([s, n]) => `${s} 补 ${n}`)
          .join(' · '),
    );
  }

  const CLOSED_FLAGSHIP_VENDORS = new Set(['openai', 'anthropic', 'google', 'xai']);
  const closedFlagships = liveModels.filter(
    (m) => CLOSED_FLAGSHIP_VENDORS.has(m.vendorId) && m.benchmarks.eci !== null,
  );
  const trainingCompute: TrainingComputeCoverage = {
    liveModels: liveModels.length,
    withFlop: liveModels.filter((m) => m.trainingComputeFlop != null).length,
    closedFlagships: {
      total: closedFlagships.length,
      withFlop: closedFlagships.filter((m) => m.trainingComputeFlop != null).length,
      without: closedFlagships.filter((m) => m.trainingComputeFlop == null).map((m) => m.id).sort(),
    },
  };
  log.step(
    `训练算力（Epoch model_metadata.csv，${epoch.trainingComputeRows} 行有估算）：` +
      `${trainingCompute.withFlop}/${liveModels.length} 个存活模型拿到；` +
      `闭源旗舰（openai/anthropic/google/xai 有 ECI 的）${trainingCompute.closedFlagships.withFlop}/${trainingCompute.closedFlagships.total}`,
  );

  // 每个榜「N 行 / M 行有分 / 接住 K 个模型」，与编程榜的日志风格一致。
  const leagueRows = Object.values(epoch.leagues).sort((a, b) => (a.league < b.league ? -1 : 1));
  for (const info of leagueRows) {
    log.info(
      `  scores[${info.league}] ← ${info.fileName}：${info.rows} 行 / ${info.scored} 行有分 / ` +
        `接住 ${leagueLanding[info.league] ?? 0} 个模型（${info.unit}${info.curated ? '，手写规格' : ''}` +
        `${info.supersededBy ? `，已被 ${info.supersededBy} 取代` : ''}）`,
    );
  }
  log.step(
    `全榜单 scores[]：${liveModels.filter((m) => (m.scores ?? []).length > 0).length}/${liveModels.length} 个存活模型有成绩，` +
      `覆盖 ${benchmarkMetas.length} 个榜单（Epoch ${benchmarkMetas.filter((b) => epoch.leagues[b.id]).length} 个 + ` +
      `models.dev / LiveBench ${benchmarkMetas.filter((b) => !epoch.leagues[b.id]).length} 个）`,
  );

  // ── 4. 编程覆盖与 Epoch 匹配率 ──────────────────────────────────────
  const codingCoverage = summarizeCoding(models);
  codingCoverage.flagship = await measureFlagshipCoding(models, vendors, new Date(runIso), registry);
  const epochMatch = summarizeEpochMatch(epoch, models, matchedEpochEntities, matchTiers);

  log.step(
    `编程赛制：${codingCoverage.modelsWithAny}/${codingCoverage.liveModels} 个存活模型有成绩，` +
      `覆盖 ${Object.keys(codingCoverage.byLeague).length} 个赛制` +
      (codingCoverage.flagship
        ? `；首屏门面 ${codingCoverage.flagship.withAnyCoding}/${codingCoverage.flagship.total}` +
          `（${((100 * codingCoverage.flagship.withAnyCoding) / codingCoverage.flagship.total).toFixed(0)}%）`
        : ''),
  );
  log.info(
    `Epoch 匹配：去重后上游 ${epochMatch.upstreamEntities} 个模型，接住 ${epochMatch.matchedEntities} 个` +
      `（去参数量兜底贡献 ${paramStrippedMatches} 个）`,
  );
  log.info(
    `LiveBench 匹配：上游 ${livebench.byModel.size} 个型号名，接住 ${liveBenchByModelId.size} 个；` +
      `未匹配 ${liveBenchUnmatchedNames.length} 个（多为不在 models.dev 收录范围里的老模型）`,
  );

  return {
    models,
    vendors,
    benchmarks: benchmarkMetas,
    sizeTiers,
    benchmarkAttribution,
    pendingDiscoveries: pending,
    quickPromoted,
    codingCoverage,
    epochMatch,
    fallbackCoverage,
    trainingCompute,
    leagueLanding,
    liveBenchMatch: {
      upstreamModelNames: livebench.byModel.size,
      matchedModels: liveBenchByModelId.size,
      unmatchedSamples: liveBenchUnmatchedNames.sort().slice(0, 30),
    },
    stats: {
      fromModelsDev: promoted.filter((c) => c.inModelsDev).length,
      promotedDiscoveries: promoted.filter((c) => !c.inModelsDev).length,
      quickPromotedDiscoveries: quickPromoted.length,
      pendingDiscoveries: pending.length,
      retiredThisRun,
      retiredTotal,
      resurrected,
      releaseDateOutliersDropped: outliersDropped,
      epochParamStrippedMatches: paramStrippedMatches,
    },
  };
}

function summarizeCoding(models: ModelRecord[]): CodingCoverage {
  const live = models.filter((m) => m.retiredAt === null);
  const byLeague: Record<string, number> = {};
  const byAttribution: Record<string, number> = {};
  const byUnit: Record<string, number> = {};
  let modelsWithAny = 0;
  let modelsOnlyElo = 0;
  for (const m of live) {
    const scores = m.coding ?? [];
    if (scores.length === 0) continue;
    modelsWithAny += 1;
    if (!scores.some((s) => s.unit === 'pct')) modelsOnlyElo += 1;
    for (const s of scores) {
      byLeague[s.league] = (byLeague[s.league] ?? 0) + 1;
      byAttribution[s.attribution] = (byAttribution[s.attribution] ?? 0) + 1;
      byUnit[s.unit] = (byUnit[s.unit] ?? 0) + 1;
    }
  }
  return {
    modelsWithAny,
    liveModels: live.length,
    modelsOnlyElo,
    byLeague: Object.fromEntries(Object.entries(byLeague).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))),
    byAttribution,
    byUnit,
    flagship: null,
  };
}

/**
 * 首屏当家门面的编程命中率。
 *
 * 选拔规则住在前端的 `src/lib/roster.ts`，这里**动态导入**它而不是重写一遍：
 * 重写必然会跟前端慢慢漂移，那时报告里的数字就成了自说自话。
 * 但也不能让管线因此依赖前端——两边是并行开发的，
 * 所以按 merge/vendor-registry.ts 的同一套路子处理：加载失败就把这项指标记成 null，
 * 绝不把 npm run sync 拖崩。
 */
async function measureFlagshipCoding(
  models: ModelRecord[],
  vendors: Vendor[],
  now: Date,
  registry: LoadedRegistry,
): Promise<CodingCoverage['flagship']> {
  try {
    const mod = (await import('../../../src/lib/roster')) as {
      buildPlazaRoster?: (
        models: ModelRecord[],
        vendors: Vendor[],
        now: Date,
        registryHas: (id: string) => boolean,
      ) => Array<{ entries: Array<{ model: ModelRecord }> }>;
    };
    const buildPlazaRoster = mod.buildPlazaRoster;
    if (typeof buildPlazaRoster !== 'function') {
      log.warn('src/lib/roster.ts 没有导出 buildPlazaRoster，首屏编程命中率本次留空');
      return null;
    }
    const rosters = buildPlazaRoster(models, vendors, now, (id) => id in registry.entries);
    const flagships = rosters.flatMap((r) => r.entries.map((e) => e.model));
    if (flagships.length === 0) return null;
    return {
      total: flagships.length,
      withAnyCoding: flagships.filter((m) => (m.coding ?? []).length > 0).length,
      withPercentCoding: flagships.filter((m) => (m.coding ?? []).some((s) => s.unit === 'pct'))
        .length,
      without: flagships.filter((m) => (m.coding ?? []).length === 0).map((m) => m.id).sort(),
    };
  } catch (err) {
    log.warn(`加载 src/lib/roster.ts 失败，首屏编程命中率本次留空：${String(err)}`);
    return null;
  }
}

function summarizeEpochMatch(
  epoch: EpochResult,
  models: ModelRecord[],
  matchedEntities: Set<string>,
  matchTiers: Record<string, number>,
): EpochMatchStats {
  const byBenchmark: EpochMatchStats['byBenchmark'] = {};
  for (const key of epochBenchKeys()) {
    const upstream = [...epoch.entities.values()].filter((e) => e.benchmarks.includes(key));
    byBenchmark[key] = {
      upstreamRows: epoch.counts[key] ?? 0,
      upstreamModels: upstream.length,
      matchedModels: upstream.filter((e) => matchedEntities.has(e.key)).length,
      landedModels: models.filter((m) => m.benchmarks[key] !== null).length,
    };
  }
  const unmatched = [...epoch.entities.values()]
    .filter((e) => !matchedEntities.has(e.key))
    .sort((a, b) => b.benchmarks.length - a.benchmarks.length || (a.key < b.key ? -1 : 1))
    .slice(0, 25)
    .map((e) => ({
      key: e.key,
      label: e.label,
      organization: e.organization,
      benchmarks: [...e.benchmarks].sort() as string[],
    }));
  return {
    upstreamEntities: epoch.entities.size,
    matchedEntities: matchedEntities.size,
    matchTiers,
    byBenchmark,
    unmatchedSamples: unmatched,
  };
}

export function hfTargets(modelsDev: ModelsDevResult): Array<{ modelId: string; repos: string[] }> {
  const out: Array<{ modelId: string; repos: string[] }> = [];
  for (const fact of modelsDev.facts.values()) {
    // 只对开源模型查 HF；闭源模型在 HF 上根本没有权重仓库。
    if (fact.openWeights !== true) continue;
    if (fact.hfRepos.length === 0) continue;
    out.push({ modelId: fact.id, repos: fact.hfRepos });
  }
  out.sort((a, b) => (a.modelId < b.modelId ? -1 : 1));
  return out;
}
