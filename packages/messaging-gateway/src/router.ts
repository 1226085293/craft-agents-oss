/**
 * Router — routes inbound messages from platform adapters to sessions.
 *
 * Looks up the ChannelBinding for (platform, channelId).
 * If found → access-control gate, then resolves any `IncomingAttachment.localPath`
 * entries to `FileAttachment`s via `readFileAttachment()` and forwards to
 * SessionManager.
 * If not found → delegates to Commands for /bind, /new, etc. (Commands
 * applies its own pre-binding access gate.)
 */

import type { ISessionManager } from '@craft-agent/server-core/handlers'
import { readFileAttachment } from '@craft-agent/shared/utils'
import type { FileAttachment } from '@craft-agent/shared/protocol'
import {
  evaluateBindingAccess,
  executeRejection,
  readPlatformOwners,
  type AccessRejectReason,
} from './access-control'
import type { BindingStore } from './binding-store'
import type { Commands } from './commands'
import type { PendingSendersStore } from './pending-senders'
import type {
  IncomingMessage,
  MessagingConfig,
  MessagingLogger,
  PlatformAdapter,
} from './types'

const NOOP_LOGGER: MessagingLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => NOOP_LOGGER,
}

export interface RouterDeps {
  /** Reads the workspace's current MessagingConfig. Called per-message
   *  so config edits take effect without restart. */
  getWorkspaceConfig: () => MessagingConfig
  /** Optional pending-senders store; rejected attempts are recorded here so
   *  the Settings UI can surface them with one-click "Allow" buttons. */
  pendingStore?: PendingSendersStore
}

export class Router {
  private readonly deps: RouterDeps
  private readonly recentRejectReplies = new Map<string, number>()
  /** Last decision-gate timestamp per (platform, groupId) for throttling. */
  private readonly groupChatDecisionAt = new Map<string, number>()
  /** Last decision action per group ('reply' | 'ignore'). */
  private readonly groupChatLastAction = new Map<string, 'reply' | 'ignore'>()
  /** Cooldown between non-@ group-message decisions per group (ms). */
  private static readonly GROUP_CHAT_DECISION_COOLDOWN_MS = 2 * 1000

  constructor(
    private readonly sessionManager: ISessionManager,
    private readonly bindingStore: BindingStore,
    private readonly commands: Commands,
    private readonly log: MessagingLogger = NOOP_LOGGER,
    deps: RouterDeps = { getWorkspaceConfig: () => ({ enabled: false, platforms: {} }) },
  ) {
    this.deps = deps
  }

  async route(adapter: PlatformAdapter, msg: IncomingMessage): Promise<void> {
    // Threads (Telegram supergroup forum topics) participate in the binding
    // lookup key, so two topics in the same supergroup route to different
    // sessions even though they share `chat.id`.
    const binding = this.bindingStore.findByChannel(msg.platform, msg.channelId, msg.threadId)

    if (binding) {
      const verdict = evaluateBindingAccess({
        msg,
        workspaceConfig: this.deps.getWorkspaceConfig(),
        binding,
      })
      if (!verdict.allow) {
        await this.handleReject(adapter, msg, verdict.reason, {
          bindingId: binding.id,
          sessionId: binding.sessionId,
        })
        return
      }

      try {
        const fileAttachments = this.resolveAttachments(msg)
        const attachmentCount = fileAttachments?.length ?? 0
        const isBusy = typeof this.sessionManager.isSessionProcessing === 'function'
          ? this.sessionManager.isSessionProcessing(binding.sessionId)
          : false

        // Group-chat decision gate: for plain (non-@) group messages, ask
        // whether the bot should reply before routing into the session, so
        // the bot behaves like a real group member instead of echoing
        // every message. @-mentioned messages (`mentionKind: 'at'`) and
        // DMs bypass this gate entirely.
        if (
          msg.mentionKind === 'none' &&
          attachmentCount === 0 &&
          !isBusy &&
          this.sessionManager.decideGroupChat
        ) {
          const handled = await this.tryDecideGroupChat(adapter, msg, binding.sessionId, binding.channelName)
          if (handled) return
        }

        if (
          isBusy &&
          attachmentCount === 0 &&
          binding.config.busyMessagePolicy === 'agent_decide' &&
          this.sessionManager.decideBusyMessage
        ) {
          const handled = await this.tryHandleBusyMessage(adapter, msg, binding.sessionId, binding.channelName)
          if (handled) return
        }

        this.log.info('routing inbound chat message to session', {
          event: 'message_routed',
          platform: msg.platform,
          channelId: msg.channelId,
          threadId: msg.threadId,
          sessionId: binding.sessionId,
          bindingId: binding.id,
          attachmentCount,
          busy: isBusy,
        })
        await this.sessionManager.sendMessage(
          binding.sessionId,
          msg.text,
          fileAttachments,
          undefined, // storedAttachments (handled by session layer)
          {
            // Non-desktop platforms (Telegram, WhatsApp) default to steer for
            // mid-stream messages — injects the message into the active turn
            // via agent.redirect() so the user can guide/interrupt the running task.
            midStreamBehavior: isBusy ? 'steer' : undefined,
            // Mobile chats clamp a desktop `ask` session to read-only for THIS
            // message: the agent processes it under explore rules while the
            // desktop UI keeps showing `ask`. `execute` sessions are unaffected
            // (override only tightens, never loosens) and `/exec` remains the
            // explicit way to switch modes for real.
            permissionModeOverride: 'safe',
            // Let the agent know which messaging platform this message came from
            // so it can adapt reply format (files via deliver_file on plain-text
            // platforms like QQ/WeChat, MarkdownV2 on Telegram, etc.).
            platform: msg.platform,
          },
        )
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        this.log.error('failed to route inbound chat message', {
          event: 'message_route_failed',
          platform: msg.platform,
          channelId: msg.channelId,
          threadId: msg.threadId,
          sessionId: binding.sessionId,
          bindingId: binding.id,
          error: err,
        })
        await adapter.sendText(
          msg.channelId,
          `Failed to send message to session: ${errorMsg}`,
          { threadId: msg.threadId },
        )
      }
      return
    }

    this.log.info('routing inbound chat message to command handler', {
      event: 'message_unbound',
      platform: msg.platform,
      channelId: msg.channelId,
      threadId: msg.threadId,
      messageId: msg.messageId,
    })
    await this.commands.handle(adapter, msg)
  }

  private async tryHandleBusyMessage(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    sessionId: string,
    channelName?: string,
  ): Promise<boolean> {
    if (!this.sessionManager.decideBusyMessage) return false

    const decision = await this.sessionManager.decideBusyMessage({
      platform: msg.platform,
      userMessage: msg.text,
      sessionId,
      ...(channelName ? { channelName } : {}),
      isBusy: true,
    })

    this.log.info('busy inbound chat message decision', {
      event: 'message_busy_decision',
      platform: msg.platform,
      channelId: msg.channelId,
      threadId: msg.threadId,
      sessionId,
      action: decision.action,
      replied: !!decision.replyText,
    })

    if (decision.action === 'ignore') return true

    if (decision.action === 'reply') {
      const replyText = decision.replyText?.trim()
      if (!replyText) return true
      await adapter.sendText(msg.channelId, replyText, { threadId: msg.threadId })
      return true
    }

    if (decision.action === 'abort') {
      // User explicitly wants to stop the current task. Force-abort the session
      // so the subprocess and any child processes are terminated, then let the
      // next user message start a fresh turn.
      await this.sessionManager.cancelProcessing(sessionId, /* silent */ true)
      return true
    }

    // Returning false means: the message was not handled (no reply sent, not ignored).
    // The caller will use sendMessage with midStreamBehavior='steer' by default,
    // which injects the message into the active turn via agent.redirect().
    return false
  }

  /**
   * Group-chat decision gate: decide whether the bot should reply to a
   * plain (non-@) group message. Applies a per-group cooldown so a chatty
   * group doesn't trigger a mini-LLM decision for every single message.
   * Returns true when the message was handled (decision consumed it).
   */
  private async tryDecideGroupChat(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    sessionId: string,
    channelName?: string,
  ): Promise<boolean> {
    if (!this.sessionManager.decideGroupChat) return false

    const gateKey = `${msg.platform}:${msg.channelId}`
    const now = Date.now()
    const lastDecision = this.groupChatDecisionAt.get(gateKey) ?? 0

    // Cooldown window: don't re-run the LLM decision for every message,
    // but DO NOT drop the message either — if the last decision was
    // 'reply', the follow-up messages carry the user's real intent, so
    // route them straight into the session (no delay). Only drop when the
    // last decision said 'ignore' (chatty idle chatter).
    if (now - lastDecision < Router.GROUP_CHAT_DECISION_COOLDOWN_MS) {
      const lastAction = this.groupChatLastAction.get(gateKey)
      if (lastAction === 'reply') {
        this.log.info('group chat follow-up routed (last decision reply)', {
          event: 'group_chat_followup_routed',
          platform: msg.platform,
          channelId: msg.channelId,
          sessionId,
          textPreview: (msg.text ?? '').slice(0, 60),
        })
        return false
      }
      this.log.info('group chat message ignored (decision cooldown)', {
        event: 'group_chat_ignored_cooldown',
        platform: msg.platform,
        channelId: msg.channelId,
        sessionId,
      })
      return true
    }

    // Not in cooldown — run the decision gate.
    this.groupChatDecisionAt.set(gateKey, now)

    try {
      // NOTE: call the method on the receiver (this.sessionManager) so
      // `this` stays bound — destructuring the method loses the receiver
      // and breaks implementations that read instance state.
      const decision = await this.sessionManager.decideGroupChat({
        platform: msg.platform,
        groupId: msg.channelId,
        userMessage: msg.text,
        sessionId,
        senderIsOwner: this.isPlatformOwner(msg.platform, msg.senderId),
        ...(channelName ? { channelName } : {}),
      })

      this.log.info('group chat message decision', {
        event: 'group_chat_decision',
        platform: msg.platform,
        channelId: msg.channelId,
        sessionId,
        action: decision.action,
      })

      this.groupChatLastAction.set(gateKey, decision.action)

      if (decision.action === 'ignore') return true
      // 'reply' → fall through to the normal routing path (no delay).
      return false
    } catch (err) {
      this.log.warn('group chat decision failed; ignoring message', {
        event: 'group_chat_decision_failed',
        platform: msg.platform,
        channelId: msg.channelId,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
      return true
    }
  }

  /**
   * Common reject path for both bound (this file) and pre-binding (Commands)
   * gating. Delegates to the shared `executeRejection` so text and button
   * paths behave identically.
   */
  async handleReject(
    adapter: PlatformAdapter,
    msg: IncomingMessage,
    reason: AccessRejectReason,
    extra?: { bindingId?: string; sessionId?: string },
  ): Promise<void> {
    await executeRejection(
      adapter,
      msg,
      reason,
      {
        recentRejectReplies: this.recentRejectReplies,
        ...(this.deps.pendingStore ? { pendingStore: this.deps.pendingStore } : {}),
      },
      this.log,
      extra,
    )
  }

  /**
   * Convert adapter-emitted `IncomingAttachment[]` into the session's
   * `FileAttachment[]` shape. Adapters that download the blob to disk
   * populate `localPath`; we wrap it with `readFileAttachment()` which
   * handles image→base64 / pdf→base64 / text→utf-8 encoding.
   *
   * Attachments without a `localPath`, or whose file can't be read, are
   * silently skipped — the upstream adapter already logged/notified on
   * download failure, so re-surfacing here would double up.
   */
  private resolveAttachments(msg: IncomingMessage): FileAttachment[] | undefined {
    if (!msg.attachments?.length) return undefined
    const built: FileAttachment[] = []
    for (const a of msg.attachments) {
      if (!a.localPath) continue
      const att = readFileAttachment(a.localPath) as FileAttachment | null
      if (!att) continue
      if (a.fileName) att.name = a.fileName
      if (a.mimeType) att.mimeType = a.mimeType
      built.push(att)
    }
    return built.length > 0 ? built : undefined
  }

  /**
   * Whether the sender openid is listed as an owner of this platform in
   * the workspace config. Used to bias the group-chat decision gate
   * toward replying to the owner's messages.
   */
  private isPlatformOwner(platform: string, senderId: string): boolean {
    if (!senderId) return false
    const config = this.deps.getWorkspaceConfig()
    const owners = readPlatformOwners(config, platform as IncomingMessage['platform'])
    return owners.some((o) => o.userId === senderId)
  }
}
