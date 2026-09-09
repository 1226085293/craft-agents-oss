import { describe, it, expect } from 'bun:test';
import {
  AUTO_RETRY_FIRST_DELAY_MS,
  AUTO_RETRY_INTERVAL_MS,
  AUTO_RETRY_DEADLINE_MS,
  AUTO_RETRY_MAX_ROUNDS,
  classifyAutoRetryError,
  extractLastAssistant,
  stripTrailingErrorAssistant,
} from './auto-retry.ts';

describe('auto-retry constants', () => {
  it('matches the agreed retry policy', () => {
    expect(AUTO_RETRY_FIRST_DELAY_MS).toBe(2_000);
    expect(AUTO_RETRY_INTERVAL_MS).toBe(5 * 60_000);
    expect(AUTO_RETRY_DEADLINE_MS).toBe(2 * 60 * 60_000);
    expect(AUTO_RETRY_MAX_ROUNDS).toBe(30);
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
