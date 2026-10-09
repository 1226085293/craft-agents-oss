import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { CONFIG_DIR } from './paths.ts';
import { debug } from '../utils/debug.ts';
import { i18n, SUPPORTED_LANGUAGE_CODES } from '../i18n/index.ts';
import { LOCALE_REGISTRY, type LanguageCode } from '../i18n/registry.ts';

/**
 * Unified appearance configuration (~/.craft-agent/appearance.json).
 *
 * All UI/appearance-domain settings live here, one section per UI area:
 * theme (mode/colorTheme/font), ui (language + UI toggles), board (kanban
 * appearance + drop-status automation), diff (diff viewer display) and icons
 * (CLI tool icon mappings). The legacy `preferences.json` and the appearance
 * fields previously spread across config.json / localStorage are migrated in
 * on first access.
 */

export interface DiffViewerPreferences {
  /** Diff layout: 'unified' (stacked) or 'split' (side-by-side) */
  diffStyle?: 'unified' | 'split';
  /** Whether to disable background highlighting on changed lines */
  disableBackground?: boolean;
}

/** CLI tool icon mapping entry (icon file name relative to the tool-icons dir). */
export interface AppearanceToolIconEntry {
  id: string;
  displayName: string;
  icon: string;
  commands: string[];
}

export interface AppearanceThemeSettings {
  /** UI mode: light / dark / system */
  mode?: 'light' | 'dark' | 'system';
  /** ID of selected preset color theme (e.g. 'dracula', 'nord'). Default: 'default' */
  colorTheme?: string;
  /** Font family */
  font?: string;
}

export interface AppearanceUiSettings {
  /** Internal: persisted UI language (Appearance → Language). */
  language?: LanguageCode;
  /** Whether the in-app "background session finished" chip is shown. Default off. */
  backgroundFinishedChip?: boolean;
  /** Project color treatment in the session list ('stripe' | 'stripe-tint', ...). */
  projectColorTreatment?: string;
  /** Per-workspace avatar color overrides (workspaceId -> hex). */
  workspaceAvatarColors?: Record<string, string>;
}

export interface AppearanceBoardSettings {
  /** Per-column color overrides (columnId -> hex). */
  columnColors?: Record<string, string>;
  /** Whether active (in-progress) tiles get the live-pulse treatment. Default on. */
  livePulse?: boolean;
  /** Per-column status auto-applied when a task is dropped into that column. */
  columnStatus?: Record<string, string>;
}

export interface AppearanceConfig {
  theme?: AppearanceThemeSettings;
  ui?: AppearanceUiSettings;
  board?: AppearanceBoardSettings;
  diff?: DiffViewerPreferences;
  icons?: {
    version?: number;
    tools?: AppearanceToolIconEntry[];
  };
}

const APPEARANCE_FILE = join(CONFIG_DIR, 'appearance.json');

// ---------------------------------------------------------------------------
// File access
// ---------------------------------------------------------------------------

export function getAppearancePath(): string {
  return APPEARANCE_FILE;
}

export function loadAppearanceConfig(): AppearanceConfig {
  try {
    if (!existsSync(APPEARANCE_FILE)) return {};
    return JSON.parse(readFileSync(APPEARANCE_FILE, 'utf-8')) as AppearanceConfig;
  } catch {
    return {};
  }
}

export function saveAppearanceConfig(config: AppearanceConfig): void {
  mkdirSync(dirname(APPEARANCE_FILE), { recursive: true });
  writeFileSync(APPEARANCE_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

/** Read a single appearance section (undefined when absent). */
export function getAppearanceSection<K extends keyof AppearanceConfig>(key: K): AppearanceConfig[K] | undefined {
  migrateLegacyPreferencesFile();
  return loadAppearanceConfig()[key];
}

/** Merge updates into a single appearance section and persist. */
export function setAppearanceSection<K extends keyof AppearanceConfig>(key: K, value: AppearanceConfig[K]): void {
  migrateLegacyPreferencesFile();
  const config = loadAppearanceConfig();
  (config as Record<string, unknown>)[key] = value;
  saveAppearanceConfig(config);
}

// ---------------------------------------------------------------------------
// UI language (Appearance → Language)
// ---------------------------------------------------------------------------

/**
 * One-time migration from the legacy preferences.json into appearance.json.
 *
 * The User Preferences feature (Settings → Preferences, update_user_preferences)
 * was removed; its remaining appearance content (uiLanguage, diffViewer) is
 * absorbed into appearance.json and the legacy file is deleted. Safe to call
 * repeatedly — only runs once per process and no-ops when the file is absent.
 */
let legacyMigrationAttempted = false;
export function migrateLegacyPreferencesFile(): void {
  if (legacyMigrationAttempted) return;
  legacyMigrationAttempted = true;

  // Legacy config.json `colorTheme` → appearance.theme.colorTheme (and clean up).
  try {
    const configPath = join(CONFIG_DIR, 'config.json');
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      if (typeof raw.colorTheme === 'string') {
        const config = loadAppearanceConfig();
        if (!config.theme?.colorTheme) {
          config.theme = { ...config.theme, colorTheme: raw.colorTheme };
          saveAppearanceConfig(config);
        }
        delete raw.colorTheme;
        writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf-8');
        debug('[appearance] migrated legacy config.json colorTheme into appearance.json');
      }
    }
  } catch (error) {
    // Non-fatal: keep the legacy field, migration can retry next process start.
    debug('[appearance] legacy config.json colorTheme migration failed', error);
  }

  try {
    const legacy = join(CONFIG_DIR, 'preferences.json');
    if (!existsSync(legacy)) return;
    const raw = JSON.parse(readFileSync(legacy, 'utf-8')) as Record<string, unknown>;
    const config = loadAppearanceConfig();
    let changed = false;

    if (typeof raw.uiLanguage === 'string' && !config.ui?.language) {
      config.ui = { ...config.ui, language: raw.uiLanguage as LanguageCode };
      changed = true;
    }
    if (raw.diffViewer && typeof raw.diffViewer === 'object' && !config.diff) {
      config.diff = raw.diffViewer as DiffViewerPreferences;
      changed = true;
    }

    if (changed) saveAppearanceConfig(config);
    unlinkSync(legacy);
    debug('[appearance] migrated legacy preferences.json into appearance.json');
  } catch (error) {
    // Non-fatal: keep the legacy file, migration can retry next process start.
    debug('[appearance] legacy preferences.json migration failed', error);
  }
}

/**
 * Read the persisted UI language code (validated against the supported set).
 * Returns `undefined` when the field is missing or holds an unrecognised value.
 */
export function getPersistedUiLanguage(): LanguageCode | undefined {
  const candidate = getAppearanceSection('ui')?.language;
  if (!candidate) return undefined;
  if (!SUPPORTED_LANGUAGE_CODES.includes(candidate)) return undefined;
  return candidate;
}

/**
 * Persist the UI language code. Idempotent — does not rewrite appearance.json
 * when the value is unchanged (avoids re-triggering the config watcher on
 * startup syncs and duplicate IPC calls).
 */
export function setPersistedUiLanguage(code: LanguageCode): void {
  const ui = getAppearanceSection('ui');
  if (ui?.language === code) return;
  setAppearanceSection('ui', { ...ui, language: code });
}

/**
 * Native-language name to request for AI-generated session titles, or
 * `undefined` to let the model follow the conversation's own language.
 *
 * Resolves from the explicitly persisted UI language (disk-backed) rather than
 * `i18n.resolvedLanguage`, which in the main process hydrates asynchronously at
 * startup and can still read the `'en'` fallback when an early title fires
 * (#885). Returning `undefined` when no language was chosen lets the title
 * prompt auto-detect the conversation language instead of being forced to
 * English.
 */
export function resolveTitleLanguageName(): string | undefined {
  const code = getPersistedUiLanguage();
  return code ? LOCALE_REGISTRY[code]?.nativeName : undefined;
}

// ---------------------------------------------------------------------------
// Diff viewer display
// ---------------------------------------------------------------------------

/** Read the persisted diff-viewer display preferences. */
export function getDiffViewerSettings(): DiffViewerPreferences | undefined {
  return getAppearanceSection('diff');
}

/** Persist the diff-viewer display preferences. */
export function setDiffViewerSettings(settings: DiffViewerPreferences): void {
  setAppearanceSection('diff', settings);
}

// ---------------------------------------------------------------------------
// User context (system prompt)
// ---------------------------------------------------------------------------

/**
 * Format the user-context block for inclusion in the system prompt.
 *
 * Timezone and country are derived directly from the local system (via
 * `Intl`) — the User Preferences feature was removed and cross-session
 * memory covers personal facts. The preferred language comes from the app's
 * i18n setting (Appearance > Language). Returns an empty string if no
 * system info can be resolved.
 */
export function formatUserContextForPrompt(): string {
  // Derive language from the app's i18n setting (Appearance > Language).
  const langCode = (i18n.resolvedLanguage ?? 'en') as LanguageCode;
  const langEntry = LOCALE_REGISTRY[langCode];
  const langName = langEntry?.nativeName ?? 'English';

  // Timezone & country come from the local system.
  let timezone: string | undefined;
  let country: string | undefined;
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions();
    timezone = resolved.timeZone;
    const region = new Intl.Locale(resolved.locale).region;
    if (region) {
      country = new Intl.DisplayNames([langCode], { type: 'region' }).of(region);
    }
  } catch {
    // Non-fatal: fall through without the system-derived fields.
  }

  if (!timezone && !country) {
    return '';
  }

  const lines: string[] = ['## User Context (from the local system)', ''];

  if (timezone) {
    lines.push(`- Timezone: ${timezone}`);
  }

  if (country) {
    lines.push(`- Country: ${country}`);
  }

  // Always include language so the AI knows which language to respond in.
  lines.push(`- Preferred language: ${langName}`);

  lines.push('');
  return lines.join('\n');
}

/**
 * Whether the Co-Authored-By trailer should be included on git commits.
 * The user-level opt-out (`includeCoAuthoredBy`) was removed together with
 * the User Preferences feature, so the trailer is always included.
 */
export function getCoAuthorPreference(): boolean {
  return true;
}