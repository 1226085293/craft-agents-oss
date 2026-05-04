import { stat } from 'fs/promises'

/**
 * Basic file-name validation for Bash executable paths.
 * Windows requires bash.exe; Unix-like platforms require bash.
 */
export function isGitBashExecutablePath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const trimmedPath = filePath.trim()
  return platform === 'win32'
    ? /(?:^|[\\/])bash\.exe$/i.test(trimmedPath)
    : /(?:^|[\\/])bash$/i.test(trimmedPath)
}

/**
 * Validate a user-provided Bash executable path.
 * Enforces the platform-specific filename and existence on disk.
 */
export async function validateGitBashPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<{ valid: true; path: string } | { valid: false; error: string }> {
  const trimmedPath = filePath.trim()
  const expectedName = platform === 'win32' ? 'bash.exe' : 'bash'

  if (!isGitBashExecutablePath(trimmedPath, platform)) {
    return { valid: false, error: `Path must point to ${expectedName}` }
  }

  try {
    const info = await stat(trimmedPath)
    if (!info.isFile()) {
      return { valid: false, error: 'Path must point to a file' }
    }
    return { valid: true, path: trimmedPath }
  } catch {
    return { valid: false, error: 'File does not exist at the specified path' }
  }
}

/**
 * Check if a Bash path is usable without returning UI-facing errors.
 */
export async function isUsableGitBashPath(
  filePath: string,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean> {
  const result = await validateGitBashPath(filePath, platform)
  return result.valid
}
