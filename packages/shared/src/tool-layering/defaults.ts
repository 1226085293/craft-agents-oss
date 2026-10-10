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
      description: '会话与任务管理：会话信息、标签、状态、任务板、归档、后台任务。',
      tools: [
        'get_session_info',
        'set_session_labels',
        'set_session_status',
        'archive_session',
        'list_sessions',
        'list_background_tasks',
        'create_task',
        'send_agent_message',
        'deliver_file',
        'list_messaging_channels',
        'unbind_messaging_channel',
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
      description: 'agent 运行时辅助：计划提交、浏览器自动化、子会话派生。',
      tools: ['SubmitPlan', 'browser_tool', 'spawn_session'],
    },
  ],
};