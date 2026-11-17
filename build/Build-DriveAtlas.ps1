# Builds DriveAtlas.exe: one file that carries the app (app.zip) and the official Node.js installer, plus the
# launcher in DriveAtlasLauncher.cs (tray icon, first-run install, Node.js check). Uses only the C# compiler that
# comes with Windows (.NET Framework 4); GitHub Actions runs this for every release.
#
#   powershell -ExecutionPolicy Bypass -File build\Build-DriveAtlas.ps1 -NodeMsi <node-vX.Y.Z-x64.msi> [-OutDir dist] [-BuildNumber 0]
#   powershell -ExecutionPolicy Bypass -File build\Build-DriveAtlas.ps1 -NoNode      # test build without the installer
param(
  [string]$NodeMsi,
  [switch]$NoNode,
  [string]$OutDir,
  [int]$BuildNumber = 0
)
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$appDir = Join-Path $root 'app'
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path $OutDir).Path
$work = Join-Path $OutDir 'exe-build'
if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force -Path $work | Out-Null
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { throw "C# compiler not found at $csc (it comes with .NET Framework 4)." }

$version = (Get-Content -Raw (Join-Path $appDir 'package.json') | ConvertFrom-Json).version
Write-Host "== DriveAtlas.exe $version ==" -ForegroundColor Cyan

# 1. The app: the files the repository publishes under app/ (tracked or new, never ignored local files).
Write-Host '[1/3] Packing the app...'
$zip = Join-Path $work 'app.zip'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$files = @(git -C $root ls-files --cached --others --exclude-standard -- app 2>$null)
if ($LASTEXITCODE -ne 0 -or $files.Count -eq 0) { throw 'git ls-files found no app files (run this from a clone of the repository).' }
$archive = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  foreach ($f in $files) {
    $src = Join-Path $root $f
    if (-not (Test-Path $src -PathType Leaf)) { continue } # deleted in the working tree
    $entry = $f.Substring(4) # path inside app/, with forward slashes
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $src, $entry, 'Optimal')
  }
} finally { $archive.Dispose() }
Write-Host ("    {0} files, {1:N1} MB" -f $files.Count, ((Get-Item $zip).Length / 1MB))

# 2. Node.js: the official installer, checked by the caller (the release workflow verifies its SHA-256).
$nodeVersion = 'none'
if (-not $NoNode) {
  if (-not $NodeMsi -or -not (Test-Path $NodeMsi)) { throw 'Pass -NodeMsi <path to node-vX.Y.Z-x64.msi>, or -NoNode for a test build.' }
  if ((Split-Path $NodeMsi -Leaf) -match '^node-(v\d+\.\d+\.\d+)-x64\.msi$') { $nodeVersion = $Matches[1] } else { throw 'Expected a file named like node-v24.11.1-x64.msi.' }
  Write-Host ("[2/3] Node.js installer {0}: {1:N1} MB" -f $nodeVersion, ((Get-Item $NodeMsi).Length / 1MB))
} else {
  Write-Host '[2/3] No Node.js installer (test build: needs Node.js 22.13+ already installed)'
}

# 3. Compile, with the version written into the exe.
Write-Host '[3/3] Compiling the launcher...'
$m = [regex]::Match($version, '^(\d+)\.(\d+)\.(\d+)')
$fileVersion = '{0}.{1}.{2}.{3}' -f $m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value, $BuildNumber
$versionCs = Join-Path $work 'Version.g.cs'
@"
using System.Reflection;
[assembly: AssemblyTitle("DriveAtlas")]
[assembly: AssemblyProduct("DriveAtlas")]
[assembly: AssemblyDescription("DriveAtlas: every drive you own and every file on it")]
[assembly: AssemblyCopyright("Sulman Ahmad")]
[assembly: AssemblyVersion("$fileVersion")]
[assembly: AssemblyFileVersion("$fileVersion")]
[assembly: AssemblyInformationalVersion("$version")]
namespace DriveAtlasLauncher { static class Build { public const string Version = "$version"; public const string NodeVersion = "$nodeVersion"; } }
"@ | Set-Content -Encoding UTF8 $versionCs

$out = Join-Path $OutDir 'DriveAtlas.exe'
$cscArgs = @('/nologo', '/target:winexe', "/out:$out", '/optimize+', '/platform:anycpu', '/codepage:65001', '/warnaserror-',
  '/reference:System.dll', '/reference:System.Core.dll', '/reference:System.Drawing.dll', '/reference:System.Windows.Forms.dll',
  '/reference:System.IO.Compression.dll', '/reference:System.IO.Compression.FileSystem.dll',
  "/win32icon:$(Join-Path $appDir 'assets\DriveAtlas.ico')",
  "/resource:$zip,DriveAtlasLauncher.app.zip")
if (-not $NoNode) { $cscArgs += "/resource:$NodeMsi,DriveAtlasLauncher.node-installer.msi" }
$cscArgs += @((Join-Path $PSScriptRoot 'DriveAtlasLauncher.cs'), $versionCs)
& $csc @cscArgs
if ($LASTEXITCODE -ne 0) { throw "Compiling failed (exit $LASTEXITCODE)." }
Remove-Item -Recurse -Force $work

$hash = (Get-FileHash -Algorithm SHA256 $out).Hash.ToLower()
Write-Host ("Built {0} ({1:N1} MB)" -f $out, ((Get-Item $out).Length / 1MB)) -ForegroundColor Green
Write-Host "SHA-256 $hash"
