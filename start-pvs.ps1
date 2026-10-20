param([switch]$Serve)
$ErrorActionPreference = "Stop"
$entry = Join-Path $PSScriptRoot "scripts\start-isolated.mjs"
if ($Serve) { & node $entry --serve } else { & node $entry --check }
exit $LASTEXITCODE
