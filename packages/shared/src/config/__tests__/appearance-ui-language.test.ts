/**
 * Tests for the persisted UI language (appearance.json → ui.language) that
 * backs main-process i18n hydration. See packages/shared/CLAUDE.md →
 * "Cross-process language persistence".
 *
 * `CONFIG_DIR` is captured at module-load from `process.env.CRAFT_CONFIG_DIR`,
 * so each scenario runs in a subprocess with its own tmpdir — the same pattern
 * `storage-startup-migration.test.ts` uses.
 */
import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';

const APPEARANCE_MODULE = pathToFileURL(join(import.meta.dir, '..', 'appearance.ts')).href;

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runScript(configDir: string, script: string): RunResult {
  const result = Bun.spawnSync([process.execPath, '--eval', script], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode ?? -1,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function setupDir(): { configDir: string; appearanceFile: string } {
  const configDir = mkdtempSync(join(tmpdir(), 'appearance-ui-lang-'));
  return { configDir, appearanceFile: join(configDir, 'appearance.json') };
}

function writeRawAppearance(appearanceFile: string, contents: Record<string, unknown>) {
  writeFileSync(appearanceFile, JSON.stringify(contents, null, 2), 'utf-8');
}

describe('appearance.ui.language', () => {
  describe('getPersistedUiLanguage', () => {
    it('returns undefined when the file does not exist', () => {
      const { configDir } = setupDir();
      try {
        const r = runScript(configDir, `
          import { getPersistedUiLanguage } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: null });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('returns undefined when the ui section is missing', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        writeRawAppearance(appearanceFile, { theme: { mode: 'dark' } });
        const r = runScript(configDir, `
          import { getPersistedUiLanguage } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: null });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('returns the code when valid', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        writeRawAppearance(appearanceFile, { ui: { language: 'es' } });
        const r = runScript(configDir, `
          import { getPersistedUiLanguage } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: 'es' });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('returns undefined for unsupported codes (validates against the registry)', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        writeRawAppearance(appearanceFile, { ui: { language: 'xx' } });
        const r = runScript(configDir, `
          import { getPersistedUiLanguage } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: null });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  describe('setPersistedUiLanguage', () => {
    it('writes the value and getter reads it back', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        const r = runScript(configDir, `
          import { setPersistedUiLanguage, getPersistedUiLanguage } from '${APPEARANCE_MODULE}';
          setPersistedUiLanguage('hu');
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: 'hu' });
        expect(existsSync(appearanceFile)).toBe(true);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('is idempotent — does not rewrite the file when value is unchanged', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        const r = runScript(configDir, `
          import { setPersistedUiLanguage } from '${APPEARANCE_MODULE}';
          import { statSync } from 'fs';
          setPersistedUiLanguage('hu');
          const first = statSync('${appearanceFile.replace(/\\/g, '\\\\')}').mtimeMs;
          const start = Date.now();
          while (Date.now() - start < 30) {}
          setPersistedUiLanguage('hu');
          const second = statSync('${appearanceFile.replace(/\\/g, '\\\\')}').mtimeMs;
          console.log(JSON.stringify({ first, second }));
        `);
        expect(r.exitCode).toBe(0);
        const { first, second } = JSON.parse(r.stdout);
        expect(second).toBe(first);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('preserves the other appearance sections', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        writeRawAppearance(appearanceFile, { theme: { mode: 'dark', colorTheme: 'dracula' } });
        const r = runScript(configDir, `
          import { setPersistedUiLanguage } from '${APPEARANCE_MODULE}';
          setPersistedUiLanguage('hu');
        `);
        expect(r.exitCode).toBe(0);
        const raw = JSON.parse(readFileSync(appearanceFile, 'utf-8'));
        expect(raw.ui.language).toBe('hu');
        expect(raw.theme).toEqual({ mode: 'dark', colorTheme: 'dracula' });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  describe('migrateLegacyPreferencesFile', () => {
    it('absorbs uiLanguage + diffViewer from a legacy preferences.json and removes it', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        writeFileSync(
          join(configDir, 'preferences.json'),
          JSON.stringify({ uiLanguage: 'hu', diffViewer: { diffStyle: 'split' } }),
          'utf-8',
        );
        const r = runScript(configDir, `
          import { getPersistedUiLanguage, getDiffViewerSettings } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({
            language: getPersistedUiLanguage() ?? null,
            diff: getDiffViewerSettings() ?? null,
          }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({
          language: 'hu',
          diff: { diffStyle: 'split' },
        });
        expect(existsSync(join(configDir, 'preferences.json'))).toBe(false);
        const raw = JSON.parse(readFileSync(appearanceFile, 'utf-8'));
        expect(raw.ui.language).toBe('hu');
        expect(raw.diff.diffStyle).toBe('split');
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('leaves the appearance file untouched when there is no legacy file', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        writeRawAppearance(appearanceFile, { ui: { language: 'es' } });
        const r = runScript(configDir, `
          import { getPersistedUiLanguage } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({ value: getPersistedUiLanguage() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: 'es' });
        expect(existsSync(join(configDir, 'preferences.json'))).toBe(false);
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });

  describe('resolveTitleLanguageName', () => {
    it('returns undefined when no UI language is persisted (so titles auto-detect)', () => {
      const { configDir } = setupDir();
      try {
        const r = runScript(configDir, `
          import { resolveTitleLanguageName } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({ value: resolveTitleLanguageName() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: null });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('maps a persisted code to its native language name', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        writeRawAppearance(appearanceFile, { ui: { language: 'es' } });
        const r = runScript(configDir, `
          import { resolveTitleLanguageName } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({ value: resolveTitleLanguageName() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: 'Español' });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('resolves the Chinese native name (the #885 motivating case)', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        writeRawAppearance(appearanceFile, { ui: { language: 'zh-Hans' } });
        const r = runScript(configDir, `
          import { resolveTitleLanguageName } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({ value: resolveTitleLanguageName() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: '简体中文' });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('honors an explicit English UI language (returns "English", not auto-detect)', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        writeRawAppearance(appearanceFile, { ui: { language: 'en' } });
        const r = runScript(configDir, `
          import { resolveTitleLanguageName } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({ value: resolveTitleLanguageName() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: 'English' });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });

    it('returns undefined for an unsupported persisted code', () => {
      const { configDir, appearanceFile } = setupDir();
      try {
        writeRawAppearance(appearanceFile, { ui: { language: 'xx' } });
        const r = runScript(configDir, `
          import { resolveTitleLanguageName } from '${APPEARANCE_MODULE}';
          console.log(JSON.stringify({ value: resolveTitleLanguageName() ?? null }));
        `);
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout)).toEqual({ value: null });
      } finally {
        rmSync(configDir, { recursive: true, force: true });
      }
    });
  });
});