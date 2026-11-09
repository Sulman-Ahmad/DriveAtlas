# Reads drive health and writes it as JSON to -Out. Read-only.
# Runs with administrator rights (started through elevate.ps1), because Windows only
# shares wear, temperature and SMART data with administrators.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Smartctl = ''
)
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$isAdmin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$haveSmartctl = $Smartctl -and (Test-Path -LiteralPath $Smartctl)

$list = foreach ($p in Get-PhysicalDisk) {
  $rel = $null
  try {
    $r = $p | Get-StorageReliabilityCounter -ErrorAction Stop
    if ($r) {
      $rel = [ordered]@{
        temperature = $r.Temperature; temperatureMax = $r.TemperatureMax; wear = $r.Wear; powerOnHours = $r.PowerOnHours
        readErrors = $r.ReadErrorsTotal; writeErrors = $r.WriteErrorsTotal; readErrorsUncorrected = $r.ReadErrorsUncorrected
        startStopCycles = $r.StartStopCycleCount
      }
    }
  } catch { }

  $smart = $null
  if ($haveSmartctl) {
    $device = "/dev/pd$($p.DeviceId)"
    $raw = & $Smartctl -a -j $device 2>$null
    $code = $LASTEXITCODE
    if (($code -band 2) -and [string]$p.BusType -eq 'USB') {
      # Drives in USB enclosures often need the SAT pass-through to be named.
      $raw = & $Smartctl -a -j -d sat $device 2>$null
      $code = $LASTEXITCODE
    }
    $smart = [ordered]@{ exitCode = $code; json = ($raw -join "`n") }
  }

  [ordered]@{
    number = [int]$p.DeviceId
    friendlyName = [string]$p.FriendlyName
    serial = ([string]$p.SerialNumber).Trim()
    busType = [string]$p.BusType
    mediaType = [string]$p.MediaType
    healthStatus = [string]$p.HealthStatus
    reliability = $rel
    smart = $smart
  }
}

$result = [ordered]@{ admin = $isAdmin; smartctl = [bool]$haveSmartctl; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); disks = @($list) }
$json = ConvertTo-Json -InputObject $result -Depth 6 -Compress
[IO.File]::WriteAllText($Out, $json, (New-Object Text.UTF8Encoding($false)))
