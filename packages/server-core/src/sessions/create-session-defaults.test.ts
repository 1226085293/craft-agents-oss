import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SESSION_MANAGER_MODULE = pathToFileURL(join(import.meta.dir, 'SessionManager.ts')).href
const SESSION_STORAGE_MODULE = pathToFileURL(join(import.meta.dir, '..', '..', '..', 'shared', 'src', 'sessions', 'storage.ts')).href

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('SessionManager.createSession defaults', () => {
  it('persists workspace default enabled sources into newly-created sessions', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'sm-default-sources-config-'))
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'sm-default-sources-workspace-'))
    tempDirs.push(configDir, workspaceRoot)

    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify(
        {
          workspaces: [
            {
              id: 'ws-defaults',
              name: 'Defaults Workspace',
              rootPath: workspaceRoot,
              createdAt: Date.now(),
            },
          ],
          activeWorkspaceId: 'ws-defaults',
          activeSessionId: null,
        },
        null,
        2,
      ),
      'utf-8',
    )

    writeFileSync(
      join(configDir, 'config-defaults.json'),
      JSON.stringify(
        {
          workspaceDefaults: {
            permissionMode: 'ask',
            cyclablePermissionModes: ['safe', 'ask', 'allow-all'],
            thinkingLevel: 'medium',
            localMcpServers: { enabled: true },
          },
        },
        null,
        2,
      ),
      'utf-8',
    )

    writeFileSync(
      join(workspaceRoot, 'config.json'),
      JSON.stringify(
        {
          id: 'ws-defaults',
          name: 'Defaults Workspace',
          slug: 'defaults-workspace',
          defaults: {
            permissionMode: 'ask',
            enabledSourceSlugs: ['knowledge-api', 'repo-mcp'],
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf-8',
    )

    const script = `
      import { readFileSync } from 'node:fs'
      import { SessionManager } from '${SESSION_MANAGER_MODULE}'
      import { getSessionFilePath } from '${SESSION_STORAGE_MODULE}'

      const sm = new SessionManager()
      const events = []
      sm.setEventSink((channel, target, ...args) => {
        events.push({ channel, target, event: args[0] })
      })
      const session = await sm.createSession('ws-defaults')
      const sessionFile = getSessionFilePath(${JSON.stringify(workspaceRoot)}, session.id)
      const header = JSON.parse(readFileSync(sessionFile, 'utf-8').split('\\n')[0])
      console.log(JSON.stringify({
        returned: session.enabledSourceSlugs,
        persisted: header.enabledSourceSlugs,
        events,
      }))
    `

    const run = Bun.spawnSync([process.execPath, '--eval', script], {
      env: {
        ...process.env,
        CRAFT_CONFIG_DIR: configDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(run.exitCode, run.stderr.toString()).toBe(0)
    const output = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)

    expect(output.returned).toEqual(['knowledge-api', 'repo-mcp'])
    expect(output.persisted).toEqual(['knowledge-api', 'repo-mcp'])
    expect(output.events).toEqual([
      {
        channel: 'session:event',
        target: { to: 'workspace', workspaceId: 'ws-defaults' },
        event: { type: 'session_created', sessionId: expect.any(String) },
      },
    ])
  })

  it('keeps persisted enabled sources in the metadata-only session list after restart', () => {
    const configDir = mkdtempSync(join(tmpdir(), 'sm-source-metadata-config-'))
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'sm-source-metadata-workspace-'))
    tempDirs.push(configDir, workspaceRoot)

    writeFileSync(
      join(configDir, 'config.json'),
      JSON.stringify(
        {
          workspaces: [
            {
              id: 'ws-source-metadata',
              name: 'Source Metadata Workspace',
              rootPath: workspaceRoot,
              createdAt: Date.now(),
            },
          ],
          activeWorkspaceId: 'ws-source-metadata',
          activeSessionId: null,
        },
        null,
        2,
      ),
      'utf-8',
    )

    writeFileSync(
      join(workspaceRoot, 'config.json'),
      JSON.stringify(
        {
          id: 'ws-source-metadata',
          name: 'Source Metadata Workspace',
          slug: 'source-metadata-workspace',
          defaults: {
            permissionMode: 'ask',
            enabledSourceSlugs: ['docs-api'],
          },
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
        null,
        2,
      ),
      'utf-8',
    )

    const script = `
      import { SessionManager } from '${SESSION_MANAGER_MODULE}'
      import { createSession as createStoredSession } from '${SESSION_STORAGE_MODULE}'

      await createStoredSession(${JSON.stringify(workspaceRoot)}, {
        name: 'Restored default source session',
        enabledSourceSlugs: ['docs-api'],
      })

      const sm = new SessionManager()
      sm.reloadSessions()
      const sessions = sm.getSessions('ws-source-metadata')
      console.log(JSON.stringify(sessions.map(session => ({
        name: session.name,
        enabledSourceSlugs: session.enabledSourceSlugs,
        messages: session.messages,
      }))))
    `

    const run = Bun.spawnSync([process.execPath, '--eval', script], {
      env: {
        ...process.env,
        CRAFT_CONFIG_DIR: configDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })

    expect(run.exitCode, run.stderr.toString()).toBe(0)
    const output = JSON.parse(run.stdout.toString().trim().split('\n').at(-1)!)

    expect(output).toEqual([
      {
        name: 'Restored default source session',
        enabledSourceSlugs: ['docs-api'],
        messages: [],
      },
    ])
  })
})
