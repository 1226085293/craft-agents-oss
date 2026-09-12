import { describe, it, expect } from 'bun:test';
import {
  AUTO_RETRY_BUDGET_MAX_ROUNDS,
  AUTO_RETRY_FIRST_DELAY_MS,
  AUTO_RETRY_INTERVAL_MS,
  AUTO_RETRY_DEADLINE_MS,
  AUTO_RETRY_MAX_ROUNDS,
  classifyAutoRetryError,
  extractHttpStatus,
  extractLastAssistant,
  isBudgetExhaustedError,
  stripTrailingErrorAssistant,
} from './auto-retry.ts';

describe('auto-retry constants', () => {
  it('matches the agreed retry policy', () => {
    expect(AUTO_RETRY_FIRST_DELAY_MS).toBe(2_000);
    expect(AUTO_RETRY_INTERVAL_MS).toBe(5 * 60_000);
    expect(AUTO_RETRY_DEADLINE_MS).toBe(2 * 60 * 60_000);
    expect(AUTO_RETRY_MAX_ROUNDS).toBe(30);
    expect(AUTO_RETRY_BUDGET_MAX_ROUNDS).toBe(3);
  });
});

describe('classifyAutoRetryError', () => {
  it('classifies auth/key errors as permanent', () => {
    for (const text of [
      'Request failed with status code 401',
      '401 Unauthorized',
      'Invalid API key provided',
      'invalid_api_key',
      'Incorrect API key provided: sk-xxx.',
      'API key not valid. Please pass a valid API key.',
      '认证失败：密钥无效',
      '鉴权失败',
    ]) {
      expect(classifyAutoRetryError(text)).toBe('permanent');
    }
  });

  it('classifies billing/quota errors as permanent', () => {
    for (const text of [
      'insufficient_quota: You exceeded your current quota',
      'You have insufficient balance in your account',
      '余额不足，请充值',
      'Your available balance is not enough',
      'You have exceeded your billing cycle limit',
      'out of budget',
      'Monthly usage limit reached for your plan',
      'GoUsageLimitError: usage cap hit',
      'FreeUsageLimitError',
    ]) {
      expect(classifyAutoRetryError(text)).toBe('permanent');
    }
  });

  it('classifies context overflow errors as permanent (own recovery lane)', () => {
    for (const text of [
      'prompt is too long: 213462 tokens > 200000 maximum',
      'Your input exceeds the context window of this model',
      "Requested token count exceeds the model's maximum context length of 131072 tokens",
      'context length exceeded',
    ]) {
      expect(classifyAutoRetryError(text)).toBe('permanent');
    }
  });

  it("classifies upstream_response_budget_exhausted as 'transient_limited' (fit-pulsar incidents #1+#2)", () => {
    // 2026-09-10 (#1): classified permanent — but that let a recoverable
    // memory-pressure blip kill the session with zero retries (2026-09-11 #2).
    // Whether the error is deterministic depends on which budget branch the
    // gateway hit (per-request cap vs global pressure) and on channel health —
    // unknowable client-side, and uni-api failover can land the retry on a
    // healthy channel. So: retried like transient, but capped tightly
    // (AUTO_RETRY_BUDGET_MAX_ROUNDS) by the retry loop.
    for (const text of [
      'Error: Current provider response failed: upstream_response_budget_exhausted',
      'upstream_response_budget_exhausted',
      'response budget exhausted for current request',
    ]) {
      expect(classifyAutoRetryError(text)).toBe('transient_limited');
      expect(isBudgetExhaustedError(text)).toBe(true);
    }
    // The tight cap applies ONLY to budget errors.
    expect(isBudgetExhaustedError('503 Service Unavailable')).toBe(false);
    expect(classifyAutoRetryError('503 Service Unavailable')).toBe('transient');
  });

  it('classifies transient provider/gateway errors as transient', () => {
    for (const text of [
      '429 Too Many Requests',
      'Request failed with status code 429',
      'The model is overloaded. Please try again later.',
      '503 Service Unavailable',
      '500 Internal Server Error',
      '502 Bad Gateway',
      '504 Gateway Timeout',
      'socket hang up',
      'fetch failed: ECONNRESET',
      'Connection terminated by peer',
      'Request timed out after 30000ms',
      'No available providers for this model',
      'User location is not supported for the API use.',
      '当前访问量过大，请稍后再试',
      '模型限流，请稍后重试',
      'Provider error 1305: upstream issue',
      'upstream connect error or disconnect/reset before headers',
    ]) {
      expect(classifyAutoRetryError(text)).toBe('transient');
    }
  });

  it('defaults UNKNOWN errors to transient (bounded by deadline + round cap)', () => {
    expect(classifyAutoRetryError('some totally unknown gateway hiccup')).toBe('transient');
    expect(classifyAutoRetryError('')).toBe('transient');
    expect(classifyAutoRetryError(undefined)).toBe('transient');
    expect(classifyAutoRetryError(null)).toBe('transient');
  });

  it('permanent wins when an error mentions both billing and rate limits', () => {
    expect(classifyAutoRetryError('429 rate limit: quota exceeded for your billing plan')).toBe(
      'permanent',
    );
  });

  it('does not misfire \b401\b inside longer numbers', () => {
    expect(classifyAutoRetryError('generated 4013 tokens')).toBe('transient');
    expect(classifyAutoRetryError('request id 14019 failed')).toBe('transient');
  });

  // -------------------------------------------------------------------------
  // Status-code layer (2026-09-13 lively-forest).
  //
  // The retry loop re-sends the SAME history, so a rejection that is a
  // property of the request can never heal. Both errors below were classified
  // 'transient' before this layer existed, which would have burned the full
  // 2h / 30-round budget while the UI reported "retrying".
  // -------------------------------------------------------------------------

  it('classifies a deterministic 400 as permanent (reasoning_content incident)', () => {
    // Verbatim `message` field from sessions/260907-lively-forest/api-error.json.
    // NOTE: no status code in the text — the SDK's `errorMessage` deliberately
    // omits it (`status` lives in a sibling field), so this must be caught by
    // the request-shape patterns, not the status-code layer.
    const text =
      "'messages.2' : for 'role:assistant' the following must be satisfied" +
      "[('messages.2' : property 'reasoning_content' is unsupported)]";
    expect(extractHttpStatus(text)).toBeNull();
    expect(classifyAutoRetryError(text)).toBe('permanent');
  });

  it('classifies 413 payload/rate over-limit as permanent (Groq 8000 TPM incident)', () => {
    // Verbatim Groq body — again status-free, so it must be caught by pattern.
    const text =
      'Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): ' +
      'Limit 8000, Requested 61426, please reduce your message size';
    expect(extractHttpStatus(text)).toBeNull();
    expect(classifyAutoRetryError(text)).toBe('permanent');
  });

  it('classifies other definitive 4xx codes as permanent', () => {
    for (const text of [
      '403 Forbidden: your key lacks access to this model',
      '404 The model `gpt-9` does not exist',
      '422 Unprocessable Entity: messages.0.content must be a string',
      '415 Unsupported media type',
      'HTTP/1.1 400 Bad Request',
      'Error 400 with provider groq-1 (openai/gpt-oss-120b)',
      '{"error":{"message":"bad request","status":400}}',
      'upstream returned status_code=400',
    ]) {
      expect(classifyAutoRetryError(text)).toBe('permanent');
    }
  });

  it('keeps genuinely transient 4xx codes transient', () => {
    for (const text of [
      '429 Rate limit reached for requests',
      '429 Too Many Requests',
      '408 Request Timeout',
      '409 Conflict: resource is locked',
      '425 Too Early',
    ]) {
      expect(classifyAutoRetryError(text)).toBe('transient');
    }
  });

  it('classifies 5xx as transient regardless of phrasing', () => {
    for (const text of [
      '500 Internal Server Error',
      '502 Bad Gateway',
      '503 Service Temporarily Unavailable',
      '504 Gateway Timeout',
      'HTTP/1.1 500 Internal Server Error',
    ]) {
      expect(classifyAutoRetryError(text)).toBe('transient');
    }
  });

  it('still defaults status-less unknown text to transient', () => {
    for (const text of [
      'socket hang up',
      'fetch failed',
      'upstream connect error or disconnect/reset before headers',
      'some totally unknown gateway hiccup',
    ]) {
      expect(classifyAutoRetryError(text)).toBe('transient');
    }
  });
});

describe('extractHttpStatus', () => {
  it('recovers the status from common provider shapes', () => {
    expect(extractHttpStatus('HTTP/1.1 400 Bad Request')).toBe(400);
    expect(extractHttpStatus('HTTP 413')).toBe(413);
    expect(extractHttpStatus('Error 400 with provider groq-1')).toBe(400);
    expect(extractHttpStatus('upstream returned status_code=400')).toBe(400);
    expect(extractHttpStatus('{"error":{"message":"bad","status":400}}')).toBe(400);
    expect(extractHttpStatus('500 Internal Server Error')).toBe(500);
    expect(extractHttpStatus('429 Too Many Requests')).toBe(429);
  });

  it('ignores numbers that are not status codes', () => {
    expect(extractHttpStatus('generated 4013 tokens')).toBeNull();
    expect(extractHttpStatus('request id 14019 failed')).toBeNull();
    expect(extractHttpStatus('Request too large: Limit 8000, Requested 61426')).toBeNull();
    expect(extractHttpStatus('')).toBeNull();
    expect(extractHttpStatus(undefined)).toBeNull();
  });
});

describe('extractLastAssistant', () => {
  it('returns the last assistant message', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', stopReason: 'stop' },
    ];
    const last = extractLastAssistant(messages);
    expect(last?.stopReason).toBe('stop');
  });

  it('returns null for a non-assistant tail', () => {
    const messages = [
      { role: 'assistant', stopReason: 'toolUse' },
      { role: 'toolResult', content: 'ok' },
    ];
    expect(extractLastAssistant(messages)).toBeNull();
  });

  it('returns null for empty or non-array input', () => {
    expect(extractLastAssistant([])).toBeNull();
    expect(extractLastAssistant(undefined)).toBeNull();
    expect(extractLastAssistant(null)).toBeNull();
    expect(extractLastAssistant('nope')).toBeNull();
  });
});

describe('stripTrailingErrorAssistant', () => {
  it('removes a trailing error assistant in place and returns true', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', stopReason: 'error', errorMessage: '503 Service Unavailable' },
    ];
    expect(stripTrailingErrorAssistant(messages)).toBe(true);
    expect(messages).toHaveLength(1);
    expect((messages[0] as { role: string }).role).toBe('user');
  });

  it('removes a trailing aborted assistant (stall-watchdog kill) and returns true', () => {
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', stopReason: 'aborted' },
    ];
    expect(stripTrailingErrorAssistant(messages)).toBe(true);
    expect(messages).toHaveLength(1);
  });

  it('refuses when the tail is not an error assistant', () => {
    expect(stripTrailingErrorAssistant([{ role: 'user' }])).toBe(false);
    expect(stripTrailingErrorAssistant([{ role: 'assistant', stopReason: 'stop' }])).toBe(false);
    expect(stripTrailingErrorAssistant([{ role: 'assistant', stopReason: 'toolUse' }])).toBe(false);
    expect(stripTrailingErrorAssistant([{ role: 'toolResult' }])).toBe(false);
    expect(stripTrailingErrorAssistant([])).toBe(false);
    expect(stripTrailingErrorAssistant(undefined)).toBe(false);
  });
});
