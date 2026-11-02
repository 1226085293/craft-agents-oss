/**
 * Resolve a provider's `baseUrl` into the endpoint a chat request is POSTed to.
 *
 * `baseUrl` is whatever the user pasted into the provider dialog, and the three
 * shapes people actually paste all mean the same thing:
 *
 *   - a version root          `http://127.0.0.1:8788/v1`
 *   - a full chat endpoint    `http://127.0.0.1:8788/v1/chat/completions`
 *   - either, with a query    `…/v1/chat/completions?realm=cn`
 *
 * The gateway used to POST `baseUrl` verbatim, so the first shape answered 404
 * from the relay's root and the request died before any key was used
 * (261027-long-bronze: every workbuddycn request was a 5–27 ms 404, which the
 * gateway then reported as a generic 502). The model probe had the opposite
 * problem — `modelsEndpointFor` strips the chat path — so "test connection"
 * passed while real traffic could never work.
 *
 * Normalising here, at the single outbound call site, keeps the stored value
 * byte-for-byte what the user typed (the settings page shows it back) while the
 * request always lands on a real chat endpoint.
 *
 * Rules, mirroring `modelsEndpointFor` so probing and chatting hit the same tree:
 *
 *   1. an already-correct endpoint is returned untouched — this is what keeps
 *      Azure-style deployment URLs (`…/deployments/<name>/chat/completions?
 *      api-version=…`) from growing a bogus `/v1`;
 *   2. the other family's suffix (`/messages` on an OpenAI provider, or
 *      `/chat/completions` on an Anthropic one) is replaced, not appended to,
 *      so flipping the protocol in the UI cannot produce `…/messages/messages`;
 *   3. a path without a version segment gets `v1`, exactly like the probe;
 *   4. the query string survives verbatim — relays select a tenant/account with
 *      it, and dropping it silently changes which account pays.
 */

import type { LlmProtocol } from './llm-config.ts';

/** Path suffixes that mean "this is already a chat endpoint". */
const CHAT_SUFFIXES = ['chat/completions', 'messages', 'responses'] as const;

/** `/v1`, `/v3`, `/v1beta`, `/v2alpha1` … */
const VERSION_SEGMENT = /^v\d+[a-z0-9.-]*$/i;

function chatSuffix(protocol: LlmProtocol): string {
  return protocol === 'anthropic-messages' ? 'messages' : 'chat/completions';
}

function pathSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean);
}

function endsWithSegments(segments: string[], suffix: string): boolean {
  const parts = suffix.split('/');
  if (segments.length < parts.length) return false;
  const tail = segments.slice(segments.length - parts.length);
  return parts.every((part, i) => tail[i]!.toLowerCase() === part.toLowerCase());
}

function withoutSegments(segments: string[], suffix: string): void {
  segments.splice(segments.length - suffix.split('/').length);
}

/**
 * The URL one chat request is sent to.
 *
 * Returns `''` for an empty baseUrl and the trimmed input when it cannot be
 * parsed as an absolute URL — the caller then fails with a transport error that
 * names the real string, instead of posting to a URL this helper invented.
 */
export function chatEndpointFor(baseUrl: string, protocol: LlmProtocol): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const suffix = chatSuffix(protocol);
  const segments = pathSegments(url);

  // 1. Already the endpoint the caller wants.
  if (endsWithSegments(segments, suffix)) return url.toString();

  // 2. A different chat suffix (protocol flipped on an existing provider).
  for (const other of CHAT_SUFFIXES) {
    if (other.toLowerCase() === suffix.toLowerCase()) continue;
    if (endsWithSegments(segments, other)) {
      withoutSegments(segments, other);
      break;
    }
  }

  // 3. Keep the version segment the user chose, add `v1` when there is none.
  if (!segments.some((segment) => VERSION_SEGMENT.test(segment))) segments.push('v1');

  // 4. Append the endpoint path; the query (tenant/realm) rides along untouched.
  segments.push(...suffix.split('/'));
  url.pathname = `/${segments.join('/')}`;
  url.hash = '';
  return url.toString();
}

/**
 * The URL a `GET /models` catalog request is sent to.
 *
 * Mirrors `chatEndpointFor`'s tree rules so probing and chatting hit the same
 * version root: a trailing chat suffix (`/chat/completions`, `/messages`,
 * `/responses`) is dropped, a missing version segment gets `v1`, and the query
 * string survives verbatim — some relays select a tenant/account with it, and
 * dropping it silently changes which account is probed.
 */
export function modelsEndpointFor(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return '';

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return '';
  }

  const segments = pathSegments(url);
  for (const suffix of CHAT_SUFFIXES) {
    if (endsWithSegments(segments, suffix)) {
      withoutSegments(segments, suffix);
      break;
    }
  }

  if (!segments.some((segment) => VERSION_SEGMENT.test(segment))) segments.push('v1');

  segments.push('models');
  url.pathname = `/${segments.join('/')}`;
  url.hash = '';
  return url.toString();
}
