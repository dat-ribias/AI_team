param(
  [Parameter(Mandatory=$true)][string]$ConfigFile,
  [Parameter(Mandatory=$true)][string]$Member,
  [Parameter(Mandatory=$true)][string]$ResultFile,
  [string]$Mode = 'login'
)
$ErrorActionPreference = 'Stop'
$teamRoot = Split-Path -Parent $PSScriptRoot
$teamNode = (Get-Command node -ErrorAction Stop).Source
& $teamNode (Join-Path $teamRoot 'src\login-terminal.js') $ConfigFile $Member $ResultFile $Mode
Write-Host 'Login window finished. Return to AI Team and click Check connection.'
Read-Host 'Press Enter to close'
