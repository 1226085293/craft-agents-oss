import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { exportResources, importResources, validateResourceBundle } from '../resource-bundle'
import type { ResourceBundle, SourceBundleEntry, SkillBundleEntry } from '../types'
import type { FolderSourceConfig } from '../../sources/types'

// ============================================================
// Helpers
// ============================================================

function createTestWorkspace(rootDir: string): string {
  const wsDir = join(rootDir, 'workspace')
  mkdirSync(join(wsDir, 'sources'), { recursive: true })
  mkdirSync(join(wsDir, 'skills'), { recursive: true })
  writeFileSync(join(wsDir, 'config.json'), JSON.stringify({ name: 'Test Workspace' }))
  return wsDir
}

function createTestSource(wsDir: string, slug: string, config?: Partial<FolderSourceConfig>): void {
  const sourceDir = join(wsDir, 'sources', slug)
  mkdirSync(sourceDir, { recursive: true })

  const defaultConfig: FolderSourceConfig = {
    id: `${slug}_abc123`,
    name: slug,
    slug,
    enabled: true,
    provider: 'custom',
    type: 'api',
    api: { baseUrl: 'https://api.example.com', authType: 'bearer' },
    isAuthenticated: true,
    connectionStatus: 'connected',
    lastTestedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...config,
  }

  writeFileSync(join(sourceDir, 'config.json'), JSON.stringify(defaultConfig, null, 2))
  writeFileSync(join(sourceDir, 'guide.md'), `# ${slug}\n\nUsage guide.`)
}

function createTestSkill(wsDir: string, slug: string, extraFiles?: Record<string, string>): void {
  const skillDir = join(wsDir, 'skills', slug)
  mkdirSync(skillDir, { recursive: true })

  writeFileSync(join(skillDir, 'SKILL.md'), `---
name: ${slug}
description: Test skill ${slug}
---

Instructions for ${slug}.
`)

  if (extraFiles) {
    for (const [name, content] of Object.entries(extraFiles)) {
      const filePath = join(skillDir, name)
      const dir = join(skillDir, ...name.split('/').slice(0, -1))
      if (dir !== skillDir) mkdirSync(dir, { recursive: true })
      writeFileSync(filePath, content)
    }
  }
}

function makeBundleFile(path: string, content: string) {
  const buf = Buffer.from(content)
  return {
    relativePath: path,
    contentBase64: buf.toString('base64'),
    size: buf.length,
  }
}

// Minimal valid deps for import
const noopDeps = {
  clearSourceCredentials: async () => {},
}

// ============================================================
// Tests
// ============================================================

describe('resource-bundle', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `resource-bundle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true })
    }
  })

  // ============================================================
  // Export
  // ============================================================

  describe('exportResources', () => {
    it('exports sources with sanitized config', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'github', {
        isAuthenticated: true,
        connectionStatus: 'connected',
        connectionError: 'old error',
        lastTestedAt: 12345,
      })

      const { bundle, warnings } = exportResources(wsDir, { sources: 'all' })

      expect(bundle.version).toBe(1)
      expect(bundle.resources.sources).toHaveLength(1)

      const source = bundle.resources.sources![0]!
      expect(source.slug).toBe('github')
      // Auth state should be reset
      expect(source.config.isAuthenticated).toBe(false)
      expect(source.config.connectionStatus).toBe('needs_auth')
      expect(source.config.connectionError).toBeUndefined()
      expect(source.config.lastTestedAt).toBeUndefined()
    })

    it('strips known secret fields from source configs', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'google-api', {
        provider: 'google',
        type: 'api',
        api: {
          baseUrl: 'https://gmail.googleapis.com',
          authType: 'oauth',
          googleOAuthClientSecret: 'super-secret',
          defaultHeaders: { 'X-Custom': 'value' },
        },
      })

      const { bundle, warnings } = exportResources(wsDir, { sources: ['google-api'] })

      const config = bundle.resources.sources![0]!.config
      expect(config.api?.googleOAuthClientSecret).toBeUndefined()
      expect(config.api?.defaultHeaders).toBeUndefined()
      expect(warnings.some(w => w.includes('googleOAuthClientSecret'))).toBe(true)
      expect(warnings.some(w => w.includes('defaultHeaders'))).toBe(true)
    })

    it('strips mcp.env and mcp.headers from source configs', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'mcp-server', {
        type: 'mcp',
        mcp: {
          url: 'https://mcp.example.com',
          authType: 'bearer',
          env: { SECRET_TOKEN: 'abc123' },
          headers: { 'Authorization': 'Bearer xyz' },
        },
      })

      const { bundle, warnings } = exportResources(wsDir, { sources: ['mcp-server'] })

      const config = bundle.resources.sources![0]!.config
      expect(config.mcp?.env).toBeUndefined()
      expect(config.mcp?.headers).toBeUndefined()
      expect(warnings.some(w => w.includes('mcp.env'))).toBe(true)
      expect(warnings.some(w => w.includes('mcp.headers'))).toBe(true)
    })

    it('exports all non-hidden files from source folder', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'postgres')

      // Add extra files
      const sourceDir = join(wsDir, 'sources', 'postgres')
      writeFileSync(join(sourceDir, 'INSTALL.md'), '# Installation')
      mkdirSync(join(sourceDir, 'templates'), { recursive: true })
      writeFileSync(join(sourceDir, 'templates', 'query.sql'), 'SELECT 1')

      const { bundle } = exportResources(wsDir, { sources: ['postgres'] })

      const files = bundle.resources.sources![0]!.files
      const paths = files.map(f => f.relativePath)
      expect(paths).toContain('guide.md')
      expect(paths).toContain('INSTALL.md')
      expect(paths).toContain('templates/query.sql')
      // config.json should NOT be in files (it's in the config field)
      expect(paths).not.toContain('config.json')
    })

    it('exports skills with all auxiliary files', () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSkill(wsDir, 'pdf', {
        'forms.md': '# Forms reference',
        'reference.md': '# PDF Reference',
        'scripts/extract.py': 'import pdf',
        'LICENSE.txt': 'MIT',
      })

      const { bundle } = exportResources(wsDir, { skills: 'all' })

      expect(bundle.resources.skills).toHaveLength(1)
      const skill = bundle.resources.skills![0]!
      const paths = skill.files.map(f => f.relativePath)
      expect(paths).toContain('SKILL.md')
      expect(paths).toContain('forms.md')
      expect(paths).toContain('reference.md')
      expect(paths).toContain('scripts/extract.py')
      expect(paths).toContain('LICENSE.txt')
    })

    it('warns for non-existent sources', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const { warnings } = exportResources(wsDir, { sources: ['nonexistent'] })

      expect(warnings.some(w => w.includes('nonexistent'))).toBe(true)
    })

    it('skips skills without SKILL.md', () => {
      const wsDir = createTestWorkspace(tmpDir)
      // Create a skill dir with no SKILL.md
      mkdirSync(join(wsDir, 'skills', 'broken'), { recursive: true })
      writeFileSync(join(wsDir, 'skills', 'broken', 'readme.txt'), 'not a skill')

      const { bundle, warnings } = exportResources(wsDir, { skills: 'all' })

      expect(bundle.resources.skills).toHaveLength(0)
      expect(warnings.some(w => w.includes('SKILL.md'))).toBe(true)
    })

    it('includes sourceWorkspace from workspace config', () => {
      const wsDir = createTestWorkspace(tmpDir)
      const { bundle } = exportResources(wsDir, { sources: 'all' })

      expect(bundle.sourceWorkspace).toBe('Test Workspace')
    })
  })

  // ============================================================
  // Validation
  // ============================================================

  describe('validateResourceBundle', () => {
    it('accepts a valid bundle', () => {
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'test',
            config: { id: 'test_1', name: 'Test', slug: 'test', enabled: true, provider: 'custom', type: 'api' },
            files: [makeBundleFile('guide.md', '# Test')],
          }],
          skills: [{
            slug: 'my-skill',
            files: [makeBundleFile('SKILL.md', '---\nname: test\ndescription: test\n---\nBody')],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(true)
      expect(errors).toHaveLength(0)
    })

    it('rejects non-object', () => {
      const { valid } = validateResourceBundle('not an object')
      expect(valid).toBe(false)
    })

    it('rejects wrong version', () => {
      const { valid, errors } = validateResourceBundle({ version: 2, exportedAt: 1, resources: {} })
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('version'))).toBe(true)
    })

    it('rejects duplicate source slugs', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [
            { slug: 'dup', config: { id: '1', name: 'A', slug: 'dup', enabled: true, provider: 'x', type: 'api' }, files: [] },
            { slug: 'dup', config: { id: '2', name: 'B', slug: 'dup', enabled: true, provider: 'x', type: 'api' }, files: [] },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate slug'))).toBe(true)
    })

    it('rejects duplicate skill slugs', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [
            { slug: 'dup', files: [makeBundleFile('SKILL.md', 'x')] },
            { slug: 'dup', files: [makeBundleFile('SKILL.md', 'y')] },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate slug'))).toBe(true)
    })

    it('rejects skills without SKILL.md', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [
            { slug: 'no-skill-md', files: [makeBundleFile('readme.md', 'hi')] },
          ],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('missing SKILL.md'))).toBe(true)
    })

    it('rejects path traversal in files', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'evil',
            config: { id: '1', name: 'Evil', slug: 'evil', enabled: true, provider: 'x', type: 'api' },
            files: [makeBundleFile('../escape.txt', 'pwned')],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('traversal'))).toBe(true)
    })

    it('rejects source with mismatched config.slug', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'github',
            config: { id: '1', name: 'Evil', slug: 'evil-proxy', enabled: true, provider: 'x', type: 'api' },
            files: [],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('does not match'))).toBe(true)
    })

    it('rejects duplicate file paths', () => {
      const bundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'test',
            config: { id: '1', name: 'Test', slug: 'test', enabled: true, provider: 'x', type: 'api' },
            files: [
              makeBundleFile('guide.md', 'first'),
              makeBundleFile('guide.md', 'second'),
            ],
          }],
        },
      }

      const { valid, errors } = validateResourceBundle(bundle)
      expect(valid).toBe(false)
      expect(errors.some(e => e.includes('duplicate path'))).toBe(true)
    })
  })

  // ============================================================
  // Import
  // ============================================================

  describe('importResources', () => {
    it('imports sources into workspace', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'imported-api',
            config: {
              id: 'imported-api_abc',
              name: 'Imported API',
              slug: 'imported-api',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# Imported\n\nGuide content.')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.sources.imported).toEqual(['imported-api'])
      expect(existsSync(join(wsDir, 'sources', 'imported-api', 'config.json'))).toBe(true)
      expect(existsSync(join(wsDir, 'sources', 'imported-api', 'guide.md'))).toBe(true)
      expect(readFileSync(join(wsDir, 'sources', 'imported-api', 'guide.md'), 'utf-8')).toBe('# Imported\n\nGuide content.')
    })

    it('imports skills with auxiliary files', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          skills: [{
            slug: 'pdf-tools',
            files: [
              makeBundleFile('SKILL.md', '---\nname: PDF Tools\ndescription: PDF stuff\n---\nInstructions'),
              makeBundleFile('forms.md', '# Forms'),
              makeBundleFile('scripts/extract.py', 'import pdf'),
            ],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.skills.imported).toEqual(['pdf-tools'])
      expect(existsSync(join(wsDir, 'skills', 'pdf-tools', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(wsDir, 'skills', 'pdf-tools', 'forms.md'))).toBe(true)
      expect(existsSync(join(wsDir, 'skills', 'pdf-tools', 'scripts', 'extract.py'))).toBe(true)
    })

    it('skips existing resources in skip mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'existing')
      createTestSkill(wsDir, 'existing-skill')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'existing',
            config: { id: 'x', name: 'X', slug: 'existing', enabled: true, provider: 'x', type: 'api', api: { baseUrl: 'http://new', authType: 'none' }, createdAt: 1, updatedAt: 1 },
            files: [makeBundleFile('guide.md', '# New guide')],
          }],
          skills: [{
            slug: 'existing-skill',
            files: [makeBundleFile('SKILL.md', '---\nname: new\ndescription: new\n---\nNew')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.sources.skipped).toEqual(['existing'])
      expect(result.skills.skipped).toEqual(['existing-skill'])
      // Original content should be preserved
      expect(readFileSync(join(wsDir, 'sources', 'existing', 'guide.md'), 'utf-8')).toContain('Usage guide')
    })

    it('replaces existing resources in overwrite mode', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'target')

      // Add an extra file to the original that shouldn't survive overwrite
      writeFileSync(join(wsDir, 'sources', 'target', 'old-file.txt'), 'stale')

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'target',
            config: {
              id: 'target_new',
              name: 'Target',
              slug: 'target',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://new-api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [makeBundleFile('guide.md', '# New guide')],
          }],
        },
      }

      const result = await importResources(wsDir, bundle, 'overwrite', noopDeps)

      expect(result.sources.imported).toEqual(['target'])
      // New content
      expect(readFileSync(join(wsDir, 'sources', 'target', 'guide.md'), 'utf-8')).toBe('# New guide')
      // Old stale file should be gone (full replacement)
      expect(existsSync(join(wsDir, 'sources', 'target', 'old-file.txt'))).toBe(false)
    })

    it('calls clearSourceCredentials on source overwrite', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      createTestSource(wsDir, 'creds-test')

      const cleared: string[] = []
      const deps = {
        clearSourceCredentials: async (_wsId: string, slug: string) => {
          cleared.push(slug)
        },
      }

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'creds-test',
            config: {
              id: 'creds-test_x',
              name: 'Creds Test',
              slug: 'creds-test',
              enabled: true,
              provider: 'custom',
              type: 'api',
              api: { baseUrl: 'https://api.example.com', authType: 'none' },
              createdAt: Date.now(),
              updatedAt: Date.now(),
            },
            files: [],
          }],
        },
      }

      await importResources(wsDir, bundle, 'overwrite', deps)
      expect(cleared).toEqual(['creds-test'])
    })

    it('rejects invalid bundle with error in result', async () => {
      const wsDir = createTestWorkspace(tmpDir)
      const result = await importResources(wsDir, { version: 99 } as any, 'skip', noopDeps)

      expect(result.sources.failed).toHaveLength(1)
      expect(result.sources.failed[0]!.error).toContain('Invalid bundle')
    })

    it('handles partial failures gracefully', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [
            {
              slug: 'good-source',
              config: {
                id: 'good_1',
                name: 'Good',
                slug: 'good-source',
                enabled: true,
                provider: 'custom',
                type: 'api',
                api: { baseUrl: 'https://api.example.com', authType: 'none' },
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
              files: [makeBundleFile('guide.md', '# Good')],
            },
          ],
          skills: [
            {
              slug: 'good-skill',
              files: [makeBundleFile('SKILL.md', '---\nname: Good\ndescription: Good\n---\nBody')],
            },
          ],
        },
      }

      const result = await importResources(wsDir, bundle, 'skip', noopDeps)

      expect(result.sources.imported).toEqual(['good-source'])
      expect(result.skills.imported).toEqual(['good-skill'])
    })

    it('cleans up temp dirs on failure', async () => {
      const wsDir = createTestWorkspace(tmpDir)

      // Import should complete without leaving temp dirs
      const bundle: ResourceBundle = {
        version: 1,
        exportedAt: Date.now(),
        resources: {
          sources: [{
            slug: 'test',
            config: { id: 'test_1', name: 'Test', slug: 'test', enabled: true, provider: 'x', type: 'api', api: { baseUrl: 'http://x', authType: 'none' }, createdAt: 1, updatedAt: 1 },
            files: [makeBundleFile('guide.md', '# Test')],
          }],
        },
      }

      await importResources(wsDir, bundle, 'skip', noopDeps)

      // No .tmp-* dirs should remain
      const sourcesDir = join(wsDir, 'sources')
      const entries = readdirSync(sourcesDir)
      const tmpDirs = entries.filter(e => e.startsWith('.tmp-'))
      expect(tmpDirs).toHaveLength(0)
    })
  })

  // ============================================================
  // Round-trip
  // ============================================================

  describe('round-trip export → import', () => {
    it('preserves source and skill content through round-trip', async () => {
      // Create source workspace with resources
      const srcDir = createTestWorkspace(join(tmpDir, 'src'))
      createTestSource(srcDir, 'my-api')
      createTestSkill(srcDir, 'my-skill', {
        'helper.ts': 'export function help() {}',
      })

      // Export
      const { bundle } = exportResources(srcDir, { sources: 'all', skills: 'all' })

      // Import into fresh workspace
      const dstDir = createTestWorkspace(join(tmpDir, 'dst'))
      const result = await importResources(dstDir, bundle, 'skip', noopDeps)

      expect(result.sources.imported).toEqual(['my-api'])
      expect(result.skills.imported).toEqual(['my-skill'])

      // Verify source files
      expect(existsSync(join(dstDir, 'sources', 'my-api', 'config.json'))).toBe(true)
      expect(existsSync(join(dstDir, 'sources', 'my-api', 'guide.md'))).toBe(true)

      // Verify skill files
      expect(existsSync(join(dstDir, 'skills', 'my-skill', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(dstDir, 'skills', 'my-skill', 'helper.ts'))).toBe(true)
      expect(readFileSync(join(dstDir, 'skills', 'my-skill', 'helper.ts'), 'utf-8')).toBe('export function help() {}')

      // Imported source config should have auth reset
      const importedConfig = JSON.parse(readFileSync(join(dstDir, 'sources', 'my-api', 'config.json'), 'utf-8'))
      expect(importedConfig.isAuthenticated).toBe(false)
    })

  })
})
