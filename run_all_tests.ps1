# dsh-remembers 全部测试入口（Windows / PowerShell）
#
#   .\run_all_tests.ps1
#
# 和 run_all_tests.sh 等价：跑 tests/python/*.py 和 tests/node/*.mjs。
# 不需要网络，也不需要记忆服务在跑。

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$LogDir = Join-Path $Root "_tmp\test-logs"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$Python = $env:PYTHON
if (-not $Python) {
  foreach ($cand in @((Join-Path $Root "service\.venv-win\Scripts\python.exe"), (Join-Path $Root "venv\Scripts\python.exe"), "python3", "python")) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $Python = $cmd.Source; break }
  }
}
if (-not $Python) { Write-Host "找不到 Python" -ForegroundColor Red; exit 1 }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "找不到 node" -ForegroundColor Red; exit 1 }

$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONDONTWRITEBYTECODE = "1"

$pass = 0
$fail = 0
$failed = @()

function Invoke-Suite([string]$Label, [string]$LogName, [string]$Exe, [string]$Script) {
  $log = Join-Path $LogDir "$LogName.log"
  & $Exe $Script *> $log
  if ($LASTEXITCODE -eq 0) {
    Write-Host "  ✅ $Label"
    $script:pass++
  } else {
    Write-Host "  ❌ $Label   (日志: _tmp\test-logs\$LogName.log)"
    Get-Content $log -Tail 8 | ForEach-Object { Write-Host "       $_" }
    $script:fail++
    $script:failed += $Label
  }
}

Write-Host "================================================================"
Write-Host "服务端（Python: $Python）"
Write-Host "================================================================"
foreach ($t in @("test_json_parse", "test_core", "test_gating", "test_transfer", "test_slang", "test_seeds", "test_selfline")) {
  Invoke-Suite $t $t $Python (Join-Path $Root "tests\python\$t.py")
}

Write-Host ""
Write-Host "================================================================"
Write-Host "插件（Node: $(& node -v)）"
Write-Host "================================================================"
foreach ($t in @("test_plugin", "test_client", "tone.test", "test_meme_usage")) {
  Invoke-Suite $t $t "node" (Join-Path $Root "tests\node\$t.mjs")
}

Write-Host ""
Write-Host "================================================================"
Write-Host ("合计：通过 {0}，失败 {1}" -f $pass, $fail)
if ($fail -gt 0) {
  Write-Host ("失败：{0}" -f ($failed -join " ")) -ForegroundColor Red
  exit 1
}
Write-Host "全绿 ✅" -ForegroundColor Green
