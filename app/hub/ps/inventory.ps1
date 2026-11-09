# Lists every disk Windows can see, with partitions, volumes, boot signals and
# basic health, as one JSON array on stdout. Read-only: it never writes to a drive.
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$phys = @{}
foreach ($p in Get-PhysicalDisk) { $phys[[string]$p.DeviceId] = $p }

$volumes = @{}
foreach ($v in Get-CimInstance -ClassName Win32_Volume) { $volumes[[string]$v.DeviceID] = $v }

$bootSignals = @('EFI\BOOT\BOOTX64.EFI', 'bootmgr', 'sources\install.wim', 'sources\install.esd', 'ventoy',
  'casper', 'live', 'isolinux', 'boot\grub', 'HBCD_PE.ini', 'Windows\System32')

$result = foreach ($d in Get-Disk) {
  if (-not $d.Size -or $d.Size -eq 0) { continue }
  $p = $phys[[string]$d.Number]

  $reliability = $null
  if ($p) {
    try {
      $r = $p | Get-StorageReliabilityCounter -ErrorAction Stop
      if ($r) {
        $reliability = [ordered]@{
          temperature = $r.Temperature; temperatureMax = $r.TemperatureMax; wear = $r.Wear
          powerOnHours = $r.PowerOnHours; readErrors = $r.ReadErrorsTotal; writeErrors = $r.WriteErrorsTotal
          startStopCycles = $r.StartStopCycleCount
        }
      }
    } catch { }
  }

  $parts = foreach ($pt in (Get-Partition -DiskNumber $d.Number)) {
    $vol = $null
    foreach ($ap in $pt.AccessPaths) { if ($volumes.ContainsKey([string]$ap)) { $vol = $volumes[[string]$ap] } }
    $letter = $null
    if ($pt.DriveLetter -and [int][char]$pt.DriveLetter -ne 0) { $letter = [string]$pt.DriveLetter }
    $signals = @()
    if ($letter) {
      $root = "$($letter):\"
      foreach ($s in $bootSignals) { if (Test-Path -LiteralPath (Join-Path $root $s)) { $signals += $s } }
    }
    [ordered]@{
      number = $pt.PartitionNumber
      letter = $letter
      size = [int64]$pt.Size
      offset = [int64]$pt.Offset
      type = [string]$pt.Type
      gptType = [string]$pt.GptType
      mbrType = $pt.MbrType
      guid = [string]$pt.Guid
      isActive = [bool]$pt.IsActive
      isBoot = [bool]$pt.IsBoot
      isSystem = [bool]$pt.IsSystem
      isHidden = [bool]$pt.IsHidden
      label = $(if ($vol) { [string]$vol.Label } else { $null })
      fileSystem = $(if ($vol) { [string]$vol.FileSystem } else { $null })
      capacity = $(if ($vol -and $vol.Capacity) { [int64]$vol.Capacity } else { $null })
      free = $(if ($vol -and $null -ne $vol.FreeSpace) { [int64]$vol.FreeSpace } else { $null })
      volumeSerial = $(if ($vol -and $vol.SerialNumber) { '{0:X8}' -f [uint32]$vol.SerialNumber } else { $null })
      volumeId = $(if ($vol) { [string]$vol.DeviceID } else { $null })
      signals = $signals
    }
  }

  [ordered]@{
    number = $d.Number
    friendlyName = ([string]$d.FriendlyName).Trim()
    model = ([string]$d.Model).Trim()
    manufacturer = ([string]$d.Manufacturer).Trim()
    serial = ([string]$d.SerialNumber).Trim()
    uniqueId = [string]$d.UniqueId
    busType = [string]$d.BusType
    size = [int64]$d.Size
    partitionStyle = [string]$d.PartitionStyle
    isBoot = [bool]$d.IsBoot
    isSystem = [bool]$d.IsSystem
    isOffline = [bool]$d.IsOffline
    isReadOnly = [bool]$d.IsReadOnly
    location = [string]$d.Location
    mediaType = $(if ($p) { [string]$p.MediaType } else { $null })
    spindleSpeed = $(if ($p) { $p.SpindleSpeed } else { $null })
    health = $(if ($p) { [string]$p.HealthStatus } else { [string]$d.HealthStatus })
    reliability = $reliability
    partitions = @($parts)
  }
}

ConvertTo-Json -InputObject @($result) -Depth 6 -Compress
