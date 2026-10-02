# Craft Agent 工具使用指南

> 本文件为工具描述的**扩展说明**。每个工具的描述尾部会附带 `扩展说明: docs/tool_guide.md#<工具名>`；当该工具的细节不确定时，用 Read 工具读取对应小节。
>
> 懒加载设计：工具描述只保留「做什么 / 何时用 / 关键约束 / 最短示例」，详细教程（多示例、边界行为、参数语义）统一放在本文件，按工具名分节。

## 目录

- [SubmitPlan](#submitplan)
- [config_validate](#config_validate)
- [skill_validate](#skill_validate)
- [mermaid_validate](#mermaid_validate)
- [source_test](#source_test)
- [source_oauth_trigger](#source_oauth_trigger)
- [source_google_oauth_trigger](#source_google_oauth_trigger)
- [source_slack_oauth_trigger](#source_slack_oauth_trigger)
- [source_microsoft_oauth_trigger](#source_microsoft_oauth_trigger)
- [source_credential_prompt](#source_credential_prompt)
- [update_user_preferences](#update_user_preferences)
- [transform_data](#transform_data)
- [script_sandbox](#script_sandbox)
- [render_template](#render_template)
- [browser_tool](#browser_tool)
- [call_llm](#call_llm)
- [spawn_session](#spawn_session)
- [send_developer_feedback](#send_developer_feedback)
- [set_session_labels](#set_session_labels)
- [set_session_status](#set_session_status)
- [archive_session](#archive_session)
- [create_task](#create_task)
- [list_pages](#list_pages)
- [get_page](#get_page)
- [create_page](#create_page)
- [update_page](#update_page)
- [write_page_data](#write_page_data)
- [delete_page](#delete_page)
- [get_session_info](#get_session_info)
- [list_sessions](#list_sessions)
- [list_background_tasks](#list_background_tasks)
- [send_agent_message](#send_agent_message)
- [deliver_file](#deliver_file)
- [list_messaging_channels](#list_messaging_channels)
- [unbind_messaging_channel](#unbind_messaging_channel)

---

## SubmitPlan

写计划后提交用户审查。**关键约束（违反会导致执行不完整）**：
- 调用前必须已用 Write 工具把计划写入 markdown 文件；
- 调用后执行会被**自动暂停**，计划展示给用户；
- 调用后**不要**再输出任何文本或调用其他工具——它们不会被执行；
- 会话在用户响应（接受/修改/拒绝）后恢复。

## config_validate

校验 Craft Agent 配置文件。编辑任何配置后调用，先于生效检查错误。
返回结构化校验结果（errors / warnings / suggestions）。

`targets` 取值（必填其一）：
- `config` — config.json（工作区、模型、设置）
- `sources` — 所有 source config.json
- `statuses` — statuses config.json
- `preferences` — preferences.json
- `permissions` — permissions.json 文件
- `automations` — automations.json
- `tool-icons` — tool-icons.json
- `all` — 全部配置文件

## Skill 验证（skill_validate）

校验技能 SKILL.md。检查项：slug 格式（小写字母数字+连字符）、文件存在可读、YAML frontmatter 有效（name/description 必填）、正文非空、图标格式（svg/png/jpg）。

## mermaid_validate

输出复杂 Mermaid 图前先校验语法（多节点、复杂关系、报错调试）。返回具体错误信息；参数原样保留。

## source_test

验证→（默认）启用属性源配置。步骤：
1. Schema 校验 config.json 结构
2. 图标处理（如配了则下载）
3. 完整性检查（缺少 guide.md/icon/tagline 会告警）
4. 连通性测试（源可达性）
5. 鉴权状态检查
6. 默认快乐启用：通过后把 `enabled: true` 写入 config 并激活到当前会话（工具即刻可用，无需重启）

传 `autoEnable: false` 保持纯验证（不写 config、不改会话）。

## source_oauth_trigger

为 MCP 源启动 OAuth 2.0 + PKCE 流程。
前置：源存在于当前 workspace、类型为 `mcp`、`authType: 'oauth'`、有合法 MCP URL。
⚠️ 调用后执行会暂停直至 OAuth 完成。

## source_google_oauth_trigger

为 Google API 源触发 Google OAuth：弹出浏览器窗口让用户登录 Google 账号。
支持服务：Gmail、Calendar、Drive、Docs、Sheets、YouTube、Search Console。
⚠️ 调用后执行暂停直至 OAuth 完成。

## source_slack_oauth_trigger

为 Slack API 源触发 Slack OAuth（浏览器弹出用户登录）。⚠️ 调用后执行暂停。

## source_microsoft_oauth_trigger

为 Microsoft API 源触发 Microsoft OAuth（浏览器弹出用户登录）。
支持：Outlook、Calendar、OneDrive、Teams、SharePoint。⚠️ 调用后执行暂停。

## source_credential_prompt

源需要非 OAuth 认证时，让用户在安全输入 UI 填凭据。

auth 模式与字段：
- `bearer` — 单 Token 字段（Bearer Token / API Key）
- `basic` — 用户名 + 密码
- `header` — 自定义 header 名展示的 API Key
- `query` — query 参数的 API Key
- `multi-header` — 多 API keys（自定义 header 名）

可选字段：`labels`（字段标签）、`description`（给用户看说明）、`hint`（去哪找凭据）、`passwordRequired`、`headerNames`。
⚠️ 调用后执行暂停等待用户输入。

## update_user_preferences

了解到用户信息（名字、时区、地点，或值得记忆的上下文）时更新偏好记忆。只更新已确认字段，不要猜。

## transform_data

提交脚本把数据文件变换为结构化输出（给 datatable/spreadsheet 块）、或提取 HTML 内容供预览。适用：20+ 行数据集、或解码富内容。写一次序列化，结果用 `"src"` 引用。

**脚本约定**：
- 输入文件路径作为命令行参数（最后一个 = 输出文件路径）
- Python：`sys.argv[1:-1]` 输入、`sys.argv[-1]` 输出
- Node/Bun：`process.argv.slice(2, -1)` 输入、`process.argv.at(-1)` 输出
- datatable/spreadsheet 输出须为合法 JSON：`{"title","columns","rows"}`，或 `src` 引用 `{"rows": [...]}`
- html-preview 输出可为任意合法 HTML

**工作流**：① 用脚本变换输入 → ② 输出 datatable（`"src": "data/output.json"`）、或 html-preview（`"src": "data/output.html"`）等块。
**安全**：隔离子进程执行，无 API keys/凭据访问，30 秒超时。

## script_sandbox

在 URL 隔离的子进程中跑快速内联诊断（短 Python/Node/Bun，当 Explore 模式 Bash 解析受阻时）。
- 行为：script 存临时文件执行，返回 stdout/stderr/exit code/时长/超时状态；可传输入文件和 stdin
- 安全：敏感凭据环境变量被剥离、写文件仅限会话目录、超时上限（默认 5000ms / 最大 15000ms）、网络/文件系统隔离必需（不可用则执行被阻断）

## render_template

用源提供的 HTML 模板按模板渲染数据。
流程：① 从源取数据 → ② `render_template`（源 slug + 模板 ID + 数据）→ ③ 输出 html-preview（返回路径作为 `src`）。
模板清单见各源 `guide.md` 的 "Templates" 小节；用 Mustache 语法渲染到会话 data 目录。

## browser_tool

统一 CLI 样式的浏览器控制工具。字符串模式支持分号批量（`fill @e1 value; click @e3`；**导航命令（click/navigate/back/forward）后批执行停止**，因为页面状态变了）。数组模式绕过解析保留原始参数（推荐含分号/制表符/换行的用法）。

**常用命令**：
- `navigate <url>` 加载页面、`snapshot` 获取元素引用（@e1…，仅存者页面）或对全部可交互元素（导航后重新 snapshot，引用随 DOM 变）
- `find <keyword>` 关键词查元素、`click @eN`、`fill @eN text`、`type text`（聚焦元素输入）、`select @e3 value`（支持 `--assert-text`/`--timeout`）
- `click-at x y`、`drag x1 y1 x2 y2`、`scroll down N`
- `set-clipboard` / `get-clipboard` / `paste`（贴到页面）、`key Enter`/`key k meta`
- `screenshot` / `screenshot --annotated`（@eN 叠加）/ `screenshot-region ...` / `window-resize w h`
- `console [limit] [level]` 看运行时报错、`network [limit] [status]` 调试失败请求
- `wait network-idle 8000` / `wait 元素` 等待载荷
- `windows` 窗口列表、`focus [windowId]`、`release` 解除覆盖、`close` 关闭并销毁、`hide` 隐藏保留状态
≥务必先 `browser_tool --help` 看全部命令与示例。流程：先 `open` 创建窗口 → `navigate`/`snapshot` → 交互 → `downloads wait` 下载。完成后 `close`（任务完毕）或 `release`（用户想继续浏览）。

## call_llm

推理子任务调用次级 LLM（Haiku 级别）：
- 批量处理：并行 `call_llm`（同时运行），而非逐个读文件
- 结构化提取：`outputSchema` 保证 JSON 输出
- 上下文隔离：处理大文件不污染主上下文（超大文件用 `attachments` + `{path, startLine, endLine}`）

调用约束：
- 文本/内容直接放 `prompt` 参数，**不要**通过 attachments 传内联文本
- `attachments` 仅用于已存在磁盘的文件路径（自动加载，最多 20 个）
- 大文件（2000+ 行）用 `{path, startLine, endLine}` 分段
- 模型默认是当前会话 fast mini（不用传，除非你有意图）

## spawn_session

创建独立会话运行（各自 prompt/connection/model/sources）——委派研究等球状任务。
- 先 `help=true` 查看可用 connections/models/sources
- `prompt` 必填；`model`/`llmConnection`/`permissionMode`/`thinkingLevel`/`enabledSourceSlugs`/`labels`/`workingDirectory` 可选，省略继承启动会话或 workspace 默认
- `thinkingLevel` 在非 reasoning 模型上被静默忽略（SDK 丢弃参数），它是用 "低/中/高/xhigh/max" 强制深推理的
- 会话出现在会话列表且后台运行（fire-and-forget）
- `attachments` 只能磁盘已有文件路径

## send_developer_feedback

给 Craft Agent 开发团队发反馈：你遇到的问题、改进建议、更好经历的观察。markdown 格式书写，越详细越好。

## set_session_labels

设置当前会话或指定会话 ID 的标签（替换全部）。用于过滤/触发自动化（LabelAdd/LabelRemove 事件）。传空数组清空全部；省略或 `sessionId`（默认当前会话）。

## set_session_status

设置会话状态（如 `todo`/`in_progress`/`done`）。
⚠️ 重要：绝不能自己把任务移到已关闭状态（`done`/`cancelled`)——那由用户在看板决策；你只能设置打开状态（用 `needs-review` 即可，用户审阅后关闭）。Closed 状态调用被拒绝。省略 `sessionId` 作用于当前会话。

## archive_session

归档（或取消归档）当前 workspace 中其他会话：
- 归档 = 从活动列表和未读计数移除，**不删除**（传 `archived: false` 恢复）
- 明确 sessionId、不能归档自己、需要先用 list_sessions/get_session_info 找到目标 ID

## create_task

创建看板 Task——写 `tasks/<slug>/task.yaml` + 创建 orchestrator session。**仅创建**：task 落地 `todo` 不跑，启动由用户/自动化决策。

- `title` + `description` 必填（description 成为任务目标与初始节点 prompt）
- 可选：acceptanceCriteria（验收标准）、sources/skills（workspace slug）、llmConnection+model、workingDirectory、projectId；projectId 省略则继承调用方会话的项目
- 返回 `{slug, orchestratorSessionId, taskLabelId, warnings}`——未知 slug 是 warning 不是 error
- 想立刻干活请留在当前会话或 spawn_session 代替

## list_pages

列出 workspace 的 Pages（dashboard 等）。返回摘要：slug、name、kind、project、刷新计划、上次刷新结果、分享状态、folder path。可按 projectId 过滤。详情用 get_page。

## get_page

按 slug 获取 Page 详情：config、content digest/length/path、数据摘要（KV keys + 各系列点数与最新值）、grants 和分享状态。response 有绝对路径（contentPath, data.snapshotPath）——Read 那些文件获取完整 HTML 或完整数据；`includeContent: true` 只在需要 HTML 文本时用。

## create_page

创建永久、自包含 HTML「Page」：存 `pages/{slug}/`、出现在侧栏 Pages 区（按项目过滤）、沙盒 iframe 渲染。分享需求或自动化刷新时用（比聊天预览持久）。

**写 HTML 前先读 `~/.craft-agent/docs/pages.md`**。要点：
- 完整单文件 HTML，所有 CSS/JS 内嵌 —— 分享副本禁止外部网络请求（否则丢字）
- 展示数据走 postMessage 协议，先发 `craft-pages/v1` ready，再接受 init/data 消息（payload.snapshot）；kind=live 的页面打开时自动收到最新快照
- kind 类型：`static`（无 JS）/ `interactive`（JS，用户驱动）/ `live`（JS + 打开时收到数据快照更新）默认 interactive
- 页面不存凭据；页面上的 source 动作走 bridge 且要求用户批准、链路性授权

## update_page

更新已有 Page：metadata（name/description/kind/projectId）、刷新计划（refresh）、或替换 HTML 内容。部分字段变化；传 null 清除 description/projectId/refresh。替换内容会重新计算 digest → **已有 grants 失效须重新授权**。slug 永不变。

## write_page_data

写页面的数据存储（kv 键→任意 JSON + series 数值）——一套交易内执行。data/snapshot.json 重新生成并把推送到打开的渲染（live 页面即时刷新）。

数据模型：`kv` 键→任意 JSON；`set` 可以放 values；`delete` 删 keys；`appendSeries` 添加 {t: 当 ms, v:数字} 点（同 (series, t) 重写，幂等）；`pruneSeries` 最后删旧点。适合度量/时间序列数据；可配合计划刷新脚本写同一 store。

## delete_page

永久删 Page（文件夹、数据、授权全部移除）。**很有破坏性：需先向用户确认**（除非明确要求删）。已发布页面先撤销发布（尽力）；若远端副本无法确认移除，result 上报 `publicCopyMayRemain`。

## get_session_info

查当前会话或指定会话的元数据：标签、状态、名称、权限模式、projectId（如有绑定）、workingDirectory 等。无需传参查自身。

## list_sessions

列出 workspace 会话（总 count + 分页）。
- 用 status/label/search 缩小范围，不要海量拉全场
- 默认 limit 20、用 limit+offset 分页
- 想全量详情用 get_session_info

## list_background_tasks

列出会话的进行任务背景代理（running/completed/failed/orphaned）——回答 "什么在跑/状态如何" 的权威通道，读主进程注册表（跨轮次跟踪）。

状态含义：`running` 后台运行、未上报完成；`completed/failed/stopped` 收到终止通知；`orphaned` 启动轮结束但任务未完成（随子进程被终止）。

不要瞎猜 "app 重启了"——照报表真实返回即可。省略 sessionId 查当前会话。

## send_agent_message

给另一会话发消息（带发送者 ID，可以回复）。用于协调衍生会话、跟随该发展推进或做跨会话情报搬运。目标会话邮箱会话封装 Sender 信封。

## deliver_file

把本地文件作为附件发给绑定到当前会话的 messaging 渠道（Telegram/WhatsApp/Lark/QQ/WeChat）。场景：用户要求发送/转发一个生成的/下载的文件（PNG/PDF/CSV 等）到手机或聊天应用。有真实附件诉求时优先于打印本地路径或 Markdown 链接。可选 `caption`。

## list_messaging_channels

列出绑定到会话的 messaging（Telegram、WhatsApp、Lark、QQ、WeChat），显示连接的外链，可以收发消息/文件。

## unbind_messaging_channel

把 messenger 从当前会话解绑；消息转发间链路即断开。`platform` 指定卸载某个平台（否则）、解绑全部；仅支持 Telegram/WhatsApp。