import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/dsh-client-connection";
import { Context } from "@deepseek-ai/cordis";
import { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import "@deepseek-ai/dsh-session";
import { StreamChunk } from "@deepseek-ai/dsh-llm";
//#region src/estimator.d.ts
/**
 * 用于实时输出 token 计数的双密度 Unicode 估算器。
 *
 * 官方 usage 到达时以官方为准，在此之前按字符密度给流式增量计价，区分 ASCII 与 CJK。
 * 当前经验值 1 token 约等于 3.33 个 ASCII 字符或 1.67 个 CJK 字符，即 ASCII 每字符 0.3 token、CJK 每字符 0.6 token。
 * 两种密度均可配置、绝不写死，这里的一切都是其参数的纯函数，便于单元测试与确定性地折叠。
 *
 * @module dsh-live-token-stats/estimator
 */
/** 计数模式：bpe 为真实 BPE 分词且默认采用，density 为旧的双密度盲估。 */
type TokenizerMode = 'bpe' | 'density';
/** 默认密度的估算器配置，同时是 Config schema 的来源。 */
interface EstimatorSpec {
  /** 每 token 对应的 ASCII 字符数。 */
  readonly asciiTokenPerChar: number;
  /** 每 token 对应的 CJK 字符数。 */
  readonly cjkTokenPerChar: number;
  /** 实时 TPS 速率的滑动窗口，单位为毫秒。 */
  readonly rateWindowMs: number;
  /** 计数模式：bpe 为真实 BPE 切分，density 为双密度盲估。 */
  readonly tokenizerMode: TokenizerMode;
}
/** 允许只提供部分部署配置；缺失项用默认值补齐。 */
type EstimatorConfig = Partial<EstimatorSpec>;
/** 默认值，导出供测试与 Config schema 默认值使用。 */
declare const ESTIMATOR_DEFAULTS: Readonly<EstimatorSpec>;
/**
 * 把部署配置解析并校验成完全带默认值的 spec。
 *
 * 未知 key 一律忽略而非拒绝。
 * 本函数在 cordis 插件的 `apply` 内运行，loader 会把 schema 带默认值的 key 如 `enabled` 注入我们收到的同一个 config 对象。
 * 把注入的 key 当作硬错误会让整个插件树加载中断，所以只消费已知的估算器 key，其余的一律丢弃。
 * 严格拒绝逻辑放在单元测试里，那里由调用方掌控输入。
 * 数值密度仍会做范围校验，避免脏数据污染实时估算。
 */
declare function resolveSpec(config?: EstimatorConfig): Readonly<EstimatorSpec>;
//#endregion
//#region src/tokenizer/incremental.d.ts
/**
 * 跨 delta 的增量 BPE 切分：维护「未完成尾段」的纯 fold 状态。
 *
 * 与一次性整段切分的一致性论证：
 *   BPE 合并只发生在 pre-token 段内部，追加文本只会扩展或改变最后一段。
 *   因此把除尾段外的段落立即结算进基线，只重切「尾段 + 新帧」即可。
 *   已结算段不再参与重切，数学上等价，避免每帧全量 O(buffer) 的正则扫描成本，尤其是无空白长段的 alternation 回溯。
 *   任何时刻的 total() 与整段一次性切分逐 token 一致，段边界随追加变化时旧尾段未入账，重切后按新段结算。
 *
 *   added token 的匹配会跨越多个段，若已结算段被后续帧补全成 added 匹配则计数将偏高。
 *   因此只把文本末尾确实处于某 added 前缀匹配中的部分保留在未结算窗口内。
 *   待后续帧补全或确认中断，前缀一旦断开窗口立即关闭。
 *   普通文本没有未闭合前缀时窗口只含尾段，行为与旧版完全一致。
 *
 * 状态是纯 JSON { buffer, counted }，可持久化、可重放，满足投影约束。
 *
 * @module dsh-live-token-stats/tokenizer/incremental
 */
/** 增量切分状态，纯 JSON 可序列化，随事件序列确定演化。 */
interface IncrementalState {
  /** 未结算的尾段文本，追加文本后会被重切。 */
  buffer: string;
  /** 已结算 token 数，即 buffer 之前的全部段落。 */
  counted: number;
}
//#endregion
//#region src/tokenizer/unescape.d.ts
/**
 * 流式 JSON 反转义：把协议层加在 tool-call arguments 上的转义剥掉，还原模型真实生成文本。
 *
 * 背景见 DESIGN §10.6：官方 usage 数的是模型原始生成的 token 序列。
 * 模型生成工具调用时输出序列里的参数文本是解码形态，带真实换行符与真实引号，但 OpenAI 兼容协议把参数作为 JSON 字符串序列化进 SSE 时加了一层转义，即 `\n` 两字符、`\"`、`\\`、`\uXXXX`。
 * 我们逐帧拿到的是序列化后的转义原文，按原文 BPE 会系统性高估，参数越长、转义越密偏得越多，write 大 content 参数曾偏 −53。
 * 计数前把转义剥掉还原模型真实生成文本，偏差即回到「结构费」簇，负值清零。
 *
 * 流式约束：argumentsDelta 逐帧到达，转义序列可能跨帧，如 `\` 与 `n` 分帧、`\u` 后不足 4 位 hex。
 * 本模块维护一个悬空尾部状态，状态为纯 JSON，只可能是 `'\'` 或 `'\u'` 加 0~3 位 hex，下一帧拼上后继续解码。
 * 纯函数、可持久化、可重放，满足投影约束。
 *
 * @module dsh-live-token-stats/tokenizer/unescape
 */
/** 流式反转义状态：上一帧留下的未决尾部。 */
interface UnescapeState {
  /** 悬空尾部：`'\'` 等待下一字符，或 `'\u'` 加 0~3 位 hex 等待补全。 */
  tail: string;
}
//#endregion
//#region src/projection.d.ts
/** 在会话投影映射表里声明我们的 key，可合并扩展。 */
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** 当前正在流式输出或刚结算步骤的实时与时间性 token 数据。 */
    liveTokenStats: LiveTokenStatsProjection;
  }
  interface SessionProjectionStateMap {
    /** 支撑 liveTokenStats 客户端视图的持久化折叠状态。 */
    liveTokenStats: LiveTokenStatsState;
  }
}
/** 一步的 token 数据，含实时启发式估算以及官方 usage 落地后的实际值。
 * 两者都保留，以便步骤结束后展示估算值与实际值的结算偏差。 */
interface LiveStepFacts {
  turn: number;
  step: number;
  /** step 开始的墙钟时间，单位为 epoch 毫秒。 */
  startTime: number;
  /** 首 token 墙钟时间，单位为 epoch 毫秒，首字到来前为 null。 */
  firstTokenTime: number | null;
  /** 实时输出 token 启发式估算，逐 delta 累加。 */
  estimatedTokens: number;
  /** 官方上报的输出 token 数，usage 落地后才有值。 */
  actualTokens?: number;
  /** 官方 usage 是否已上报。 */
  exact: boolean;
}
/** 为 liveTokenStats key 提供的线上值。 */
interface LiveTokenStatsProjection {
  /** 当前正在流式输出的步骤，空闲时为 null。 */
  active: LiveStepFacts | null;
  /** 最近已结算的步骤，保留以避免闪烁。 */
  lastSettled: (LiveStepFacts & {
    endTime: number;
  }) | null;
}
/** 整个投影的不可变纯 JSON 状态。 */
interface LiveTokenStatsState {
  activeStep: ActiveStepState;
}
interface ActiveStepState {
  active: LiveTokenStatsProjection['active'];
  lastSettled: LiveTokenStatsProjection['lastSettled'];
  /** BPE 增量切分状态，纯 JSON，density 模式保持初始态不增长。 */
  inc: IncrementalState;
  /** tool-call 参数反转义状态，即跨 delta 帧的悬空尾部，纯 JSON 可重放。 */
  esc: UnescapeState;
  /** 已计入 name token 的工具调用 id，同一调用跨帧只计一次，纯 JSON 可重放。 */
  nameCountedIds: string[];
}
/**
 * 注册表客户端可见的 register 重载所要求的具体承载 wire 的定义形态。
 * SessionProjectionMap 里的 key 必须有 wire。
 */
type LiveTokenStatsDefinition = Omit<ProjectionDefinition<'liveTokenStats', LiveTokenStatsState>, 'wire'> & {
  wire: NonNullable<ProjectionDefinition<'liveTokenStats', LiveTokenStatsState>['wire']>;
};
/**
 * 创建可重放的 liveTokenStats 投影定义。
 * @param spec - 已解析的估算器 spec。
 * @returns 供 sessionProjections.register() 使用的投影定义。
 */
declare function createLiveTokenStatsDefinition(spec: Readonly<EstimatorSpec>): LiveTokenStatsDefinition;
//#endregion
//#region src/live-stream.d.ts
/** 提供给客户端、针对某个会话的实时快照。 */
interface LiveTokenSnapshot {
  /**
   * 实时速度 tok/s：窗口内累计 token 除以跨度。
   * 跨度取自 step 开始流逝时间与窗口定值的较小值，即刚开始时含首字延迟随窗口滑动爬升，首字延迟摊完且流逝超过窗口后固定为窗口定值。
   * 超窗无样本则无值。
   */
  tokensPerSecond?: number;
  /** 最新折叠样本的墙钟 epoch 毫秒，客户端从这里开始衰减。 */
  updatedAt: number;
  /** 累计停顿毫秒，含生成中正在进行的当前停顿，间隔达 STALL_GRACE_MS 才计；流结束后冻结，不再累加工具执行等非生成时间。 */
  stallMs: number;
  /** 距上一次 delta 样本的毫秒数，0 表示刚有数据，用于观察当前卡了多久。 */
  sinceLastMs: number;
  /** 该 step 的模型生成是否仍在进行；流结束后为 false，客户端据此切到空闲态而非继续显示生成中。 */
  generating: boolean;
  /** 本 step 累计输出 token：官方 usage 已到则用实际值，否则为估算。 */
  outputTokens?: number;
  /** outputTokens 是否为官方 usage 实际值。 */
  exact?: boolean;
  /** 首 token 相对 step 起点的延迟毫秒，尚未出首字时缺省。 */
  firstTokenDelayMs?: number;
  /** 本 step 已流逝毫秒。 */
  elapsedMs?: number;
  /** 本 step 全程平均速度 tok/s，含首字延迟与停顿。 */
  avgTokensPerSecond?: number;
}
/**
 * 实时的每会话 token 速率追踪器。
 * 单线程即单一主机进程，`llm/stream` 按请求串行，因此映射无需加锁。
 */
declare class LiveTokenRateTracker {
  private readonly spec;
  private readonly cells;
  constructor(spec: Readonly<EstimatorSpec>);
  /** 把一个 adapter chunk 折叠进其会话的速率单元。相对流本身为纯函数。 */
  fold(sessionId: string | undefined, chunk: StreamChunk, timeMs: number): void;
  /**
   * 每次 llm/stream 拦截到就调用。同一会话的模型输出会被拆成多条 llm/stream 且时间交错，
   * 前缀/预热流与主内容流重叠，若每条都重置 cell，前缀流的 endStep 会误杀仍在流的主内容流。
   * 因此用存活流计数建模：首条流从 0 起算，全新 step 才全量重置；后续并存流只递增计数，
   * 保留已在累积的主内容样本，计数归零才视为生成结束。startAt 为拦截时刻，TTFT 由此起算。
   */
  beginStep(sessionId: string, startAt: number): void;
  /**
   * 标记本 step 的 llm/stream 已结束。
   * 生成结束后浏览器仍在轮询，若保持「生成中」状态会把工具执行等非生成时间误计入进行中的停顿，
   * 因此流结束后 `snapshot` 冻结累计停顿，不再累加 idle 时间。
   */
  endStep(sessionId: string): void;
  /**
   * 按 `asOf` 时刻给单元做实时速率快照，`asOf` 缺省为 `Date.now()`。
   * 跨度恒 ≤ 窗口大小：开始阶段取 step 开始后的流逝时间，首字延迟随窗口滑动爬升，流逝超过窗口后固定为窗口定值。
   * 停顿超窗后无样本，速率不外发，数学上未定义，客户端显示 0 兜底；stallMs 同步计入进行中的停顿。
   */
  snapshot(sessionId: string, asOf?: number): LiveTokenSnapshot;
  /** 丢弃一个会话的单元，例如 turn/end 或不再需要时。 */
  reset(sessionId: string): void;
}
/**
 * 安装主机端：拦截 `llm/stream` 并挂载 RPC 通道。
 * @param ctx - 主机插件上下文，与 `apply` 用的是同一个上下文。
 * @param spec - 已解析的估算器 spec。
 * @param debug - 诊断日志开关，默认关；开启时把每流完整 delta 序列与官方 usage 对照记录到 ~/.dsh/dsh-live-token-stats-debug.jsonl，关闭时拦截器零额外开销。
 * @returns 追踪器供测试与善后使用，以及一个销毁器。
 */
declare function installHostLiveStream(ctx: Context, spec: Readonly<EstimatorSpec>, debug?: boolean): {
  tracker: LiveTokenRateTracker;
  dispose: () => void;
};
//#endregion
//#region src/index.d.ts
/** 插件名即 cordis 配置项 id。 */
declare const name = "dsh-live-token-stats";
/** 本插件需要的主机服务。 */
declare const inject: string[];
/** 插件配置：估算器密度参数外加一个总开关。 */
interface Config extends EstimatorConfig {
  /** 整套能力的总开关。 */
  enabled?: boolean;
  /**
   * 诊断日志开关，默认关，发布零污染。
   * 开启后在 ~/.dsh/dsh-live-token-stats-debug.jsonl 记录每流完整 delta 序列并与官方 usage 对照，用于定位估算偏差。
   * 关闭时拦截器零开销。
   * 也可用环境变量 DSH_LIVE_TOKEN_STATS_DEBUG=1 开启，免改配置。
   */
  debug?: boolean;
}
/** {@link Config} 的运行时 schema，默认值由 loader 应用。 */
declare const Config: z<Config>;
/**
 * 注册 liveTokenStats 投影与实时主机→客户端通道。
 * @param ctx - 主机插件上下文。
 * @param config - 已解析的插件配置，schema 默认值由 loader 应用。
 */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, ESTIMATOR_DEFAULTS, LiveTokenRateTracker, type LiveTokenSnapshot, type LiveTokenStatsProjection, type LiveTokenStatsState, apply, createLiveTokenStatsDefinition, inject, installHostLiveStream, name, resolveSpec };