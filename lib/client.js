window.__ModuleLoader__.load({
	id: "dsh-live-token-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/LiveTokenStatsLine.tsx
		/**
		* dsh-live-token-stats 的浏览器端：composer 停靠区里的实时流读数。
		*
		* 三种状态，标签按产品惯例使用中文：
		*   - 生成中、首字已出：
		*       实时速度 ~53.0 tok/s | 平均速度 ~40.3 tok/s | 已停顿 2.5s | 实时输出 ~2,123 token | 首字延迟 1.2s
		*     实时速度是主机的窗口速率，TTFT 被折进跨度，跨度从 step 开始滑到窗口大小之后固定。
		*     平均速度是从请求发出的 step 级全程平均，含首字延迟与一切停顿，因此这一对能看出推流相对其自身平均值在提速还是减速。
		*     长停顿会让窗口样本过期，主机停止发速率，实时速度读数消失，只剩已停顿在走。
		*   - 等待首字：
		*       准确速度 28.7 tok/s | 估算 2,123 / 实际 1,966 (+8%) | 首字延迟 2.3s
		*     还没有 token 到达，所以没有实时速度与输出可显示，保留上一次结算的读数作为对照基线。
		*     首字延迟从 step 开始以 10 Hz 实时跳动，首字落地瞬间冻结为该 step 的精确 TTFT，同时状态切到生成中。
		*   - 空闲、上一步已结算，同样的结算读数，但首字延迟是上一步的结算 TTFT，作为静态对照基线。生成已停止但 step 未结束时也显示此态。
		*
		* @module dsh-live-token-stats/client
		*/
		/** 千分位整数 token 计数：517 / 1,234 / 12,300。 */
		function formatInt(n) {
			if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "0";
			return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}
		/** 100 tok/s 以下保留一位小数的 TPS。 */
		function formatTps(v) {
			if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return "";
			return v < 100 ? String(Math.round(v * 10) / 10) : String(Math.round(v));
		}
		/** 紧凑时长：45.2s / 2m42s。 */
		function formatDuration(ms) {
			if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
			const s = ms / 1e3;
			if (s < 60) return `${Math.round(s * 10) / 10}s`;
			const whole = Math.round(s);
			return `${Math.floor(whole / 60)}m${whole % 60}s`;
		}
		/** 估算减实际的带符号整数百分比，如 "+12%"。精确相等显示 "±0%"，四舍五入为 0 但仍有方向时保留正负向的 "+0%" / "-0%"。 */
		function formatGapPct(estimated, actual) {
			if (typeof estimated !== "number" || typeof actual !== "number" || !Number.isFinite(estimated) || !Number.isFinite(actual) || actual <= 0) return "";
			const pct = (estimated - actual) / actual * 100;
			const rounded = Math.round(pct);
			if (rounded === 0) {
				if (estimated === actual) return "±0%";
				return pct >= 0 ? "+0%" : "-0%";
			}
			return `${pct >= 0 ? "+" : ""}${rounded}%`;
		}
		/** 请求序号，用于 client-request/server-response 的 rpcId 配对。 */
		let rpcIdCounter = 0;
		/**
		* 直接向插件自注册通道发一次 snapshot 请求，复用官方信封，绕开取不到的 connection.rpc。
		* @param sessionId - 目标会话。
		* @returns 快照，任何非成功路径都返回 null。
		*/
		async function callSnapshot(sessionId) {
			const rpcId = "lts-" + String(++rpcIdCounter);
			const response = await fetch("/dsh-live-token-stats/snapshot", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "client-request",
					rpcId,
					method: "snapshot",
					payload: { sessionId }
				})
			});
			if (!response.ok) return null;
			const full = await response.json();
			if (full.type !== "server-response" || full.rpcId !== rpcId) return null;
			return full.result?.ok === true ? full.result.value ?? null : null;
		}
		/**
		* 实时快照拉取：向主机 `/dsh-live-token-stats` 通道轮询本会话数据。
		* 主机在每次轮询时按当下时刻计算速率，因此流停顿期间数值也在移动，无需本地计时。
		* 模型生成中约 10 Hz，step 仍在但生成已停的工具阶段降到约 2 Hz，空闲只留 5 秒一次的兜底探测，基本不产生空转流量。
		* dsh 0.1.5-rc.2 起会话投影不再有实时增量，投影的 active 只用来判断 step 是否在跑，实时数值仍取自快照。
		*/
		function useLiveSnapshot(sessionId, active) {
			const [live, setLive] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let disposed = false;
				let timer;
				const poll = async () => {
					let delayMs = active ? 100 : 5e3;
					try {
						const data = await callSnapshot(sessionId);
						if (disposed) return;
						setLive(data);
						if (data?.generating === true) delayMs = 100;
						else if (active) delayMs = 500;
					} catch {
						if (disposed) return;
						setLive(null);
					}
					if (!disposed) timer = setTimeout(() => void poll(), delayMs);
				};
				poll();
				return () => {
					disposed = true;
					if (timer !== void 0) clearTimeout(timer);
				};
			}, [sessionId, active]);
			return live;
		}
		/** 三态实时读数行；没有任何实时内容可显示时渲染为空。 */
		const LiveTokenStatsLine = (0, react.memo)(function LiveTokenStatsLine({ useProjection, sessionId }) {
			const live = useProjection("liveTokenStats");
			const active = live?.active ?? null;
			const lastSettled = live?.lastSettled ?? null;
			const liveSnap = useLiveSnapshot(sessionId, active !== null);
			const generating = liveSnap?.generating === true;
			const firstTokenDelay = liveSnap?.firstTokenDelayMs;
			const liveRate = liveSnap?.tokensPerSecond;
			const stallMs = liveSnap?.stallMs ?? 0;
			const startTime = active?.startTime;
			const waiting = generating && firstTokenDelay === void 0;
			const groups = [];
			const settledGroups = () => {
				const out = [];
				if (lastSettled === null) return out;
				const durMs = lastSettled.endTime - lastSettled.startTime;
				if (durMs > 0) {
					const tokens = lastSettled.actualTokens !== void 0 ? lastSettled.actualTokens : lastSettled.estimatedTokens;
					const mark = lastSettled.actualTokens !== void 0 ? "" : "~";
					out.push(`准确速度 ${mark}${formatTps(tokens / (durMs / 1e3))} tok/s`);
				}
				if (lastSettled.actualTokens !== void 0) out.push(`估算 ${formatInt(lastSettled.estimatedTokens)} / 实际 ${formatInt(lastSettled.actualTokens)} (${formatGapPct(lastSettled.estimatedTokens, lastSettled.actualTokens)})`);
				else out.push(`估算 ~${formatInt(lastSettled.estimatedTokens)} token`);
				return out;
			};
			if (generating && firstTokenDelay !== void 0) {
				if (liveRate !== void 0) groups.push(`实时速度 ~${formatTps(liveRate)} tok/s`);
				if (stallMs > 0) groups.push(`已停顿 ${formatDuration(stallMs)}`);
				const out = liveSnap?.outputTokens ?? 0;
				groups.push(`实时输出 ${liveSnap?.exact === true ? "" : "~"}${formatInt(out)} token`);
				if (liveSnap?.avgTokensPerSecond !== void 0) groups.push(`平均速度 ${liveSnap.exact === true ? "" : "~"}${formatTps(liveSnap.avgTokensPerSecond)} tok/s`);
				groups.push(`首字延迟 ${formatDuration(firstTokenDelay)}`);
			} else if (waiting) {
				groups.push(...settledGroups());
				const elapsedMs = startTime !== void 0 ? Date.now() - startTime : liveSnap?.elapsedMs;
				if (elapsedMs !== void 0) groups.push(`首字延迟 ${formatDuration(elapsedMs)}`);
			} else if (lastSettled !== null) {
				groups.push(...settledGroups());
				if (lastSettled.firstTokenTime !== null) groups.push(`首字延迟 ${formatDuration(lastSettled.firstTokenTime - lastSettled.startTime)}`);
			} else if (liveSnap !== null && (liveSnap.outputTokens ?? 0) > 0) {
				const out = liveSnap.outputTokens ?? 0;
				groups.push(`输出 ${liveSnap.exact === true ? "" : "~"}${formatInt(out)} token`);
				if (liveSnap.firstTokenDelayMs !== void 0) groups.push(`首字延迟 ${formatDuration(liveSnap.firstTokenDelayMs)}`);
			}
			if (groups.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LiveStatsRow, { segments: ["空闲 · 发起对话后显示实时速度 / 输出 / 首字延迟"] });
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)(LiveStatsRow, { segments: groups });
		});
		/**
		* 单行统一样式容器，结构与 dsh 原生的结算统计行一致：
		* 根容器一个 div，每个指标块是独立 span，块与块之间用 aria-hidden 的 `|` 分隔 span 隔开，末尾不带分隔符。
		* 复刻时保留语义 token，不使用颜色字面量。
		*/
		/** 分隔符 span 的样式：比正文更淡的次级分隔点，避免喧宾夺主。 */
		const SEP_STYLE = {
			color: "var(--dsw-alias-label-tertiary)",
			whiteSpace: "nowrap"
		};
		/** 根容器样式：一行次级小字，数值等宽对齐，块间与块内留出呼吸感。 */
		const ROOT_STYLE = {
			display: "flex",
			alignItems: "center",
			gap: "12px",
			flexWrap: "wrap",
			padding: "0 12px",
			color: "var(--dsw-alias-label-tertiary)",
			fontSize: "13px",
			fontVariantNumeric: "tabular-nums",
			lineHeight: "18px",
			whiteSpace: "nowrap"
		};
		function LiveStatsRow({ segments }) {
			const nodes = [];
			for (const [i, seg] of segments.entries()) {
				if (i > 0) nodes.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					"aria-hidden": "true",
					style: SEP_STYLE,
					children: "|"
				}, "sep-" + i));
				nodes.push(/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: seg }, "seg-" + i));
			}
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				"data-dsh-live-token-stats": "true",
				style: ROOT_STYLE,
				children: nodes
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** 插件名即配置项 id。 */
		const name = "dsh-live-token-stats";
		/** 本插件需要的客户端服务：只需槽位，实时数据直接打插件通道。 */
		const inject = ["slots"];
		/**
		* 把读数注册进 composer 停靠区。
		* 停靠区所属方提供会话作用域的 `useProjection` 座位和 `sessionId`。
		* @param ctx - 客户端根上下文。
		*/
		function apply(ctx) {
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "dsh-live-token-stats",
				order: 10
			}, LiveTokenStatsLine));
		}
		//#endregion
		exports.LiveTokenStatsLine = LiveTokenStatsLine;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
