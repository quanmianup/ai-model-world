/**
 * 编程赛制注册表。
 *
 * 这是继 `vendor-registry.ts` 之后第二处**人类常识层**：机器能读出
 * 「这个模型在 Terminal-Bench 上拿了 73.4」，读不出「Terminal-Bench 考的是
 * 能不能在真实终端里干完一件活，和 SWE-bench 修 bug 不是一回事」。
 *
 * 与厂商注册表遵循同一条铁律：**查表而非逻辑，未收录的赛制自动兜底**。
 * 上游随时会冒出新榜单，注册表里没有它也不会让页面崩掉，
 * 只是显示成通用措辞。这是零维护承诺的一部分。
 */

import type { Attribution, ScoreUnit } from '@/lib/types';

export interface CodingLeague {
  /** 界面上的短名，尽量用中文，实在没有通行译法就保留英文原名 */
  label: string;
  /** 一句话说清它考什么，给悬停提示与详情页用 */
  blurb: string;
  unit: ScoreUnit;
  /**
   * 展示优先级，数字越小越优先。同一个模型在多个赛制都有成绩时，
   * 卡片上只展示优先级最高的那一条，其余留给详情页。
   *
   * 排序依据是「这个赛制离『会不会写代码』这个问题有多近」，
   * 不是「谁测的」——测量方由每条成绩自己的 `attribution` 字段承载，
   * 在同一个赛制内部作为次级排序。
   *
   * 这个区分踩过一次：把 WebDev Arena 排在最前之后，
   * 一张卡的「编程」是 SWE-bench 的百分数、另一张是 Elo 分，
   * 同一行标签在不同卡片上指的不是同一件事，横向扫过去反而更糊涂。
   * 现在 SWE 家族一律优先，WebDev 只在完全没有 SWE 成绩时兜底，
   * 而且会把那一行的标签改成「前端」。
   */
  priority: number;
  /**
   * 用这个赛制时，能力条那一行的标签要改成什么。
   * 只有口径明显不是「通用编程」的赛制才需要，缺省沿用「编程」。
   */
  rowLabel?: string;
  /** 榜单方自己的主页，用于详情页署名 */
  homepage: string | null;
}

/**
 * 收录的赛制。
 *
 * `priority` 的分段约定：
 *   10–19  SWE-bench 本尊，业界默认的「编程能力」就是指它
 *   20–29  SWE-bench 的变体（更难的 Pro、多语言版）
 *   30–49  其他通用编程赛制（终端操作、代码编辑、竞赛题）
 *   50+    口径明显偏窄的赛制，只在没有别的成绩时兜底，且会改写行标签
 */
export const CODING_LEAGUES: Record<string, CodingLeague> = {
  // ── SWE-bench 家族：业界默认说「编程能力」指的就是这一套 ──
  swe_bench_verified: {
    label: 'SWE-bench Verified',
    blurb: '从真实 GitHub 仓库里挑出的 500 个 issue，看模型能不能提交出通过测试的补丁。业界最通行的编程标尺。这一列由 Epoch AI 用统一脚手架复跑。',
    unit: 'pct',
    priority: 10,
    homepage: 'https://www.swebench.com/',
  },
  /*
   * 与上面同一套题，但分数是从厂商系统卡或第三方榜单转载来的，不是 Epoch 复跑。
   * 赛制 id 沿用了管线里的历史字段名 `swe_bench_vendor`，实际测量方由每条成绩
   * 自己的 attribution 字段决定——转载来源里既有厂商自评也有中立榜单。
   * 分位池按「赛制 + 测量方」分组，所以这两类不会被混算。
   */
  swe_bench_vendor: {
    label: 'SWE-bench Verified（转载）',
    blurb: '同样是 SWE-bench Verified，但分数来自厂商系统卡或其他榜单的转载，没有经过 Epoch 的统一复跑。',
    unit: 'pct',
    priority: 12,
    homepage: 'https://www.swebench.com/',
  },
  swe_bench_multilingual: {
    label: 'SWE-bench 多语言版',
    blurb: '把 SWE-bench 的题目扩展到 Python 以外的语言，考的是跨语言的工程能力。',
    unit: 'pct',
    priority: 20,
    homepage: 'https://www.swebench.com/',
  },
  swe_bench_pro: {
    label: 'SWE-Bench Pro',
    blurb: '同一个思路但难度高得多的版本，题目更长、依赖更复杂。分数普遍比 Verified 低三十分左右，两者不可直接比较。',
    unit: 'pct',
    priority: 22,
    homepage: 'https://scale.com/leaderboard/swe_bench_pro_public',
  },
  swe_bench_multimodal: {
    label: 'SWE-bench 多模态版',
    blurb: '题目里带截图和界面录屏的 SWE-bench 变体，考的是能不能看懂视觉线索再改代码。',
    unit: 'pct',
    priority: 24,
    homepage: 'https://www.swebench.com/multimodal.html',
  },
  swe_marathon: {
    label: 'SWE-Marathon',
    blurb: '超长时程的软件工程任务，一道题要连续工作很久，考的是耐力与不跑偏。',
    unit: 'pct',
    priority: 26,
  homepage: null,
  },
  frontier_swe: {
    label: 'FrontierSWE',
    blurb: '面向前沿模型设计的高难度软件工程题，普通模型基本做不动，用来拉开顶尖选手之间的差距。',
    unit: 'pct',
    priority: 28,
    homepage: 'https://frontierswe.com/',
  },
  deepswe: {
    label: 'DeepSWE',
    blurb: 'SWE-bench Verified 的一个变体测法，用不同的 agent 脚手架跑同一批题。',
    unit: 'pct',
    priority: 29,
    homepage: 'https://deepswe.datacurve.ai/',
  },

  // ── 终端与真实工作环境 ──
  terminal_bench: {
    label: 'Terminal-Bench',
    blurb: '把模型丢进一个真实终端里让它自己干完一件活——装环境、跑脚本、调错。考的是当「实习生」的本事，不只是写代码。',
    unit: 'pct',
    priority: 30,
    homepage: 'https://www.tbench.ai/',
  },
  terminal_bench_2_0: {
    label: 'Terminal-Bench 2.0',
    blurb: 'Terminal-Bench 的第二代题库，任务更长更杂。与 1.0 的分数不可直接比较。',
    unit: 'pct',
    priority: 31,
    homepage: 'https://www.tbench.ai/',
  },
  terminal_bench_2_1: {
    label: 'Terminal-Bench 2.1',
    blurb: 'Terminal-Bench 第二代的修订版题库。与其他代次的分数不可直接比较。',
    unit: 'pct',
    priority: 32,
    homepage: 'https://www.tbench.ai/',
  },
  terminal_bench_4_0: {
    label: 'Terminal-Bench 4.0',
    blurb: 'Terminal-Bench 的第四代题库，在真实终端里完成多步骤的专业任务。与其他代次的分数不可直接比较。',
    unit: 'pct',
    priority: 29.5,
    homepage: 'https://www.tbench.ai/',
  },
  cursorbench: {
    label: 'CursorBench',
    blurb: '在真实 IDE 里做代码编辑的测试，题目来自 Cursor 收集的实际使用场景。',
    unit: 'pct',
    priority: 33,
    homepage: 'https://cursor.com/cursorbench',
  },

  // ── 代码编辑与生成 ──
  aider_polyglot: {
    label: 'Aider Polyglot',
    blurb: '多语言代码编辑测试，看模型能不能按要求准确改动已有代码。榜单已停更在 2025 年底，只覆盖那之前的模型。',
    unit: 'pct',
    priority: 36,
    homepage: 'https://aider.chat/docs/leaderboards/',
  },
  nl2repo: {
    label: 'NL2Repo',
    blurb: '从一段自然语言需求直接生成一整个可运行的代码仓库。',
    unit: 'pct',
    priority: 38,
    homepage: null,
  },
  frontier_code: {
    label: 'FrontierCode',
    blurb: 'Cognition 出的高难度代码题集，面向前沿模型。',
    unit: 'pct',
    priority: 40,
    homepage: 'https://cognition.com/frontiercode',
  },
  program_bench: {
    label: 'ProgramBench',
    blurb: '通用程序设计能力测试。',
    unit: 'pct',
    priority: 42,
    homepage: null,
  },
  livebench_coding: {
    label: 'LiveBench 编程分项',
    blurb: 'LiveBench 每月换新题以避免污染，这一列是它的编程分项均分。',
    unit: 'pct',
    priority: 43,
    homepage: 'https://livebench.ai/',
  },
  livebench_agentic_coding: {
    label: 'LiveBench 智能体编程',
    blurb: 'LiveBench 的智能体编程分项：不是写一段代码，而是像开发者那样多轮改动一个项目。',
    unit: 'pct',
    priority: 35,
    homepage: 'https://livebench.ai/',
  },
  livebench2_coding: {
    label: 'LiveBench 2.0 编程',
    blurb: 'LiveBench 2.0 的编程分项：不是做题，而是接 API、写 Agent 循环、接云基础设施、做计费与限额这类真活儿。2.0 换了评测方式（长程任务、产物评审），与旧版 LiveBench 编程分不是同一把尺子，分数不可直接比较。',
    unit: 'pct',
    priority: 45,
    homepage: 'https://livebench.ai/',
  },
  livecodebench: {
    label: 'LiveCodeBench',
    blurb: '持续收录新出的编程竞赛题，题目发布时间晚于模型训练截止日期，用来避开「背过答案」的嫌疑。',
    unit: 'pct',
    priority: 44,
    homepage: 'https://livecodebench.github.io/',
  },
  livecodebench_v6: {
    label: 'LiveCodeBench v6',
    blurb: 'LiveCodeBench 的第六版题库切片。不同版本之间的分数不可直接比较。',
    unit: 'pct',
    priority: 45,
    homepage: 'https://livecodebench.github.io/',
  },
  livecodebench_pro: {
    label: 'LiveCodeBench Pro',
    blurb: 'LiveCodeBench 的高难度版本，题目取自竞赛中的难题。',
    unit: 'pct',
    priority: 46,
    homepage: 'https://livecodebench.github.io/',
  },
  claw_eval: {
    label: 'ClawEval',
    blurb: '一套面向代码智能体的评测。',
    unit: 'pct',
    priority: 48,
    homepage: null,
  },

  /*
   * 以下几个赛制的口径明显只覆盖编程能力的一个侧面，
   * 拿它们兜底时会改写能力条那一行的标签，避免「编程」这两个字
   * 在不同卡片上指的不是同一件事。
   */
  /*
   * 这两个赛制的分数**不是百分数**，是自定义标度。判错量纲会让界面印出
   * 「2176.9%」这种一看就是错的数字，所以 unit 必须和管线产出保持一致。
   */
  ale_bench: {
    label: 'ALE-Bench',
    blurb: 'AtCoder 启发式算法竞赛题，考的是给一个没有标准答案的优化问题找出尽量好的解。分数是 137–2177 的评分标度，不是百分比。和「修 bug」是两种能力。',
    unit: 'index',
    priority: 50,
    rowLabel: '算法',
    homepage: null,
  },
  algotune: {
    label: 'AlgoTune',
    blurb: '给定一段算法实现，让模型把它调得更快。分数是加速倍率（约 1.3–2 倍），不是百分比。考的是性能调优而不是功能实现。',
    unit: 'index',
    priority: 51,
    rowLabel: '调优',
    homepage: null,
  },
  gso: {
    label: 'GSO',
    blurb: '代码性能优化测试：在保持功能不变的前提下把真实项目跑得更快。',
    unit: 'pct',
    priority: 52,
    rowLabel: '调优',
    homepage: 'https://gso-bench.github.io/',
  },
  swe_atlas_codebase_qna: {
    label: 'SWE-Atlas 代码库问答',
    blurb: '给模型一个陌生的大型代码库，问它这段代码在干什么。考的是读代码，不是写代码。',
    unit: 'pct',
    priority: 53,
    rowLabel: '读码',
    homepage: 'https://scale.com/leaderboard',
  },
  swe_atlas_refactoring: {
    label: 'SWE-Atlas 重构',
    blurb: '在不改变行为的前提下重构已有代码。',
    unit: 'pct',
    priority: 54,
    rowLabel: '重构',
    homepage: 'https://scale.com/leaderboard',
  },
  swe_atlas_test_writing: {
    label: 'SWE-Atlas 写测试',
    blurb: '给已有代码补写测试用例。',
    unit: 'pct',
    priority: 55,
    rowLabel: '写测试',
    homepage: 'https://scale.com/leaderboard',
  },
  mle_bench: {
    label: 'MLE-Bench',
    blurb: '让模型自己完成一整个机器学习工程任务——处理数据、训模型、调参、提交结果。',
    unit: 'pct',
    priority: 56,
    rowLabel: '炼丹',
    homepage: null,
  },
  mirrorcode: {
    label: 'MirrorCode',
    blurb: 'Epoch AI 自测的一项代码评测。',
    unit: 'pct',
    priority: 57,
    homepage: 'https://epoch.ai/benchmarks',
  },
  webdev_arena_elo: {
    label: 'WebDev Arena',
    blurb: '让两个模型各写一个网页，由人来投票选哪个更好，按对战胜负算 Elo 分。考的是前端开发的实际观感，和「能不能修复一个后端 bug」不是一回事。',
    unit: 'elo',
    priority: 60,
    rowLabel: '前端',
    homepage: 'https://web.lmarena.ai/leaderboard',
  },
};

/** 未收录赛制的兜底档案。 */
const FALLBACK: CodingLeague = {
  label: '编程评测',
  blurb: '一项公开的编程能力评测。这个榜单还没有收进本站的赛制说明表，所以只能给出通用描述。',
  unit: 'pct',
  priority: 90,
  homepage: null,
};

/** 把上游的赛制 id 转成可读档案。未收录时给通用兜底，绝不抛错。 */
export function leagueOf(id: string): CodingLeague {
  return CODING_LEAGUES[id] ?? { ...FALLBACK, label: prettifyLeagueId(id) };
}

/**
 * 把 `terminal_bench_hard` 这样的 id 变成 `Terminal Bench Hard`。
 * 只在兜底路径上用——收录过的赛制一律以注册表里的中文名为准。
 */
function prettifyLeagueId(id: string): string {
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/** 第三方复核过的成绩在界面上有更强的视觉肯定，措辞也不同。 */
export function attributionLabel(a: Attribution): string {
  return a === 'third-party' ? '第三方实测' : '厂商自报';
}
