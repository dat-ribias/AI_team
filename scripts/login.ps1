param([Parameter(Mandatory=$true)][ValidateSet('codex-1','codex-2','codex-3')][string]$Agent)
$ErrorActionPreference = 'Stop'
$teamRoot = Split-Path -Parent $PSScriptRoot
$teamConfig = Get-Content -LiteralPath (Join-Path $teamRoot 'team.config.json') -Raw | ConvertFrom-Json
$teamAgent = $teamConfig.agents | Where-Object { $_.id -eq $Agent }
$oldCodexHome = $env:CODEX_HOME
try {
  $env:CODEX_HOME = $teamAgent.home
  Write-Host "Login $Agent. Choose the correct account and workspace in your browser."
  & codex -c 'cli_auth_credentials_store="file"' login
  if ($LASTEXITCODE -ne 0) { throw 'Codex login failed' }
  & codex -c 'cli_auth_credentials_store="file"' login status
} finally {
  if ($null -eq $oldCodexHome) { Remove-Item Env:CODEX_HOME -ErrorAction SilentlyContinue }
  else { $env:CODEX_HOME = $oldCodexHome }
}
