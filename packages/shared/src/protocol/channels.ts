/**
 * RPC channel names — organized by domain namespace.
 * Wire-format strings (values) are the stable API contract.
 * Key paths are internal and may be reorganized freely.
 */
export const RPC_CHANNELS = {
  remote: {
    TEST_CONNECTION: 'remote:testConnection',
  },
  server: {
    GET_WORKSPACES: 'server:getWorkspaces',
    CREATE_WORKSPACE: 'server:createWorkspace',
    GET_STATUS: 'server:getStatus',
    GET_HEALTH: 'server:getHealth',
    GET_ACTIVE_SESSIONS: 'server:getActiveSessions',
    SHUTTING_DOWN: 'server:shuttingDown',
    STATUS_CHANGED: 'server:statusChanged',
    HOME_DIR: 'server:homeDir',
  },
  sessions: {
    GET: 'sessions:get',
    GET_UNREAD_SUMMARY: 'sessions:getUnreadSummary',
    MARK_ALL_READ: 'sessions:markAllRead',
    UNREAD_SUMMARY_CHANGED: 'sessions:unreadSummaryChanged',
    CREATE: 'sessions:create',
    /** Reuse the workspace's on-duty supervisor session, creating it once. */
    ENSURE_SUPERVISOR: 'sessions:ensureSupervisor',
    DELETE: 'sessions:delete',
    GET_MESSAGES: 'sessions:getMessages',
    SEND_MESSAGE: 'sessions:sendMessage',
    CANCEL: 'sessions:cancel',
    KILL_SHELL: 'sessions:killShell',
    RESPOND_TO_PERMISSION: 'sessions:respondToPermission',
    RESPOND_TO_CREDENTIAL: 'sessions:respondToCredential',
    COMMAND: 'sessions:command',
    GET_PERMISSION_MODE_STATE: 'sessions:getPermissionModeState',
    EVENT: 'session:event',
    GET_MODEL: 'session:getModel',
    SET_MODEL: 'session:setModel',
    /** Re-assign the role profile a session runs as (persona + scopes). */
    SET_AGENT: 'session:setAgent',
    SWITCH_CONNECTION: 'session:switchConnection',
    GET_FILES: 'sessions:getFiles',
    GET_NOTES: 'sessions:getNotes',
    SET_NOTES: 'sessions:setNotes',
    WATCH_FILES: 'sessions:watchFiles',
    UNWATCH_FILES: 'sessions:unwatchFiles',
    FILES_CHANGED: 'sessions:filesChanged',
    SEARCH_CONTENT: 'sessions:searchContent',
    EXPORT: 'sessions:export',
    IMPORT: 'sessions:import',
    EXPORT_REMOTE_TRANSFER: 'sessions:exportRemoteTransfer',
    IMPORT_REMOTE_TRANSFER: 'sessions:importRemoteTransfer',
  },
  transfer: {
    START: 'transfer:start',
    CHUNK: 'transfer:chunk',
    COMMIT: 'transfer:commit',
    ABORT: 'transfer:abort',
  },
  tasks: {
    GET_OUTPUT: 'tasks:getOutput',
    STOP: 'tasks:stop',
    /** Persisted, not-yet-delivered tasks — hydrates the composer rows on load. */
    LIST: 'tasks:list',
  },

  workspaces: {
    GET: 'workspaces:get',
    CREATE: 'workspaces:create',
    CHECK_SLUG: 'workspaces:checkSlug',
    UPDATE_REMOTE: 'workspaces:updateRemote',
  },
  window: {
    GET_WORKSPACE: 'window:getWorkspace',
    GET_MODE: 'window:getMode',
    OPEN_WORKSPACE: 'window:openWorkspace',
    OPEN_SESSION_IN_NEW_WINDOW: 'window:openSessionInNewWindow',
    OPEN_SETTINGS_WINDOW: 'window:openSettingsWindow',
    SWITCH_WORKSPACE: 'window:switchWorkspace',
    CLOSE: 'window:close',
    CLOSE_REQUESTED: 'window:closeRequested',
    CONFIRM_CLOSE: 'window:confirmClose',
    CANCEL_CLOSE: 'window:cancelClose',
    SET_TRAFFIC_LIGHTS: 'window:setTrafficLights',
    FOCUS_STATE: 'window:focusState',
    GET_FOCUS_STATE: 'window:getFocusState',
  },
  file: {
    READ: 'file:read',
    READ_DATA_URL: 'file:readDataUrl',
    READ_PREVIEW_DATA_URL: 'file:readPreviewDataUrl',
    READ_BINARY: 'file:readBinary',
    OPEN_DIALOG: 'file:openDialog',
    READ_ATTACHMENT: 'file:readAttachment',
    READ_USER_ATTACHMENT: 'file:readUserAttachment',
    STORE_ATTACHMENT: 'file:storeAttachment',
    GENERATE_THUMBNAIL: 'file:generateThumbnail',
  },
  fs: {
    SEARCH: 'fs:search',
    LIST_DIRECTORY: 'fs:listDirectory',
  },
  debug: {
    LOG: 'debug:log',
  },
  theme: {
    GET_SYSTEM_PREFERENCE: 'theme:getSystemPreference',
    SYSTEM_CHANGED: 'theme:systemChanged',
    APP_CHANGED: 'theme:appChanged',
    GET_APP: 'theme:getApp',
    GET_PRESETS: 'theme:getPresets',
    LOAD_PRESET: 'theme:loadPreset',
    GET_COLOR_THEME: 'theme:getColorTheme',
    SET_COLOR_THEME: 'theme:setColorTheme',
    BROADCAST_PREFERENCES: 'theme:broadcastPreferences',
    PREFERENCES_CHANGED: 'theme:preferencesChanged',
    GET_WORKSPACE_COLOR_THEME: 'theme:getWorkspaceColorTheme',
    SET_WORKSPACE_COLOR_THEME: 'theme:setWorkspaceColorTheme',
    GET_ALL_WORKSPACE_THEMES: 'theme:getAllWorkspaceThemes',
    BROADCAST_WORKSPACE_THEME: 'theme:broadcastWorkspaceTheme',
    WORKSPACE_THEME_CHANGED: 'theme:workspaceThemeChanged',
  },
  system: {
    VERSIONS: 'system:versions',
    HOME_DIR: 'system:homeDir',
    IS_DEBUG_MODE: 'system:isDebugMode',
  },
  update: {
    CHECK: 'update:check',
    GET_INFO: 'update:getInfo',
    INSTALL: 'update:install',
    DISMISS: 'update:dismiss',
    GET_DISMISSED: 'update:getDismissed',
    AVAILABLE: 'update:available',
    DOWNLOAD_PROGRESS: 'update:downloadProgress',
  },
  shell: {
    OPEN_URL: 'shell:openUrl',
    OPEN_FILE: 'shell:openFile',
    SHOW_IN_FOLDER: 'shell:showInFolder',
  },
  menu: {
    NEW_CHAT: 'menu:newChat',
    NEW_WINDOW: 'menu:newWindow',
    OPEN_SETTINGS: 'menu:openSettings',
    KEYBOARD_SHORTCUTS: 'menu:keyboardShortcuts',
    TOGGLE_FOCUS_MODE: 'menu:toggleFocusMode',
    TOGGLE_SIDEBAR: 'menu:toggleSidebar',
    QUIT: 'menu:quit',
    MINIMIZE: 'menu:minimize',
    MAXIMIZE: 'menu:maximize',
    ZOOM_IN: 'menu:zoomIn',
    ZOOM_OUT: 'menu:zoomOut',
    ZOOM_RESET: 'menu:zoomReset',
    TOGGLE_DEV_TOOLS: 'menu:toggleDevTools',
    UNDO: 'menu:undo',
    REDO: 'menu:redo',
    CUT: 'menu:cut',
    COPY: 'menu:copy',
    PASTE: 'menu:paste',
    SELECT_ALL: 'menu:selectAll',
  },
  deeplink: {
    NAVIGATE: 'deeplink:navigate',
  },
  auth: {
    LOGOUT: 'auth:logout',
    SHOW_LOGOUT_CONFIRMATION: 'auth:showLogoutConfirmation',
    SHOW_DELETE_SESSION_CONFIRMATION: 'auth:showDeleteSessionConfirmation',
  },
  credentials: {
    HEALTH_CHECK: 'credentials:healthCheck',
  },
  onboarding: {
    GET_AUTH_STATE: 'onboarding:getAuthState',
    VALIDATE_MCP: 'onboarding:validateMcp',
    START_MCP_OAUTH: 'onboarding:startMcpOAuth',
    DEFER_SETUP: 'onboarding:deferSetup',
  },
  llmConnections: {
    LIST: 'LLM_Connection:list',
    LIST_WITH_STATUS: 'LLM_Connection:listWithStatus',
    GET: 'LLM_Connection:get',
    GET_API_KEY: 'LLM_Connection:getApiKey',
    SAVE: 'LLM_Connection:save',
    DELETE: 'LLM_Connection:delete',
    TEST: 'LLM_Connection:test',
    SET_DEFAULT: 'LLM_Connection:setDefault',
    SET_WORKSPACE_DEFAULT: 'LLM_Connection:setWorkspaceDefault',
    REFRESH_MODELS: 'LLM_Connection:refreshModels',
    CHANGED: 'LLM_Connection:changed',
    TOGGLE_MODEL: 'LLM_Connection:toggleModel',
    ADD_CUSTOM_MODEL: 'LLM_Connection:addCustomModel',
    UPDATE_MODEL_ENABLED: 'LLM_Connection:updateModelEnabled',
  },
  // In-process LLM gateway: config read/write plus a push channel for live
  // scheduling state (cooldowns, open circuits, in-flight requests). The status
  // channel follows the same event-sink pattern as llmConnections.CHANGED.
  llmGateway: {
    GET_STATUS: 'llm_gateway:getStatus',
    GET_CONFIG: 'llm_gateway:getConfig',
    GET_USAGE: 'llm_gateway:getUsage',
    QUERY_LOGS: 'llm_gateway:queryLogs',
    GET_PROVIDER_DETAIL: 'llm_gateway:getProviderDetail',
    SAVE_CONFIG: 'llm_gateway:saveConfig',
    CLEAR_KEY_COOLDOWN: 'llm_gateway:clearKeyCooldown',
    TEST_CONNECTION: 'llm_gateway:testConnection',
    LIST_MODELS: 'llm_gateway:listModels',
    STATUS: 'llm_gateway:status',
  },
  settings: {
    SETUP_LLM_CONNECTION: 'settings:setupLlmConnection',
    TEST_LLM_CONNECTION_SETUP: 'settings:testLlmConnectionSetup',
    GET_DEFAULT_THINKING_LEVEL: 'settings:getDefaultThinkingLevel',
    SET_DEFAULT_THINKING_LEVEL: 'settings:setDefaultThinkingLevel',
    GET_DEFAULT_CONTEXT_WINDOW: 'settings:getDefaultContextWindow',
    GET_NETWORK_PROXY: 'settings:getNetworkProxy',
    SET_NETWORK_PROXY: 'settings:setNetworkProxy',
    GET_SERVER_CONFIG: 'settings:getServerConfig',
    SET_SERVER_CONFIG: 'settings:setServerConfig',
    GET_SERVER_STATUS: 'settings:getServerStatus',
  },
  pi: {
    GET_API_KEY_PROVIDERS: 'pi:getApiKeyProviders',
    GET_PROVIDER_BASE_URL: 'pi:getProviderBaseUrl',
    GET_PROVIDER_MODELS: 'pi:getProviderModels',
  },
  dialog: {
    OPEN_FOLDER: 'dialog:openFolder',
  },
  drafts: {
    GET: 'drafts:get',
    SET: 'drafts:set',
    DELETE: 'drafts:delete',
    GET_ALL: 'drafts:getAll',
  },
  sources: {
    GET: 'sources:get',
    CREATE: 'sources:create',
    DELETE: 'sources:delete',
    START_OAUTH: 'sources:startOAuth',
    SAVE_CREDENTIALS: 'sources:saveCredentials',
    CHANGED: 'sources:changed',
    GET_PERMISSIONS: 'sources:getPermissions',
    GET_MCP_TOOLS: 'sources:getMcpTools',
  },
  oauth: {
    START: 'oauth:start',
    COMPLETE: 'oauth:complete',
    CANCEL: 'oauth:cancel',
    REVOKE: 'oauth:revoke',
  },
  workspace: {
    GET_PERMISSIONS: 'workspace:getPermissions',
    READ_IMAGE: 'workspace:readImage',
    WRITE_IMAGE: 'workspace:writeImage',
    SETTINGS_GET: 'workspaceSettings:get',
    SETTINGS_UPDATE: 'workspaceSettings:update',
  },
  permissions: {
    GET_DEFAULTS: 'permissions:getDefaults',
    DEFAULTS_CHANGED: 'permissions:defaultsChanged',
  },
  skills: {
    GET: 'skills:get',
    GET_FILES: 'skills:getFiles',
    DELETE: 'skills:delete',
    OPEN_EDITOR: 'skills:openEditor',
    OPEN_FINDER: 'skills:openFinder',
    CHANGED: 'skills:changed',
  },
  toolIcons: {
    GET_MAPPINGS: 'toolIcons:getMappings',
  },
  logo: {
    GET_URL: 'logo:getUrl',
  },
  notification: {
    SHOW: 'notification:show',
    NAVIGATE: 'notification:navigate',
    GET_ENABLED: 'notification:getEnabled',
    SET_ENABLED: 'notification:setEnabled',
  },
  input: {
    GET_SEND_MESSAGE_KEY: 'input:getSendMessageKey',
    SET_SEND_MESSAGE_KEY: 'input:setSendMessageKey',
    GET_SPELL_CHECK: 'input:getSpellCheck',
    SET_SPELL_CHECK: 'input:setSpellCheck',
  },
  power: {
    GET_KEEP_AWAKE: 'power:getKeepAwake',
    SET_KEEP_AWAKE: 'power:setKeepAwake',
  },
  appearance: {
    READ: 'appearance:read',
    WRITE: 'appearance:write',
    CHANGED: 'appearance:changed',
    GET_RICH_TOOL_DESCRIPTIONS: 'appearance:getRichToolDescriptions',
    SET_RICH_TOOL_DESCRIPTIONS: 'appearance:setRichToolDescriptions',
  },
  tools: {
    GET_BROWSER_TOOL_ENABLED: 'tools:getBrowserToolEnabled',
    SET_BROWSER_TOOL_ENABLED: 'tools:setBrowserToolEnabled',
  },
  rtk: {
    GET_ENABLED: 'rtk:getEnabled',
    SET_ENABLED: 'rtk:setEnabled',
    GET_STATUS: 'rtk:getStatus',
    GET_GAIN: 'rtk:getGain',
  },
  embedding: {
    GET_PATH: 'embedding:getPath',
    SET_PATH: 'embedding:setPath',
    CLEAR_PATH: 'embedding:clearPath',
  },
  defense: {
    GET_ENABLED: 'defense:getEnabled',
    SET_ENABLED: 'defense:setEnabled',
    GET_GUARDRAILS: 'defense:getGuardrails',
    SET_GUARDRAILS: 'defense:setGuardrails',
  },
  badge: {
    REFRESH: 'badge:refresh',
    SET_ICON: 'badge:setIcon',
    DRAW: 'badge:draw',
    DRAW_WINDOWS: 'badge:draw-windows',
  },
  releaseNotes: {
    GET: 'releaseNotes:get',
    GET_LATEST_VERSION: 'releaseNotes:getLatestVersion',
  },
  git: {
    GET_BRANCH: 'git:getBranch',
  },
  gitbash: {
    CHECK: 'gitbash:check',
    BROWSE: 'gitbash:browse',
    SET_PATH: 'gitbash:setPath',
    OPEN_PATH: 'gitbash:openPath',
  },
  pageWindow: {
    OPEN: 'page-window:open',
    LIST: 'page-window:list',
    FOCUS: 'page-window:focus',
    CLOSE: 'page-window:close',
    MINIMIZE_SELF: 'page-window:minimize-self',
    CLOSE_SELF: 'page-window:close-self',
    STATE_CHANGED: 'page-window:state-changed',
    REMOVED: 'page-window:removed',
  },
  browserPane: {
    CREATE: 'browser-pane:create',
    DESTROY: 'browser-pane:destroy',
    LIST: 'browser-pane:list',
    NAVIGATE: 'browser-pane:navigate',
    GO_BACK: 'browser-pane:go-back',
    GO_FORWARD: 'browser-pane:go-forward',
    RELOAD: 'browser-pane:reload',
    STOP: 'browser-pane:stop',
    FOCUS: 'browser-pane:focus',
    SNAPSHOT: 'browser-pane:snapshot',
    CLICK: 'browser-pane:click',
    FILL: 'browser-pane:fill',
    SELECT: 'browser-pane:select',
    SCREENSHOT: 'browser-pane:screenshot',
    EVALUATE: 'browser-pane:evaluate',
    SCROLL: 'browser-pane:scroll',
    LAUNCH: 'browser-empty-state:launch',
    STATE_CHANGED: 'browser-pane:state-changed',
    REMOVED: 'browser-pane:removed',
    INTERACTED: 'browser-pane:interacted',
  },
  resources: {
    EXPORT: 'resources:export',
    IMPORT: 'resources:import',
  },
  projects: {
    GET: 'projects:get',
    GET_ONE: 'projects:getOne',
    CREATE: 'projects:create',
    UPDATE: 'projects:update',
    DELETE: 'projects:delete',
    ARCHIVE: 'projects:archive',
    UNARCHIVE: 'projects:unarchive',
    ARCHIVED_CHANGED: 'projects:archivedChanged',
    LIST_ASSETS: 'projects:listAssets',
    UPLOAD_ASSET: 'projects:uploadAsset',
    DELETE_ASSET: 'projects:deleteAsset',
    CHANGED: 'projects:changed',
  },
  folders: {
    LIST: 'folders:list',
    CREATE: 'folders:create',
    RENAME: 'folders:rename',
    MOVE: 'folders:move',
    MOVE_TO_SCOPE: 'folders:moveToScope',
    ARCHIVE: 'folders:archive',
    UNARCHIVE: 'folders:unarchive',
    REORDER: 'folders:reorder',
    PIN: 'folders:pin',
    DELETE: 'folders:delete',
    CHANGED: 'folders:changed',
  },
  agents: {
    /** Role profiles for the picker (built-in default first). */
    LIST: 'agents:list',
    /** One profile in full (the picker list is deliberately flat). */
    GET: 'agents:get',
    /** Create or update one profile (built-in default edits `defaults`). */
    SAVE: 'agents:save',
    /** Soft-delete a profile. */
    DELETE: 'agents:delete',
    /** Pushed when the profile set changes. */
    CHANGED: 'agents:changed',
  },
  taskboard: {
    /** Task list (metadata only) for the sidebar. */
    LIST: 'taskboard:list',
    /** One task, optionally with its journal. */
    GET: 'taskboard:get',
    /** Advance a task's status (the state machine still applies). */
    UPDATE: 'taskboard:update',
    /** Record a worker handoff against a task. */
    HANDOFF: 'taskboard:handoff',
    /** Start a run now (claims the lock, spawns a worker). */
    RUN: 'taskboard:run',
    /**
     * Answer the task's pending question.
     *
     * A bare chat message cannot say which task it answers: two tasks waiting at once
     * produce two cards whose answers are identical prose, and the supervisor has to
     * guess. Naming the task here is what makes the answer unambiguous, and recording it
     * on the decision is what makes 「已答复」 survive a reload.
     */
    ANSWER: 'taskboard:answer',
    /** Delete a finished task for good (record, journal, index entry). */
    DELETE: 'taskboard:delete',
    /** Change what starts a task (manual / cron / event). */
    UPDATE_TRIGGER: 'taskboard:updateTrigger',
    /** Pushed when any task changes (workspace-scoped). */
    CHANGED: 'taskboard:changed',
  },
  events: {
    /** Paginated metadata list (never includes bodies). */
    LIST: 'events:list',
    /** Single event including its body. */
    GET: 'events:get',
    /** Per-source totals for the listener cards. */
    COUNTS: 'events:counts',
    /** Ingest server address + whether it is listening. */
    STATUS: 'events:status',
    /** Pushed when a new event lands (workspace-scoped). */
    CHANGED: 'events:changed',
    /** Content of one attachment: text, image data URL, or PDF bytes. */
    READ_ATTACHMENT: 'events:readAttachment',
    /** Hand one attachment to the OS default application. */
    OPEN_ATTACHMENT: 'events:openAttachment',

    /** Installed listener cards. */
    LIST_LISTENERS: 'events:listListeners',
    /** One listener with dependencies, config and log tail. */
    GET_LISTENER: 'events:getListener',
    /** Enable/disable (also starts/stops the process). */
    SET_LISTENER_ENABLED: 'events:setListenerEnabled',
    /** Persist user config values. */
    SET_LISTENER_CONFIG: 'events:setListenerConfig',
    /** Run the manifest's install command for one package dependency. */
    INSTALL_DEPENDENCY: 'events:installDependency',
    /** Install a managed MCP server from dependencies.mcp. */
    INSTALL_MCP: 'events:installMcp',
    /** Dependency state the listener itself reports (control service). */
    LISTENER_DEPS: 'events:listenerDeps',
    /** Trigger one reported dependency's action (the install button). */
    LISTENER_DEPS_ACTION: 'events:listenerDepsAction',
    /**
     * Relay one manifest-declared plugin action from the renderer (the
     * plugin's own HTML page) to the plugin's loopback control service.
     * Generic: the manifest whitelist is checked, the plugin executes.
     */
    LISTENER_PLUGIN_ACTION: 'events:listenerPluginAction',
    /** Pushed when a listener process changes state. */
    LISTENER_STATUS: 'events:listenerStatus',
    /** Plugin-provided HTML config UI (file content or the inline document). */
    GET_LISTENER_UI: 'events:getListenerUi',
    /** Log tail + process state, without re-running the dependency probes. */
    GET_LISTENER_LOG: 'events:getListenerLog',
    /**
     * Pushed when a listener's on-disk facts change (enabled flag, saved
     * config, installed dependency), so list lights follow the detail page.
     */
    LISTENER_CHANGED: 'events:listenerChanged',

    /**
     * Durable outbox: the outbound messages this agent asked to send, and
     * whether each one actually went out. Read by the 发件箱 panel; the
     * server-side dispatcher retries the pending ones.
     */
    OUTBOX_LIST: 'events:outboxList',
    /** Re-arm a record the dispatcher gave up on, for automatic retry. */
    OUTBOX_RETRY: 'events:outboxRetry',
    /** Drop finished (sent / failed) records; pending ones keep their place. */
    OUTBOX_PURGE: 'events:outboxPurge',

    /**
     * Channel pairing: a one-minute, single-use code that unlocks a chat to
     * send events. Generated on the task detail page; redeemed in-chat via
     * `/pair <code>`.
     */
    PAIRING_GENERATE: 'events:pairingGenerate',
    PAIRING_LIST: 'events:pairingList',
    PAIRING_UNPAIR: 'events:pairingUnpair',

    /** This session's subscriptions. */
    LIST_SUBSCRIPTIONS: 'events:listSubscriptions',
    SUBSCRIBE: 'events:subscribe',
    UNSUBSCRIBE: 'events:unsubscribe',
  },
  pages: {
    GET: 'pages:get',
    GET_ONE: 'pages:getOne',
    CREATE: 'pages:create',
    UPDATE: 'pages:update',
    DELETE: 'pages:delete',
    GET_CONTENT: 'pages:getContent',
    SET_CONTENT: 'pages:setContent',
    GET_DATA: 'pages:getData',
    LIST_GRANTS: 'pages:listGrants',
    ISSUE_GRANT: 'pages:issueGrant',
    REVOKE_GRANT: 'pages:revokeGrant',
    CREATE_LEASE: 'pages:createLease',
    RELEASE_LEASE: 'pages:releaseLease',
    EXECUTE_ACTION: 'pages:executeAction',
    CANCEL_ACTION: 'pages:cancelAction',
    GET_SHARE_CAPABILITIES: 'pages:getShareCapabilities',
    GET_SHARE_DATA_SCAN: 'pages:getShareDataScan',
    PUBLISH: 'pages:publish',
    SET_PUBLICATION_PASSWORD: 'pages:setPublicationPassword',
    UNPUBLISH: 'pages:unpublish',
    GET_THUMBNAIL: 'pages:getThumbnail',
    REGENERATE_THUMBNAIL: 'pages:regenerateThumbnail',
    CHANGED: 'pages:changed',
  },
  memory: {
    MEMORY_GET_STATS: 'memory:getStats',
    MEMORY_ADD: 'memory:add',
    MEMORY_DELETE: 'memory:delete',
    MEMORY_DELETE_MANY: 'memory:deleteMany',
    MEMORY_EXTRACT: 'memory:extract',
    MEMORY_UPDATE: 'memory:update',
    MEMORY_GET_TRASH: 'memory:getTrash',
    MEMORY_RESTORE: 'memory:restore',
    MEMORY_CLEAR_TRASH: 'memory:clearTrash',
    MEMORY_SESSION_GET: 'memory:session:get',
    MEMORY_SESSION_ADD: 'memory:session:add',
    MEMORY_SESSION_UPDATE: 'memory:session:update',
    MEMORY_SESSION_DELETE: 'memory:session:delete',
    MEMORY_CONSOLIDATE: 'memory:consolidate',
    MEMORY_CONSOLIDATE_CANCEL: 'memory:consolidate:cancel',
    MEMORY_CONSOLIDATE_STATE_GET: 'memory:consolidate:state',
    MEMORY_CONSOLIDATE_PROGRESS: 'memory:consolidate:progress',
    MEMORY_TRASH_DELETE_MANY: 'memory:trash:deleteMany',
    MEMORY_SCHEDULE_GET: 'memory:schedule:get',
    MEMORY_SCHEDULE_SET: 'memory:schedule:set',
    /** Broadcast after any global-memory write, so UI counts stay live. */
    MEMORY_CHANGED: 'memory:changed',
  },
  usage: {
    GET_STATS: 'usage:getStats',
    GET_HISTORY: 'usage:getHistory',
  },
} as const

// IPC_CHANNELS compat alias removed — all consumers now use RPC_CHANNELS

/**
 * Flatten all channel string values from the nested RPC_CHANNELS object.
 * Used by the exhaustive routing test to ensure every channel is classified.
 */
export function getAllChannelValues(): string[] {
  const values: string[] = []
  for (const namespace of Object.values(RPC_CHANNELS)) {
    for (const channel of Object.values(namespace)) {
      values.push(channel)
    }
  }
  return values
}
