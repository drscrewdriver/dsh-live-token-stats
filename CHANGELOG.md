# Changelog

本文件记录本 fork 的变更。上游 `better-er/dsh-live-token-stats` 的发布节奏以提交信息为准，本文件从本 fork 开始维护。

## [0.4.4-beta.1] 修复投影无损 JSON 边界 · 改为提交构建产物

### Fixed

- **投影状态不再写出 `undefined` 值字段**：`step/end` 结算时若该 step 从未收到官方 usage（被 kill / 中断），`actualTokens` 曾以 `undefined` 值写进 `lastSettled`，使整个投影状态不再是无损 JSON。
  这一个字段会同时打穿三层：
  1. 宿主转发 `api-session/added` 时 `assertJsonArgs` 抛 `not lossless JSON data` → 客户端收不到会话条目，列表里消失 / 闪跳；
  2. `session/fork` 的 create-publish 整体回滚 → 点 fork 无任何反应（客户端侧又被 `.catch(() => {})` 吃掉）；
  3. 投影缓存按整条记录写、不做字段级降级 → 缓存停在旧 seq，每次打开都从旧状态重算。
  会话内容本身仍可阅读（冷读走 JSON 序列化会自然丢弃 `undefined` 值键），所以现象是「能看见内容但不能接续使用」。
- **改走 git 安装不再被 pnpm 拦构建**：去掉 `prepare` 脚本并随仓库提交 `lib/`。原来从 git 安装时 pnpm 报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`，放行需要往 `pnpm-workspace.yaml` 的 `allowBuilds` 加一条含 codeload 地址与 commit SHA 的键，且**每推一次 commit 就失效一次**；同时为跑构建还要拉整棵 devDependency 树（实测 3741 文件 / 83.8 MB）。现在安装端零构建、免白名单。

### Added

- `src/compact.ts`：无损 JSON 边界工具。
  - `omitUndefined()`：剔除值为 `undefined` 的键；无变化时返回原引用，保持 `apply` 的「无变化即同引用」语义。
  - `findNonJsonPath()` / `isJsonValue` 同口径的违规定位（`undefined`、非有限数、`-0`、稀疏洞、非普通原型、函数 / Symbol / BigInt、循环引用）。
  - `assertLosslessJson()`：开发期自检，`off` / `warn` / `throw` 三档；主机侧接插件 `debug` 开关走 `warn`（带违规路径、按指纹去重），测试侧用 `throw`。
- `tests/lossless.spec.ts`：12 个用例守住这条边界（无 usage 结算、`turn/end` 中断、日志结尾停在 open step、`viewSchema` 往返、历史污染状态的出口清理、断言档位）。

### Changed

- `src/projection.ts`：结算统一走 `settleStep()`，`activeStepView()` 出口再过一次无损边界。
- `src/live-stream.ts`：`debug` 开关同时打开投影无损自检。
- `package.json`：`repository` / `homepage` / `bugs` 从上游 `better-er/dsh-live-token-stats` 改为本 fork `drscrewdriver/dsh-live-token-stats`（此前装上去后任何读该字段的工具都会把人导去上游）。
- `.gitignore`：不再忽略 `lib/`，构建产物随仓库提交。
- 版本 `0.4.3` → `0.4.4-beta.1`：与 npm 上那个含缺陷的同号 0.4.3 区分开。

### Notes

- **不递增 `stateVersion`**：既未改字段语义也未改折叠语义，只是不再写出一个本就不该存在的值。
- 客户端以 `lastSettled.actualTokens !== undefined` 判断「有无实际值」，因此**不能**改用 `null` 或哨兵值表达无值，只能是键缺席。
- 历史会话无需迁移：污染只存在于内存态与缓存里，修复后宿主重折叠即得干净状态。

### 涉及会话（离线识别出的受影响集合）

`session-8c015d04…`、`session-1043bbd4…`、`session-a395e77d…`、`session-a3ab8a11…`、`session-12f8bbbf…`、`session-a09d17bd…`
