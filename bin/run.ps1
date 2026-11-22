param(
  [ValidateSet('local','hybrid','cloud')][string]$Mode = 'local',
  [ValidateSet('smoke','concurrency-validation','baseline','sustained','spike','stress')][string]$Profile = 'smoke',
  [string]$Types = '1,2,3,4',
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $root

if (Test-Path '.env') {
  Get-Content '.env' | ForEach-Object {
    if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$' -and $Matches[1] -notmatch '^(#|$)') {
      [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"', "'"), 'Process')
    }
  }
}
if (-not $env:FINANCIERO_USER -or -not $env:FINANCIERO_PASSWORD) { throw 'Define FINANCIERO_USER y FINANCIERO_PASSWORD en el entorno o en .env.' }
if ($Mode -ne 'local' -and (-not $env:K6_CLOUD_TOKEN -or -not $env:K6_CLOUD_STACK_ID)) { throw 'La modalidad híbrida o cloud requiere K6_CLOUD_TOKEN y K6_CLOUD_STACK_ID.' }
$typesArray = $Types.Split(',') | ForEach-Object { [int]$_ }
if ($typesArray.Count -eq 0 -or ($typesArray | Where-Object { $_ -notin 1,2,3,4 })) { throw 'Types acepta uno o más valores entre 1,2,3,4.' }
$profilePath = Join-Path $root "profiles/$Profile.json"
$thresholdPath = Join-Path $root $(if ($Profile -eq 'smoke') { 'thresholds/smoke.json' } else { 'thresholds/provisional.json' })
$null = Get-Content -Raw $profilePath | ConvertFrom-Json
$null = Get-Content -Raw $thresholdPath | ConvertFrom-Json
if ($CheckOnly) { Write-Output "Configuración válida: modo=$Mode, perfil=$Profile, tipos=$($typesArray -join ',')"; exit 0 }
$version = (& k6 version 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or $version -notmatch 'v2\.3\.0') { throw 'Se requiere Grafana k6 v2.3.0; la versión configurada para este proyecto.' }
if (-not $env:RUN_ID) { $env:RUN_ID = (Get-Date).ToUniversalTime().ToString('yyMMddHHmm') + ([guid]::NewGuid().ToString('N').Substring(0,6)) }
if ($env:RUN_ID.Length -gt 16 -or $env:RUN_ID -notmatch '^[A-Za-z0-9]+$') { throw 'RUN_ID debe ser alfanumérico y tener como máximo 16 caracteres.' }
$env:EXECUTION_MODE = $Mode
$env:LOAD_PROFILE = $Profile
$env:THRESHOLD_PROFILE = $(if ($Profile -eq 'smoke') { 'smoke' } else { 'provisional' })
$env:VOUCHER_TYPES = $typesArray -join ','
$console = Join-Path $root "results/console-$($env:RUN_ID).log"
$env:K6_CONSOLE_OUTPUT = $console
if ($Mode -eq 'local') { & k6 run 'src/main.js' }
elseif ($Mode -eq 'hybrid') { & k6 cloud run --local-execution 'src/main.js' }
else { & k6 cloud run --env "FINANCIERO_USER=$env:FINANCIERO_USER" --env "FINANCIERO_PASSWORD=$env:FINANCIERO_PASSWORD" --env "FINANCIERO_BASE_URL=$env:FINANCIERO_BASE_URL" --env "RUN_ID=$env:RUN_ID" --env "LOAD_PROFILE=$Profile" --env "THRESHOLD_PROFILE=$($env:THRESHOLD_PROFILE)" --env "VOUCHER_TYPES=$($env:VOUCHER_TYPES)" --env "ENVIRONMENT=$($env:ENVIRONMENT)" --env "EXECUTION_MODE=cloud" 'src/main.js' }
$exitCode = $LASTEXITCODE
if (Test-Path $console) {
  $manifest = Join-Path $root "results/manifest-$($env:RUN_ID).ndjson"
  Get-Content $console | ForEach-Object { if ($_ -match 'MANIFEST (\{.*\})') { $Matches[1] } } | Set-Content -Encoding utf8 $manifest
}
exit $exitCode
