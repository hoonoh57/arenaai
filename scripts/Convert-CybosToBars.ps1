# 원본 CYBOS parquet → data/bars/*.bar (없는 파티션만 증분)
# 사용:  .\scripts\Convert-CybosToBars.ps1
#        .\scripts\Convert-CybosToBars.ps1 -SkipMinute
#        .\scripts\Convert-CybosToBars.ps1 -RemoveCsvCache
param(
  [string]$Src = $env:CYBOS_SRC,
  [string]$Dest = "data\bars",
  [switch]$SkipDaily,
  [switch]$SkipMinute,
  [switch]$RemoveCsvCache
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not $Src) {
  foreach ($c in @(
      "G:\내 드라이브\db\raw\cybos",
      "G:\My Drive\db\raw\cybos"
    )) {
    if (Test-Path $c) { $Src = $c; break }
  }
}
if (-not $Src -or -not (Test-Path $Src)) {
  Write-Error "원본 parquet 폴더를 찾지 못했습니다. -Src 또는 CYBOS_SRC 를 지정하세요."
}

$py = Join-Path $PWD ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }

$args = @("scripts\ingest_cybos.py", "--src", $Src, "--dest", $Dest)
if ($SkipDaily) { $args += "--skip-daily" }
if ($SkipMinute) { $args += "--skip-minute" }

Write-Host "origin $Src"
Write-Host "dest   $Dest"
& $py @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($RemoveCsvCache) {
  $csvRoots = @("data\cybos", (Join-Path $Dest "D"), (Join-Path $Dest "1"))
  foreach ($root in @("data\cybos")) {
    if (Test-Path $root) {
      Write-Host "remove parquet cache $root"
      Remove-Item -Recurse -Force $root
    }
  }
  foreach ($dir in @((Join-Path $Dest "D"), (Join-Path $Dest "1"))) {
    if (Test-Path $dir) {
      Get-ChildItem $dir -Filter *.csv -ErrorAction SilentlyContinue | Remove-Item -Force
      Write-Host "removed csv in $dir"
    }
  }
}

Write-Host "done. git pull 후 npm run dev 하면 시작 시 같은 증분이 다시 돕니다."
