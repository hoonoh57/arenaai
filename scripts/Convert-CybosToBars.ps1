# Convert Drive CYBOS parquet -> data/bars/*.bar (incremental)
# Usage:  .\scripts\Convert-CybosToBars.ps1
#         .\scripts\Convert-CybosToBars.ps1 -Src "G:\My Drive\db\raw\cybos"
#         .\scripts\Convert-CybosToBars.ps1 -SkipMinute -RemoveCsvCache
param(
  [string]$Src = $env:CYBOS_SRC,
  [string]$Dest = "data\bars",
  [switch]$SkipDaily,
  [switch]$SkipMinute,
  [switch]$RemoveCsvCache
)

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

function Find-CybosOrigin {
  param([string]$Given)
  if ($Given -and (Test-Path -LiteralPath $Given)) { return $Given }
  $names = @(
    "G:\My Drive\db\raw\cybos",
    "G:\Google Drive\db\raw\cybos"
  )
  $driveLetter = Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Name -match '^[A-Z]$' }
  foreach ($d in $driveLetter) {
    $root = $d.Root
    foreach ($leaf in @("My Drive", "Google Drive")) {
      $names += (Join-Path $root (Join-Path $leaf "db\raw\cybos"))
    }
    Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue | ForEach-Object {
      $try = Join-Path $_.FullName "db\raw\cybos"
      if (Test-Path -LiteralPath (Join-Path $try "cybos_1d_A")) { $names += $try }
    }
  }
  foreach ($c in $names) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c "cybos_1d_A"))) { return $c }
    if ($c -and (Test-Path -LiteralPath (Join-Path $c "1d"))) { return $c }
  }
  return $null
}

$Src = Find-CybosOrigin $Src
if (-not $Src) {
  Write-Host "Origin parquet not found. Pass -Src or set CYBOS_SRC."
  Write-Host "Example: .\scripts\Convert-CybosToBars.ps1 -Src `"G:\My Drive\db\raw\cybos`""
  exit 1
}

$py = Join-Path $PWD ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) { $py = "python" }

$pyArgs = @("scripts\ingest_cybos.py", "--src", $Src, "--dest", $Dest)
if ($SkipDaily) { $pyArgs += "--skip-daily" }
if ($SkipMinute) { $pyArgs += "--skip-minute" }

Write-Host "origin $Src"
Write-Host "dest   $Dest"
& $py @pyArgs
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($RemoveCsvCache) {
  if (Test-Path "data\cybos") {
    Write-Host "remove parquet cache data\cybos"
    Remove-Item -Recurse -Force "data\cybos"
  }
  foreach ($dir in @((Join-Path $Dest "D"), (Join-Path $Dest "1"))) {
    if (Test-Path $dir) {
      Get-ChildItem $dir -Filter *.csv -ErrorAction SilentlyContinue | Remove-Item -Force
      Write-Host "removed csv in $dir"
    }
  }
}

Write-Host "done."
