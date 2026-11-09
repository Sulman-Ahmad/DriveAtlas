# Runs health.ps1 with administrator rights. Windows shows its permission prompt first;
# if you choose No, nothing runs and this exits with code 2.
param(
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$Smartctl = ''
)
$ErrorActionPreference = 'Stop'
# Each path is quoted on its own; Windows paths cannot contain the quote character.
$arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f $Script), '-Out', ('"{0}"' -f $Out))
if ($Smartctl) { $arguments += @('-Smartctl', ('"{0}"' -f $Smartctl)) }
try {
  $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList $arguments
  exit $p.ExitCode
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 2
}
