"""One-shot re-application of the multi-agent wiring into SessionManager.ts.

Kept as a script (not hand edits) because the file is 13k lines and every hunk
below is anchored on text that must match exactly once.
"""

import io
import sys

PATH = 'packages/server-core/src/sessions/SessionManager.ts'
NL = chr(92) + 'n'  # literal backslash-n written into the generated source

s = io.open(PATH, encoding='utf-8').read()


def sub_once(old, new, label):
    global s
    if s.count(old) != 1:
        print(f'FAIL {label}: found {s.count(old)} occurrences')
        sys.exit(1)
    s = s.replace(old, new, 1)
    print(f'ok {label}')


# ---------------------------------------------------------------- imports
sub_once(
    "import type { AutomationSystem } from '@craft-agent/shared/automations'",
    "import type { AutomationSystem } from '@craft-agent/shared/automations'\n"
    "import {\n"
    "  applyScope,\n"
    "  buildAgentSnapshot,\n"
    "  loadAgents,\n"
    "  resolveSessionDefaults,\n"
    "  type AgentSnapshot,\n"
    "} from '@craft-agent/shared/agents'\n"
    "import { listEnabledStrategyIds } from '@craft-agent/shared/config/strategy-ids.ts'\n"
    "import { TaskService } from '../tasks/task-service.ts'\n"
    "import { SupervisorRuntime } from '../routing/supervisor-runtime.ts'\n"
    "import { buildAgentToolBindings } from './agent-tools-bindings.ts'",
    'imports',
)

# ------------------------------------------------------- createSession chain
OLD_CHAIN = """    // Read permission mode from workspace config, fallback to global defaults
    const defaultPermissionMode = options?.permissionMode
      ?? wsConfig?.defaults?.permissionMode
      ?? globalDefaults.workspaceDefaults.permissionMode

    const userDefaultWorkingDir = wsConfig?.defaults?.workingDirectory || undefined
    // Every creation path inherits a default group — automations, messaging and
    // the API included. It resolves here rather than in the composer because
    // those callers never see a renderer preference. The gateway config carries
    // the last resort: the settings page can always write it, whatever window
    // the user happened to be in.
    const defaultStrategy =
      options?.strategy ??
      wsConfig?.defaults?.strategy ??
      (gatewayRouteDeps.config ?? loadLlmConfig())?.defaultStrategy
    // Resolve thinking level with caller-first precedence, matching permissionMode above:
    //   caller override → workspace default → global default.
    // normalizeThinkingLevel() tolerates undefined/unknown inputs.
    const defaultThinkingLevel =
      normalizeThinkingLevel(options?.thinkingLevel)
      ?? normalizeThinkingLevel(wsConfig?.defaults?.thinkingLevel)
      ?? getDefaultThinkingLevel()
    // Get default model from workspace config (used when no session-specific model is set)
    const defaultModel = wsConfig?.defaults?.model
    // Get default enabled sources from workspace config
    const defaultEnabledSourceSlugs = options?.enabledSourceSlugs ?? wsConfig?.defaults?.enabledSourceSlugs"""

NEW_CHAIN = """    // One resolution point for every inherited value.
    //
    // Everything a new session inherits comes from the agent profile, and the
    // last tier is computed from the enabled strategy groups instead of being
    // stored in a config field. That is what lets the gateway config drop its
    // old `defaultStrategy`: automations, messaging and the API all reach this
    // same function, so none of them can end up unrouted.
    //
    // `wsConfig.defaults.*` is only a legacy tier, for an upgrade that runs
    // before the v0->v1 agents migration has touched the workspace.
    const resolvedDefaults = resolveSessionDefaults({
      workspaceRoot: workspaceRootPath,
      agentId: options?.agentId,
      strategy: options?.strategy,
      model: null,
      permissionMode: options?.permissionMode,
      thinkingLevel: normalizeThinkingLevel(options?.thinkingLevel),
      workspaceDefaults: {
        strategy: wsConfig?.defaults?.strategy,
        model: wsConfig?.defaults?.model,
        permissionMode: wsConfig?.defaults?.permissionMode,
        thinkingLevel: wsConfig?.defaults?.thinkingLevel,
      },
      enabledStrategies: listEnabledStrategyIds(gatewayRouteDeps.config ?? loadLlmConfig()),
    })

    const resolvedAgent = resolvedDefaults.agent
    const defaultPermissionMode = resolvedDefaults.permissionMode
      ?? globalDefaults.workspaceDefaults.permissionMode

    const userDefaultWorkingDir = wsConfig?.defaults?.workingDirectory || undefined
    const defaultStrategy = resolvedDefaults.strategy
    const defaultThinkingLevel =
      normalizeThinkingLevel(resolvedDefaults.thinkingLevel)
      ?? getDefaultThinkingLevel()
    const defaultModel = resolvedDefaults.model
    // Sources are an agent ceiling, not a free-for-all: intersect the caller's
    // request with the allowlist so a session created by an automation cannot
    // reach a source its role was never granted.
    const requestedSourceSlugs =
      options?.enabledSourceSlugs ?? wsConfig?.defaults?.enabledSourceSlugs ?? undefined
    const defaultEnabledSourceSlugs = requestedSourceSlugs
      ? applyScope(resolvedAgent.sources, requestedSourceSlugs)
      : requestedSourceSlugs"""

sub_once(OLD_CHAIN, NEW_CHAIN, 'createSession chain')

# --------------------------------------------------- stored session literal
OLD_LITERAL = """    const storedSession = await createStoredSession(workspaceRootPath, {
      name: options?.name,
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      ...(defaultStrategy ? { strategy: defaultStrategy } : {}),
      enabledSourceSlugs: options?.enabledSourceSlugs ?? defaultEnabledSourceSlugs,
      hidden: options?.hidden,
      projectId: resolvedProjectId,
      folderId: resolvedFolderId,
      parentSessionId: options?.parentSessionId,
    })"""

NEW_LITERAL = """    // Freeze the agent at creation: later edits must not rewrite this
    // session's persona or re-open sources it was never granted.
    const agentSnapshot: AgentSnapshot = buildAgentSnapshot(resolvedAgent)

    const storedSession = await createStoredSession(workspaceRootPath, {
      name: options?.name,
      permissionMode: defaultPermissionMode,
      workingDirectory: resolvedWorkingDir,
      ...(defaultStrategy ? { strategy: defaultStrategy } : {}),
      ...(defaultModel ? { model: defaultModel } : {}),
      enabledSourceSlugs: defaultEnabledSourceSlugs,
      hidden: options?.hidden,
      projectId: resolvedProjectId,
      folderId: resolvedFolderId,
      parentSessionId: options?.parentSessionId,
      agentId: resolvedAgent.id,
      agentSnapshot,
      role: options?.role,
      taskId: options?.taskId,
      spawnDepth: options?.spawnDepth,
    })"""

sub_once(OLD_LITERAL, NEW_LITERAL, 'stored session literal')

# -------------------------------------------------------- sessionConfig fields
OLD_CFG = """        permissionMode: managed.permissionMode,
        previousPermissionMode: managed.previousPermissionMode,
        projectId: managed.projectId,
      }"""

NEW_CFG = """        permissionMode: managed.permissionMode,
        previousPermissionMode: managed.previousPermissionMode,
        projectId: managed.projectId,
        // Multi-agent fields: the backend needs these for the persona prompt,
        // the skill ceiling and the role-pruned tool table.
        name: managed.name,
        strategy: managed.strategy,
        enabledSourceSlugs: managed.enabledSourceSlugs,
        agentId: managed.agentId,
        agentSnapshot: managed.agentSnapshot,
        role: managed.role,
        taskId: managed.taskId,
        spawnDepth: managed.spawnDepth,
      }"""

sub_once(OLD_CFG, NEW_CFG, 'sessionConfig fields')

# ------------------------------------------------------------- agent bindings
OLD_AI = "      }) as AgentInstance\n"
NEW_AI = """      }) as AgentInstance

      // Multi-agent wiring: the callbacks exist only where the role makes them
      // meaningful, so a worker never sees `dispatch` and a supervisor never
      // sees execution tools (the table is pruned in session-tools-core).
      if (managed.agent) {
        managed.agent.agentTools = buildAgentToolBindings({
          sessionId: managed.id,
          role: managed.role === 'supervisor' ? 'supervisor' : 'worker',
          taskId: managed.taskId,
          sessionName: managed.name,
          tasks: this.getTasks(managed.workspace.id),
          spawnDepth: managed.spawnDepth ?? 0,
          spawnWorkerSession: async (params) => {
            const created = await this.createSession(managed.workspace.id, {
              name: params.name,
              agentId: params.agentId,
              role: 'worker',
              taskId: params.taskId,
              spawnDepth: params.spawnDepth,
              strategy: managed.strategy,
            })
            await this.sendMessage(created.id, params.instruction)
            return { sessionId: created.id }
          },
          sendToSession: async (sessionId, text) => {
            await this.sendMessage(sessionId, text)
          },
          writeUserVisible: async (text) => {
            await this.surfaceSupervisorMessage(managed, text)
          },
          askUser: async (questions) => {
            await this.surfaceSupervisorQuestion(managed, questions)
          },
          dispatchViaSupervisor: async (params) => {
            const runtime = this.getSupervisorRuntime(managed.workspace.id)
            return runtime.dispatch({ fromSessionId: managed.id, ...params })
          },
        })
      }
"""
sub_once(OLD_AI, NEW_AI, 'agent bindings')

# --------------------------------------------------------------- manager API
OLD_ARCHIVE = "  async archiveSession(sessionId: string): Promise<void> {"
NEW_ARCHIVE = """  /** One task service per workspace (lazy; storage is file-based). */
  private readonly taskServices = new Map<string, TaskService>()
  /** One supervisor runtime per workspace (holds the event backlog). */
  private readonly supervisorRuntimes = new Map<string, SupervisorRuntime>()

  /** Task service for a workspace. */
  getTasks(workspaceId: string): TaskService {
    const cached = this.taskServices.get(workspaceId)
    if (cached) return cached
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error(`Workspace ${workspaceId} not found`)
    const service = new TaskService({
      workspaceRoot: workspace.rootPath,
      sessionExists: (sessionId) => this.sessions.has(sessionId),
      wakeSupervisor: (sessionId, text) => {
        void this.sendMessage(sessionId, text).catch((error) => {
          sessionLog.warn('Failed to wake supervisor', { sessionId, error })
        })
      },
    })
    this.taskServices.set(workspaceId, service)
    return service
  }

  /** Supervisor runtime for a workspace, created on first use. */
  getSupervisorRuntime(workspaceId: string): SupervisorRuntime {
    const cached = this.supervisorRuntimes.get(workspaceId)
    if (cached) return cached

    const runtime = new SupervisorRuntime({
      workspaceRoot: getWorkspaceByNameOrId(workspaceId)?.rootPath ?? '',
      ensureSupervisorSession: async () => {
        const existing = this.findOnDutySupervisor(workspaceId)
        if (existing) {
          return {
            id: existing.id,
            role: 'supervisor',
            spawnDepth: existing.spawnDepth ?? 0,
            agentId: existing.agentId,
            isProcessing: existing.isProcessing,
          }
        }
        try {
          const created = await this.createSession(workspaceId, { role: 'supervisor', name: '督导' })
          return { id: created.id, role: 'supervisor', spawnDepth: 0, isProcessing: false }
        } catch (error) {
          sessionLog.warn('Failed to create supervisor session', { workspaceId, error })
          return null
        }
      },
      getSession: (sessionId) => {
        const managed = this.sessions.get(sessionId)
        if (!managed) return null
        return {
          id: managed.id,
          role: managed.role === 'supervisor' ? 'supervisor' : 'worker',
          spawnDepth: managed.spawnDepth ?? 0,
          agentId: managed.agentId,
          isProcessing: managed.isProcessing,
        }
      },
      spawnWorker: async (params) => {
        const created = await this.createSession(workspaceId, {
          name: params.name ?? params.scope.slice(0, 24),
          agentId: params.agentId,
          role: 'worker',
          taskId: params.taskId,
          spawnDepth: params.spawnDepth,
        })
        await this.sendMessage(created.id, params.instruction)
        return { sessionId: created.id }
      },
      sendToSession: async (sessionId, text) => {
        await this.sendMessage(sessionId, text)
      },
      writeToSupervisor: async (sessionId, text) => {
        const managed = this.sessions.get(sessionId)
        if (managed) await this.surfaceSupervisorMessage(managed, text)
      },
      askUser: async (sessionId, questions) => {
        const managed = this.sessions.get(sessionId)
        if (managed) await this.surfaceSupervisorQuestion(managed, questions)
      },
      getTask: (taskId) => {
        const task = this.getTasks(workspaceId).get(taskId)
        return task ? { id: task.id, currentSessionId: task.currentSessionId } : null
      },
    })

    this.supervisorRuntimes.set(workspaceId, runtime)
    return runtime
  }

  /** The workspace's on-duty supervisor, if one exists and is alive. */
  private findOnDutySupervisor(workspaceId: string): ManagedSession | undefined {
    for (const managed of this.sessions.values()) {
      if (managed.workspace.id !== workspaceId) continue
      if (managed.role !== 'supervisor') continue
      if (managed.isArchived) continue
      return managed
    }
    return undefined
  }

  /**
   * A supervisor's message to the user.
   *
   * Written on the supervisor's own transcript: one channel, so the user never
   * has to guess which session spoke.
   */
  private async surfaceSupervisorMessage(managed: ManagedSession, text: string): Promise<void> {
    await this.appendSyntheticMessage(managed, text)
  }

  /** A supervisor's question to the user. */
  private async surfaceSupervisorQuestion(
    managed: ManagedSession,
    questions: { question: string; options?: string[] }[],
  ): Promise<void> {
    const body = questions
      .map((q, i) => {
        const options = q.options?.length ? `@NL@选项：${q.options.join(' / ')}` : ''
        return `${i + 1}. ${q.question}${options}`
      })
      .join('@NL@')
    await this.appendSyntheticMessage(managed, `需要你拍板：@NL@${body}`)
  }

  async archiveSession(sessionId: string): Promise<void> {""".replace('@NL@', NL)

sub_once(OLD_ARCHIVE, NEW_ARCHIVE, 'manager api')

io.open(PATH, 'w', encoding='utf-8').write(s)
print('done')
