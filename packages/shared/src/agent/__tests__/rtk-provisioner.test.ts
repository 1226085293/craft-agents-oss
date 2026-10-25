import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

import {
  provisionBundledRtk,
  provisionedRtkPath,
  provisionedRtkSize,
  type ArchiveExtractor,
  type BinaryVerifier,
} from '../core/rtk-provisioner'

/**
 * The extraction step is injected rather than shelled out to tar/zip. Windows'
 * bundled tar parses `-C C:\...` as a remote host, so a real tar is unusable in
 * a Windows test run even though production only calls it on unix. What these
 * tests need to pin down is the logic around extraction — checksum
 * verification, idempotence, upgrade detection, and the post-extract sanity
 * check — not tar's own behaviour, which the platform owns.
 *
 * `stageRtk` holds a runnable fake binary that the stub extractor copies out,
 * standing in for the contents of a real archive.
 */

let workDir: string
let configDir: string
let archivesDir: string
let stageDir: string
let savedConfigDir: string | undefined
let savedPlatform: NodeJS.Platform | undefined
let savedArch: string | undefined

const FAKE_RTK = '#!/bin/sh\necho "rtk 1.0.1"\n'
const BROKEN_RTK = '#!/bin/sh\nexit 1\n'

function currentPlatformKey(): string {
  const platform = process.platform as string
  const arch = process.arch as string
  if (platform === 'win32') return 'win32-x64'
  if (platform === 'darwin') return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64'
  return arch === 'arm64' ? 'linux-arm64' : 'linux-x64'
}

function currentBinaryName(): string {
  return process.platform === 'win32' ? 'rtk.exe' : 'rtk'
}

function currentArchiveName(): string {
  const key = currentPlatformKey()
  return key === 'win32-x64' ? 'rtk-win32-x64.zip' : `rtk-${key}.tar.gz`
}

/**
 * Writes an opaque blob as the "archive" plus its checksum manifest. The blob
 * content is what the checksum covers, so callers can change it to simulate an
 * upgraded release.
 *
 * The hash comes from node's crypto, not the `sha256sum` binary: Git Bash's
 * build prefixes its output with a binary-mode marker, which would otherwise
 * land inside the manifest and never match.
 */
function stageArchive(content: string): string {
  const name = currentArchiveName()
  const path = join(archivesDir, name)
  writeFileSync(path, content)
  const hash = createHash('sha256').update(readFileSync(path)).digest('hex')
  writeFileSync(join(archivesDir, 'SHA256SUMS.txt'), `${hash}  ${name}\n`)
  return path
}

/** Stub extractor: copies the staged binary into the destination directory. */
function stubExtractor(body: string): ArchiveExtractor {
  return (_archivePath, destDir) => {
    mkdirSync(destDir, { recursive: true })
    const staged = join(stageDir, 'rtk-payload')
    writeFileSync(staged, body)
    copyFileSync(staged, join(destDir, currentBinaryName()))
  }
}

const failingExtractor: ArchiveExtractor = () => {
  throw new Error('simulated extractor failure')
}

/**
 * The default verifier spawns `<binary> --version`, which needs a real
 * executable for the current platform. Tests stand in a check on the file's
 * contents so the same fixtures work on Windows, where a `#!/bin/sh` script
 * cannot be executed at all.
 */
const verifyOk: BinaryVerifier = (binaryPath) => readFileSync(binaryPath, 'utf-8').includes('rtk')
const verifyFails: BinaryVerifier = () => false

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'rtk-prov-'))
  configDir = join(workDir, 'config')
  archivesDir = join(configDir, 'resources', 'bin', 'rtk-archives')
  stageDir = join(workDir, 'stage')
  mkdirSync(archivesDir, { recursive: true })
  mkdirSync(stageDir, { recursive: true })

  savedConfigDir = process.env.CRAFT_CONFIG_DIR
  savedPlatform = process.platform
  savedArch = process.arch
  process.env.CRAFT_CONFIG_DIR = configDir
})

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.CRAFT_CONFIG_DIR
  else process.env.CRAFT_CONFIG_DIR = savedConfigDir
  Object.defineProperty(process, 'platform', { value: savedPlatform, configurable: true })
  Object.defineProperty(process, 'arch', { value: savedArch, configurable: true })
  rmSync(workDir, { recursive: true, force: true })
})

describe('provisionBundledRtk', () => {
  it('reports no-archive when nothing is bundled', () => {
    const result = provisionBundledRtk(configDir, stubExtractor(FAKE_RTK), verifyOk)
    expect(result.path).toBeNull()
    expect(result.reason).toBe('no-archive')
  })

  it('extracts a matching archive and returns a runnable path', () => {
    stageArchive('archive-v1')
    const result = provisionBundledRtk(configDir, stubExtractor(FAKE_RTK), verifyOk)

    expect(result.reason).toBeUndefined()
    expect(result.path).not.toBeNull()
    expect(existsSync(result.path!)).toBe(true)
    // The verifier ran against the extracted file and accepted it. Executing
    // the fixture for real is deliberately not asserted here — it is a shell
    // script, which Windows cannot spawn at all.
    expect(readFileSync(result.path!, 'utf-8')).toContain('rtk')
  })

  it('refuses an archive whose checksum does not match the manifest', () => {
    const name = currentArchiveName()
    writeFileSync(join(archivesDir, name), 'archive-v1')
    writeFileSync(join(archivesDir, 'SHA256SUMS.txt'), `${'0'.repeat(64)}  ${name}\n`)

    const result = provisionBundledRtk(configDir, stubExtractor(FAKE_RTK), verifyOk)

    expect(result.path).toBeNull()
    expect(result.reason).toBe('checksum-mismatch')
    expect(existsSync(join(configDir, 'rtk', currentPlatformKey(), currentBinaryName()))).toBe(false)
  })

  it('is idempotent: a second call does not re-extract', () => {
    stageArchive('archive-v1')
    const first = provisionBundledRtk(configDir, stubExtractor(FAKE_RTK), verifyOk)
    expect(first.path).not.toBeNull()

    // Overwrite the extracted binary with a sentinel that still passes
    // verification. If the second call re-extracted, the sentinel would be gone.
    writeFileSync(first.path!, 'rtk sentinel')

    const second = provisionBundledRtk(configDir, stubExtractor(FAKE_RTK), verifyOk)
    expect(second.path).toBe(first.path)
    expect(second.reason).toBe('already-present')
    expect(readFileSync(second.path!, 'utf-8')).toBe('rtk sentinel')
  })

  it('re-extracts when the bundled archive changed (an upgrade)', () => {
    stageArchive('archive-v1')
    const initial = provisionBundledRtk(configDir, stubExtractor(FAKE_RTK), verifyOk)
    expect(initial.path).not.toBeNull()

    // Leave a stale binary behind and ship a new archive with a new checksum.
    writeFileSync(initial.path!, 'stale')
    stageArchive('archive-v2')

    const result = provisionBundledRtk(configDir, stubExtractor(FAKE_RTK), verifyOk)

    expect(result.path).not.toBeNull()
    expect(result.reason).toBeUndefined()
    expect(readFileSync(result.path!, 'utf-8')).not.toContain('stale')
  })

  it('fails when the extracted binary fails verification', () => {
    stageArchive('archive-v1')
    const result = provisionBundledRtk(configDir, stubExtractor(FAKE_RTK), verifyFails)

    expect(result.path).toBeNull()
    expect(result.reason).toBe('extract-failed')
  })

  it('fails when the extractor cannot unpack the archive', () => {
    stageArchive('archive-v1')
    const result = provisionBundledRtk(configDir, failingExtractor, verifyOk)

    expect(result.path).toBeNull()
    expect(result.reason).toBe('extract-failed')
  })

  it('fails when the archive unpacks but the binary cannot run', () => {
    stageArchive('archive-v1')
    const result = provisionBundledRtk(configDir, stubExtractor(BROKEN_RTK), verifyOk)

    expect(result.path).toBeNull()
    expect(result.reason).toBe('extract-failed')
  })

  it('reports no-archive for an unsupported platform', () => {
    Object.defineProperty(process, 'platform', { value: 'sunos', configurable: true })
    const result = provisionBundledRtk(configDir, stubExtractor(FAKE_RTK), verifyOk)
    expect(result.path).toBeNull()
    expect(result.reason).toBe('no-archive')
  })

  it('falls back to CRAFT_RESOURCES_BASE when no explicit path is given', () => {
    stageArchive('archive-v1')
    const saved = process.env.CRAFT_RESOURCES_BASE
    process.env.CRAFT_RESOURCES_BASE = configDir
    try {
      const result = provisionBundledRtk(undefined, stubExtractor(FAKE_RTK), verifyOk)
      expect(result.path).not.toBeNull()
    } finally {
      if (saved === undefined) delete process.env.CRAFT_RESOURCES_BASE
      else process.env.CRAFT_RESOURCES_BASE = saved
    }
  })
})

describe('provisionedRtkPath / provisionedRtkSize', () => {
  it('returns null and 0 when nothing is provisioned', () => {
    expect(provisionedRtkPath()).toBeNull()
    expect(provisionedRtkSize()).toBe(0)
  })

  it('returns the path and size once provisioned', () => {
    stageArchive('archive-v1')
    const result = provisionBundledRtk(configDir, stubExtractor(FAKE_RTK), verifyOk)
    expect(result.path).not.toBeNull()

    expect(provisionedRtkPath()).toBe(result.path)
    expect(provisionedRtkSize()).toBeGreaterThan(0)
  })
})
