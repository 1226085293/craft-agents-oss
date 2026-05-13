# Windows unsigned build notes

This document records local Windows unsigned packaging failures and the fixes used so the same issues are not repeated.

## Goal

Build an unsigned Windows installer from `apps/electron`:

```powershell
$env:CSC_IDENTITY_AUTO_DISCOVERY="false"
Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
& "E:\craft-agents-oss\apps\electron\scripts\build-win.ps1"
```

Final expected artifact:

```text
apps/electron/release/Craft-Agents-x64.exe
```

## Build, install, and restart the local app

When validating a fix from inside Craft Agents, use the repository-root helper instead of only running the installer manually:

```powershell
cd E:\craft-agents-oss
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-install-restart-win.ps1
```

The helper:

1. Runs `apps/electron/scripts/build-win.ps1` with unsigned-build signing environment variables.
2. Finds the newest `apps/electron/release/Craft-Agents-*.exe` installer.
3. Starts a detached PowerShell helper for install/restart because the installer can close the currently running Craft Agents process, including the agent session that launched the script.
4. Stops existing `Craft Agents` processes, runs the installer with `/S`, and starts the installed app from `%LOCALAPPDATA%\Programs\@craft-agentelectron\Craft Agents.exe`.
5. Writes a helper log to `%TEMP%\craft-agents-install-restart-*.log`.

Useful options:

```powershell
# Use an already-built installer, then install and restart.
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-install-restart-win.ps1 -SkipBuild

# Build only; do not install or restart.
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-install-restart-win.ps1 -NoInstall
```

Expect the current Craft Agents UI/session to disconnect during the restart step. After the app comes back, verify the installed bundle or behavior before reporting completion.

## Failure 1: build stuck or exited while downloading Bun

### Symptom

The Windows build stopped around:

```text
Downloading Bun bun-v1.3.9 for Windows x64 (baseline)...
Downloading from https://github.com/oven-sh/bun/releases/download/bun-v1.3.9/bun-windows-x64-baseline.zip...
Command exited with code 255
```

### Cause

`apps/electron/vendor/bun/` was empty, and `apps/electron/scripts/build-win.ps1` always tried to download Bun from GitHub during packaging. Local builds therefore depended on network access to GitHub release assets.

### Fix

`apps/electron/scripts/build-win.ps1` now stages Bun in this order:

1. Use `CRAFT_BUILD_BUN_EXE` if set.
2. Otherwise use `Get-Command bun` from the current machine.
3. Only download `bun-windows-x64-baseline.zip` as a fallback.

The download fallback also uses explicit timeouts.

### Prevention

- Prefer a locally installed Bun for local packaging.
- If a specific Bun binary must be used, set:

```powershell
$env:CRAFT_BUILD_BUN_EXE="C:\path\to\bun.exe"
```

- Do not reintroduce unconditional GitHub Bun downloads in the local Windows packaging path.

## Failure 2: unsigned build still downloaded winCodeSign and failed extracting symlinks

### Symptom

After Bun was staged successfully, `electron-builder` failed while extracting `winCodeSign-2.6.0.7z`:

```text
downloading url=https://github.com/electron-userland/electron-builder-binaries/releases/download/winCodeSign-2.6.0/winCodeSign-2.6.0.7z
ERROR: Cannot create symbolic link ... libcrypto.dylib
ERROR: Cannot create symbolic link ... libssl.dylib
electron-builder failed after 3 attempts
```

### Cause

Even though this was intended to be an unsigned build, `electron-builder` still attempted Windows executable signing/editing steps, which triggered download and extraction of `winCodeSign`. The `winCodeSign` archive contains macOS symlinks, and extraction failed on Windows without developer-mode/admin symlink privileges.

### Fix

`apps/electron/electron-builder.yml` now disables Windows executable signing/editing for local unsigned builds:

```yaml
win:
  signAndEditExecutable: false
```

This prevents the `winCodeSign` download/extraction path during unsigned local packaging.

### Prevention

- Keep `signAndEditExecutable: false` for unsigned local Windows builds.
- If signed release builds are needed later, use a separate CI/release configuration or override instead of changing the default local unsigned path.
- If `winCodeSign` extraction errors reappear, check whether signing/editing was re-enabled or environment signing variables were restored.

## Verification used

After applying the fixes, the package was produced at:

```text
E:\craft-agents-oss\apps\electron\release\Craft-Agents-x64.exe
```

Authenticode check showed no signer certificate:

```powershell
Get-AuthenticodeSignature "E:\craft-agents-oss\apps\electron\release\Craft-Agents-x64.exe"
```

Expected for the unsigned build:

```text
SignerCertificate: null
```

## Related files

- `apps/electron/scripts/build-win.ps1`
- `apps/electron/electron-builder.yml`
- `apps/electron/release/Craft-Agents-x64.exe` (generated artifact, not source)
