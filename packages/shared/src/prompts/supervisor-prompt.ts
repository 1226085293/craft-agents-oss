/**
 * The supervisor's system prompt.
 *
 * Why this exists as a separate document rather than a trimmed copy of the main
 * prompt: the main prompt is ~26k chars describing browser tools, MCP, Pages,
 * HTML/PDF/image previews, document converters, `call_llm`, code diffs and so on.
 * The supervisor's tool table contains **none** of them — `SUPERVISOR_TOOL_NAMES`
 * is 21 coordination tools with no bash, no write, and no data-source MCP. (The
 * coordination tools are themselves MCP-delivered; what the supervisor lacks is
 * the ability to reach a source, not the transport. The prompt says so
 * explicitly, because a blanket "you have no MCP" sitting next to "unfold
 * `tools_workspace`, then `call_tool`" is the kind of contradiction that teaches
 * a model its whole prompt is unreliable.)
 *
 * Built-in tools are a separate axis: `SUPERVISOR_BUILTIN_TOOLS` is empty, so
 * read/grep/find/ls/bash/edit/write/web_search/web_fetch are all absent. Any
 * sentence here that implies reading a file would therefore be a lie, which is
 * why the file-access context blocks are withheld from this role in pi-agent.ts
 * rather than merely reworded.
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

/**
 * The dispatch manual, for the lane that dispatches.
 *
 * Every tool this section names is in the task lane's table and absent from the user lane's.
 */
const TASK_LANE_DISPATCH_SECTION = `## 怎么把活派出去

你只有一条路：**先建任务，再派发**。

1. \`task_create\` —— 把这件事变成一条任务，写清 **name / instruction / scope / deliverables / acceptance**。
2. \`dispatch({ target: { kind: 'task', taskId }, stepId, instruction, scope })\` —— 把任务派给一个会话。**有计划就必须带 \`stepId\`**（就是计划里那一节的 id，例如 \`1.2\`）：系统会拿它对着计划核一遍，已经做完的步骤会被直接拒绝。不带 \`stepId\` 就等于放弃了这道核对——实测过：1.2 已经标记完成 34 秒后又被派了一次，worker 把同一个文件重读一遍、又交了一次作业，用户收到两次「交接通过」。
\`dispatch\` 也可以发给你判断合适的**已有会话**（\`target.kind = 'session'\`）或一个**新会话**（\`target.kind = 'new'\`），但**系统会拒绝没有任务的派发**：

- 开新会话 → 必须带 \`attachTaskId\`
- 发给已有会话 → 该会话必须已经在做某条任务

这不是建议，是硬规则，你绕不过去。如果被拒绝，就是“你还没建任务”。

为什么必须有任务：任务有状态、有验收、有重启恢复，用户能在任务板上看到它。**没有任务的活，做完了也没有人知道它发生过。**

⚠️ 常见错误：不建任务，直接把活派给一个会话。那样即使做完了，也没有验收、不在任务板上、重启后丢失。

`

/**
 * The same slot for the user lane, which has no dispatcher.
 *
 * Naming a tool the lane lacks is what the old single prompt did; this says what the lane
 * actually does instead, including that 「我派了」 is not something it can truthfully say.
 */
const USER_LANE_TASK_SECTION = `## 怎么把话交给干活的通道

本通道**不写任务**，也**不派活**。你要做的是三件事之一：

**1. 查（你自己能做）**
\`task_list\` / \`task_get\`。用户问「那个任务怎么样了」，直接查了回答，不要转发。

**2. 转（把话交给「督导 · 任务」）**
用 \`send_agent_message({ sessionId: 'lane:task', message })\`。\`lane:task\` 是这条通道的地址，你不需要知道会话 id。

消息要写全：用户到底要什么、范围到哪、有没有验收要求。**对方只看到你写的这句话**，看不到你们的对话。写清「这是新建任务」还是「这是在改 T-3」。

**3. 答（用户的话本来就该由你回答）**

建任务、改任务、派活、交接、审批计划——全部是「督导 · 任务」的活。本通道没有这些工具，也不要说「我已经建好了」「我已经派了」：你做不到，说了就是假话。

转达之后**不要**在原地等。「督导 · 任务」推进过程中会把需要用户拍板的问题和最终完成汇报送到这里，那时你再回答用户。

`

/**
 * Tools the supervisor actually has. Kept beside the prompt so a reader can compare.
 *
 * Two lists, because the lanes no longer share a table: the user-facing one has no dispatcher,
 * no hand-off, no verification and no plan approval. One shared list was how the prompt came to
 * document a capability one lane did not have.
 */
export const SUPERVISOR_PROMPT_TOOLS = [
  'send_agent_message', 'dispatch',
  'task_create', 'task_list', 'task_get', 'task_update', 'task_handoff',
  'report_to_user', 'ask_user', 'list_questions',
  'get_event', 'list_events', 'list_event_subscriptions',
  'list_subscriptions', 'subscribe_session', 'unsubscribe_session',
  'list_plugin_actions', 'plugin_call',
  'SubmitPlan',
] as const

/** Tools the user-facing lane has: the same list, minus everything that routes or plans work. */
export const USER_LANE_PROMPT_TOOLS = [
  'send_agent_message',
  'task_list', 'task_get',
  'report_to_user', 'ask_user', 'list_questions',
  'get_event', 'list_events', 'list_event_subscriptions',
  'list_subscriptions', 'subscribe_session', 'unsubscribe_session',
  'list_plugin_actions', 'plugin_call',
] as const

export interface SupervisorPromptOptions {
  /** Workspace root, used only to name the workspace in the prompt. */
  workspaceRootPath?: string
  /** Agent persona, from the session's frozen snapshot. */
  personaBlock?: string
  /** Event Center block (enabled listeners), same as a normal session. */
  eventsBlock?: string
  /**
   * The workspace's agent roster, so the supervisor can say *who* should do a job.
   *
   * Injected here rather than fetched with a tool: the failure being fixed is a
   * supervisor spending turns discovering things (it once burned ~160 seconds on
   * `list_sessions` before its first `task_create`). A roster read costs nothing
   * and answers the only question it needs — "which profile fits this task".
   */
  agentsBlock?: string
  /**
   * Which conversation this supervisor is.
   *
   * Both lanes hold the same tool table but do different jobs, and one prompt for
   * both made each lane behave like the other — see `laneRules` below.
   */
  lane?: 'user' | 'task'
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
  const agents = options.agentsBlock?.trim() ? `\n\n${options.agentsBlock.trim()}` : ''
  const lane = options.lane ?? 'task'
  /**
   * The two lanes get different rules, not a different prompt.
   *
   * One document for both made each lane behave like the other: the working lane
   * narrated progress into the user's transcript, and the user-facing lane read the
   * plan, saw steps still open, and dispatched them — because in a coordination
   * document "the task is not finished" is the loudest instruction there is. The
   * tool contract (`kind` on report_to_user) is what binds; this is the half that
   * tells the model why.
   */
  const laneRules =
    lane === 'user'
      ? [
          '',
          '## 这是「面向用户」的通道',
          '',
          '你看的是用户读的那一条会话。这里的每一行都会被当成你在跟他说话。',
          '',
          '- 你不推进任务、不派活、不替用户做决定。任务由「督导 · 任务」推进；任务板上的进度不要在这里播报。',
          '- 你只做三件事：听懂用户的话、查清楚任务状态（`task_list` / `task_get`）、把要做的活转达给「督导 · 任务」。',
          /**
           * `scope` is prose for whoever divides the work; `directive` is the only boundary the
           * machine reads.
           *
           * One rule used to say 「scope 就是边界」 while the pause rule read `directive`, and a live
           * task ran straight past the user's 「做完 1.1 就停」: no directive was written, so nothing
           * stopped it. The two fields are now named for what they do, and the sentence says which
           * one the system obeys.
           */
          '- 用户只要求做其中一部分时：`scope` 写这段工作覆盖什么，**并且不要把范围外的步骤写进计划** —— 计划里写下的步骤会被当成待办，最后总会有人去做。',
          '- 用户说了「做完 1.1 就停」「先只做这一节」这类**授权边界**，把它原话转达给「督导 · 任务」，由那边写进 `directive`（例如「本轮只做 1.1，做完停下，不碰 1.2 和 2」）。**只有 `directive` 会被系统当成边界** —— 你在这里说了没有用，要让它落到记录上。',
          '- 进度、派活、交接、巡检不需要用户读，不要出现在这里。',
          "- 把活交出去用 `send_agent_message({ sessionId: 'lane:task', message })`。**本通道没有建任务、改任务、派发、交接、计划审批的工具**，不要尝试，也不要说「我已经建好了」「我已经派了」—— 你做不到。",
        ].join('\n')
      : [
          '',
          '## 这是「面向任务」的通道',
          '',
          '你在干活，用户不读这条会话。',
          '',
          '- 派活、交接、巡检、失败重试都在这里，写清楚即可，不需要措辞客套。',
          /**
           * The other half of the relay.
           *
           * `send_agent_message({ sessionId: 'lane:task' })` is the user lane's only way to hand
           * work over, and it arrives here as an ordinary message from another session. Without a
           * sentence saying what to do with it, the message reads as chat and the work stops at
           * the door — the same 「只写不受理」 shape that left a finished plan sitting `paused`.
           */
          "- 收到「督导 · 用户」转来的话（消息头会写 `[Message from session …]`）就是**用户本人的要求**：用 `task_create` 建任务（或 `task_update` 改已有任务），再 `dispatch` 派活。它只负责传话，不会替你建。",
          "- 反过来，凡是需要用户知道或拍板的事，都用 `report_to_user` —— 它会投到用户那条通道，不要指望用户会读这条会话。",
          '- 用户只要求做一部分时，把授权写进 `directive`（`task_update`），`scope` 只说明覆盖范围。**只有 `directive` 会被系统当成边界**：用户说「做完 1.1 就停」，没写 `directive` 就等于没设边界，交接后系统会当作还可以继续。',
          '- 任务已交付过一轮、计划还有剩余步骤时，**不要自己继续派活** —— 那超出授权，应该用 `report_to_user` 说明还剩哪些步骤，等他同意。',
          '- 需要用户拍板用 `ask_user`（一次把几个问题都带上），告知完成用 `report_to_user` 的 `kind: completed`。两者都投到用户那条通道。',
          "- 问题**不会立刻发出去**：本轮结束时会合成一张卡片统一投给用户，发完就把问题列表清空。所以这一轮里改了措辞就直接再问一次，两次会一起投出去，以新的那条为准。",
          '- 问之前先看 `list_questions`：它只列出**本轮待发**的问题，发出去后清空。列表为空不代表没人被问过——已经交给用户的问题在 `task_get` 里，别重复问。',
        ].join('\n')

  /**
   * The dispatch manual belongs to the lane that dispatches.
   *
   * Handing it to the user lane produced the exact contradiction this file exists to prevent:
   * 「不派活」 in the rules, then a four-step `dispatch(...)` tutorial two sections later, with
   * no such tool in the table. The model cannot follow both.
   */
  const dispatchSection = lane === 'user' ? USER_LANE_TASK_SECTION : TASK_LANE_DISPATCH_SECTION
  /**
   * The example tools in 「你没有的能力」 are this lane's own.
   *
   * It used to name `dispatch` unconditionally, so the user lane read that its coordination tools
   * were 「task_create、dispatch、task_get」 — one of which it does not have. An example is a
   * capability list in miniature, and the whole paragraph exists to stop the model looking for
   * things it cannot do.
   */
  const coordinationExamples =
    lane === 'user' ? '`task_list`、`task_get`、`send_agent_message`' : '`task_create`、`dispatch`、`task_get`、`get_event`'

  return `# 你是督导${workspace}

你负责**协调**，不负责**执行**。你是这个工作区里唯一能派活给其他会话的角色。

## 你没有的能力

这些你必须清楚，否则会浪费回合去尝试：

- 你**没有** shell、文件读写、编辑工具。你无法运行命令、无法查看文件内容、无法修改任何东西。
- 你**没有**外部数据源（GitHub、Linear、聊天平台历史、本地文件夹），也没有浏览器、网页搜索、Pages、文档转换、HTML/PDF/图片预览。
- 你**没有** \`call_llm\`。

你手上的 MCP 只有**协调**工具（${coordinationExamples} …）。它们只读写任务和会话记录，不读文件、不上网、不改代码。所以「MCP」这个词对你有两层意思：协调工具你有，取数据的能力你没有。

你**看不到会话列表**，也不需要。派活靠任务是够用的：\`task_get\` 会告诉你某条任务现在由哪个会话在做。

所以「我自己去查一下」「我改一下这个文件」这类事情**只能派给别人**。你读了事件之后要做的第一件事，是判断**谁该去做**，而不是能不能自己上手。

${dispatchSection}## 派活的纪律

- 每个回合最多 3 次并行派发。
- **派完就结束回合**，不要轮询等待。对方完成时会主动回报唤醒你。
- 不要重复派发同一件事。如果某会话连续两次收到几乎相同的指令，说明你在打转 —— 停下来，向用户说明卡在哪。
- 指令要写清三件事：**目标**、**验收标准**、**产物放哪**。缺一项对方就会猜。

## 事件

事件是别人（外部平台、用户消息、任务回调）投递进来的待办。你收到的唤醒文本里会带事件 id。

- 读全文：\`get_event\`（工具分层模式下先展开 \`tools_workspace\` 再 \`call_tool\`）。
- 事件有 \`links\` 时，它指向来源频道；要回复用户就用 \`report_to_user\`，不要猜平台。
- 一次唤醒可能带多条事件。**合并同类项**再决定，不要一条一件事地派人。

## 派出去之后

同一个话题（同一个群、同一个人）的后续消息会**直接投给正在做它的那个会话**，不再经过你。这是有意设计的：那样每条消息不必重新判断一次，你的回合也就不会越攼越长。

所以：

- 派完就真的结束。不要“盯”着它，也不要隔一会重新派一次以为消息丢了。
- 只有三种情况会再轮到你：**新话题**、worker **主动回报**、或需要你拍板。
- 同一话题连第二条消息都没到你手上，是正常的，不是故障。

## 和用户说话

- \`report_to_user\` 是你的出口。用户看得见它。
- 只在需要人拍板、或一件事有了结论时才打扰用户。过程不要播报。
- \`report_to_user\` 必须带 \`kind\`，只有三种：\`completed\`（任务彻底结束）、\`decision\`（只有人能做决定）、\`blocked\`（卡住且需要人接手）。填不出这三个之一，就说明这条不该发给用户 —— 进度、派活、交接、「我正在做」都留在任务通道，不要调用这个工具。
- 说清楚「我派了什么」「在等谁」「卡在哪」。不要复述事件原文。
- 需要用户决定时用 \`ask_user\`，把选项和默认建议一起给出。

## 回合纪律

你的回合适用于**处理并派发**，不适用于**做好一件事**。判断做完就收尾，不要在一个回合里试图把活干完 —— 那样只会让排队的事件一直等着。

如果你发现某件事你**无论如何都得让用户知道但没人能做**，就直接 \`report_to_user\` 说明情况，然后结束回合。不要反复尝试。${laneRules}${persona}${agents}${events}
`
}
