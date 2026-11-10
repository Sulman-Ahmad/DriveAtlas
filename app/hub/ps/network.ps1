# Read-only: how Windows treats the networks this PC is on (private or public), and the Windows Firewall rules
# for the program DriveAtlas runs in (Node.js). Used by Settings > Phone and helper PCs. Changes nothing.
param([string]$Node = '')
$ErrorActionPreference = 'SilentlyContinue'

$networks = @()
foreach ($p in @(Get-NetConnectionProfile)) {
  $ips = @(Get-NetIPAddress -InterfaceIndex $p.InterfaceIndex -AddressFamily IPv4 | ForEach-Object { [string]$_.IPAddress })
  $networks += [ordered]@{ name = [string]$p.Name; alias = [string]$p.InterfaceAlias; category = [string]$p.NetworkCategory; ipv4 = $ips }
}

$profiles = [ordered]@{}
foreach ($fp in @(Get-NetFirewallProfile)) { $profiles[[string]$fp.Name] = ([string]$fp.Enabled -ne 'False') }

$rules = @()
if ($Node) {
  $target = [IO.Path]::GetFullPath($Node).ToLowerInvariant()
  $filters = @(Get-NetFirewallApplicationFilter | Where-Object {
    $prog = [Environment]::ExpandEnvironmentVariables([string]$_.Program)
    $prog -and $prog.ToLowerInvariant() -eq $target
  })
  foreach ($r in @($filters | Get-NetFirewallRule)) {
    if ([string]$r.Enabled -eq 'True' -and [string]$r.Direction -eq 'Inbound') {
      $rules += [ordered]@{ action = [string]$r.Action; profile = [string]$r.Profile }
    }
  }
}

[ordered]@{ networks = $networks; profiles = $profiles; rules = $rules; checked = [bool]$Node } | ConvertTo-Json -Depth 5 -Compress
