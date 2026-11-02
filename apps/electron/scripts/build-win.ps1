# Build script for Windows NSIS installer
# Usage: powershell -ExecutionPolicy Bypass -File scripts/build-win.ps1

[CmdletBinding()]
param(
    [switch]$SkipDependencyInstall,
    [switch]$SkipProcessKill,
    # Local rebuilds: `compression: store` (no 7z at all) — the 3-5 min path.
    # Hard precondition: the app archive must stay under 2GB, because makensis is
    # 32-bit without /LARGEADDRESSAWARE and cannot mmap a bigger one
    # (`File: failed creating mmap of "…nsis.7z"`). That is why
    # electron-builder.yml has to keep excluding stale output dirs
    # (`!release/**`): on 2026-10-27 a swept-in release/ pushed the archive to
    # 2.2GB and this mode started failing outright.
    [switch]$Fast
)

$ErrorActionPreference = "Stop"

# Per-step wall clock. Every run prints "[+NNNs] step", so a slow build can
# be attributed to staging vs packaging without guesswork (2026-10-18: a full
# rebuild took 10m37s and nobody could say which phase owned it).
$ScriptStart = Get-Date
function Write-Step {
    param([string]$Name)
    $elapsed = [int]((Get-Date) - $ScriptStart).TotalSeconds
    Write-Host ("[+{0,4}s] {1}" -f $elapsed, $Name) -ForegroundColor Magenta
}

# Shared diagnostic for a packaging output dir that cannot be freed.
# electron-builder reports the same condition as a Go stack trace
# ("EnsureEmptyDir -> The process cannot access the file ... app.asar") and never
# says who holds it, which is how a whole build gets wasted guessing.
function Write-OutDirLockedDiagnostic {
    param([string]$BlockedPath, [string]$DirToScan)
    Write-Host "  ERROR: the build output directory is in use:" -ForegroundColor Red
    Write-Host "    $BlockedPath" -ForegroundColor Red

    # Most likely a dev build of the app itself, running out of win-unpacked.
    $holders = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessId -ne $PID -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($DirToScan, 'OrdinalIgnoreCase')
    }
    if ($holders) {
        Write-Host "  Held by:" -ForegroundColor Yellow
        $holders | ForEach-Object {
            Write-Host ("    PID {0}  {1}" -f $_.ProcessId, $_.ExecutablePath) -ForegroundColor Yellow
        }
        Write-Host "  Close those processes, then re-run." -ForegroundColor Yellow
    } else {
        Write-Host "  No process runs from that folder, so the handle belongs to an editor, an" -ForegroundColor Yellow
        Write-Host "  antivirus scan or another build. Close it, or delete this by hand:" -ForegroundColor Yellow
        Write-Host "    $BlockedPath" -ForegroundColor Yellow
    }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)

# Configuration
$BunVersion = "bun-v1.3.9"  # Pinned version for reproducible builds

# Output directory for the installer. Defaults to `release`, but can be
# overridden when that directory is unavailable (e.g. a stale
# release/win-unpacked/resources/app.asar still held open by another process).
$OutDir = if ($env:CRAFT_BUILD_OUT_DIR) { $env:CRAFT_BUILD_OUT_DIR } else { "release" }

Write-Host "=== Building Craft Agents Windows Installer using electron-builder ===" -ForegroundColor Cyan

# Debug: System information
Write-Host ""
Write-Host "=== Debug: System Information ===" -ForegroundColor Magenta
Write-Host "OS: $([System.Environment]::OSVersion.VersionString)"
Write-Host "PowerShell: $($PSVersionTable.PSVersion)"
Write-Host "Hostname: $env:COMPUTERNAME"
Write-Host "User: $env:USERNAME"
Write-Host "Temp: $env:TEMP"
Write-Host "Working Dir: $(Get-Location)"

# Debug: Check Windows Defender status
Write-Host ""
Write-Host "=== Debug: Windows Defender Status ===" -ForegroundColor Magenta
try {
    $defenderStatus = Get-MpComputerStatus -ErrorAction SilentlyContinue
    if ($defenderStatus) {
        Write-Host "Real-time Protection: $($defenderStatus.RealTimeProtectionEnabled)"
        Write-Host "Antivirus Enabled: $($defenderStatus.AntivirusEnabled)"
        Write-Host "On Access Protection: $($defenderStatus.OnAccessProtectionEnabled)"
        Write-Host "IO AV Protection: $($defenderStatus.IoavProtectionEnabled)"
    } else {
        Write-Host "Could not get Defender status"
    }
} catch {
    Write-Host "Defender status check failed: $_"
}

# Debug: List exclusions
Write-Host ""
Write-Host "=== Debug: Defender Exclusions ===" -ForegroundColor Magenta
try {
    $prefs = Get-MpPreference -ErrorAction SilentlyContinue
    if ($prefs.ExclusionPath) {
        Write-Host "Path Exclusions: $($prefs.ExclusionPath -join ', ')"
    }
    if ($prefs.ExclusionProcess) {
        Write-Host "Process Exclusions: $($prefs.ExclusionProcess -join ', ')"
    }
} catch {
    Write-Host "Could not get exclusions: $_"
}
Write-Host ""

# 0. Kill any lingering processes that might lock files.
Write-Step "step 0: process cleanup"
# -SkipProcessKill: agent sessions running inside Craft Agents must NOT kill
# node/electron wholesale — that terminates the caller's own pipeline (2026-10-10
# observed as instant 'Command timed out') and can take down the host app.
# Callers inside a Craft session should pass -SkipProcessKill and instead run
# electron-builder as a detached background process, then poll the exe timestamp.
if (-not $SkipProcessKill) {
    Write-Host "Killing any lingering node/npm processes..."
    $processesToKill = @('node', 'npm', 'electron', 'electron-builder')
    foreach ($procName in $processesToKill) {
        Get-Process -Name $procName -ErrorAction SilentlyContinue | ForEach-Object {
            Write-Host "  Killing $($_.ProcessName) (PID: $($_.Id))..." -ForegroundColor Yellow
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    }
    # Give processes time to fully terminate
    Start-Sleep -Seconds 2
} else {
    Write-Host "Skipping process kill (-SkipProcessKill)." -ForegroundColor Yellow
    # Still clear STALE BUILD LEFTOVERS that hold locks on the release dir.
    # Killing all node/npm would terminate the caller's own pipeline, so match
    # precisely: only processes whose command line references the build output
    # dir (previous electron-builder/node children) are targets. Without this a
    # locked release\win-unpacked\resources\app.asar makes every retry fail and
    # the whole run burns 3x (build + retries) for nothing.
    # Release dir may appear in a command line with either separator
    # (electron-builder uses backslashes, hand-rolled node probes often use
    # forward slashes), so match on a separator-agnostic form.
    # NOTE: use String.Replace(), NOT `-replace '\\','/'` — the regex form
    # yields an empty pattern here and would then match every process.
    $releaseDir = Join-Path $ElectronDir $OutDir
    $releaseDirFwd = $releaseDir.Replace('\', '/')
    # Exclude ourselves AND the whole parent chain. Excluding only $PID is not
    # enough: the shell / agent that launched this script usually has the output
    # dir in its own command line (e.g. CRAFT_BUILD_OUT_DIR=release-xxx), so it
    # matched as a "stale build process" and got killed - which SIGKILLed the
    # build itself with exit code 0xffffffff (2026-10-27).
    $ancestors = @{}
    $ancestors[[int]$PID] = $true
    $cursor = $PID
    for ($depth = 0; $depth -lt 8; $depth++) {
        $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$cursor" -ErrorAction SilentlyContinue
        if (-not $procInfo -or -not $procInfo.ParentProcessId) { break }
        $parentId = [int]$procInfo.ParentProcessId
        if ($parentId -le 0 -or $ancestors.ContainsKey($parentId)) { break }
        $ancestors[$parentId] = $true
        $cursor = $parentId
    }
    $stale = Get-CimInstance Win32_Process -Filter "Name='node.exe' or Name='powershell.exe' or Name='pwsh.exe'" |
        Where-Object { $_.CommandLine -and ($_.CommandLine.Contains($releaseDir) -or $_.CommandLine.Contains($releaseDirFwd)) -and -not $ancestors.ContainsKey([int]$_.ProcessId) }
    if ($stale) {
        foreach ($proc in $stale) {
            Write-Host "  Killing stale build process $($proc.ProcessId) (holds lock on release dir)" -ForegroundColor Yellow
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 3
        # Verify the lock is gone; a still-locked app.asar is the #1 cause of
        # ERR_ELECTRON_BUILDER_CANNOT_EXECUTE.
        $asarPath = Join-Path $releaseDir "win-unpacked\resources\app.asar"
        if (Test-Path $asarPath) {
            Remove-Item $asarPath -Force -ErrorAction SilentlyContinue
            if (Test-Path $asarPath) {
                Write-Host "  WARNING: $asarPath is still locked. Delete it manually or close the app holding it." -ForegroundColor Red
            } else {
                Write-Host "  release dir lock cleared" -ForegroundColor Green
            }
        }
    }
}

# Preflight (early, before the ~2 minute app build): if the packaging output dir
# is already held open, stop here instead of letting electron-builder discover it
# after assembling win-unpacked. Only win-unpacked (build scratch, recreated by
# the packer anyway) is removed - a previous run's installer survives a failed
# build. Delete is the reliable lock test: any open handle without FILE_SHARE_DELETE
# makes it fail, whatever the holder's share mode.
$EarlyOutDirAbs = Join-Path $ElectronDir $OutDir
$EarlyWinUnpacked = Join-Path $EarlyOutDirAbs 'win-unpacked'
if (Test-Path $EarlyWinUnpacked) {
    Write-Host "  Preflight: clearing stale $EarlyWinUnpacked"
    Remove-Item -Recurse -Force $EarlyWinUnpacked -ErrorAction SilentlyContinue
    if (Test-Path $EarlyWinUnpacked) {
        Write-OutDirLockedDiagnostic -BlockedPath $EarlyWinUnpacked -DirToScan $EarlyOutDirAbs
        throw "Build output directory is locked: $EarlyWinUnpacked"
    }
}

# 1. Clean previous build artifacts (with retry for locked files)
Write-Host "Cleaning previous builds..."
$foldersToClean = @(
    "$ElectronDir\vendor",
    "$ElectronDir\node_modules\@anthropic-ai",
    "$ElectronDir\packages"
    # NOTE: `$ElectronDir\release` is deliberately NOT cleaned here. The packer
    # below manages $OutDir itself, and wiping it up front fails when a previous
    # run's app.asar is still held open by another process.
)
foreach ($folder in $foldersToClean) {
    if (Test-Path $folder) {
        $retries = 3
        for ($i = 1; $i -le $retries; $i++) {
            try {
                Remove-Item -Recurse -Force $folder -ErrorAction Stop
                break
            } catch {
                if ($i -eq $retries) { throw }
                Write-Host "  Retrying cleanup of $folder (attempt $i)..." -ForegroundColor Yellow
                Start-Sleep -Seconds 2
            }
        }
    }
}

# 2. Install dependencies
if ($SkipDependencyInstall) {
    Write-Host "Skipping dependency install because -SkipDependencyInstall was supplied." -ForegroundColor Yellow
} else {
    Write-Host "Installing dependencies..."
    Push-Location $RootDir
    try {
        bun install
    } finally {
        Pop-Location
    }
}

# 3. Stage Bun binary for Windows.
# Prefer the already-installed local bun.exe so local packaging does not depend
# on GitHub downloads (the previous build stopped here with Invoke-WebRequest
# exiting 255). Download only as a fallback when no local bun.exe is available.
Write-Host "Staging Bun for Windows x64..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\vendor\bun" | Out-Null

$BunExePath = "$ElectronDir\vendor\bun\bun.exe"
$LocalBun = $env:CRAFT_BUILD_BUN_EXE
if (-not $LocalBun) {
    $BunCommand = Get-Command bun -ErrorAction SilentlyContinue
    if ($BunCommand) { $LocalBun = $BunCommand.Source }
}

if ($LocalBun -and (Test-Path $LocalBun)) {
    Write-Host "Using local Bun: $LocalBun"
    Copy-Item -Force $LocalBun $BunExePath
    Unblock-File -Path $BunExePath -ErrorAction SilentlyContinue
    Write-Host "Bun staged to: $BunExePath" -ForegroundColor Green
} else {
    # Use baseline build - works on all x64 CPUs (no AVX2 requirement)
    Write-Host "Local Bun not found; downloading Bun $BunVersion for Windows x64 (baseline)..."

    $BunDownload = "bun-windows-x64-baseline"
    $TempDir = Join-Path $env:TEMP "bun-download-$(Get-Random)"
    New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

    try {
        # Download binary and checksums
        $ZipUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/$BunDownload.zip"
        $ChecksumUrl = "https://github.com/oven-sh/bun/releases/download/$BunVersion/SHASUMS256.txt"

        Write-Host "Downloading from $ZipUrl..."
        Invoke-WebRequest -Uri $ZipUrl -OutFile "$TempDir\$BunDownload.zip" -TimeoutSec 120
        Invoke-WebRequest -Uri $ChecksumUrl -OutFile "$TempDir\SHASUMS256.txt" -TimeoutSec 60

        # Verify checksum
        Write-Host "Verifying checksum..."
        $ExpectedHash = (Get-Content "$TempDir\SHASUMS256.txt" | Select-String "$BunDownload.zip").ToString().Split(" ")[0]
        $ActualHash = (Get-FileHash "$TempDir\$BunDownload.zip" -Algorithm SHA256).Hash.ToLower()

        if ($ActualHash -ne $ExpectedHash) {
            throw "Checksum verification failed! Expected: $ExpectedHash, Got: $ActualHash"
        }
        Write-Host "Checksum verified successfully" -ForegroundColor Green

        # Extract and install using robocopy for better file handle management
        Write-Host "Extracting Bun..."
        Expand-Archive -Path "$TempDir\$BunDownload.zip" -DestinationPath $TempDir -Force

        # Unblock in temp first (before copy)
        Unblock-File -Path "$TempDir\$BunDownload\bun.exe" -ErrorAction SilentlyContinue

        # Use robocopy with retries - handles transient file locks better than Copy-Item
        # /R:5 = 5 retries, /W:3 = 3 second wait between retries, /NP = no progress, /NFL /NDL = quiet
        Write-Host "Copying bun.exe with robocopy..."
        $robocopyResult = robocopy "$TempDir\$BunDownload" "$ElectronDir\vendor\bun" "bun.exe" /R:5 /W:3 /NP /NFL /NDL
        # Robocopy exit codes: 0-7 are success, 8+ are errors
        if ($LASTEXITCODE -ge 8) {
            throw "robocopy failed with exit code $LASTEXITCODE"
        }

        Write-Host "Bun extracted to: $BunExePath" -ForegroundColor Green
    } finally {
        Remove-Item -Recurse -Force $TempDir -ErrorAction SilentlyContinue
    }
}

# Give Windows time to release any file handles from the copy
Write-Host "Waiting for file handles to release..."
Start-Sleep -Seconds 3

# 5. Copy ripgrep.
$RgSource = "$RootDir\node_modules\@vscode\ripgrep"
$RgBinary = "$RgSource\bin\rg.exe"
if ((Test-Path $RgSource) -and -not (Test-Path $RgBinary)) {
    $PlatformRgBinary = "$RootDir\node_modules\@vscode\ripgrep-win32-x64\bin\rg.exe"
    if (Test-Path $PlatformRgBinary) {
        New-Item -ItemType Directory -Force -Path "$RgSource\bin" | Out-Null
        Copy-Item -Force $PlatformRgBinary $RgBinary
    }
}
if (-not (Test-Path $RgSource) -or -not (Test-Path $RgBinary)) {
    Write-Host "ERROR: @vscode/ripgrep not installed or postinstall did not run" -ForegroundColor Red
    Write-Host "Run 'bun install' and ensure @vscode/ripgrep-win32-x64 is installed."
    exit 1
}
Write-Host "Copying @vscode/ripgrep..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\node_modules\@vscode" | Out-Null
Remove-Item -Recurse -Force "$ElectronDir\node_modules\@vscode\ripgrep" -ErrorAction SilentlyContinue
Copy-Item -Recurse -Force $RgSource "$ElectronDir\node_modules\@vscode\"

# 6. Copy network interceptor sources (for the Pi subprocess).
$InterceptorSource = "$RootDir\packages\shared\src\unified-network-interceptor.ts"
if (-not (Test-Path $InterceptorSource)) {
    Write-Host "ERROR: Interceptor not found at $InterceptorSource" -ForegroundColor Red
    exit 1
}
Write-Host "Copying interceptor (for Pi subprocess)..."
New-Item -ItemType Directory -Force -Path "$ElectronDir\packages\shared\src" | Out-Null
Copy-Item $InterceptorSource "$ElectronDir\packages\shared\src\"
foreach ($dep in @("interceptor-common.ts", "feature-flags.ts", "interceptor-request-utils.ts")) {
    $depPath = "$RootDir\packages\shared\src\$dep"
    if (Test-Path $depPath) {
        Copy-Item $depPath "$ElectronDir\packages\shared\src\"
    }
}

# 6a. Build the interceptor bundle used by the Pi subprocess in packaged builds.
#     Copying the .ts sources is NOT enough — at runtime resolveInterceptorBundlePath()
#     loads the pre-built dist/interceptor.cjs (runtime-resolver.ts). Without this
#     step a stale bundle silently ships old interceptor code (2026-09-08 incident:
#     empty-stream guard, pendingFinishLine flush and #995 synthetic finish_reason
#     were missing from packaged builds).
Write-Host "  Building interceptor bundle..."
Push-Location $ElectronDir
try {
    bun run build:interceptor
    if ($LASTEXITCODE -ne 0) { throw "Interceptor bundle build failed" }
    Write-Host "  Interceptor bundle built" -ForegroundColor Green
} finally {
    Pop-Location
}

# 6. Build Electron app
Write-Host "Building Electron app..."

# Build WhatsApp worker bundle before packaging. electron-builder.yml includes
# packages/messaging-whatsapp-worker/dist/worker.cjs as an extraResource.
Write-Host "  Building WhatsApp worker..."
Push-Location $RootDir
try {
    bun run build:wa-worker
    if ($LASTEXITCODE -ne 0) { throw "WhatsApp worker build failed" }
} finally {
    Pop-Location
}

# Build main process with OAuth credentials
Write-Host "  Building main process..."
$MainArgs = @(
    "apps/electron/src/main/index.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--outfile=apps/electron/dist/main.cjs",
    "--external:electron",
    # Replace grammY's bundled polyfills (node-fetch@2 + abort-controller@3)
    # with native Node globals. Without this, packaged Telegram API calls can
    # fail before polling or file download starts.
    "--alias:node-fetch=./apps/electron/src/main/shims/node-fetch.cjs",
    "--alias:abort-controller=./apps/electron/src/main/shims/abort-controller.cjs",
    # Embedding engine (bge-small-zh-v1.5): transformers.js + onnxruntime must
    # NOT be inlined — esbuild dead-code-eliminates the onnxruntime-node native
    # binding loader when it bundles them, breaking embedding in the Electron
    # MAIN process (where the encodeEmbedding callback runs). Keep external so
    # Node resolves the full package (incl. native binding) from node_modules.
    # Must stay in sync with package.json build:main / build:main:win.
    "--external:@huggingface/transformers"
)
# Add OAuth defines if env vars are set
if ($env:GOOGLE_OAUTH_CLIENT_ID) {
    $MainArgs += "--define:process.env.GOOGLE_OAUTH_CLIENT_ID=`"'$env:GOOGLE_OAUTH_CLIENT_ID'`""
}
if ($env:GOOGLE_OAUTH_CLIENT_SECRET) {
    $MainArgs += "--define:process.env.GOOGLE_OAUTH_CLIENT_SECRET=`"'$env:GOOGLE_OAUTH_CLIENT_SECRET'`""
}
if ($env:SLACK_OAUTH_CLIENT_ID) {
    $MainArgs += "--define:process.env.SLACK_OAUTH_CLIENT_ID=`"'$env:SLACK_OAUTH_CLIENT_ID'`""
}
if ($env:SLACK_OAUTH_CLIENT_SECRET) {
    $MainArgs += "--define:process.env.SLACK_OAUTH_CLIENT_SECRET=`"'$env:SLACK_OAUTH_CLIENT_SECRET'`""
}
if ($env:MICROSOFT_OAUTH_CLIENT_ID) {
    $MainArgs += "--define:process.env.MICROSOFT_OAUTH_CLIENT_ID=`"'$env:MICROSOFT_OAUTH_CLIENT_ID'`""
}
Push-Location $RootDir
try {
    $EsbuildExe = Join-Path $RootDir "node_modules\.bin\esbuild.exe"
    if (Test-Path $EsbuildExe) {
        & $EsbuildExe @MainArgs
    } else {
        & npx esbuild @MainArgs
    }
    if ($LASTEXITCODE -ne 0) { throw "Main process build failed" }
} finally {
    Pop-Location
}

# Build preload
Write-Host "  Building preload..."
Push-Location $RootDir
try {
    bun run electron:build:preload
    if ($LASTEXITCODE -ne 0) { throw "Preload build failed" }
} finally {
    Pop-Location
}

# Build renderer (frontend)
Write-Host "  Building renderer (frontend)..."
Push-Location $RootDir
try {
    # Clean previous renderer build
    $RendererDir = "$ElectronDir\dist\renderer"
    if (Test-Path $RendererDir) { Remove-Item -Recurse -Force $RendererDir }

    # Run vite build
    $ViteExe = Join-Path $RootDir "node_modules\.bin\vite.exe"
    if (Test-Path $ViteExe) {
        & $ViteExe build --config apps/electron/vite.config.ts
    } else {
        npx vite build --config apps/electron/vite.config.ts
    }
    if ($LASTEXITCODE -ne 0) { throw "Renderer build failed" }

    # Verify renderer was built
    if (-not (Test-Path "$RendererDir\index.html")) {
        throw "Renderer build verification failed: index.html not found"
    }
    Write-Host "  Renderer build verified: $RendererDir" -ForegroundColor Green
} finally {
    Pop-Location
}

# Rebuild the Pi Agent Server subprocess so the packaged product always embeds
# the current source (incl. hot model/connection switching). copy-assets.ts copies
# packages/pi-agent-server/dist/index.js verbatim, so we MUST regenerate it here —
# otherwise a stale dist (built before a feature landed) ships silently and the Pi
# subprocess rejects newer message types like 'switch_connection' at runtime.
Write-Host "  Building Pi agent server (subprocess)..."
$PiAgentSrc = "$RootDir\packages\pi-agent-server\src\index.ts"
if (Test-Path $PiAgentSrc) {
    Push-Location $RootDir
    try {
        $PiDistDir = "$RootDir\packages\pi-agent-server\dist"
        if (-not (Test-Path $PiDistDir)) { New-Item -ItemType Directory -Force -Path $PiDistDir | Out-Null }
        & bun build $PiAgentSrc --outfile="$PiDistDir\index.js" --target=bun --format=esm --external koffi
        if ($LASTEXITCODE -ne 0) { throw "Pi agent server build failed" }
    } finally {
        Pop-Location
    }
    Write-Host "  Pi agent server built" -ForegroundColor Green
} else {
    Write-Host "  WARNING: Pi agent server source not found, using existing dist" -ForegroundColor Yellow
}

# Copy all resources and bundled assets using the shared script.
# NOTE: This is the single source of truth — matches Mac/Linux build (bun run build:copy).
# Copies: resources (icons, DMG bg), docs, tool-icons, themes, permissions, config-defaults.
Write-Host "  Copying resources and bundled assets..."
Push-Location $ElectronDir
try {
    bun scripts/copy-assets.ts
    if ($LASTEXITCODE -ne 0) { throw "Asset copy failed" }
    Write-Host "  Assets copied" -ForegroundColor Green

    # Validate critical build artifacts BEFORE packaging (main.cjs, preloads,
    # pi-agent-server, embedding model, bundled assets). Exit early with a
    # clear message instead of shipping a broken installer.
    Write-Host "  Validating build assets..."
    bun scripts/validate-assets.ts
    if ($LASTEXITCODE -ne 0) { throw "Build asset validation failed" }
    Write-Host "  Build assets validated" -ForegroundColor Green
} finally {
    Pop-Location
}

# 7. Package with electron-builder
Write-Step "step 7: electron-builder packaging"
Write-Host "Packaging app with electron-builder..."

# Preflight: NSIS writes the installer in one pass, so a full disk only shows up
# minutes later as `Error: can't write N bytes to output` from makensis, which
# reads like an NSIS bug rather than "you ran out of disk" (2026-10-26: E: filled
# up mid-write and the build died after packing ~1.7GB for nothing).
# Peak usage = win-unpacked (~1.7GB) + the 7z archive + the installer itself.
# -Fast (compression=store) writes a ~1.4GB archive AND a ~1.4GB installer.
# Payload ~1.4GB + archive + installer ≈ 4.2GB, hence the higher reserve.
$OutDriveLetter = (Split-Path -Qualifier (Join-Path $ElectronDir $OutDir)).TrimEnd(':')
# Drop the previous run's artifacts BEFORE measuring: a stale release dir can hold
# several GB (win-unpacked + 7z + installer), so measuring first would report
# "not enough space" for a build that actually fits once it is cleared.
$OutDirAbs = Join-Path $ElectronDir $OutDir
if (Test-Path $OutDirAbs) {
    Write-Host "  Clearing previous output directory ($OutDir) before the space check..."
    Remove-Item -Recurse -Force $OutDirAbs -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
}
# Authoritative lock check. The early preflight above catches a dir that was
# already in use at startup; this one verifies the dir really became empty (a
# handle could have been taken during the app build).
if (Test-Path $OutDirAbs) {
    Write-OutDirLockedDiagnostic -BlockedPath $OutDirAbs -DirToScan $OutDirAbs
    throw "Build output directory is locked: $OutDirAbs"
}
New-Item -ItemType Directory -Force -Path $OutDirAbs | Out-Null

# NOTE: "$OutDriveLetter:" would parse as a SCOPED variable ($x: is scope
# syntax), so the drive letter must be interpolated as $($x) or ${x}.
$OutDrive = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$($OutDriveLetter):'" -ErrorAction SilentlyContinue
if ($OutDrive) {
    $freeGB = [math]::Round($OutDrive.FreeSpace / 1GB, 1)
    $neededGB = if ($Fast) { 6 } else { 4 }
    $color = if ($freeGB -lt $neededGB) { 'Red' } else { 'Green' }
    Write-Host "  Disk $($OutDrive.DeviceID) free: $freeGB GB (packaging needs ~$neededGB GB)" -ForegroundColor $color
    if ($freeGB -lt $neededGB) {
        throw "Not enough free space on $($OutDrive.DeviceID) to package: $freeGB GB free, ~$neededGB GB needed. Free space, drop -Fast, or point `$env:CRAFT_BUILD_OUT_DIR at another drive."
    }
}

# Debug: Show bun.exe file info
Write-Host ""
Write-Host "=== Debug: bun.exe File Info ===" -ForegroundColor Magenta
$BunExe = "$ElectronDir\vendor\bun\bun.exe"
if (Test-Path $BunExe) {
    $fileInfo = Get-Item $BunExe
    Write-Host "Path: $($fileInfo.FullName)"
    Write-Host "Size: $([math]::Round($fileInfo.Length / 1MB, 2)) MB"
    Write-Host "Created: $($fileInfo.CreationTime)"
    Write-Host "Modified: $($fileInfo.LastWriteTime)"
    Write-Host "Attributes: $($fileInfo.Attributes)"

    # Check Zone.Identifier (Mark of the Web)
    $zoneFile = "$BunExe`:Zone.Identifier"
    if (Test-Path $zoneFile -ErrorAction SilentlyContinue) {
        Write-Host "Zone.Identifier: EXISTS (file may be blocked)" -ForegroundColor Yellow
    } else {
        Write-Host "Zone.Identifier: None (file is unblocked)"
    }

    # Check file hash
    $hash = (Get-FileHash $BunExe -Algorithm SHA256).Hash
    Write-Host "SHA256: $hash"
} else {
    Write-Host "ERROR: bun.exe not found at $BunExe" -ForegroundColor Red
}

# Debug: List vendor directory contents
Write-Host ""
Write-Host "=== Debug: vendor/bun Directory ===" -ForegroundColor Magenta
Get-ChildItem "$ElectronDir\vendor\bun" -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "  $($_.Name) - $($_.Length) bytes"
}

# Debug: Check for processes that might have files open
Write-Host ""
Write-Host "=== Debug: Potentially Relevant Processes ===" -ForegroundColor Magenta
$relevantProcesses = Get-Process | Where-Object {
    $_.ProcessName -match 'node|npm|bun|electron|defender|antimalware|mpcmdrun'
} | Select-Object ProcessName, Id, CPU, WorkingSet64
if ($relevantProcesses) {
    $relevantProcesses | ForEach-Object {
        Write-Host "  $($_.ProcessName) (PID: $($_.Id)) - Memory: $([math]::Round($_.WorkingSet64 / 1MB, 1)) MB"
    }
} else {
    Write-Host "  No relevant processes found"
}
Write-Host ""

# NOTE: bun.exe is now copied via extraResources in electron-builder.yml
# This avoids EBUSY errors from the npm node module collector.
# See electron-builder.yml for details.

# Verify bun.exe is accessible (not locked by another process)
Write-Host "  Verifying $BunExe is accessible..."
$retryCount = 0
$maxRetries = 6
while ($retryCount -lt $maxRetries) {
    try {
        # Try to open the file exclusively to verify no other process has it locked
        $stream = [System.IO.File]::Open($BunExe, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::None)
        $stream.Close()
        $stream.Dispose()
        Write-Host "  File is accessible" -ForegroundColor Green
        break
    } catch {
        $retryCount++
        if ($retryCount -ge $maxRetries) {
            Write-Host "  WARNING: File may be locked after $maxRetries attempts, proceeding anyway..." -ForegroundColor Yellow
        } else {
            Write-Host "  File locked, waiting 5 seconds (attempt $retryCount/$maxRetries)..." -ForegroundColor Yellow
            Start-Sleep -Seconds 5
        }
    }
}

# Force garbage collection to release any managed file handles
[System.GC]::Collect()
[System.GC]::WaitForPendingFinalizers()

# Preflight already ran before the app build (see step 7 header), so the output
# dir is known to be free. Single attempt: a failed packaging run is
# deterministic here (NSIS script error, missing dependency, full disk), so
# retrying only multiplied the wall clock - on 2026-10-26 three attempts turned
# a 5-minute build into 20 while the real cause (a makensis warning promoted by
# -WX) sat unread in the captured output.
Push-Location $ElectronDir
Write-Host "  Running electron-builder..." -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $OutDirAbs | Out-Null

# Prefer the bun-generated .bin shim (bun install creates no .cmd shims, so
# plain `npx` fails with "not recognized"); fall back to npx like the
# esbuild/vite call sites above.
$ElectronBuilderExe = Join-Path $RootDir "node_modules\.bin\electron-builder.exe"
# These are all positional arguments to an external exe (not PowerShell
# named parameters), so array splatting is safe here.
$builderArgs = @('--win', '--x64', "-c.directories.output=$OutDir")
if ($Fast) {
    # 'store' skips 7z entirely. Measured on this repo: ~6-7 min end to end vs
    # ~13 min at 'maximum'. Precondition: archive < 2GB (see param docs).
    $builderArgs += '-c.compression=store'
    Write-Host "  -Fast: compression=store (no 7z, installer ~1.7GB)" -ForegroundColor Cyan
}
if (Test-Path $ElectronBuilderExe) {
    & $ElectronBuilderExe @builderArgs 2>&1 | Tee-Object -Variable builderOutput
} else {
    npx electron-builder @builderArgs 2>&1 | Tee-Object -Variable builderOutput
}

$builderExitCode = $LASTEXITCODE
if ($builderExitCode -ne 0) {
    Write-Host "  electron-builder failed with exit code $builderExitCode" -ForegroundColor Red
    $builderText = if ($builderOutput) { ($builderOutput | Out-String) } else { '' }

    # `can't write N bytes to output` is makensis' ENOSPC: it reads like an NSIS
    # bug but means the output drive filled up mid-write.
    if ($builderText -match "can't write \d+ bytes to output") {
        Write-Host "  HINT: makensis could not write the installer - the output drive is full." -ForegroundColor Yellow
        Write-Host "        Free space on $($OutDriveLetter):, or build with the output dir on" -ForegroundColor Yellow
        Write-Host "        another drive (CRAFT_BUILD_OUT_DIR, but keep it OUTSIDE apps\electron)." -ForegroundColor Yellow
    }

    $salient = $builderText -split "`r?`n" |
        Select-String -Pattern 'Error|error in script|!include|warning \d+|ERR_[A-Z_]+|failedTask|being used by another process' |
        Select-Object -First 10
    if ($salient) {
        Write-Host "  --- root cause lines ---" -ForegroundColor Red
        $salient | ForEach-Object { Write-Host ("  " + $_.Line.Trim()) -ForegroundColor DarkGray }
    }
    throw "electron-builder failed (exit code $builderExitCode). See the 'root cause lines' above."
}

Pop-Location
Write-Host "  electron-builder succeeded" -ForegroundColor Green

# 8. Verify the installer was built
Write-Step "step 8: verify installer"
$InstallerPath = Get-ChildItem -Path $OutDirAbs -Filter "*.exe" | Select-Object -First 1

if (-not $InstallerPath) {
    Write-Host "ERROR: Installer not found in $OutDirAbs" -ForegroundColor Red
    Write-Host "Contents of output directory:"
    Get-ChildItem $OutDirAbs
    exit 1
}

Write-Host ""
Write-Host "=== Build Complete ===" -ForegroundColor Green
Write-Host "Installer: $($InstallerPath.FullName)"
Write-Host "Size: $([math]::Round($InstallerPath.Length / 1MB, 2)) MB"
Write-Step "build complete"

# Explicit success code. Without it $LASTEXITCODE keeps whatever the last
# external process (electron-builder / bun / npm) left behind — callers that
# check `if ($LASTEXITCODE -ne 0) { throw }` then report a failure for a
# build that actually succeeded (2026-10-17, build-install-restart-win.ps1).
exit 0
