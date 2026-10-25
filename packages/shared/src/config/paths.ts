/**
 * Centralized path configuration for Craft Agent.
 *
 * Supports multi-instance development via CRAFT_CONFIG_DIR environment variable.
 * When running from a numbered folder (e.g., craft-tui-agent-1), the detect-instance.sh
 * script sets CRAFT_CONFIG_DIR to ~/.craft-agent-1, allowing multiple instances to run
 * simultaneously with separate configurations.
 *
 * Default (non-numbered folders): ~/.craft-agent/
 * Instance 1 (-1 suffix): ~/.craft-agent-1/
 * Instance 2 (-2 suffix): ~/.craft-agent-2/
 */

import { homedir } from 'os';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync } from 'fs';

/**
 * Where this process keeps its configuration.
 *
 * Under `bun test` this must never be the real `~/.craft-agent`: the constant is
 * resolved once, at import, so a test that sets `CRAFT_CONFIG_DIR` in
 * `beforeEach` (or that imports this module before setting it) would otherwise
 * read and write the developer's live config. That is not theoretical — one
 * full-suite run wrote a gateway fixture over a live `llm-config.json` and
 * deleted a real provider. Bun sets `NODE_ENV=test` for its runner, so an
 * un-overridden test process gets a throwaway directory instead.
 */
function resolveConfigDir(): string {
  const override = process.env.CRAFT_CONFIG_DIR;
  if (override) return override;
  if (process.env.NODE_ENV === 'test') {
    return mkdtempSync(join(tmpdir(), 'craft-test-config-'));
  }
  return join(homedir(), '.craft-agent');
}

// Allow override via environment variable for multi-instance dev
// Falls back to default ~/.craft-agent/ for production and non-numbered dev folders
export const CONFIG_DIR = resolveConfigDir();
