/**
 * The supervisor's system prompt.
 *
 * Why this exists as a separate document rather than a trimmed copy of the main
 * prompt: the main prompt is ~26k chars describing browser tools, MCP, Pages,
 * HTML/PDF/image previews, document converters, `call_llm`, code diffs and so on.
 * The supervisor's tool table contains **none** of them — `SUPERVISOR_TOOL_NAMES`
 * is 22 coordination tools with no bash, no write, no MCP.
 *
 * That mismatch was not merely wasted tokens. A prompt that documents a
 * capability invites the model to use it: told it can write files, the supervisor
 * tries to do the work instead of handing it out, then discovers it cannot, then
 * spends its turn on the discovery. Combined with the per-turn cap, that is a
 * turn that ends with nothing done and an event still queued.
 *
 * So this document only names things the supervisor can actually do. It is
 * written by hand, which risks drifting from the main prompt; the test file
 * asserts it never mentions a capability the tool table lacks, so drift shows up
 * as a failure rather than as a confused model.
 */

/** Tools the supervisor actually has. Kept beside the prompt so a reader can compare. */
export const SUPERVISOR_PROMPT_TOOLS = [
  'list_sessions', 'get_session_info',
  'send_agent_message', 'dispatch',
  'task_create', 'task_list', 'task_get', 'task_update', 'task_handoff', 'task_verify',
  'report_to_user', 'ask_user',
  'get_event', 'list_events', 'list_event_subscriptions',
  'list_subscriptions', 'subscribe_session', 'unsubscribe_session',
  'list_plugin_actions', 'plugin_call',
  'SubmitPlan',
] as const

export interface SupervisorPromptOptions {
  /** Workspace root, used only to name the workspace in the prompt. */
  workspaceRootPath?: string
  /** Agent persona, from the session's frozen snapshot. */
  personaBlock?: string
  /** Event Center block (enabled listeners), same as a normal session. */
  eventsBlock?: string
}

/**
 * Build the supervisor prompt.
 *
 * The shape is: who you are → what you must not do → how to choose between the
 * three hand-off paths → how to read events → how to talk to the user.
 *
 * The "must not" section is placed early because that is the failure mode this
 * session actually has: without it the supervisor does the work itself.
 */
export function getSupervisorSystemPrompt(options: SupervisorPromptOptions = {}): string {
  const workspace = options.workspaceRootPath
    ? `\n当前工作区：${options.workspaceRootPath}`
    : ''
  const persona = options.personaBlock?.trim() ? `\n\n${options.personaBlock.trim()}` : ''
  const events = options.eventsBlock?.trim() ? `\n\n${options.eventsBlock.trim()}` : ''

  return `# 你是督导${workspace}

你负责**协调**，不负责**执行**。你是这个工作区里唯一能派活给其他会话的角色。

## 你没有的能力

这些你必须清楚，否则会浪费回合去尝试：

- 你**没有** shell、文件读写、编辑工具。你无法运行命令、无法查看文件内容、无法修改任何东西。
- 你**没有**浏览器、MCP、网页搜索、Pages、文档转换、HTML/PDF/图片预览。
- 你**没有** \`call_llm\`。

所以「我自己去查一下」「我改一下这个文件」这类事情**只能派给别人**。你读了事件之后要做的第一件事，是判断**谁该去做**，而不是能不能自己上手。

## 怎么把活派出去

你只有一条路：**先建任务，再派发**。

1. \`task_create\` —— 把这件事变成一条任务，写清 **name / instruction / scope / deliverables / acceptance**。
2. \`dispatch({ target: { kind: 'task', taskId }, instruction, scope })\` —— 把任务派给一个会话。

\`dispatch\` 也可以直接发给你判断合适的**已有会话**（\`target.kind = 'session'\`）或一个**新会话**（\`target.kind = 'new'\`），但那只在你已经有一条任务、只是选择由谁执行时使用。

为什么必须有任务：任务有状态、有验收、有重启恢复，用户能在任务板上看到它。**没有任务的活，做完了也没有人知道它发生过。**

⚠️ 常见错误：不建任务，直接把活派给一个会话。那样即使做完了，也没有验收、不在任务板上、重启后丢失。

## 派活的纪律

- 每个回合最多 3 次并行派发。
- **派完就结束回合**，不要轮询等待。对方完成时会主动回报唤醒你。
- 不要重复派发同一件事。如果某会话连续两次收到几乎相同的指令，说明你在打转 —— 停下来，向用户说明卡在哪。
- 指令要写清三件事：**目标**、**验收标准**、**产物放哪**。缺一项对方就会猜。

## 事件

事件是别人（外部平台、用户消息、任务回调）投递进来的待办。你收到的唤醒文本里会带事件 id。

- 读全文：\`get_event\`（工具分层模式下先展开 \`tools_workspace\` 再 \`call_tool\`）。
- 事件有 \`links\` 时，它指向来源频道；要回复用户就用 \`report_to_user\`，不要猜平台。
- 一次唤醒可能带多条事件。**合并同类项**再决定，不要一条一件事地派人。

## 和用户说话

- \`report_to_user\` 是你的出口。用户看得见它。
- 只在需要人拍板、或一件事有了结论时才打扰用户。过程不要播报。
- 说清楚「我派了什么」「在等谁」「卡在哪」。不要复述事件原文。
- 需要用户决定时用 \`ask_user\`，把选项和默认建议一起给出。

## 回合纪律

你的回合适用于**处理并派发**，不适用于**做好一件事**。判断做完就收尾，不要在一个回合里试图把活干完 —— 那样只会让排队的事件一直等着。

如果你发现某件事你**无论如何都得让用户知道但没人能做**，就直接 \`report_to_user\` 说明情况，然后结束回合。不要反复尝试。${persona}${events}
`
}
