/**
 * The tail every sign-in relay call shares — one transition point for
 * `connected`, whether the host learned about it from an action it performed
 * (start / submit / cancel) or from reading the plugin's state.
 *
 * Why this exists: the plugin cannot push, so the UI reaches `connected` by
 * polling `getPluginAuthState`. If only the action handlers applied
 * credentials, a scan observed through the poll would flip the dialog to
 * "已连接" while `<dataDir>/config.json` stayed empty — the person would be
 * told they were signed in and the plugin would start without a token. Both
 * observations therefore end here.
 *
 * Writes happen once per (listener, attempt). Both paths can see the same
 * `connected` state — the action that started the flow often reports it, and
 * the next poll reports it again — so a second sighting must not merge the
 * same credentials twice, fire a second `listenerChanged`, or re-broadcast the
 * event. The ledger is keyed by listener and remembers which attempt was
 * written; a state that is no longer `connected` (awaiting / scanned /
 * expired / failed / a fresh idle) clears it, so a genuine re-connect writes
 * again.
 *
 * A failed write is deliberately *not* recorded: the credential still has to
 * land, and the next poll is a free retry.
 */

import type { PluginAuthStateDto } from '@craft-agent/shared/protocol/dto';
import type { PluginAuthResult } from './plugin-auth';

export interface AuthFinishDeps {
  /** Broadcast one snapshot to the workspace's renderers. */
  pushAuthEvent(workspaceId: string, listenerId: string, state: PluginAuthStateDto): void;
  /** Merge credentials into the plugin's config and restart it if running. */
  applyCredentials(
    workspaceId: string,
    listenerId: string,
    workspaceRoot: string,
    credentials: Record<string, unknown>,
  ): Promise<void>;
}

/** Result shape the renderer sees: never carries `credentials`. */
export type SafePluginAuthResult = Omit<PluginAuthResult, 'credentials'>;

export function createAuthFinisher(
  deps: AuthFinishDeps,
): (
  workspaceId: string,
  listenerId: string,
  workspaceRoot: string,
  result: PluginAuthResult,
) => Promise<SafePluginAuthResult> {
  /** `${workspaceId}:${listenerId}` → the attempt whose credentials landed. */
  const written = new Map<string, number>();

  return async function finishAuth(workspaceId, listenerId, workspaceRoot, result) {
    const state = result.state;
    const key = `${workspaceId}:${listenerId}`;

    // Anything that is not `connected` means the previous sign-in is over (or
    // never happened): the next `connected` is a new one and must write.
    if (state && state.phase !== 'connected') written.delete(key);

    // A `connected` for an attempt we already wrote is a repeat sighting: it
    // carries neither new credentials nor news for the renderers. This covers
    // the later polls too, which report the phase without credentials.
    const alreadyWritten =
      result.ok && state?.phase === 'connected' && written.get(key) === (state.attempt ?? 0);
    let duplicate = alreadyWritten;

    if (result.ok && state?.phase === 'connected' && result.credentials && !alreadyWritten) {
      const attempt = state.attempt ?? 0;
      {
        try {
          await deps.applyCredentials(workspaceId, listenerId, workspaceRoot, result.credentials);
          written.set(key, attempt);
        } catch (error) {
          // The sign-in itself succeeded; only the hand-over failed. Say so
          // instead of reporting a failed scan the person just completed.
          return {
            ...result,
            ok: false,
            code: 'rejected',
            error: `授权成功，但写入插件配置失败：${error instanceof Error ? error.message : String(error)}`,
          };
        }
      }
    }

    // A duplicate sighting carries nothing new for the renderers.
    if (state && !duplicate) deps.pushAuthEvent(workspaceId, listenerId, state);

    // `credentials` never leaves the host: the renderer gets the snapshot only.
    const { credentials: _credentials, ...safe } = result;
    return safe;
  };
}
