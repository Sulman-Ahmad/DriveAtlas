# Adds DriveAtlas to the Start menu (and, with -Startup, starts the hub when you sign in).
# Only creates shortcuts for your user; needs no admin rights. Remove with -Uninstall.
#   powershell -ExecutionPolicy Bypass -File app\scripts\install.ps1 [-Startup] [-Uninstall]
param([switch]$Startup, [switch]$Uninstall)

$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$vbs = Join-Path $root 'DriveAtlas.vbs'
$icon = Join-Path $root 'app\assets\DriveAtlas.ico'
$startMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'DriveAtlas.lnk'
$startupLnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'DriveAtlas hub.lnk'

if ($Uninstall) {
  Remove-Item $startMenu, $startupLnk -ErrorAction SilentlyContinue
  Write-Host 'DriveAtlas shortcuts removed. Your catalog was not touched.'
  exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js was not found. Install Node.js 22 or newer from https://nodejs.org, then run this again.'
  exit 1
}

$shell = New-Object -ComObject WScript.Shell
function New-Shortcut($path, $arguments, $description) {
  $s = $shell.CreateShortcut($path)
  $s.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
  $s.Arguments = "`"$vbs`" $arguments".Trim()
  $s.WorkingDirectory = $root
  $s.Description = $description
  if (Test-Path $icon) { $s.IconLocation = $icon }
  $s.Save()
}

New-Shortcut $startMenu '' 'DriveAtlas: every drive you own and every file on it'
Write-Host "Added to the Start menu: $startMenu"
if ($Startup) {
  New-Shortcut $startupLnk '/hub' 'Starts the DriveAtlas hub in the background'
  Write-Host 'The hub will start when you sign in to Windows.'
}
