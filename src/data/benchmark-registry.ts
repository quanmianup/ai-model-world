/**
 * 榜单注册表：把 Epoch 的榜单 id 翻译成普通人能看懂的中文名、一句话说明与分类。
 *
 * 这是 `coding-leagues.ts` 在全部榜单上的推广，是第三处**人类常识层**：
 * 机器能读出「这个模型在 HLE 上拿了 46%」，读不出「HLE 是一套连博士都答不好的
 * 刁钻题，46% 已经是前沿水平」。
 *
 * 与前两处注册表遵循同一条铁律：**查表而非逻辑，未收录的榜单自动兜底**。
 * Epoch 新增一个榜单，下一次同步它就会带着自动生成的标签出现在排行榜里，
 * 不需要改一行代码。这里补一条只是让它有中文名和说明，不补也不会坏。
 *
 * 编程类条目直接从 `CODING_LEAGUES` 派生，不在这里重复维护——
 * 两张表各改一份迟早会对不上。
 */

import { CODING_LEAGUES } from './coding-leagues';

export type BenchmarkCategory =
  | '综合'
  | '数学'
  | '知识与推理'
  | '编程'
  | '智能体'
  | '长文本'
  | '多模态'
  | '游戏与谜题'
  | '写作'
  | '其他';

/** 分类在界面上的排列顺序：先是所有人都想问的「谁最强」，然后按关注度递减 */
export const BENCHMARK_CATEGORIES: BenchmarkCategory[] = [
  '综合',
  '编程',
  '数学',
  '知识与推理',
  '智能体',
  '长文本',
  '多模态',
  '游戏与谜题',
  '写作',
  '其他',
];

export interface BenchmarkInfo {
  /** 中文短名，尽量不超过六个字；没有通行译法的保留英文原名 */
  label: string;
  /** 一句人话：它量什么、一般人为什么该关心 */
  blurb: string;
  category: BenchmarkCategory;
  /** 分数越高越好。目前收录的榜单全部为真，留这个字段是给「越低越好」的榜单（如错误率）预留 */
  higherIsBetter: boolean;
  /** 同类里的默认展示优先级，数字越小越靠前 */
  priority: number;
  /** 榜单方主页，用于署名与跳转 */
  homepage: string | null;
}

type Entry = Omit<BenchmarkInfo, 'higherIsBetter'> & { higherIsBetter?: boolean };

/**
 * 非编程榜单。id 与管线 `scores[].league` 一致：一般是 Epoch `benchmark_metadata.csv`
 * 的文件名去掉 `.csv` 与 `_external`，少数沿用管线的历史字段名（`eci`、`aime`、`fiction_live`），
 * Epoch 原名通过下面的 ALIASES 归一过来。
 */
const GENERAL: Record<string, Entry> = {
  // ── 综合 ──
  eci: {
    label: '综合智力',
    blurb: 'Epoch Capabilities Index，把十几项学术评测归并成一个总分。想看综合实力，先看这一栏。',
    category: '综合',
    priority: 1,
    homepage: 'https://epoch.ai/benchmarks/eci',
  },
  // ── LiveBench 2.0：长程任务评测，七个分类各占一列 ──
  //    2.0 与 1.x 是两把不同的尺子（题集、评分方式全换了），所以 id 一律带 `2_`；
  //    旧版的 livebench_coding 原样保留，两者分数不可直接比较。
  livebench2_overall: {
    label: 'LiveBench 2.0 综合',
    blurb: 'LiveBench 2.0 七个长程任务分类的等权均分——这个总分由本站计算，上游并不发布。',
    category: '综合',
    priority: 2,
    homepage: 'https://livebench.ai/',
  },
  livebench2_long_agentic: {
    label: '长程任务',
    blurb: '跑几个月的运维、财务合规、电商运营这类长线任务，看模型能不能一直把事做对。',
    category: '智能体',
    priority: 20,
    homepage: 'https://livebench.ai/',
  },
  livebench2_browser: {
    label: '浏览器操作',
    blurb: '在真实网页里点选、翻页、汇总信息，考验 agent 是不是真的会用浏览器。',
    category: '智能体',
    priority: 25,
    homepage: 'https://livebench.ai/',
  },
  livebench2_reasoning: {
    label: '推理谜题',
    blurb: '心理理论、斑马谜题、空间推理这类不靠背题的死磕题。',
    category: '游戏与谜题',
    priority: 30,
    homepage: 'https://livebench.ai/',
  },
  livebench2_research: {
    label: '带引用的研究',
    blurb: '监管、法律、财税、科研五类检索与研判任务，答案要带得住核验的出处。',
    category: '知识与推理',
    priority: 30,
    homepage: 'https://livebench.ai/',
  },
  livebench2_data_analysis: {
    label: '数据分析',
    blurb: '从表格里认事件、连表、把一种格式转成另一种格式。',
    category: '知识与推理',
    priority: 35,
    homepage: 'https://livebench.ai/',
  },
  livebench2_design: {
    label: '文档与排版',
    blurb: '产出 Word 文档、PDF、PPT 三类成品，看内容组织与版式。',
    category: '写作',
    priority: 30,
    homepage: 'https://livebench.ai/',
  },
  simplebench: {
    label: 'SimpleBench',
    blurb: '一套普通人能轻松答对、模型却常常答错的常识题。分数越高越少犯「一看就傻」的错。',
    category: '综合',
    priority: 20,
    homepage: 'https://simple-bench.com/',
  },

  // ── 数学 ──
  frontiermath_tiers_1_3_v2: {
    label: 'FrontierMath',
    blurb: '由职业数学家出的原创难题，连数学博士都要花几小时甚至几天。分数是解出的比例，能过一成就是前沿水平。',
    category: '数学',
    priority: 10,
    homepage: 'https://epoch.ai/frontiermath',
  },
  frontiermath: {
    label: 'FrontierMath（旧版）',
    blurb: 'FrontierMath 2025 年初的版本，已被新题库取代。留作历史对照。',
    category: '数学',
    priority: 11,
    homepage: 'https://epoch.ai/frontiermath',
  },
  frontiermath_tier_4_v2: {
    label: 'FrontierMath 第四层',
    blurb: 'FrontierMath 里最难的一层，研究级别的问题，绝大多数模型接近零分。',
    category: '数学',
    priority: 12,
    homepage: 'https://epoch.ai/frontiermath',
  },
  frontiermath_tier_4: {
    label: 'FrontierMath 第四层（旧版）',
    blurb: 'FrontierMath 第四层 2025 年中的版本，已被新题库取代。',
    category: '数学',
    priority: 13,
    homepage: 'https://epoch.ai/frontiermath',
  },
  aime: {
    label: 'AIME 数学',
    blurb: '美国高中数学邀请赛难度的模拟题，是数学竞赛能力的通行标尺。答对比例，满分 100。',
    category: '数学',
    priority: 20,
    homepage: 'https://epoch.ai/benchmarks/otis-mock-aime-2024-2025',
  },
  math_level_5: {
    label: 'MATH 五级',
    blurb: 'MATH 题库里难度最高的一档，高中竞赛水平。老榜单，顶尖模型早已接近满分。',
    category: '数学',
    priority: 30,
    homepage: 'https://epoch.ai/benchmarks/math-level-5',
  },
  proofbench: {
    label: 'ProofBench',
    blurb: '不是算出答案，而是写出完整证明并由人评判。考的是数学推理的严谨程度。',
    category: '数学',
    priority: 35,
    homepage: null,
  },
  gsm8k: {
    label: 'GSM8K',
    blurb: '小学应用题。早期用来测数学能力，如今顶尖模型全部接近满分，只对小模型还有区分度。',
    category: '数学',
    priority: 60,
    homepage: null,
  },

  // ── 知识与推理 ──
  hle: {
    label: 'HLE 终极考试',
    blurb: "Humanity's Last Exam，各学科专家出的刁钻题，专为难住模型而设计。能过四成就是当今顶尖。",
    category: '知识与推理',
    priority: 10,
    homepage: 'https://lastexam.ai/',
  },
  hle_tools: {
    label: 'HLE 终极考试（可用工具）',
    blurb: "Humanity's Last Exam 允许联网搜索、跑代码的测法，分数会比闭卷高一截，不能和闭卷那一栏放在一起比。",
    category: '知识与推理',
    priority: 11,
    homepage: 'https://lastexam.ai/',
  },
  gpqa_diamond: {
    label: 'GPQA 科学',
    blurb: '博士级别的物理、化学、生物选择题，题目设计到「谷歌也搜不到答案」。随机乱猜是 25 分。',
    category: '知识与推理',
    priority: 20,
    homepage: 'https://epoch.ai/benchmarks/gpqa-diamond',
  },
  arc_agi_2: {
    label: 'ARC-AGI-2',
    blurb: '看几组图形样例找规律的智力题，人类轻松、模型艰难。专门测「没见过的题会不会做」。',
    category: '知识与推理',
    priority: 30,
    homepage: 'https://arcprize.org/',
  },
  arc_agi: {
    label: 'ARC-AGI（第一代）',
    blurb: 'ARC-AGI 的第一代题库，已被第二代取代。',
    category: '知识与推理',
    priority: 31,
    homepage: 'https://arcprize.org/',
  },
  simpleqa_verified: {
    label: 'SimpleQA 事实问答',
    blurb: '一问一答的冷门事实题，测的是「知不知道」和「会不会瞎编」。分数低的模型更容易一本正经地胡说。',
    category: '知识与推理',
    priority: 40,
    homepage: 'https://www.kaggle.com/benchmarks/deepmind/simpleqa-verified',
  },
  mmlu: {
    label: 'MMLU',
    blurb: '横跨 57 个学科的大学水平选择题，曾是最通行的知识广度标尺。如今顶尖模型已接近饱和。',
    category: '知识与推理',
    priority: 50,
    homepage: null,
  },
  critpt: {
    label: 'CritPt 物理',
    blurb: '研究级别的物理问题，由在职物理学家出题。测的是能不能做前沿科研级的推理。',
    category: '知识与推理',
    priority: 55,
    homepage: null,
  },
  bbh: {
    label: 'BIG-Bench Hard',
    blurb: '从 BIG-Bench 里挑出的一批模型当年做不好的推理题。老榜单，参考意义有限。',
    category: '知识与推理',
    priority: 70,
    homepage: null,
  },
  hella_swag: {
    label: 'HellaSwag',
    blurb: '给一段情景补上最合理的下一句，测常识推理。早期榜单，顶尖模型已接近满分。',
    category: '知识与推理',
    priority: 80,
    homepage: null,
  },
  wino_grande: {
    label: 'WinoGrande',
    blurb: '指代消解的常识题（「它」指的是哪个？）。早期榜单，已经饱和。',
    category: '知识与推理',
    priority: 81,
    homepage: null,
  },
  piqa: {
    label: 'PIQA',
    blurb: '物理常识题：要达成某个目的，哪种做法可行？早期榜单。',
    category: '知识与推理',
    priority: 82,
    homepage: null,
  },
  bool_q: {
    label: 'BoolQ',
    blurb: '读一段文字回答是或否。早期阅读理解榜单。',
    category: '知识与推理',
    priority: 83,
    homepage: null,
  },
  open_book_qa: {
    label: 'OpenBookQA',
    blurb: '小学科学知识的开卷选择题。早期榜单。',
    category: '知识与推理',
    priority: 84,
    homepage: null,
  },
  common_sense_qa_2: {
    label: 'CommonsenseQA 2',
    blurb: '由人专门出来难住模型的常识判断题。早期榜单。',
    category: '知识与推理',
    priority: 85,
    homepage: null,
  },
  science_qa: {
    label: 'ScienceQA',
    blurb: '中小学科学题，部分带图。早期多模态榜单。',
    category: '知识与推理',
    priority: 86,
    homepage: null,
  },
  arc_ai2: {
    label: 'ARC（AI2 科学题）',
    blurb: 'AI2 出的小学到初中科学选择题，与 ARC-AGI 无关。早期榜单。',
    category: '知识与推理',
    priority: 87,
    homepage: null,
  },
  trivia_qa: {
    label: 'TriviaQA',
    blurb: '百科知识问答。早期榜单。',
    category: '知识与推理',
    priority: 88,
    homepage: null,
  },
  lambada: {
    label: 'LAMBADA',
    blurb: '读完一段话预测最后一个词，测长距离的语言理解。早期榜单。',
    category: '知识与推理',
    priority: 89,
    homepage: null,
  },
  superglue: {
    label: 'SuperGLUE',
    blurb: '一组经典自然语言理解任务的合集。早期榜单，已经饱和。',
    category: '知识与推理',
    priority: 90,
    homepage: null,
  },
  adversarial_nli: {
    label: 'ANLI',
    blurb: '对抗式的自然语言推理题：两句话之间是蕴含、矛盾还是无关。早期榜单。',
    category: '知识与推理',
    priority: 91,
    homepage: null,
  },
  forecastbench: {
    label: 'ForecastBench',
    blurb: '预测尚未发生的事件，事后按结果打分。测的是判断力而不是记忆力。',
    category: '知识与推理',
    priority: 45,
    homepage: 'https://www.forecastbench.org/',
  },
  deepresearchbench: {
    label: '深度研究',
    blurb: '给一个开放的研究课题，让模型上网查资料写出报告，由人评质量。',
    category: '知识与推理',
    priority: 48,
    homepage: null,
  },
  weirdml: {
    label: 'WeirdML',
    blurb: '一批刻意古怪的小型机器学习任务，模型要自己写代码训练并拿到成绩。考的是解决陌生问题的能力。',
    category: '知识与推理',
    priority: 58,
    homepage: 'https://htihle.github.io/weirdml.html',
  },

  // ── 智能体 ──
  metr_time_horizons: {
    label: '独立工作时长',
    blurb: 'METR 的时间跨度：模型能可靠独立完成的任务，换成人来做要花多久。单位是时间，越长说明能独立干越大的活。',
    category: '智能体',
    priority: 10,
    homepage: 'https://metr.org/',
  },
  os_world: {
    label: 'OSWorld 操作电脑',
    blurb: '在真实的电脑桌面上点鼠标敲键盘完成任务，比如改表格、发邮件。考的是能不能替你操作电脑。',
    category: '智能体',
    priority: 20,
    homepage: 'https://os-world.github.io/',
  },
  osworld_2: {
    label: 'OSWorld 2.0',
    blurb: 'OSWorld 的第二代题库，任务更长更杂，与第一代分数不可直接比较。',
    category: '智能体',
    priority: 21,
    homepage: 'https://os-world.github.io/',
  },
  osworld_2_partial: {
    label: 'OSWorld 2.0 部分得分',
    blurb: 'Anthropic 发布文里的 OSWorld 2.0 口径，完成一部分也给分。和 OpenAI 公布的离线集口径不是一回事，不能放在一起比。',
    category: '智能体',
    priority: 22,
    homepage: 'https://osworld-v2.xlang.ai/',
  },
  osworld_2_offline: {
    label: 'OSWorld 2.0 离线集',
    blurb: 'OpenAI 发布文里的 OSWorld 2.0 口径：离线题集的部分得分。和 Anthropic 公布的口径不是一回事，不能放在一起比。',
    category: '智能体',
    priority: 23,
    homepage: 'https://osworld-v2.xlang.ai/',
  },
  automationbench: {
    label: 'AutomationBench',
    blurb: 'Zapier 出的业务流程测试：用 47 个工具跑完销售、市场、客服、财务里的端到端流程。考的是能不能替你把一整套办公流程跑通。',
    category: '智能体',
    priority: 24,
    homepage: 'https://zapier.com/benchmarks',
  },
  agents_last_exam: {
    label: "Agents' Last Exam",
    blurb: '横跨 55 个细分行业的长流程专业工作，看智能体能不能独立干完一件有经济价值的活。',
    category: '智能体',
    priority: 25,
    homepage: 'https://agents-last-exam.org/',
  },
  terminal_bench_science: {
    label: 'Terminal-Bench 科研版',
    blurb: 'Terminal-Bench 的科研分支：在终端里独立完成科学研究类任务。',
    category: '智能体',
    priority: 26,
    homepage: 'https://www.tbench.ai/',
  },
  vending_bench_2: {
    label: '经营售货机',
    blurb: 'Vending-Bench：让模型经营一台虚拟售货机一整年——进货、定价、付租金。分数是最后账上的钱，考的是长期不犯糊涂。',
    category: '智能体',
    priority: 30,
    homepage: 'https://andonlabs.com/evals/vending-bench',
  },
  the_agent_company: {
    label: '虚拟公司实习',
    blurb: 'TheAgentCompany：在一家模拟的软件公司里干活——查文档、发消息、写代码、填表。考的是当员工的综合本事。',
    category: '智能体',
    priority: 40,
    homepage: 'https://the-agent-company.com/',
  },
  apex_agents: {
    label: 'APEX 专业任务',
    blurb: '投行、律所、咨询公司的真实工作任务，由业内专家出题与评分。',
    category: '智能体',
    priority: 45,
    homepage: null,
  },
  gdpval: {
    label: 'GDPval 职业任务',
    blurb: 'OpenAI 出的一组覆盖多个行业的真实职业任务，由专家把模型的产出与人类专业人士的成果盲比。分数是胜率。',
    category: '智能体',
    priority: 46,
    homepage: null,
  },
  rli: {
    label: '远程工作指数',
    blurb: 'Remote Labor Index：从自由职业平台上取的真实外包项目，看模型能独立交付多少。分数普遍很低，说明离「替代远程工作者」还远。',
    category: '智能体',
    priority: 47,
    homepage: null,
  },
  cybench: {
    label: 'Cybench 网络安全',
    blurb: '夺旗赛（CTF）风格的网络安全题，测攻防能力。',
    category: '智能体',
    priority: 60,
    homepage: 'https://cybench.github.io/',
  },
  exploitbench: {
    label: 'ExploitBench',
    blurb: '给一个真实的软件漏洞，看模型能不能写出利用代码。安全评测，不是日常能力。',
    category: '智能体',
    priority: 61,
    homepage: null,
  },
  posttrainbench: {
    label: 'PostTrainBench',
    blurb: '让模型自己去微调一个更小的模型，考的是「会不会炼丹」。',
    category: '智能体',
    priority: 65,
    homepage: null,
  },
  blueprint_bench_2: {
    label: 'BlueprintBench',
    blurb: '看房屋照片画出平面图，测空间理解与工程绘图能力。',
    category: '智能体',
    priority: 70,
    homepage: null,
  },
  cad_eval: {
    label: 'CAD 建模',
    blurb: '按文字描述生成三维 CAD 模型，考的是工程建模能力。',
    category: '智能体',
    priority: 71,
    homepage: null,
  },
  surface_evolver_bench: {
    label: 'Surface Evolver',
    blurb: '用一款专业的曲面数值软件完成计算任务，考的是驾驭陌生专业工具的能力。',
    category: '智能体',
    priority: 72,
    homepage: null,
  },

  // ── 长文本 ──
  fiction_live: {
    label: '长文本记忆',
    blurb: 'Fiction.liveBench：读一篇长小说后回答细节问题。很多模型号称能读百万字，实测读到一半就忘了前面。',
    category: '长文本',
    priority: 10,
    homepage: 'https://fiction.live/stories/Fiction-liveBench',
  },
  cl_bench: {
    label: 'CL-bench 长上下文',
    blurb: '在很长的上下文里做推理与检索，测的是长文本的实际可用程度。',
    category: '长文本',
    priority: 20,
    homepage: null,
  },
  cl_bench_life: {
    label: 'CL-bench 生活版',
    blurb: 'CL-bench 的日常生活场景分支。',
    category: '长文本',
    priority: 21,
    homepage: null,
  },

  /*
   * ── 生成类竞技场（LMArena，CC-BY 4.0）──
   *
   * 这几条补的是别处补不上的一块：图像与视频**生成**模型此前在站内一个分数都没有，
   * 因为它们清一色是闭源商业模型，学术基准要么只测开源、要么停在 2023 年那一代。
   *
   * 量纲是人类盲投的 Bradley-Terry 分，与学术评测的通过率不可比，所以各自单独成榜，
   * 不进综合智力。优先级排在多模态类目靠前，因为对这两类模型来说它是**唯一**的成绩。
   */
  arena_text_to_image: {
    label: '文生图竞技场',
    blurb: '同一句提示词让两个模型各画一张，真人盲选哪张更好，几百万次投票攒出的分。图像模型目前唯一的公开横评。',
    category: '多模态',
    priority: 1,
    homepage: 'https://arena.ai/leaderboard/text-to-image',
  },
  arena_text_to_video: {
    label: '文生视频竞技场',
    blurb: '同一句提示词生成两段视频，真人盲选。Veo、Sora、可灵这些闭源模型能放在一起比，靠的就是这种投票。',
    category: '多模态',
    priority: 2,
    homepage: 'https://arena.ai/leaderboard/text-to-video',
  },
  arena_image_edit: {
    label: '图像编辑竞技场',
    blurb: '给一张图加一句修改要求，看谁改得更合心意。考的是听懂指令并且只改该改的地方。',
    category: '多模态',
    priority: 3,
    homepage: 'https://arena.ai/leaderboard/image-edit',
  },
  arena_image_to_video: {
    label: '图生视频竞技场',
    blurb: '拿一张静态图让它动起来，真人盲选哪段更自然。',
    category: '多模态',
    priority: 4,
    homepage: 'https://arena.ai/leaderboard/image-to-video',
  },
  arena_video_edit: {
    label: '视频编辑竞技场',
    blurb: '给一段视频加一句修改要求，看谁改得更好。',
    category: '多模态',
    priority: 5,
    homepage: 'https://arena.ai/leaderboard/video-edit',
  },
  arena_search: {
    label: '联网搜索竞技场',
    blurb: '带联网能力的模型回答时效性问题，真人盲选谁查得准、答得实在。',
    category: '智能体',
    priority: 40,
    homepage: 'https://arena.ai/leaderboard/search',
  },
  arena_document: {
    label: '文档理解竞技场',
    blurb: '丢一份文档进去提问，真人盲选谁读得更明白。',
    category: '长文本',
    priority: 40,
    homepage: 'https://arena.ai/leaderboard/document',
  },

  // ── 多模态 ──
  chartography: {
    label: 'Chartography 读图表',
    blurb: '看懂各种统计图表并回答问题，考的是从图里准确读出数字和趋势。',
    category: '多模态',
    priority: 5,
    homepage: null,
  },
  video_mme: {
    label: '视频理解',
    blurb: 'Video-MME：看一段视频回答问题，从几秒的短片到一小时的长片都有。',
    category: '多模态',
    priority: 10,
    homepage: 'https://video-mme.github.io/',
  },
  geobench: {
    label: '看图猜地点',
    blurb: 'GeoBench：给一张街景照片猜出在哪个国家。测的是视觉细节与地理知识。',
    category: '多模态',
    priority: 20,
    homepage: null,
  },
  vpct: {
    label: '视觉物理预测',
    blurb: 'VPCT：看一张小球与斜坡的图，预测球会滚进哪个杯子。测视觉直觉物理。',
    category: '多模态',
    priority: 30,
    homepage: null,
  },
  spatialviz_bench: {
    label: '空间想象',
    blurb: 'SpatialViz-Bench：折纸、旋转、拼接之类的空间想象题。',
    category: '多模态',
    priority: 31,
    homepage: null,
  },
  mindcube: {
    label: 'MindCube 空间',
    blurb: '从几张不同视角的照片里建立空间关系。',
    category: '多模态',
    priority: 32,
    homepage: null,
  },
  gbaeval: {
    label: 'GBA 游戏评测',
    blurb: '看画面操作掌机游戏，测的是视觉理解加实时决策。',
    category: '多模态',
    priority: 40,
    homepage: null,
  },

  // ── 游戏与谜题 ──
  chess_puzzles: {
    label: '国际象棋残局',
    blurb: '给一个棋局找出最佳着法。分数是解对的比例，随机乱走约 5 分。',
    category: '游戏与谜题',
    priority: 10,
    homepage: 'https://epoch.ai/benchmarks/chess-puzzles',
  },
  balrog: {
    label: 'BALROG 游戏',
    blurb: '玩 NetHack、我的世界之类的文字或像素游戏，看能推进多少进度。',
    category: '游戏与谜题',
    priority: 20,
    homepage: 'https://balrogai.com/',
  },
  mystery_game_puzzles: {
    label: '推理游戏谜题',
    blurb: 'Epoch 自建的一组推理小游戏，测的是在规则未知的环境里摸索规律。',
    category: '游戏与谜题',
    priority: 30,
    homepage: 'https://epoch.ai/benchmarks',
  },
  enigma_eval: {
    label: 'EnigmaEval',
    blurb: '解谜比赛里的复杂谜题，通常要综合图像、文字和多步推理。',
    category: '游戏与谜题',
    priority: 40,
    homepage: null,
  },
  ebr_bench: {
    label: 'EBR-bench',
    blurb: 'Epoch 自建的一项评测，具体口径以 Epoch 榜单页说明为准。',
    category: '游戏与谜题',
    priority: 50,
    homepage: 'https://epoch.ai/benchmarks',
  },
  btf3: {
    label: 'BTF3',
    blurb: '一项对策略游戏能力的评测。',
    category: '游戏与谜题',
    priority: 60,
    homepage: null,
  },

  // ── 写作 ──
  lech_mazur_writing: {
    label: '创意写作',
    blurb: 'Lech Mazur 的短篇写作评测：按给定元素写故事，由多个模型交叉评分。分数是 0–10 的均分换算成百分制。',
    category: '写作',
    priority: 10,
    homepage: 'https://github.com/lechmazur/writing',
  },
  gdp_pdf: {
    label: 'GDP PDF 报告',
    blurb: '一项对文档生成质量的评测。',
    category: '写作',
    priority: 30,
    homepage: null,
  },
};

/**
 * 管线里的榜单 id 与 Epoch 文件名偶有出入（`terminal_bench` vs `terminalbench`，
 * `aime` vs `otis_mock_aime_2024_2025`）。这里把 Epoch 的写法指回管线用的 id，
 * 别名本身不参与展示。
 */
const ALIASES: Record<string, string> = {
  terminalbench: 'terminal_bench',
  frontiercode: 'frontier_code',
  frontierswe: 'frontier_swe',
  webdev_arena: 'webdev_arena_elo',
  live_bench: 'livebench_coding',
  epoch_capabilities_index: 'eci',
  otis_mock_aime_2024_2025: 'aime',
  fictionlivebench: 'fiction_live',
};

/** 编程类直接从编程注册表派生，一处维护 */
function codingEntries(): Record<string, BenchmarkInfo> {
  const out: Record<string, BenchmarkInfo> = {};
  for (const [id, league] of Object.entries(CODING_LEAGUES)) {
    out[id] = {
      label: league.label,
      blurb: league.blurb,
      category: '编程',
      higherIsBetter: true,
      priority: league.priority,
      homepage: league.homepage,
    };
  }
  return out;
}

const REGISTRY: Record<string, BenchmarkInfo> = (() => {
  const table: Record<string, BenchmarkInfo> = {
    ...Object.fromEntries(
      Object.entries(GENERAL).map(([id, e]) => [id, { ...e, higherIsBetter: e.higherIsBetter ?? true }]),
    ),
    ...codingEntries(),
  };
  for (const [alias, target] of Object.entries(ALIASES)) {
    if (table[target] && !table[alias]) table[alias] = table[target];
  }
  return table;
})();

/**
 * 把 `os_world_2` 这样的 id 变成 `Os World 2`。
 * 只在兜底路径上用——收录过的榜单一律以注册表里的中文名为准。
 */
function prettifyId(id: string): string {
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((w) => (w.length <= 3 && !/^\d+$/.test(w) ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1)))
    .join(' ');
}

/**
 * 同一个榜单在 `coding[]` 与 `scores[]` 里可能用不同的 id（`webdev_arena_elo` / `webdev_arena`）。
 * 统一到编程注册表的写法，否则同一个榜会在排行榜上开成两条赛道。
 */
export function canonicalBenchmarkId(id: string): string {
  return ALIASES[id] ?? id;
}

/** 把榜单 id 转成可读档案。未收录时自动生成标签并归入「其他」，绝不抛错。 */
export function benchmarkOf(id: string): BenchmarkInfo {
  return (
    REGISTRY[id] ?? {
      label: prettifyId(id),
      blurb: 'Epoch AI 收录的评测，暂无中文说明。',
      category: '其他',
      higherIsBetter: true,
      priority: 500,
      homepage: null,
    }
  );
}

/** 这个榜单是不是编程类。编程成绩另有一张战绩表，「全部成绩」区块要把它们排除 */
export function isCodingBenchmark(id: string): boolean {
  return benchmarkOf(id).category === '编程';
}
