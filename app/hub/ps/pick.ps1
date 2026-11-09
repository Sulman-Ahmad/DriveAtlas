# Shows a Windows folder or file picker and prints the chosen path (nothing if cancelled).
param([ValidateSet('folder', 'backup')][string]$Kind = 'folder')
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Width = 1
$owner.Height = 1
try {
  if ($Kind -eq 'folder') {
    $d = New-Object System.Windows.Forms.FolderBrowserDialog
    $d.Description = 'Choose a folder for DriveAtlas'
    $d.ShowNewFolderButton = $true
    if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }
  } else {
    $d = New-Object System.Windows.Forms.OpenFileDialog
    $d.Title = 'Choose a DriveAtlas backup'
    $d.Filter = 'DriveAtlas backup (*.dabackup)|*.dabackup'
    $d.Multiselect = $false
    if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.FileName) }
  }
} finally {
  $owner.Dispose()
}
