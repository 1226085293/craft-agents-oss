# 自动化子系统移除清单（B7）

> 状态：未执行。B1–B6 与 B5b 已完成并验证，本文档只记录 B7 的执行依据。
> 生成方式：对 `packages/shared/src`、`packages/server-core/src`、`packages/session-tools-core/src`、`apps/electron/src`
> 全量检索 `automation` 得到 1861 处引用，按文件聚合后取前 22 个热点。

## 为什么必须一次成形

这四层共用同一组符号，任何一层单独删除都会让类型系统立刻断裂：

- `isAutomationsNavigation` / `routes.view.automations*` —— `AppShell`、`route-parser`、路由表同时引用
- `RPC_CHANNELS.automations.*` —— `channels.ts`、`routing.ts`、`channel-map.ts`、`shared/types.ts` 同时引用
- `AutomationListItem` / `TestResult` / `ExecutionEntry` —— `atoms/automations`、`useAutomations`、`AppShellContext` 同时引用
- `SessionManager` 的自动化事件钩子 —— 会话生命周期直接调用

已有实测：用脚本按行删除曾把 `SessionManager.ts` 改出 1655 个编译错误，因此只能整块重构。

## 引用热点（前 22）

| 处数 | 文件 |
|---:|---|
| 126 | `packages/shared/src/resources/__tests__/resource-bundle.test.ts` |
| 108 | `packages/server-core/src/sessions/SessionManager.ts` |
| 107 | `apps/electron/src/renderer/components/app-shell/AppShell.tsx` |
| 105 | `apps/electron/src/renderer/hooks/useAutomations.ts` |
| 100 | `apps/electron/src/renderer/components/automations/AutomationsListPanel.tsx` |
| 87 | `packages/server-core/src/handlers/rpc/automations.ts` |
| 87 | `packages/shared/src/resources/resource-bundle.ts` |
| 84 | `apps/electron/src/renderer/components/automations/AutomationInfoPage.tsx` |
| 79 | `packages/shared/src/automations/automation-system.ts` |
| 53 | `packages/shared/src/automations/validation.ts` |
| 53 | `apps/electron/src/renderer/components/automations/types.ts` |
| 51 | `apps/electron/src/shared/route-parser.ts` |
| 44 | `apps/electron/src/renderer/components/app-shell/MainContentPanel.tsx` |
| 38 | `apps/electron/src/shared/types.ts` |
| 32 | `apps/electron/src/renderer/components/automations/BatchAutomationMenu.tsx` |
| 27 | `packages/shared/src/automations/index.ts` |
| 27 | `packages/shared/src/automations/types.ts` |
| 24 | `apps/electron/src/renderer/components/automations/AutomationCard.tsx` |
| 23 | `packages/shared/src/automations/history-store.ts` |
| 19 | `apps/electron/src/renderer/components/automations/AutomationEventTimeline.tsx` |
| 17 | `packages/shared/src/automations/utils.ts` |
| 17 | `apps/electron/src/renderer/components/automations/AutomationMenu.tsx` |

## 执行顺序（自外向内，每步结束必须 `tsc` 绿）

1. **渲染层入口**（B7-c）
   - 删 `apps/electron/src/renderer/components/automations/`（16 文件）
   - 删 `atoms/automations.ts`、`hooks/useAutomations.ts`
   - `AppShell.tsx`：移除 5 处 import、`useAutomations` 接线、`automationFilter` 派生、`automationTypeCounts`、`handleAutomationSelect`、context 传递与面板渲染
   - `AppShellContext.tsx`：删 `automationTestResults`、`getAutomationHistory` 两个可选成员
   - `MainContentPanel.tsx`：删除 44 处自动化面板分支

2. **路由与协议**（B7-b 前半）
   - `shared/route-parser.ts`（51）、`shared/routes.ts`（13）：删 `view.automations*` 路由族与 `isAutomationsNavigation`
   - `shared/types.ts`（38）：删 `AutomationFilter`、preload 方法签名
   - `channel-map.ts`（10）：删自动化通道映射

3. **RPC 层**（B7-b 后半）
   - 删 `server-core/src/handlers/rpc/automations.ts`（87）
   - 摘 `rpc/index.ts` 注册与 `protocol/channels.ts`（10）、`protocol/routing.ts`（10）中的 `automations:*`

4. **服务端钩子**
   - `SessionManager.ts`（108）：移除自动化事件发射、`automationTestResults` 相关状态与调度
   - `handlers/session-manager-interface.ts`、`handlers/rpc/resources.ts`（5）、`handlers/rpc/files.ts`（1）

5. **模块本体**（B7-a）
   - 删 `packages/shared/src/automations/`（20 个源文件）
   - 清 `packages/shared/src/resources/resource-bundle.ts`（87）与测试（126）
   - 清 `pages/script-executor-bridge.ts` 与相关测试

6. **收尾**（B7-d）
   - 残留测试：`ipc-channels.test.ts`、`route-parser-pages.test.ts`、`script-executor-bridge.test.ts`、`create-session-defaults.test.ts`
   - 文档与示例

## 完成判据

- `grep -ri automation packages/shared/src packages/server-core/src packages/session-tools-core/src apps/electron/src` 返回 0
- `apps/electron` 的 `tsc --noEmit` 在 worktree 侧 0 错误
- `bun test` 全绿
- 现有文件夹树、拖拽、归档、删除、搜索链路不受影响
