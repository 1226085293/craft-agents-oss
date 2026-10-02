import { describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'

const STORAGE_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'storage.ts')).href
const MODELS_MODULE_PATH = pathToFileURL(join(import.meta.dir, '..', 'models.ts')).href

function setupWorkspaceConfigDir() {
  const configDir = mkdtempSync(join(tmpdir(), 'craft-agent-config-ctx-window-'))
  const workspaceRoot = join(configDir, 'workspaces', 'my-workspace')
  mkdirSync(workspaceRoot, { recursive: true })

  writeFileSync(
    join(workspaceRoot, 'config.json'),
    JSON.stringify({
      id: 'ws-config-1',
      name: 'My Workspace',
      slug: 'my-workspace',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }, null, 2),
    'utf-8',
  )

  const configPath = join(configDir, 'config.json')
  writeFileSync(
    configPath,
    JSON.stringify({
      workspaces: [{ id: 'ws-1', name: 'My Workspace', rootPath: workspaceRoot, createdAt: Date.now() }],
      activeWorkspaceId: 'ws-1',
      activeSessionId: null,
      llmConnections: [],
    }, null, 2),
    'utf-8',
  )

  writeFileSync(
    join(configDir, 'config-defaults.json'),
    JSON.stringify({
      version: 'test',
      description: 'test defaults',
      defaults: {
        notificationsEnabled: true,
        colorTheme: 'default',
        sendMessageKey: 'enter',
        spellCheck: false,
        keepAwakeWhileRunning: false,
        richToolDescriptions: true,
      },
      workspaceDefaults: {
        thinkingLevel: 'off',
        permissionMode: 'ask',
        cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
        localMcpServers: { enabled: true },
      },
    }, null, 2),
    'utf-8',
  )

  return { configDir, configPath }
}

function runEval(configDir: string, code: string): string {
  const run = Bun.spawnSync([
    process.execPath,
    '--eval',
    `import { getDefaultContextWindow, setDefaultContextWindow, migrateDefaultContextWindowConfig } from '${STORAGE_MODULE_PATH}'; import { DEFAULT_CONTEXT_WINDOW } from '${MODELS_MODULE_PATH}'; ${code}`,
  ], {
    env: { ...process.env, CRAFT_CONFIG_DIR: configDir },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (run.exitCode !== 0) {
    throw new Error(`subprocess failed (exit ${run.exitCode})\nstderr:\n${run.stderr.toString()}`)
  }

  return run.stdout.toString().trim()
}

describe('default context window storage', () => {
  it('falls back to the compiled-in 128k default when config.json has no value', () => {
    const { configDir } = setupWorkspaceConfigDir()
    const output = runEval(configDir, "console.log(String(getDefaultContextWindow()))")
    expect(output).toBe('131072')
  })

  it('persists defaultContextWindow to config.json', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()

    runEval(configDir, 'setDefaultContextWindow(262144)')

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.defaultContextWindow).toBe(262144)
  })

  it('reads the user-configured value instead of the compiled-in default', () => {
    const { configDir } = setupWorkspaceConfigDir()
    // The motivating case: a custom endpoint model without a declared window
    // should follow the user's configured value (e.g. 256k), not 128k.
    runEval(configDir, 'setDefaultContextWindow(262144)')
    const output = runEval(configDir, "console.log(String(getDefaultContextWindow()))")
    expect(output).toBe('262144')
  })

  it('round-trips a manually edited config value across processes', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.defaultContextWindow = 32768
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    expect(runEval(configDir, "console.log(String(getDefaultContextWindow()))")).toBe('32768')
  })

  it('rejects invalid values on set, keeping the previous effective value', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()
    runEval(configDir, 'setDefaultContextWindow(262144)')

    const output = runEval(
      configDir,
      "console.log(String(setDefaultContextWindow(0))); console.log(String(setDefaultContextWindow(-5))); console.log(String(setDefaultContextWindow(Number.NaN))); console.log(String(getDefaultContextWindow()))",
    )
    expect(output.split('\n')).toEqual(['false', 'false', 'false', '262144'])

    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    expect(config.defaultContextWindow).toBe(262144)
  })

  it('falls back to the compiled-in default when config.json holds an invalid value', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.defaultContextWindow = -1
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    expect(runEval(configDir, "console.log(String(getDefaultContextWindow()))")).toBe('131072')
  })

  it('seeds config.json on migration so the value is visible and editable', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()
    expect(JSON.parse(readFileSync(configPath, 'utf-8')).defaultContextWindow).toBeUndefined()

    runEval(configDir, 'migrateDefaultContextWindowConfig()')

    expect(JSON.parse(readFileSync(configPath, 'utf-8')).defaultContextWindow).toBe(131_072)
  })

  it('never overwrites an existing (user-edited) value during migration', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()
    runEval(configDir, 'setDefaultContextWindow(262144)')

    runEval(configDir, 'migrateDefaultContextWindowConfig()')

    expect(JSON.parse(readFileSync(configPath, 'utf-8')).defaultContextWindow).toBe(262_144)
  })

  it('repairs an invalid seeded value during migration', () => {
    const { configDir, configPath } = setupWorkspaceConfigDir()
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    config.defaultContextWindow = 'not-a-number'
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')

    runEval(configDir, 'migrateDefaultContextWindowConfig()')

    expect(JSON.parse(readFileSync(configPath, 'utf-8')).defaultContextWindow).toBe(131_072)
  })
})
