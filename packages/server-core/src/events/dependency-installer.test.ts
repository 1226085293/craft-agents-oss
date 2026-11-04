import { describe, it, expect } from 'bun:test'
import { buildInstallCommand, runInstallCommand } from './dependency-installer.ts'
import type { ListenerPackageDep } from '@craft-agent/shared/events/manifest.ts'

describe('dependency installer', () => {
  it('builds fixed argv commands from validated fields', () => {
    expect(buildInstallCommand({ manager: 'pip', name: 'requests', range: '>=2.0' })).toEqual({
      command: 'python',
      args: ['-m', 'pip', 'install', 'requests>=2.0'],
    })
    expect(buildInstallCommand({ manager: 'npm', name: '@scope/ws', range: '*' })).toEqual({
      command: 'npm',
      args: ['install', '@scope/ws@*'],
    })
  })

  it('rejects specs that never passed manifest validation without spawning', async () => {
    const cases = [
            { manager: 'apt', name: 'x', range: '*' },
      { manager: 'pip' as const, name: '-r /etc/passwd', range: '*' },
      { manager: 'npm' as const, name: 'ok', range: '>=1 --unsafe' },
      { manager: 'pip' as const, name: '', range: '*' },
    ]
    for (const dep of cases as unknown as ListenerPackageDep[]) {
      const result = await runInstallCommand(dep)
      expect(result.ok, JSON.stringify(dep)).toBe(false)
      expect(result.error, JSON.stringify(dep)).toContain('invalid dependency spec')
      expect(result.command).toBe('')
    }
  })
})
