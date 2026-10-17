/**
 * Tests for CLI tool icon resolver.
 *
 * Covers:
 * - splitCommands: splitting bash strings on &&, ||, ;, |
 * - extractCommandName: extracting command from a single sub-command
 * - extractCommandNames: full parsing of complex bash command strings
 * - resolveToolIcon: end-to-end resolution with config and icon files
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import {
  splitCommands,
  extractCommandName,
  extractCommandNames,
  resolveToolIcon,
  loadToolIconConfig,
  type ToolIconConfig,
} from '../cli-icon-resolver.ts';

/**
 * Since the appearance.json refactor the icon mapping lives in
 * ~/.craft-agent/appearance.json (section `icons`), NOT in
 * <toolIconsDir>/tool-icons.json. `loadToolIconConfig` therefore ignores its
 * directory argument for the mapping and only the icon *files* resolve against
 * that directory. CONFIG_DIR is captured at module load from
 * CRAFT_CONFIG_DIR, so the mapping scenarios run in subprocesses with their
 * own tmpdir (same pattern as appearance-ui-language.test.ts).
 */
const ICON_RESOLVER_MODULE = pathToFileURL(join(import.meta.dir, '..', 'cli-icon-resolver.ts')).href;

// ============================================
// splitCommands
// ============================================

describe('splitCommands', () => {
  test('single command', () => {
    expect(splitCommands('git status')).toEqual(['git status']);
  });

  test('&& chained', () => {
    expect(splitCommands('git add . && git commit -m "msg"')).toEqual([
      'git add .',
      'git commit -m "msg"',
    ]);
  });

  test('|| chained', () => {
    expect(splitCommands('npm test || echo failed')).toEqual([
      'npm test',
      'echo failed',
    ]);
  });

  test('semicolon separated', () => {
    expect(splitCommands('mkdir dist; cp src/* dist/')).toEqual([
      'mkdir dist',
      'cp src/* dist/',
    ]);
  });

  test('pipe', () => {
    expect(splitCommands('git log | head -10')).toEqual([
      'git log',
      'head -10',
    ]);
  });

  test('mixed operators', () => {
    expect(splitCommands('npm install && npm run build || echo failed; npm test')).toEqual([
      'npm install',
      'npm run build',
      'echo failed',
      'npm test',
    ]);
  });

  test('preserves double-quoted strings with operators', () => {
    expect(splitCommands('git commit -m "fix && improve"')).toEqual([
      'git commit -m "fix && improve"',
    ]);
  });

  test('preserves single-quoted strings with operators', () => {
    expect(splitCommands("echo 'hello | world'")).toEqual([
      "echo 'hello | world'",
    ]);
  });

  test('empty string', () => {
    expect(splitCommands('')).toEqual([]);
  });

  test('whitespace only', () => {
    expect(splitCommands('   ')).toEqual([]);
  });

  test('pipe does not confuse with ||', () => {
    // "a || b" should split into two parts, not three
    expect(splitCommands('a || b')).toEqual(['a', 'b']);
  });
});

// ============================================
// extractCommandName
// ============================================

describe('extractCommandName', () => {
  test('simple command', () => {
    expect(extractCommandName('git status')).toBe('git');
  });

  test('command with flags', () => {
    expect(extractCommandName('npm install --save-dev')).toBe('npm');
  });

  test('env var prefix', () => {
    expect(extractCommandName('NODE_ENV=production npm run build')).toBe('npm');
  });

  test('multiple env var prefixes', () => {
    expect(extractCommandName('FOO=1 BAR=2 python3 script.py')).toBe('python3');
  });

  test('sudo prefix', () => {
    expect(extractCommandName('sudo docker ps')).toBe('docker');
  });

  test('time prefix', () => {
    expect(extractCommandName('time npm test')).toBe('npm');
  });

  test('nohup prefix', () => {
    expect(extractCommandName('nohup node server.js')).toBe('node');
  });

  test('env prefix', () => {
    expect(extractCommandName('env npm start')).toBe('npm');
  });

  test('timeout with numeric arg', () => {
    expect(extractCommandName('timeout 30 python3 script.py')).toBe('python3');
  });

  test('combined: env var + sudo', () => {
    expect(extractCommandName('NODE_ENV=prod sudo docker-compose up')).toBe('docker-compose');
  });

  test('absolute path prefix', () => {
    expect(extractCommandName('/usr/local/bin/node script.js')).toBe('node');
  });

  test('relative path prefix', () => {
    expect(extractCommandName('./node_modules/.bin/jest --watch')).toBe('jest');
  });

  test('home path prefix', () => {
    expect(extractCommandName('~/.local/bin/python3 test.py')).toBe('python3');
  });

  test('empty string returns undefined', () => {
    expect(extractCommandName('')).toBeUndefined();
  });

  test('env-only (no actual command) returns undefined', () => {
    // A bare env assignment has no command after it — correctly returns undefined
    expect(extractCommandName('FOO=bar')).toBeUndefined();
  });

  test('caffeinate prefix (macOS)', () => {
    expect(extractCommandName('caffeinate npm run build')).toBe('npm');
  });

  // Shell wrapper tests
  test('zsh -lc wrapper', () => {
    expect(extractCommandName("/bin/zsh -lc 'git status'")).toBe('git');
  });

  test('bash -c wrapper', () => {
    expect(extractCommandName('bash -c "npm install"')).toBe('npm');
  });

  test('sh -c wrapper', () => {
    expect(extractCommandName("sh -c 'docker ps'")).toBe('docker');
  });

  test('nested env vars in shell wrapper', () => {
    expect(extractCommandName("/bin/bash -c 'NODE_ENV=prod npm run build'")).toBe('npm');
  });

  test('shell wrapper with path prefix', () => {
    expect(extractCommandName("/bin/zsh -lc '/usr/local/bin/git status'")).toBe('git');
  });

  test('shell wrapper with sudo inside', () => {
    expect(extractCommandName("bash -c 'sudo docker ps'")).toBe('docker');
  });
});

// ============================================
// extractCommandNames (full pipeline)
// ============================================

describe('extractCommandNames', () => {
  test('simple command', () => {
    expect(extractCommandNames('git status')).toEqual(['git']);
  });

  test('env vars + command', () => {
    expect(extractCommandNames('NODE_ENV=prod npm run build')).toEqual(['npm']);
  });

  test('multiple env vars', () => {
    expect(extractCommandNames('FOO=1 BAR=2 python3 script.py')).toEqual(['python3']);
  });

  test('chained with &&', () => {
    expect(extractCommandNames('git add . && npm publish')).toEqual(['git', 'npm']);
  });

  test('chained with ||', () => {
    expect(extractCommandNames('npm test || echo failed')).toEqual(['npm', 'echo']);
  });

  test('semicolons', () => {
    expect(extractCommandNames('mkdir dist; cp src/* dist/')).toEqual(['mkdir', 'cp']);
  });

  test('pipes', () => {
    expect(extractCommandNames('git log | head -10')).toEqual(['git', 'head']);
  });

  test('sudo', () => {
    expect(extractCommandNames('sudo docker ps')).toEqual(['docker']);
  });

  test('time prefix', () => {
    expect(extractCommandNames('time npm test')).toEqual(['npm']);
  });

  test('absolute path', () => {
    expect(extractCommandNames('/usr/local/bin/node script.js')).toEqual(['node']);
  });

  test('relative path', () => {
    expect(extractCommandNames('./node_modules/.bin/jest')).toEqual(['jest']);
  });

  test('empty string', () => {
    expect(extractCommandNames('')).toEqual([]);
  });

  test('quoted args preserved', () => {
    expect(extractCommandNames('git commit -m "feat: add feature"')).toEqual(['git']);
  });

  test('complex mixed command', () => {
    expect(
      extractCommandNames('NODE_ENV=prod sudo docker-compose up && npm run migrate')
    ).toEqual(['docker-compose', 'npm']);
  });

  test('triple chain', () => {
    expect(
      extractCommandNames('git add . && git commit -m "msg" && git push')
    ).toEqual(['git', 'git', 'git']);
  });

  test('pipe chain', () => {
    expect(
      extractCommandNames('cat package.json | jq .scripts | head')
    ).toEqual(['cat', 'jq', 'head']);
  });
});

// ============================================
// loadToolIconConfig
// ============================================

describe('loadToolIconConfig (mapping from appearance.json → icons)', () => {
  function runWithConfigDir(configDir: string, script: string) {
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  function setupDir(): { configDir: string; appearanceFile: string } {
    const configDir = mkdtempSync(join(tmpdir(), 'cli-icon-appearance-'));
    return { configDir, appearanceFile: join(configDir, 'appearance.json') };
  }

  function writeRawAppearance(appearanceFile: string, contents: Record<string, unknown>) {
    writeFileSync(appearanceFile, JSON.stringify(contents, null, 2), 'utf-8');
  }

  test('loads valid mapping from appearance.json', () => {
    const { configDir } = setupDir();
    try {
      writeRawAppearance(join(configDir, 'appearance.json'), {
        icons: {
          version: 1,
          tools: [
            { id: 'git', displayName: 'Git', icon: 'git.png', commands: ['git'] },
            { id: 'npm', displayName: 'npm', icon: 'npm.png', commands: ['npm', 'npx'] },
          ],
        },
      });
      const r = runWithConfigDir(configDir, `
        import { loadToolIconConfig } from '${ICON_RESOLVER_MODULE}';
        const config = loadToolIconConfig('${configDir}');
        console.log(JSON.stringify(config));
      `);
      expect(r.exitCode).toBe(0);
      const config = JSON.parse(r.stdout) as ToolIconConfig;
      expect(config.version).toBe(1);
      expect(config.tools).toHaveLength(2);
      const git = config.tools.find(t => t.id === 'git');
      expect(git).toBeDefined();
      expect(git!.displayName).toBe('Git');
      expect(git!.commands).toContain('git');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('returns null when the mapping file is absent (regardless of dir arg)', () => {
    const { configDir } = setupDir();
    try {
      const r = runWithConfigDir(configDir, `
        import { loadToolIconConfig } from '${ICON_RESOLVER_MODULE}';
        console.log(JSON.stringify(loadToolIconConfig('${configDir}')));
      `);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('null');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  test('returns null when the icons section is missing/invalid', () => {
    const { configDir } = setupDir();
    try {
      writeRawAppearance(join(configDir, 'appearance.json'), { theme: { mode: 'dark' } });
      const r = runWithConfigDir(configDir, `
        import { loadToolIconConfig } from '${ICON_RESOLVER_MODULE}';
        console.log(JSON.stringify(loadToolIconConfig('${configDir}')));
      `);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.trim()).toBe('null');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// ============================================
// resolveToolIcon (end-to-end with real files)
// ============================================

describe('resolveToolIcon (end-to-end: mapping from appearance.json, icon files from dir)', () => {
  const testDir = join(tmpdir(), 'cli-icon-resolver-test-' + Date.now());
  let configDir: string;

  function run(script: string) {
    const result = Bun.spawnSync([process.execPath, '--eval', script], {
      env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { exitCode: result.exitCode ?? -1, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  function resolveInSubprocess(command: string) {
    const r = run(`
      import { resolveToolIcon } from '${ICON_RESOLVER_MODULE}';
      const m = resolveToolIcon(${JSON.stringify(command)}, ${JSON.stringify(testDir)});
      console.log(JSON.stringify(m ? { id: m.id, displayName: m.displayName, prefix: m.iconDataUrl.slice(0, 22) } : null));
    `);
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout) as { id: string; displayName: string; prefix: string } | null;
  }

  beforeAll(() => {
    // Icon files resolve against testDir; the mapping comes from an isolated
    // appearance.json seeded below (same dir as beforeAll so subprocesses can
    // reach the icons).
    configDir = mkdtempSync(join(tmpdir(), 'cli-icon-resolver-config-'));
    writeFileSync(
      join(configDir, 'appearance.json'),
      JSON.stringify({
        icons: {
          version: 1,
          tools: [
            { id: 'git', displayName: 'Git', icon: 'git.png', commands: ['git'] },
            { id: 'npm', displayName: 'npm', icon: 'npm.png', commands: ['npm', 'npx'] },
            { id: 'jq', displayName: 'jq', icon: 'jq.png', commands: ['jq'] },
            { id: 'docker', displayName: 'Docker', icon: 'docker.png', commands: ['docker', 'docker-compose'] },
          ],
        },
      }),
      'utf-8',
    );
  });

  beforeAll(() => {
    // Create a minimal test config with a tiny valid PNG icon
    mkdirSync(testDir, { recursive: true });

    // 1x1 transparent PNG (68 bytes)
    const tinyPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    // Icon filenames must match what the appearance.json mapping seeded below
    // references, since icon files resolve against this directory.
    writeFileSync(join(testDir, 'git.png'), tinyPng);
    writeFileSync(join(testDir, 'npm.png'), tinyPng);
    writeFileSync(join(testDir, 'jq.png'), tinyPng);
    writeFileSync(join(testDir, 'docker.png'), tinyPng);
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  });

  test('resolves simple git command', () => {
    const result = resolveInSubprocess('git status');
    expect(result).not.toBeNull();
    expect(result!.id).toBe('git');
    expect(result!.displayName).toBe('Git');
    expect(result!.prefix).toBe('data:image/png;base64,');
  });

  test('resolves npm command', () => {
    const result = resolveInSubprocess('npm install');
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe('npm');
  });

  test('resolves npx alias to npm tool', () => {
    const result = resolveInSubprocess('npx vitest');
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe('npm');
  });

  test('first icon match wins in chained commands', () => {
    // echo has no icon, git does — should resolve to git
    const result = resolveInSubprocess('echo hello && git push');
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe('Git');
  });

  test('resolves pipe — first match with icon', () => {
    // cat has no icon, jq does
    const result = resolveInSubprocess('cat foo.json | jq .name');
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe('jq');
  });

  test('no match for unknown command', () => {
    const result = resolveInSubprocess('ls -la');
    expect(result).toBeNull();
  });

  test('handles env vars before command', () => {
    const result = resolveInSubprocess('NODE_ENV=production npm run build');
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe('npm');
  });

  test('handles sudo prefix', () => {
    const result = resolveInSubprocess('sudo docker ps');
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe('Docker');
  });

  test('handles docker-compose (hyphenated command)', () => {
    const result = resolveInSubprocess('docker-compose up -d');
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe('Docker');
  });

  test('returns undefined for empty command', () => {
    expect(resolveInSubprocess('')).toBeNull();
  });

  test('returns undefined for non-existent icon dir', () => {
    const r = run(`
      import { resolveToolIcon } from '${ICON_RESOLVER_MODULE}';
      const m = resolveToolIcon('git status', '/nonexistent/path');
      console.log(JSON.stringify(m === undefined));
    `);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('true');
  });

  test('resolves with real bundled assets', () => {
    // Icon files resolve against the bundled tool-icons dir. Unlike the seeded
    // mapping above, this one deliberately runs WITHOUT the isolated
    // CRAFT_CONFIG_DIR: the real appearance.json maps git → git.ico, which is
    // the file actually shipped in the bundled directory.
    const assetsDir = join(import.meta.dir, '../../../../../apps/electron/resources/tool-icons');
    const { CRAFT_CONFIG_DIR: _ignored, ...env } = process.env;
    const r = Bun.spawnSync(
      [process.execPath, '--eval', `
        import { resolveToolIcon } from '${ICON_RESOLVER_MODULE}';
        const m = resolveToolIcon('git status', ${JSON.stringify(assetsDir)});
        console.log(JSON.stringify(m ? { id: m.id, displayName: m.displayName, prefix: m.iconDataUrl.slice(0, 30) } : null));
      `],
      { env, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(r.exitCode).toBe(0);
    const result = JSON.parse(r.stdout.toString()) as { id: string; displayName: string; prefix: string } | null;
    expect(result).not.toBeNull();
    expect(result!.id).toBe('git');
    expect(result!.displayName).toBe('Git');
    expect(result!.prefix.startsWith('data:image/x-icon;base64,')).toBe(true);
  });

  test('resolves git from zsh -lc wrapper', () => {
    const result = resolveInSubprocess("/bin/zsh -lc 'git status'");
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe('Git');
  });

  test('resolves npm from bash -c wrapper', () => {
    const result = resolveInSubprocess('bash -c "npm install"');
    expect(result).not.toBeNull();
    expect(result!.displayName).toBe('npm');
  });
});
