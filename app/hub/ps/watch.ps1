# Prints "changed" whenever a disk or volume appears, disappears, is renamed or
# reformatted. The hub then runs inventory.ps1. Free-space changes are ignored.
$ErrorActionPreference = 'SilentlyContinue'
$last = $null
while ($true) {
  $disks = (Get-CimInstance -ClassName Win32_DiskDrive | ForEach-Object { "$($_.PNPDeviceID)|$($_.Size)" }) -join ';'
  $vols = (Get-CimInstance -ClassName Win32_Volume | ForEach-Object { "$($_.DeviceID)|$($_.DriveLetter)|$($_.Label)|$($_.FileSystem)|$($_.Capacity)" }) -join ';'
  $sig = "$disks#$vols"
  if ($sig -ne $last) {
    if ($null -ne $last) { [Console]::Out.WriteLine('changed'); [Console]::Out.Flush() }
    $last = $sig
  }
  Start-Sleep -Milliseconds 2500
}
