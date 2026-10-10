/**
 * Session Tool Definitions — Single Source of Truth
 *
 * Canonical Zod schemas, descriptions, and handler registry for all
 * session-scoped tools. Consumers derive what they need:
 *
 * - Claude SDK  → `.shape` extracts the plain `{ key: z.string() }` literal
 * - MCP / Pi    → `getToolDefsAsJsonSchema()` auto-converts to JSON Schema
 *
 * Adding a new tool: define the schema, description, handler import, and
 * one entry in SESSION_TOOL_DEFS.
 */

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { SessionToolContext } from './context.ts';
import type { ToolResult } from './types.ts';

// Handlers
import { handleSubmitPlan } from './handlers/submit-plan.ts';
import { handleConfigValidate } from './handlers/config-validate.ts';
import { handleSkillValidate } from './handlers/skill-validate.ts';
import { handleMermaidValidate } from './handlers/mermaid-validate.ts';
import { handleSourceTest } from './handlers/source-test.ts';
import {
  handleSourceOAuthTrigger,
  handleGoogleOAuthTrigger,
  handleSlackOAuthTrigger,
  handleMicrosoftOAuthTrigger,
} from './handlers/source-oauth.ts';
import { handleCredentialPrompt } from './handlers/credential-prompt.ts';
import { handleTransformData } from './handlers/transform-data.ts';
import { handleScriptSandbox } from './handlers/script-sandbox.ts';
import { handleRenderTemplate } from './handlers/render-template.ts';
import { handleSendDeveloperFeedback } from './handlers/send-developer-feedback.ts';
import { handleSetSessionLabels } from './handlers/set-session-labels.ts';
import { handleSetSessionStatus } from './handlers/set-session-status.ts';
import { handleGetSessionInfo } from './handlers/get-session-info.ts';
import { handleListSessions } from './handlers/list-sessions.ts';
import { handleListBackgroundTasks } from './handlers/list-background-tasks.ts';
import { handleCreateTask } from './handlers/create-task.ts';
import {
  handleListPages,
  handleGetPage,
  handleCreatePage,
  handleUpdatePage,
  handleWritePageData,
  handleDeletePage,
} from './handlers/pages.ts';
import { handleArchiveSession } from './handlers/archive-session.ts';
import { handleSendAgentMessage } from './handlers/send-agent-message.ts';
import { handleDeliverFile } from './handlers/deliver-file.ts';
import { handleListMessagingChannels, handleUnbindMessagingChannel } from './handlers/messaging.ts';
import { handleAddMemory, handleQueryMemories } from './handlers/memory.ts';

// ============================================================
// Canonical Zod Schemas
// ============================================================

export const SubmitPlanSchema = z.object({
  planPath: z.string().describe('Absolute path to the plan markdown file you wrote'),
});

export const ConfigValidateSchema = z.object({
  target: z.enum(['config', 'sources', 'statuses', 'preferences', 'permissions', 'automations', 'tool-icons', 'all'])
    .describe('Which config file(s) to validate'),
  sourceSlug: z.string().optional().describe('Validate a specific source by slug'),
});

export const SkillValidateSchema = z.object({
  skillSlug: z.string().describe('The slug of the skill to validate'),
});

export const MermaidValidateSchema = z.object({
  code: z.string().describe('The mermaid diagram code to validate'),
  render: z.boolean().optional().describe('Also attempt to render (catches layout errors)'),
});

export const SourceTestSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to validate and test; this never enables or selects it'),
});

export const SourceOAuthTriggerSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
});

export const CredentialPromptSchema = z.object({
  sourceSlug: z.string().describe('The slug of the source to authenticate'),
  mode: z.enum(['bearer', 'basic', 'header', 'query', 'multi-header']).describe('Type of credential input'),
  labels: z.object({
    credential: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
  }).optional().describe('Custom field labels'),
  description: z.string().optional().describe('Description shown to user'),
  hint: z.string().optional().describe('Hint about where to find credentials'),
  headerNames: z.array(z.string()).optional().describe('Header names for multi-header auth (e.g., ["DD-API-KEY", "DD-APPLICATION-KEY"])'),
  passwordRequired: z.boolean().optional().describe('For basic auth: whether password is required'),
});

export const CallLlmSchema = z.object({
  prompt: z.string().describe('Instructions for the LLM'),
  attachments: z.array(z.union([
    z.string().describe('Simple file path'),
    z.object({
      path: z.string().describe('File path'),
      startLine: z.number().optional().describe('First line (1-indexed)'),
      endLine: z.number().optional().describe('Last line (1-indexed)'),
    }),
  ])).optional().describe('File paths on disk to attach (max 20). NOT for inline text — put text in prompt instead. Use {path, startLine, endLine} for large files.'),
  model: z.string().optional().describe('Model ID or short name. Defaults to a fast model.'),
  systemPrompt: z.string().optional().describe('Optional system prompt'),
  maxTokens: z.number().optional().describe('Max output tokens (1-64000). Defaults to 4096'),
  temperature: z.number().optional().describe('Sampling temperature 0-1'),
  thinking: z.boolean().optional().describe('Enable extended thinking. Incompatible with outputFormat/outputSchema'),
  thinkingBudget: z.number().optional().describe('Token budget for thinking (1024-100000). Defaults to 10000'),
  outputFormat: z.enum(['summary', 'classification', 'extraction', 'analysis', 'comparison', 'validation']).optional()
    .describe('Predefined output format'),
  outputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()),
    required: z.array(z.string()).optional(),
  }).optional().describe('Custom JSON Schema for structured output'),
});

export const TransformDataSchema = z.object({
  language: z.enum(['python3', 'node', 'bun']).describe('Script runtime to use'),
  script: z.string().describe('Transform script source code. Receives input file paths as command-line args (sys.argv[1:] or process.argv.slice(2)), last arg is the output file path.'),
  inputFiles: z.array(z.string()).describe('Input file paths relative to session dir (e.g., "long_responses/stripe_txns.txt")'),
  outputFile: z.string().describe('Output file name relative to session data/ dir (e.g., "transactions.json")'),
});

export const ScriptSandboxSchema = z.object({
  language: z.enum(['python3', 'node', 'bun']).describe('Script runtime to use'),
  script: z.string().describe('Inline script source to execute in a sandboxed subprocess.'),
  inputFiles: z.array(z.string()).optional().describe('Optional input file paths relative to the session directory.'),
  stdin: z.string().optional().describe('Optional stdin payload passed to the script process.'),
  timeoutMs: z.number().min(1).max(15000).optional().describe('Optional timeout in milliseconds (default 5000, max 15000).'),
});

export const RenderTemplateSchema = z.object({
  source: z.string().describe('Source slug (e.g., "linear", "gmail")'),
  template: z.string().describe('Template ID (e.g., "issue-detail", "issue-list")'),
  data: z.record(z.string(), z.unknown()).describe('JSON data to render into the template'),
});

export const SendDeveloperFeedbackSchema = z.object({
  message: z.string().describe('Freeform markdown feedback — be detailed, use headings, lists, code blocks. Include what happened, what you expected, what would help, or any ideas/suggestions.'),
});

// Browser tool schema (single CLI-like tool for all browser actions)
export const BrowserToolSchema = z.object({
  command: z.union([
    z.string(),
    z.array(z.string()),
  ]).describe('Browser command as a string (e.g., "click @e1") or array (e.g., ["evaluate", "var x = 1; x + 2"]). Array mode preserves semicolons and whitespace in arguments.'),
});

export const SpawnSessionSchema = z.object({
  help: z.boolean().optional().describe('If true, returns available connections, models, and sources instead of creating a session'),
  prompt: z.string().optional().describe('Instructions for the new session (required when not in help mode)'),
  name: z.string().optional().describe('Session name'),
  llmConnection: z.string().optional().describe('Connection slug (e.g., "anthropic-api", "codex")'),
  model: z.string().optional().describe('Model ID override'),
  enabledSourceSlugs: z.array(z.string()).optional().describe('Source slugs to enable in the new session'),
  permissionMode: z.enum(['safe', 'ask', 'allow-all']).optional().describe('Permission mode for the new session'),
  thinkingLevel: z.enum(['off', 'low', 'medium', 'high', 'xhigh', 'max']).optional()
    .describe('Reasoning level for the new session. Silently ignored on non-reasoning models (e.g. gpt-4o, gemini-2.5-flash). Omit to inherit the workspace default.'),
  labels: z.array(z.string()).optional().describe('Labels for the new session'),
  workingDirectory: z.string().optional().describe('Working directory for the new session'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  })).optional().describe('Files to include with the prompt'),
});

// Session self-management tools
export const SetSessionLabelsSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to update. Omit to update the current session.'),
  labels: z.array(z.string()).describe('Labels to set (replaces all existing labels)'),
});

export const SetSessionStatusSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to update. Omit to update the current session.'),
  status: z.string().describe('Status to set (e.g., "todo", "in_progress", "done")'),
});

export const GetSessionInfoSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to query. Omit to get info about the current session.'),
});

export const ArchiveSessionSchema = z.object({
  sessionId: z.string().describe('Session ID to archive or unarchive. Required — you cannot archive your own session.'),
  archived: z.boolean().optional().describe('true to archive (default), false to unarchive.'),
});

export const CreateTaskSchema = z.object({
  title: z.string().describe('Short task title shown on the board (also drives the slug)'),
  description: z.string().describe('What the task should accomplish — becomes the task goal and the initial node prompt'),
  acceptanceCriteria: z.string().optional().describe('Freeform rubric the final result is verified against'),
  sources: z.array(z.string()).optional().describe('Source slugs to enable on the task sessions'),
  skills: z.array(z.string()).optional().describe('Skill slugs applied to dispatched task prompts'),
  llmConnection: z.string().optional().describe('LLM connection slug serving the model'),
  model: z.string().optional().describe('Model ID for the task sessions (workspace default when omitted)'),
  workingDirectory: z.string().optional().describe('Working directory for the task sessions'),
  projectId: z.string().optional().describe("Project ID to bind the task to (defaults to the invoking session's project)"),
});

// Pages tools
const PageRefreshSpecInputSchema = z.object({
  cron: z.string().describe('5-field cron expression evaluated once per minute (e.g. "*/15 * * * *")'),
  script: z.string().describe('Script path relative to the workspace root (must stay inside it). Bun runtime.'),
  args: z.array(z.string()).optional().describe('Extra argv appended after the script path'),
  timezone: z.string().optional().describe('IANA timezone for cron evaluation (system local when omitted)'),
  timeoutMs: z.number().optional().describe('Per-run timeout in ms (default 60000, clamped to 1s–15min)'),
  enabled: z.boolean().optional().describe('Set false to pause scheduling without deleting the spec'),
});

export const ListPagesSchema = z.object({
  projectId: z.string().optional().describe('Only return pages bound to this project ID'),
});

export const GetPageSchema = z.object({
  slug: z.string().describe('Page slug (from list_pages or create_page)'),
  includeContent: z.boolean().optional().describe('Also return the full index.html content (can be large). Default false — the response always includes contentPath for reading it from disk instead.'),
});

export const CreatePageSchema = z.object({
  name: z.string().describe('Page name shown on the tile (also drives the slug)'),
  description: z.string().optional().describe('Short description shown in lists'),
  kind: z.enum(['static', 'interactive', 'live'])
    .optional()
    .describe('Runtime capability class: static = no JS, interactive = JS allowed, live = JS + receives data snapshot updates while open. Default: interactive.'),
  projectId: z.string().optional().describe('Stable Project ID to bind the page to'),
  content: z.string().optional().describe('Full self-contained HTML document for index.html (inline CSS/JS, no external requests). Read ~/.craft-agent/docs/pages.md for the authoring guide and data-bridge snippet BEFORE writing page HTML.'),
  refresh: PageRefreshSpecInputSchema.optional().describe('Scheduled data refresh: cron + workspace-relative Bun script that updates the page data store'),
});

export const UpdatePageSchema = z.object({
  slug: z.string().describe('Slug of the page to update'),
  name: z.string().optional().describe('New page name (slug stays stable)'),
  description: z.string().nullable().optional().describe('New description. Pass null to clear.'),
  kind: z.enum(['static', 'interactive', 'live']).optional().describe('New runtime capability class'),
  projectId: z.string().nullable().optional().describe('New Project ID. Pass null to unbind from its project.'),
  content: z.string().optional().describe('Replacement index.html (full document). Re-digests the content — existing source-action grants become stale by design and need re-approval.'),
  refresh: PageRefreshSpecInputSchema.nullable().optional().describe('New refresh spec. Pass null to remove scheduled refresh.'),
});

export const WritePageDataSchema = z.object({
  slug: z.string().describe('Slug of the page whose data store to write'),
  set: z.record(z.string(), z.unknown()).optional().describe('KV upserts: key → any JSON value (objects/arrays allowed)'),
  delete: z.array(z.string()).optional().describe('KV keys to delete'),
  appendSeries: z.record(z.string(), z.array(z.object({
    t: z.number().optional().describe('Timestamp epoch ms (defaults to now). Writing an existing (series, t) overwrites its value — re-runs are idempotent.'),
    v: z.number().describe('Numeric value'),
  }))).optional().describe('Timeseries appends: series name → array of points'),
  pruneSeries: z.record(z.string(), z.number()).optional().describe('Timeseries prunes: series name → deleteBefore timestamp (points with t < value are removed)'),
});

export const DeletePageSchema = z.object({
  slug: z.string().describe('Slug of the page to delete'),
});

export const ListSessionsSchema = z.object({
  status: z.string().optional().describe('Filter by status'),
  label: z.string().optional().describe('Filter by label'),
  search: z.string().optional().describe('Substring match on session name'),
  sortBy: z.enum(['recent', 'name', 'status']).optional().describe('Sort order (default: recent)'),
  limit: z.number().optional().describe('Max sessions to return (default 20, max 100)'),
  offset: z.number().optional().describe('Skip first N results (for pagination)'),
});

export const ListBackgroundTasksSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to query. Omit to list background tasks for the current session.'),
});

// Inter-session messaging
export const SendAgentMessageSchema = z.object({
  sessionId: z.string().describe('Target session ID to send the message to'),
  message: z.string().describe('The message to send to the target session'),
  attachments: z.array(z.object({
    path: z.string().describe('Absolute file path on disk'),
    name: z.string().optional().describe('Display name (defaults to file basename)'),
  })).optional().describe('Files to include with the message'),
});

export const AddMemorySchema = z.object({
  action: z.enum(['add', 'update', 'delete']),
  scope: z.enum(['session', 'global']).describe('session for temporary facts related only to this conversation; global only for durable user preferences, rules, and reusable knowledge'),
  id: z.string().optional(),
  content: z.string().min(1).max(4000).optional(),
  type: z.enum(['factual', 'behavioral', 'reminder']).optional().describe('factual = facts/context; behavioral = preferences/workflows; reminder = dated reminders'),
  tags: z.array(z.string()).optional(),
});
export const QueryMemoriesSchema = z.object({
  query: z.string().min(1),
  type: z.enum(['factual', 'behavioral', 'reminder']).optional().describe('Filter by memory type (legacy 5-class entries are folded: fact/context→factual, preference/workflow→behavioral)'),
  tags: z.array(z.string()).optional().describe('Filter by tags (entry matches if it contains any listed tag)'),
  limit: z.number().int().min(1).max(50).optional().describe('Maximum results (default: 10)'),
});

export const DeliverFileSchema = z.object({
  path: z.string().describe('Absolute or session/workspace-relative path to the file to deliver.'),
  filename: z.string().optional().describe('Attachment filename shown to the recipient. Defaults to the file basename.'),
  caption: z.string().optional().describe('Optional caption sent with the file when the channel supports it.'),
  target: z.enum(['active_channel', 'mobile', 'all_bound_channels']).optional().describe('Delivery target. Defaults to active_channel, which means the messaging channel(s) bound to this session.'),
  platform: z.enum(['telegram', 'whatsapp', 'lark', 'qq', 'wechat']).optional().describe('Optionally restrict delivery to one messaging platform.'),
});

export const ListMessagingChannelsSchema = z.object({
  sessionId: z.string().optional().describe('Session ID to list bindings for. Defaults to current session.'),
});

export const UnbindMessagingChannelSchema = z.object({
  platform: z.enum(['telegram', 'whatsapp']).optional().describe('Platform to unbind. If omitted, unbinds all.'),
});

// ============================================================
// Canonical Tool Descriptions (base — no DOC_REFS)
// ============================================================

export const TOOL_DESCRIPTIONS = {
  SubmitPlan: `Submit a plan for user review. Write the plan to a markdown file first, then call this to present it. IMPORTANT: after this returns, execution pauses until the user accepts/modifies/rejects the plan. Do not call any tools or output text after SubmitPlan.`,
  config_validate: `Validate Craft Agent config files after editing, before they take effect. Targets: config (config.json), sources, statuses, preferences, permissions, automations, tool-icons, all. Returns structured errors/warnings/suggestions.`,
  skill_validate: `Validate a skill SKILL.md: slug format (lowercase alnum + hyphens), file exists/readable, YAML frontmatter valid (name+description required), non-empty body, icon format if present.`,
  mermaid_validate: `Validate Mermaid diagram syntax before outputting (complex diagrams, many nodes, failed renders). Returns specific error messages if invalid. Include the raw diagram code.`,
  source_test: `Validate and test a source config: schema, icon, completeness, connectivity, and auth. This tool does not enable or select a source. If the user wants to use its tools, ask them to enable it in workspace settings and select it in the session source picker before they resend the request.`,
  source_oauth_trigger: `Start OAuth 2.0 + PKCE for an MCP source. Prerequisites: source exists, type mcp, authType oauth, valid MCP URL. Execution pauses while OAuth completes.`,
  source_google_oauth_trigger: `Trigger Google OAuth for a Google API source; opens a browser window for user sign-in. Services: Gmail, Calendar, Drive, Docs, Sheets, YouTube, Search Console. Pauses until OAuth completes.`,
  source_slack_oauth_trigger: `Trigger Slack OAuth for a Slack API source; opens browser for user sign-in. Pauses until OAuth completes.`,
  source_microsoft_oauth_trigger: `Trigger Microsoft OAuth for a Microsoft API source; opens browser for sign-in. Services: Outlook, Calendar, OneDrive, Teams, SharePoint. Pauses until OAuth completes.`,
  source_credential_prompt: `Ask the user for non-OAuth credentials via secure input UI. Modes: bearer (single token), basic (user+password), header (API key with header name), query (API key query param), multi-header (multiple keys). Pauses for user input.`,
  transform_data: `Run a transform script to turn data files into tables, or decode HTML for rich previews. Input files as CLI args, last arg = output path (Python: sys.argv[1:-1], Node/Bun: process.argv.slice(2, -1)). Output JSON {title, columns, rows} for datatable/spreadsheet, or any HTML. Isolated subprocess: no API keys, 30s timeout.`,
  script_sandbox: `Run a short Python/Node/Bun diagnostic in an isolated subprocess (no network, no credentials). Returns stdout/exit code/timeout. Great when strict Explore-mode parsing blocks inline Bash. Input files limited to session dir; timeout default 5s, max 15s.`,
  render_template: `Render a source HTML template with a data payload (source guide.md lists templates under Templates). Returns a file path; use the path as 'src' in an html-preview block. Mustache syntax.`,
  browser_tool: `Drive a built-in browser via a CLI-like command (string or array; array keeps literal semicolons/tabs/newlines). Batching with ';' works but the batch stops after navigation commands (click/navigate/forward/back). Commands: open, navigate, snapshot, find, click, fill, type, wait, screenshot, evaluate, console, network, sign-in flows; window management. Run --help first when unsure.`,
  call_llm: `Get a secondary LLM for focused subtasks: parallel batch processing, efficiency gains, structured extraction (outputSchema), context isolation. Put text in the prompt param; use attachments only for file paths on disk (max 20 items; for files >2000 lines pass a startLine/endLine range).`,
  spawn_session: `Create an independent session running with its own prompt, connection, model, and sources. Useful for delegating research/analysis/drafts to parallel sessions. Use help=true first to list connections/models/sources. The prompt param is required; optional overrides: model, llmConnection, permissionMode, thinkingLevel, enabledSourceSlugs, labels, workingDirectory. Runs fire-and-forget, appears in session list.`,
  send_developer_feedback: `Send freeform feedback to the Craft Agent development team: issues, improvement ideas, patterns found. Write in markdown with as much detail as possible.`,
  set_session_labels: `Set/replace labels on a session (pass ids; valued labels use 'id::value' when a valueType is declared; empty array clears all). Omit sessionId for the current session.`,
  set_session_status: `Set the status of a session (e.g. 'in_progress'). NEVER move to closed statuses ('done'/'cancelled') — those are the user's decision and calls are rejected. Omit sessionId for the current session.`,
  archive_session: `Archive or purely unarchive ANOTHER session by ID: removes it from active list/unread counts (does not delete). Requires explicit sessionId; you cannot archive your own. Find ids via list_sessions.`,
  create_task: `Create a new task (board card) — writes tasks/<slug>/task.yaml + creates its orchestrator session. Title + description required (description becomes goal + initial prompt). Optional: acceptanceCriteria, sources, skills, llmConnection, model, workingDirectory, projectId. Task is created as todo and NOT run — starting is the user's or an automation's decision.`,
  list_pages: `List the workspace's Pages (persistent HTML mini-apps shown in sidebar). Returns slug, name, kind (static/interactive/live), project, refresh schedule, last outcome, share state, folder. Use get_page for full details.`,
  get_page: `Get full details for one Page by slug: config, content path/digest, data summary (KV keys + per-series point counts/latest), grants, share state. Returns absolute paths (contentPath, data/ snapshot) to Read for full HTML/snapshot.`,
  create_page: `Create a new Page: self-contained HTML app living at pages/<slug>/ in the workspace, shown in the Pages sidebar. Read the pages doc (dev docs) BEFORE authoring: full standalone HTML, all CSS/JS inline, no external requests; receive data via the page data bridge; kind: static (no JS), interactive (JS + user-driven), live (interactive + data snapshot stream).`,
  update_page: `Update an existing Page: metadata (name/description/kind/project), refresh schedule, and/or full new HTML content. Only provided fields change; pass null to clear description/null-driven reset. Replacing content invalidates existing source grants (user must re-approve). Slug stays.`,
  write_page_data: `Write to a Page data store: set (kv upsert), delete (kv remove), appendSeries (numeric timeseries intances with timestamps), pruneSeries. The snapshot regenerates and pushes to open renders live. Idempotent writes: same series+timestamp overwrites.`,
  delete_page: `Permanently delete a Page — removes folder including content, data store, grants. DESTRUCTIVE: confirm deletion with the user first unless the user explicitly asked. Published copies are unpublished best-effort (publicCopyMayRemain possible).`,
  get_session_info: `Get metadata about the current session (or by sessionId): labels, status, name, permission mode, projectId, workingDirectory. No args = introspect your own.`,
  list_sessions: `List sessions (workspace-wide; total + paginated results, limit 20 default, sort/filters via status/label/search). Use get_session_info for details on a specific.`,
  list_background_tasks: `List background agents/tasks tracked for a session: running, finished, or orphaned (terminated when the turn launched them ended). Authoritative answer for 'what is running / what's the status?'. Omit sessionId for the current session.`,
  send_agent_message: `Send a message to another session; the target receives it with your session ID so it can reply. Use to coordinate spawned sessions, follow-up instructions, or relay information. Find ids via list_sessions or use the sessionId from spawn_session.`,
  add_memory: `Store information that should persist beyond this conversation. Use when the user wants something retained for later — a fact, preference, instruction, name or alias, or a rule — and write it down instead of only acknowledging it in your reply. Use session scope for temporary/task-specific facts about this conversation; use global scope for durable user preferences, rules, and reusable knowledge that should persist across sessions.`,
  query_memories: `Check what has been stored before answering. Call this proactively whenever the question may depend on information from earlier conversations (preferences, rules, facts, names) instead of guessing from current context alone. Performs semantic expansion internally when surface keywords miss. Searches this session's memories and workspace-global memories.`,
  deliver_file: `Deliver a local file as an attachment to the messaging channel(s) bound to this session (Telegram/WhatsApp/Lark/QQ). Use when the user asks to send/forward a generated/downloaded file to their phone or app. Prefer this over printing a link when a real attachment is wanted.`,
  list_messaging_channels: `List messaging channels (Telegram/WhatsApp/Lark/QQ) bound to this session — shows which external chat apps are connected to send/receive files.`,
  unbind_messaging_channel: `Disconnect a messaging channel from this session so messages stop forwarding. Optionally specify platform (e.g. telegram); default removes all.`,
} as const;

// ============================================================
// Tool Definition Type
// ============================================================

/** Handler function signature for session tools. */
export type SessionToolHandler = (ctx: SessionToolContext, args: any) => Promise<ToolResult>;

/** Where a session tool is executed. */
export type SessionToolExecutionMode = 'registry' | 'backend';

/** Safe/Explore mode behavior for a session tool. */
export type SessionToolSafeMode = 'allow' | 'block';

interface SessionToolDefBase {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  /** Whether this tool is allowed in Explore/Safe mode. */
  safeMode: SessionToolSafeMode;
  /** Whether this tool only reads data (no side effects). Enables parallel execution in backends that support it. */
  readOnly?: boolean;
}

/** Tool executed from the canonical registry (requires a concrete handler). */
export interface RegistrySessionToolDef extends SessionToolDefBase {
  executionMode: 'registry';
  handler: SessionToolHandler;
}

/** Tool executed by backend-specific adapters (Pi/Claude/session-mcp-server). */
export interface BackendSessionToolDef extends SessionToolDefBase {
  executionMode: 'backend';
  handler: null;
}

/** A single session tool definition combining name, description, schema, mode, and handler. */
export type SessionToolDef = RegistrySessionToolDef | BackendSessionToolDef;

// ============================================================
// Canonical Tool Registry
// ============================================================

export const SESSION_TOOL_DEFS: SessionToolDef[] = [
  { name: 'SubmitPlan', description: TOOL_DESCRIPTIONS.SubmitPlan, inputSchema: SubmitPlanSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSubmitPlan },
  { name: 'config_validate', description: TOOL_DESCRIPTIONS.config_validate, inputSchema: ConfigValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleConfigValidate },
  { name: 'skill_validate', description: TOOL_DESCRIPTIONS.skill_validate, inputSchema: SkillValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleSkillValidate },
  { name: 'mermaid_validate', description: TOOL_DESCRIPTIONS.mermaid_validate, inputSchema: MermaidValidateSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleMermaidValidate },
  { name: 'source_test', description: TOOL_DESCRIPTIONS.source_test, inputSchema: SourceTestSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSourceTest },
  { name: 'source_oauth_trigger', description: TOOL_DESCRIPTIONS.source_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleSourceOAuthTrigger },
  { name: 'source_google_oauth_trigger', description: TOOL_DESCRIPTIONS.source_google_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleGoogleOAuthTrigger },
  { name: 'source_slack_oauth_trigger', description: TOOL_DESCRIPTIONS.source_slack_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleSlackOAuthTrigger },
  { name: 'source_microsoft_oauth_trigger', description: TOOL_DESCRIPTIONS.source_microsoft_oauth_trigger, inputSchema: SourceOAuthTriggerSchema, executionMode: 'registry', safeMode: 'block', handler: handleMicrosoftOAuthTrigger },
  { name: 'source_credential_prompt', description: TOOL_DESCRIPTIONS.source_credential_prompt, inputSchema: CredentialPromptSchema, executionMode: 'registry', safeMode: 'block', handler: handleCredentialPrompt },
  { name: 'transform_data', description: TOOL_DESCRIPTIONS.transform_data, inputSchema: TransformDataSchema, executionMode: 'registry', safeMode: 'allow', handler: handleTransformData },
  { name: 'script_sandbox', description: TOOL_DESCRIPTIONS.script_sandbox, inputSchema: ScriptSandboxSchema, executionMode: 'registry', safeMode: 'allow', handler: handleScriptSandbox },
  { name: 'render_template', description: TOOL_DESCRIPTIONS.render_template, inputSchema: RenderTemplateSchema, executionMode: 'registry', safeMode: 'allow', handler: handleRenderTemplate },
  { name: 'send_developer_feedback', description: TOOL_DESCRIPTIONS.send_developer_feedback, inputSchema: SendDeveloperFeedbackSchema, executionMode: 'registry', safeMode: 'allow', handler: handleSendDeveloperFeedback },
  { name: 'call_llm', description: TOOL_DESCRIPTIONS.call_llm, inputSchema: CallLlmSchema, executionMode: 'backend', safeMode: 'allow', readOnly: true, handler: null },
  { name: 'spawn_session', description: TOOL_DESCRIPTIONS.spawn_session, inputSchema: SpawnSessionSchema, executionMode: 'backend', safeMode: 'block', handler: null },
  // Browser tool (backend-specific — requires BrowserPaneManager in Electron)
  // Single CLI-like tool that handles all browser actions via command string.
  { name: 'browser_tool', description: TOOL_DESCRIPTIONS.browser_tool, inputSchema: BrowserToolSchema, executionMode: 'backend', safeMode: 'allow', handler: null },
  // Session self-management tools (registry — use context callbacks to reach SessionManager)
  { name: 'set_session_labels', description: TOOL_DESCRIPTIONS.set_session_labels, inputSchema: SetSessionLabelsSchema, executionMode: 'registry', safeMode: 'block', handler: handleSetSessionLabels },
  { name: 'set_session_status', description: TOOL_DESCRIPTIONS.set_session_status, inputSchema: SetSessionStatusSchema, executionMode: 'registry', safeMode: 'block', handler: handleSetSessionStatus },
  { name: 'archive_session', description: TOOL_DESCRIPTIONS.archive_session, inputSchema: ArchiveSessionSchema, executionMode: 'registry', safeMode: 'block', handler: handleArchiveSession },
  { name: 'create_task', description: TOOL_DESCRIPTIONS.create_task, inputSchema: CreateTaskSchema, executionMode: 'registry', safeMode: 'block', handler: handleCreateTask },
  // Pages tools (registry — use the grouped ctx.pages callbacks from SessionManager)
  { name: 'list_pages', description: TOOL_DESCRIPTIONS.list_pages, inputSchema: ListPagesSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListPages },
  { name: 'get_page', description: TOOL_DESCRIPTIONS.get_page, inputSchema: GetPageSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleGetPage },
  { name: 'create_page', description: TOOL_DESCRIPTIONS.create_page, inputSchema: CreatePageSchema, executionMode: 'registry', safeMode: 'block', handler: handleCreatePage },
  { name: 'update_page', description: TOOL_DESCRIPTIONS.update_page, inputSchema: UpdatePageSchema, executionMode: 'registry', safeMode: 'block', handler: handleUpdatePage },
  { name: 'write_page_data', description: TOOL_DESCRIPTIONS.write_page_data, inputSchema: WritePageDataSchema, executionMode: 'registry', safeMode: 'block', handler: handleWritePageData },
  { name: 'delete_page', description: TOOL_DESCRIPTIONS.delete_page, inputSchema: DeletePageSchema, executionMode: 'registry', safeMode: 'block', handler: handleDeletePage },
  { name: 'get_session_info', description: TOOL_DESCRIPTIONS.get_session_info, inputSchema: GetSessionInfoSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleGetSessionInfo },
  { name: 'list_sessions', description: TOOL_DESCRIPTIONS.list_sessions, inputSchema: ListSessionsSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListSessions },
  { name: 'list_background_tasks', description: TOOL_DESCRIPTIONS.list_background_tasks, inputSchema: ListBackgroundTasksSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListBackgroundTasks },
  // Inter-session messaging
  { name: 'send_agent_message', description: TOOL_DESCRIPTIONS.send_agent_message, inputSchema: SendAgentMessageSchema, executionMode: 'registry', safeMode: 'block', handler: handleSendAgentMessage },
  { name: 'add_memory', description: TOOL_DESCRIPTIONS.add_memory, inputSchema: AddMemorySchema, executionMode: 'registry', safeMode: 'block', handler: handleAddMemory },
  { name: 'query_memories', description: TOOL_DESCRIPTIONS.query_memories, inputSchema: QueryMemoriesSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleQueryMemories },
  // Messaging gateway tools
  { name: 'deliver_file', description: TOOL_DESCRIPTIONS.deliver_file, inputSchema: DeliverFileSchema, executionMode: 'registry', safeMode: 'block', handler: handleDeliverFile },
  { name: 'list_messaging_channels', description: TOOL_DESCRIPTIONS.list_messaging_channels, inputSchema: ListMessagingChannelsSchema, executionMode: 'registry', safeMode: 'allow', readOnly: true, handler: handleListMessagingChannels },
  { name: 'unbind_messaging_channel', description: TOOL_DESCRIPTIONS.unbind_messaging_channel, inputSchema: UnbindMessagingChannelSchema, executionMode: 'registry', safeMode: 'block', handler: handleUnbindMessagingChannel },
];

export interface SessionToolFilterOptions {
  /** Include the experimental send_developer_feedback tool. */
  includeDeveloperFeedback?: boolean;
}

/**
 * Return session tools with optional feature filtering.
 *
 * Callers should use this helper instead of filtering ad hoc so tool visibility
 * stays consistent across Claude, Pi, and session-mcp-server backends.
 */
export function getSessionToolDefs(options?: SessionToolFilterOptions): SessionToolDef[] {
  const includeDeveloperFeedback = options?.includeDeveloperFeedback ?? true;

  return SESSION_TOOL_DEFS.filter(def => {
    if (!includeDeveloperFeedback && def.name === 'send_developer_feedback') {
      return false;
    }
    return true;
  });
}

/**
 * Build a name->definition registry with optional feature filtering.
 */
export function getSessionToolRegistry(options?: SessionToolFilterOptions): Map<string, SessionToolDef> {
  return new Map(getSessionToolDefs(options).map(def => [def.name, def]));
}

/**
 * Return session tool names with optional feature filtering.
 */
export function getSessionToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).map(def => def.name));
}

/**
 * Return backend-executed tool names with optional feature filtering.
 */
export function getSessionBackendToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).filter(d => d.executionMode === 'backend').map(d => d.name));
}

/**
 * Return registry-executed tool names with optional feature filtering.
 */
export function getSessionRegistryToolNames(options?: SessionToolFilterOptions): Set<string> {
  return new Set(getSessionToolDefs(options).filter(d => d.executionMode === 'registry').map(d => d.name));
}

export interface SessionToolNameOptions extends SessionToolFilterOptions {
  /** Optional name prefix for consumers (e.g. 'mcp__session__'). */
  prefix?: string;
}

/**
 * Return session tool names that are allowed in Explore/Safe mode.
 */
export function getSessionSafeAllowedToolNames(options?: SessionToolNameOptions): Set<string> {
  const prefix = options?.prefix ?? '';
  return new Set(
    getSessionToolDefs(options)
      .filter(def => def.safeMode === 'allow')
      .map(def => `${prefix}${def.name}`)
  );
}

/**
 * Return session tool names that are blocked in Explore/Safe mode.
 */
export function getSessionSafeBlockedToolNames(options?: SessionToolNameOptions): Set<string> {
  const prefix = options?.prefix ?? '';
  return new Set(
    getSessionToolDefs(options)
      .filter(def => def.safeMode === 'block')
      .map(def => `${prefix}${def.name}`)
  );
}

// ============================================================
// Derived Lookups
// ============================================================

/** Set of session tool names for quick membership checks. */
export const SESSION_TOOL_NAMES = new Set(SESSION_TOOL_DEFS.map(d => d.name));

/** Session tool names that must be handled by backend-specific adapters (Pi/Claude/session-mcp-server). */
export const SESSION_BACKEND_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.executionMode === 'backend').map(d => d.name)
);

/** Session tool names that are always executable from the canonical registry. */
export const SESSION_REGISTRY_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.executionMode === 'registry').map(d => d.name)
);

/** Session tool names allowed in Explore/Safe mode (unfiltered canonical set). */
export const SESSION_SAFE_ALLOWED_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.safeMode === 'allow').map(d => d.name)
);

/** Session tool names blocked in Explore/Safe mode (unfiltered canonical set). */
export const SESSION_SAFE_BLOCKED_TOOL_NAMES = new Set(
  SESSION_TOOL_DEFS.filter(d => d.safeMode === 'block').map(d => d.name)
);

/** Map from tool name → definition for O(1) lookup. */
export const SESSION_TOOL_REGISTRY = new Map(SESSION_TOOL_DEFS.map(d => [d.name, d]));

// ============================================================
// JSON Schema Converter (for MCP / Pi consumers)
// ============================================================

export interface JsonSchemaToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Convert session tool definitions to JSON Schema format.
 *
 * @param opts.prefix - Optional prefix for tool names (e.g., 'mcp__session__' for Pi)
 * @param opts.includeDeveloperFeedback - Include experimental feedback tool in output
 * @returns Array of tool definitions with JSON Schema inputSchema
 */
export function getToolDefsAsJsonSchema(opts?: {
  prefix?: string;
  includeDeveloperFeedback?: boolean;
}): JsonSchemaToolDef[] {
  const prefix = opts?.prefix || '';
  const defs = getSessionToolDefs({ includeDeveloperFeedback: opts?.includeDeveloperFeedback });

  return defs.map(def => {
    // Explicit `as any` avoids TS2589 ("type instantiation is excessively deep")
    // caused by zodToJsonSchema inferring deep generic chains from union schemas.
    const jsonSchema = zodToJsonSchema(def.inputSchema as any, { $refStrategy: 'none' }) as Record<string, unknown>;
    // Strip metadata not needed by MCP/Pi consumers
    delete jsonSchema.$schema;
    delete jsonSchema.additionalProperties;
    return {
      name: prefix + def.name,
      description: def.description,
      inputSchema: jsonSchema,
    };
  });
}
