# Pi / Claude 后端 Parity 审计

- 日期：2026-10-28
- 范围：`packages/shared/src/agent/`（只读扫描，关键行已抽查）
- 结论：**Pi 不是 Claude 的完全超集；Pi 缺一个关键能力（跨轮后台事件 sink / keep-alive），但缺口窄、可修。推荐保留双后端；若必须 Pi-only，按 1→2→3 修；不建议拷贝两者自研。**

## 1. 契约层

`AgentBackend`（`backend/types.ts:349-689`）有 37 个必需成员、7 个可选成员、9 个回调属性。其中约 33 个由共享基类 `BaseAgent` 提供；`ClaudeAgent` 和 `PiAgent` 各自只实现 7 个抽象方法：

`chatImpl`、`abort`、`forceAbort`、`runMiniCompletion`、`isProcessing`、`respondToPermission`、`queryLlm`。

工厂 `backend/factory.ts:59-62,128-137` 只有 `anthropic` / `pi` 两个 driver；默认后端是 Claude。

## 2. 关键能力矩阵

| 能力 | Claude | Pi | 判定 |
|---|---|---|---|
| 原生 Bash | SDK preset `claude_code` | 自带 bash/read/write/edit/grep/find/ls | 对等（实现不同） |
| Task/Skill/Agent | 主动禁用 `Skill`/`Task`/`Agent`/`Workflow` | 仅做名字映射 | 双方不用，无差距 |
| MCP | `createSdkMcpServer` | `register_tools` + JSON Schema | Pi 已等价替换 |
| 权限 / Safe Mode | PreToolUse hook | 子进程 `requestPreToolUseApproval` + 主进程 `runPreToolUseChecks`；共用 `core/pre-tool-use.ts` | 对等 |
| 认证 / 模型 | `postInit` 解析 env + `/v1/models` | spawn 前解析凭据 + 热切换 / `updateRuntimeConfig` | Pi 更灵活 |
| thinking | `resolveClaudeThinkingOptions` | `THINKING_TO_PI` + `setThinkingLevel` | 对等 |
| compaction | 仅 `/compact` 斜杠命令；无 `compact()` | `compact()` + `compaction-policy` / `forced-compaction` | **Claude 缺主动入口** |
| summary / memories | 基类 `extractSessionMemories` | 同 | 对等 |
| session branching | SDK `resume + forkSession` | `ensureBranchReady` + `branch-fork` | 对等 |
| subagent / skills | 基类 `[skill:slug]` + `PrerequisiteManager` | 同 | 对等 |
| plan | `SubmitPlan` session tool | 同 | 对等 |
| verification / defense | 无 | `pi-agent.ts:1224` + `pi-agent-server/src/defense/` | **Pi 独有** |
| sources / browser | SDK MCP proxy | `mcpPool` + `executeBrowserToolCommand` | 对等；Claude 多一层 SDK 包装 |
| 图片 / 附件 | `chat(message, attachments)` | `prompt` 带 `images[]` | 对等 |
| turn log / recovery | SDK transcript + `getRecoveryMessages` | `flushTurnLogs` + `turn-log.ts` / `progress-journal.ts` | **Pi 独有** |
| background sink / keep-alive | `setBackgroundEventSink` (`claude-agent.ts:675`) + `keepBackgroundTasksAlive` (`:521/1659/2322`) | **无** | **关键缺口** |
| queue / redirect / interrupt | `pendingSteerMessage`；SDK `interrupt()` | 真 `steer` 注入；handoff 退化为 `forceAbort` | Pi 更强，handoff 更粗 |
| title generation | 基类 `generateTitle` / `regenerateTitle` | 同 | 对等 |

### Pi 缺口（按影响排序）

1. **`setBackgroundEventSink` / keep-alive 缺失**：跨轮的后台任务事件无法推送；Pi 目前靠 idle reaper 回收/重生成。这是唯一有产品语义风险的缺口。
2. **无 `postInit` 认证注入**：`authInjected` 恒为 `true`，认证失败告警链路在 Pi 路径上不生效。
3. **`interruptForHandoff` 退化为 `forceAbort`**：计划提交/授权请求的协作式中断在 Pi 上变成硬断。
4. **连接预校验缺失**：`factory.ts:786-788` 对 Pi 直接返回 success；Claude 走真实 `query()` 探活。

### Claude 的反向缺口

`compact()` 主动入口、Pi 的 defense/verification、turn-log/progress-journal、idle reaper 等 Pi 独有能力，删掉 Claude 不会丢失；但 Claude 的 SDK transcript 恢复、`persistent-input` keep-alive、`guardLargeResult` 等会丢失。

## 3. 共享 SDK 耦合

直接 import `@anthropic-ai/claude-agent-sdk` 的文件（14 处）：

| 类别 | 文件:行 | 说明 |
|---|---|---|
| Claude 专属 | `claude-agent.ts:1` | `query`/`createSdkMcpServer`/`tool`/SDK 类型 |
| | `backend/claude/event-adapter.ts:15` | 仅 SDK 类型 |
| | `options.ts:1` | 仅 `Options` 类型 |
| | `claude-llm-query.ts:8`、`claude-sdk-error-mapper.ts:1` | 仅 SDK 类型 |
| 共享工具（Pi-only 必须迁移） | `browser-tools.ts:13` | SDK `tool()` 包装 |
| | `llm-tool.ts:17` | SDK `tool()` 包装 |
| | `session-scoped-tools.ts:18` | `createSdkMcpServer` + `tool` |
| | `spawn-session-tool.ts:12` | SDK `tool()` 包装 |
| | `sources/api-tools.ts:8` | `createSdkMcpServer` + `tool` |
| | `sources/server-builder.ts:18` | `createSdkMcpServer` |
| 隐藏调用 | `config/llm-validation.ts:11,76` | `query()` 连接探活 |
| | `validation/url-validator.ts:8,80` | `query()` 做 URL 校验 |
| 测试 / 依赖 | `__tests__/query-llm-partial-output.test.ts:15`、`packages/shared/package.json:94` | |

已解耦、两后端共用的部分：`session-scoped-tool-callback-registry.ts`、`core/pre-tool-use.ts`、`mode-manager.ts`、`prompt-builder.ts`、`source-policy.ts`、`browser-tool-runtime.ts`、`claude-context.ts`（命名误导，Pi 也在用）。

## 4. Pi-only 的迁移阻塞点

1. **2 个隐藏 `query()` 调用**：`config/llm-validation.ts:76`、`validation/url-validator.ts:80`；删 SDK 后连接探活/URL 校验必须改写，否则退化为“永远 success”。中等工作量，无架构风险。
2. **6 个共享工具的 SDK 包装**：`browser-tools.ts`、`llm-tool.ts`、`session-scoped-tools.ts`、`spawn-session-tool.ts`、`sources/api-tools.ts`、`sources/server-builder.ts`。都是薄包装；底层 handler 已在 `session-tools-core`，Pi 已有 `backend/pi/session-tool-defs.ts` 的 JSON-Schema 代理范式。机械但量大。
3. **background event sink / keep-alive 归零**：唯一实现者是 Claude；Pi 需要补跨轮事件通道，或显式降级为 idle reaper。**唯一有产品语义风险的缺口。**
4. **`postInit` / `interruptForHandoff` / 连接预校验**：小改动，但需要补。

## 5. 拷贝两者自研 NativeAgent 的评估

体量：`claude-agent` 141KB + `pi-agent` 181KB + 两个 event-adapter 106KB + `pi-agent-server` 202KB ≈ **630KB**；共享基类 `base-agent` 66KB + 契约 `types.ts` 25KB 已是最大公约数。

已有 4 个对偶测试守护两后端一致性：`backend/pi/session-tool-parity.test.ts`、`backend/claude/session-tool-parity.test.ts`、`pi-event-adapter`、`claude-event-adapter`。这说明差异是已知且被测试钉住的。

两个后端的差异是真差异（SDK 子进程 vs 自研子进程；SDK 原生 Bash vs 自带 bash；keep-alive vs idle-reaper），不是历史包袱。合成一个类只能靠 `if (provider === ...)` 分叉，等价于把类继承换成分支判断，收益为负。

**结论：拷贝两者自研是成本最高、一致性风险最大、且与“删依赖减代码”目标相反的方案。**

## 6. 建议

- **A（推荐）保留双后端**：Claude 作为可选依赖（`apps/electron/package.json` 已标 `--external`），Pi 继续用自有执行器/30s 自动转后台。把“去 SDK”降级为“让 Pi 在无 SDK 时功能完整”，单独立项做 1+2。
- **B（若必须 Pi-only）**：按 1→2→3 修；keep-alive 若必须支持，给 Pi 加跨轮事件通道，否则显式降级为 idle reaper，并作为产品决策记录。
- **C（不推荐）**：拷贝两者自研 NativeAgent。

### 唯一需要产品侧先拍板的点

`setBackgroundEventSink` / keep-alive（后台任务跨轮事件）在 Pi 上是否必须支持。这是决定 A/B 之外还能否走 Pi-only 的关键闸门。

## 7. 证据说明

本报告基于只读扫描；关键行已抽查：`setBackgroundEventSink` 仅 `claude-agent.ts:675`，`keepBackgroundTasksAlive` 仅 `claude-agent.ts:521/1659/2322`，`compact()` 仅 `pi-agent.ts:3012`。其余矩阵项来自 `backend/types.ts`、`backend/factory.ts`、`claude-agent.ts`、`pi-agent.ts`、`base-agent.ts`、`backend/pi/*`、`pi-agent-server/src/*` 的审计结果。
