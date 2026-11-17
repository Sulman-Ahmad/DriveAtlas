# Adds DriveAtlas to the Start menu (and, with -Startup, starts the hub when you sign in).
# Only creates shortcuts for your user; needs no admin rights. Remove with -Uninstall.
#   powershell -ExecutionPolicy Bypass -File app\scripts\install.ps1 [-Startup] [-Uninstall]
# With DriveAtlas.exe the app lives in %LOCALAPPDATA%\DriveAtlas, next to the exe, so the shortcuts open the exe.
# From the zip or a clone of the repository they open DriveAtlas.vbs instead.
param([switch]$Startup, [switch]$Uninstall)

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$exe = Join-Path $root 'DriveAtlas.exe'
$vbs = Join-Path $root 'DriveAtlas.vbs'
$icon = Join-Path $root 'app\assets\DriveAtlas.ico'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'DriveAtlas.lnk'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'DriveAtlas hub.lnk'
$useExe = Test-Path $exe

if ($Uninstall) {
  Remove-Item $startMenu, $startupLnk -ErrorAction SilentlyContinue
  Write-Host 'DriveAtlas shortcuts removed. Your catalog was not touched.'
  exit 0
}

# DriveAtlas.exe brings its own Node.js installer; the .vbs needs Node.js already installed.
if (-not $useExe -and -not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js was not found. Install Node.js 22.13 or newer from https://nodejs.org, then run this again.'
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
# $hubOnly: start just the hub in the background (the exe takes --hub, the .vbs takes /hub).
function New-Shortcut($path, [bool]$hubOnly, $description) {
  $s = $shell.CreateShortcut($path)
  if ($useExe) {
    $s.TargetPath = $exe
    $s.Arguments = if ($hubOnly) { '--hub' } else { '' }
  } else {
    $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $s.Arguments = if ($hubOnly) { "`"$vbs`" /hub" } else { "`"$vbs`"" }
  }
  $s.WorkingDirectory = $root
  $s.Description = $description
  if (Test-Path $icon) { $s.IconLocation = $icon }
  $s.Save()
}

New-Shortcut $startMenu $false 'DriveAtlas: every drive you own and every file on it'
Write-Host "Added to the Start menu: $startMenu"
if ($Startup) {
  New-Shortcut $startupLnk $true 'Starts the DriveAtlas hub in the background'
  Write-Host 'The hub will start when you sign in to Windows.'
}
