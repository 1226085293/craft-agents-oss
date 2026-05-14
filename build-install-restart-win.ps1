# Build, install, and restart the local Windows Craft Agents app.
#
# Usage from repository root:
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\build-install-restart-win.ps1
#
# Notes:
# - This script intentionally starts a detached helper for the install/restart
#   step because installing the app can close the currently running Craft Agents
#   process, including the agent session that launched this script.
# - The helper writes a log to %TEMP%\craft-agents-install-restart-*.log.

[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$SkipDependencyInstall,
    [switch]$NoInstall,
    [int]$RestartDelaySeconds = 2
)

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Join-Path $RootDir "apps\electron"
$BuildScript = Join-Path $ElectronDir "scripts\build-win.ps1"
$ReleaseDir = Join-Path $ElectronDir "release"
$InstalledExe = Join-Path $env:LOCALAPPDATA "Programs\@craft-agentelectron\Craft Agents.exe"

if (-not (Test-Path $BuildScript)) {
    throw "Windows build script not found: $BuildScript"
}

Write-Host "=== Craft Agents Windows build/install/restart ===" -ForegroundColor Cyan
Write-Host "Repository: $RootDir"

# Keep local builds unsigned and avoid accidentally picking up signing variables
# from the user's shell.
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue

if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "=== Building installer ===" -ForegroundColor Cyan
    $BuildArgs = @()
    if ($SkipDependencyInstall) { $BuildArgs += "-SkipDependencyInstall" }
    & $BuildScript @BuildArgs
    if ($LASTEXITCODE -ne 0) {
        throw "build-win.ps1 failed with exit code $LASTEXITCODE"
    }
} else {
    Write-Host "Skipping build because -SkipBuild was supplied." -ForegroundColor Yellow
}

$Installer = Get-ChildItem -Path $ReleaseDir -Filter "Craft-Agents-*.exe" -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $Installer) {
    throw "Installer not found in $ReleaseDir"
}

Write-Host ""
Write-Host "Installer: $($Installer.FullName)"
Write-Host "Size: $([math]::Round($Installer.Length / 1MB, 2)) MB"
Write-Host "Modified: $($Installer.LastWriteTime)"

if ($NoInstall) {
    Write-Host "-NoInstall supplied; leaving installer built but not installed/restarted." -ForegroundColor Yellow
    exit 0
}

$HelperPath = Join-Path $env:TEMP ("craft-agents-install-restart-{0}.ps1" -f ([System.Guid]::NewGuid().ToString("N")))
$LogPath = [System.IO.Path]::ChangeExtension($HelperPath, ".log")

$Helper = @'
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$InstallerPath,
    [Parameter(Mandatory = $true)][string]$InstalledExe,
    [int]$RestartDelaySeconds = 2,
    [Parameter(Mandatory = $true)][string]$LogPath
)

$ErrorActionPreference = "Stop"

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Message
    Add-Content -Path $LogPath -Value $line
}

try {
    Write-Log "Helper started. Installer=$InstallerPath InstalledExe=$InstalledExe"

    Write-Log "Stopping running Craft Agents processes before install..."
    Get-Process -Name "Craft Agents" -ErrorAction SilentlyContinue | ForEach-Object {
        Write-Log "Stopping PID $($_.Id) $($_.Path)"
        Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    }

    Start-Sleep -Seconds 2

    Write-Log "Running silent installer..."
    $proc = Start-Process -FilePath $InstallerPath -ArgumentList "/S" -Wait -PassThru
    Write-Log "Installer exited with code $($proc.ExitCode)"
    if ($proc.ExitCode -ne 0) {
        throw "Installer failed with exit code $($proc.ExitCode)"
    }

    if (-not (Test-Path $InstalledExe)) {
        throw "Installed executable not found: $InstalledExe"
    }

    Start-Sleep -Seconds $RestartDelaySeconds

    Write-Log "Starting Craft Agents..."
    Start-Process -FilePath $InstalledExe | Out-Null
    Start-Sleep -Seconds 3

    $running = Get-Process -Name "Craft Agents" -ErrorAction SilentlyContinue
    if (-not $running) {
        throw "Craft Agents did not appear to start after install"
    }

    foreach ($p in $running) {
        Write-Log "Running PID $($p.Id) Started=$($p.StartTime) Path=$($p.Path)"
    }

    Write-Log "Helper completed successfully."
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    throw
}
'@

Set-Content -Path $HelperPath -Value $Helper -Encoding UTF8

Write-Host ""
Write-Host "=== Starting detached install/restart helper ===" -ForegroundColor Cyan
Write-Host "The current Craft Agents window/session may close during this step."
Write-Host "Helper script: $HelperPath"
Write-Host "Helper log: $LogPath"

$HelperArgs = @(
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", $HelperPath,
    "-InstallerPath", $Installer.FullName,
    "-InstalledExe", $InstalledExe,
    "-RestartDelaySeconds", $RestartDelaySeconds,
    "-LogPath", $LogPath
)

Start-Process -FilePath "powershell.exe" -ArgumentList $HelperArgs -WindowStyle Hidden

Write-Host "Detached helper launched. If this session disconnects, reopen Craft Agents and check:" -ForegroundColor Green
Write-Host "  $LogPath"
