/**
 * Tool Layering Defaults
 *
 * Default config files used when {workspaceRoot}/config/tool_layering.json or
 * tool_categories.json are missing. The 34 session tools (getSessionToolProxyDefs)
 * are bucketed into 6 categories (spec §4: 4-6 categories).
 */

import type { ToolLayeringConfig, ToolCategoriesConfig } from './types.ts';
import { DEFAULT_ENTER_THRESHOLD_TOKENS } from './types.ts';

/** Default layering config: auto mode, 8000 token threshold, empty fixed layer. */
/**
 * Built-in memory tools that are ALWAYS in the fixed layer.
 * Memory tools are first-class session tools: the agent must be able to
 * call them directly at any moment (explicit memory requests), regardless
 * of tool-layering config or category buckets. `loadToolLayering` merges
 * these unconditionally, so a workspace config cannot fold them away.
 */
export const ALWAYS_FIXED_TOOLS: readonly string[] = ['add_memory', 'query_memories'];

/** Default layering config: auto mode, 8000 token threshold. */
export const DEFAULT_TOOL_LAYERING: ToolLayeringConfig = {
  mode: 'auto',
  enterThresholdTokens: DEFAULT_ENTER_THRESHOLD_TOKENS,
  fixedLayer: [...ALWAYS_FIXED_TOOLS],
};

/** Default category buckets for the 34 session tools. */
export const DEFAULT_TOOL_CATEGORIES: ToolCategoriesConfig = {
  categories: [
    {
      name: 'workspace',
      metaToolName: 'tools_workspace',
      description: '会话与任务管理：会话信息、归档、后台任务、事件读取。',
      tools: [
        // Event reads live in this bucket rather than their own: the spec caps
        // the default set at six categories, and an uncategorised tool lands in
        // `misc` — where a supervisor handed "有一条未处理的事件" cannot guess to
        // look. `call_tool` refuses a folded tool whose category was not
        // expanded, so the turn burns its cap without ever reading the event.
        'get_event',
        'list_events',
        'list_event_subscriptions',
        'get_session_info',
        'archive_session',
        'list_sessions',
        'list_background_tasks',
        'get_background_task_output',
        'stop_background_task',
              'send_agent_message',
        'deliver_file',
        //
        // The task surface itself. Every one of these was uncategorised, which put
        // it in `misc` — and `call_tool` refuses a folded tool from a category that
        // was never expanded, while `misc` has no meta tool to expand. So the
        // supervisor could not call `dispatch` at all: the tools existed, the prompts
        // told it to use them, and the router refused them. That is a large part of
        // "the supervisor never dispatches and does the work itself" — it was reading
        // the disk because its own tools were unreachable.
        //
        'task_get',
        'task_list',
        'task_update',
        'task_handoff',
        'dispatch',
        'ask_user',
      ],
    },
    {
      name: 'sources',
      metaToolName: 'tools_sources',
      description: '外部数据源接入与鉴权：测试、OAuth、凭据录入、模板渲染。',
      tools: [
        'source_test',
        'source_oauth_trigger',
        'source_google_oauth_trigger',
        'source_slack_oauth_trigger',
        'source_microsoft_oauth_trigger',
        'source_credential_prompt',
        'render_template',
      ],
    },
    {
      name: 'pages',
      metaToolName: 'tools_pages',
      description: 'Pages 页面管理：创建、更新、数据写入、列表查询、删除。',
      tools: [
        'list_pages',
        'get_page',
        'create_page',
        'update_page',
        'write_page_data',
        'delete_page',
      ],
    },
    {
      name: 'compute',
      metaToolName: 'tools_compute',
      description: '数据处理与计算：脚本执行、数据转换、LLM 批量调用。',
      tools: [
        'script_sandbox',
        'transform_data',
        'call_llm',
      ],
    },
    {
      name: 'validation',
      metaToolName: 'tools_validation',
      description: '配置校验：配置、技能、Mermaid 图校验，保证修改合法。',
      tools: ['config_validate', 'skill_validate', 'mermaid_validate'],
    },
    {
      name: 'agent',
      metaToolName: 'tools_agent',
      description: 'agent 运行时辅助：任务计划、浏览器自动化、子会话派生与关注。',
      tools: [
        //
        // The task tools belong here rather than nowhere.
        //
        // `task_plan` was absent from every category, so it fell into `misc` — and
        // `call_tool` refuses a folded tool whose category has not been expanded,
        // while `misc` has no meta tool to expand. The result was a worker that could
        // not use the one tool its brief tells it to call first: observed twice in a
        // real run, the worker expanded `tools_agent`, then `tools_misc`, found no
        // `task_plan`, and gave up. A tool nobody can reach is not a tool.
        //
        'task_plan',
        'report_result',
        'SubmitPlan',
        'browser_tool',
        'spawn_session',
        'subscribe_session',
        'unsubscribe_session',
        'list_subscriptions',
      ],
    },
  ],
};