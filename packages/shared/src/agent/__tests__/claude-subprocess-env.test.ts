import { describe, it, expect, afterEach } from 'bun:test';
import { buildClaudeSubprocessEnv } from '../options.ts';

const ORIGINAL_ENV = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  CRAFT_SESSION_DIR: process.env.CRAFT_SESSION_DIR,
};

function restoreEnv() {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnv();
});

describe('buildClaudeSubprocessEnv concurrency isolation', () => {
  it('does not inherit Claude auth/session vars from the main process', () => {
    process.env.ANTHROPIC_API_KEY = 'global-key-from-other-session';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'global-oauth-from-other-session';
    process.env.ANTHROPIC_BASE_URL = 'https://wrong.example';
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = 'wrong-haiku';
    process.env.CRAFT_SESSION_DIR = '/wrong/session';

    const env = buildClaudeSubprocessEnv({
      CRAFT_SESSION_DIR: '/sessions/current',
      ANTHROPIC_API_KEY: 'current-key',
      ANTHROPIC_BASE_URL: 'https://current.example',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'current-mini',
    });

    expect(env.CRAFT_SESSION_DIR).toBe('/sessions/current');
    expect(env.ANTHROPIC_API_KEY).toBe('current-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://current.example');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('current-mini');
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it('can build two different session envs from the same process concurrently', () => {
    process.env.ANTHROPIC_API_KEY = 'global-key-that-must-not-leak';
    process.env.CRAFT_SESSION_DIR = '/global/session';

    const first = buildClaudeSubprocessEnv({
      CRAFT_SESSION_DIR: '/sessions/one',
      ANTHROPIC_API_KEY: 'key-one',
    });
    const second = buildClaudeSubprocessEnv({
      CRAFT_SESSION_DIR: '/sessions/two',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-two',
    });

    expect(first.CRAFT_SESSION_DIR).toBe('/sessions/one');
    expect(first.ANTHROPIC_API_KEY).toBe('key-one');
    expect(first.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();

    expect(second.CRAFT_SESSION_DIR).toBe('/sessions/two');
    expect(second.ANTHROPIC_API_KEY).toBeUndefined();
    expect(second.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-two');
  });
});
