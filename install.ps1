<#
.SYNOPSIS
  dsh-remembers 一键安装（Windows）

.DESCRIPTION
  装两半：
    1. 插件 —— 交给 install.mjs，优先 `dsh plugin add`，没 dsh 命令就手工登记；
    2. 服务 —— 建 venv、装 numpy、写 service\.env.win、后台启动、注册登录自启。

.PARAMETER Profile
  DSH profile 名（默认 web）

.PARAMETER Port
  服务端口（默认 8080，和插件默认端点一致）

.PARAMETER NoService
  只装插件，不碰 Python 服务

.PARAMETER NoPlugin
  只准备服务

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Profile desktop -Port 8080
  .\install.ps1 -NoService

.NOTES
  要求：Node.js >= 22.19、Python >= 3.10（去 python.org 装，别用 Microsoft Store 的占位版）
#>

param(
  [string]$Profile = "web",
  [int]$Port = 8080,
  [switch]$NoService,
  [switch]$NoPlugin
)

$ErrorActionPreference = "Stop"

function Info($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "[error] $msg" -ForegroundColor Red; exit 1 }

$KitDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServiceDir = Join-Path $KitDir "service"
$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$VenvDir    = Join-Path $ServiceDir ".venv-win"
$EnvFile    = Join-Path $ServiceDir ".env.win"

Info "插件目录: $KitDir"
Info "profile:  $ProfileDir"

# ---------------------------------------------------------------- 1. 插件
if ($NoPlugin) {
  Info "跳过插件安装（-NoPlugin）"
} else {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if (-not $node) { Die "没找到 node。先装 Node.js >= 22.19（https://nodejs.org）" }
  $nodeVer = (& node -p "process.versions.node")
  $parts = $nodeVer.Split(".")
  if (([int]$parts[0] -lt 22) -or ([int]$parts[0] -eq 22 -and [int]$parts[1] -lt 19)) {
    Warn "Node $nodeVer，插件要求 >= 22.19（可能起不来）"
  } else {
    Info "Node $nodeVer OK"
  }
  & node (Join-Path $KitDir "install.mjs") --profile $Profile
  if ($LASTEXITCODE -ne 0) { Die "插件安装失败" }
}

# ---------------------------------------------------------------- 2. 服务
if ($NoService) {
  Info "跳过服务（-NoService）"
} else {
  Info "检查 Python"
  $python = $null
  $pyVer = $null
  foreach ($cand in @("python", "python3", "py")) {
    $p = Get-Command $cand -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $ver = (& $p.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null)
    if ($ver -match "^(3\.(1[0-9]|[2-9][0-9]))$") { $python = $p.Source; $pyVer = $ver; break }
  }
  if (-not $python) {
    Die "没找到真正的 Python >= 3.10。去 python.org 装，不要在 Microsoft Store 装占位版"
  }
  Info "Python $pyVer OK"

  if (-not (Test-Path $VenvDir)) {
    Info "创建 venv: $VenvDir"
    & $python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { Die "venv 创建失败" }
  }
  $venvPy = Join-Path $VenvDir "Scripts\python.exe"
  if (-not (Test-Path $venvPy)) { Die "venv Python 不存在: $venvPy" }

  Info "安装依赖（只有 numpy）"
  & $venvPy -m pip install --quiet --disable-pip-version-check -r (Join-Path $ServiceDir "requirements.txt")
  if ($LASTEXITCODE -ne 0) { Die "pip 安装失败" }

  if (-not (Test-Path $EnvFile)) {
    $dataDir = Join-Path $ServiceDir "data"
    @"
# dsh-remembers 服务配置（KEY=VALUE，服务启动时读）
CMEM_HOST=127.0.0.1
CMEM_PORT=$Port
CMEM_DATA_DIR=$dataDir
CMEM_EXTRACT=1

# 对话模型（抽取记忆、写日记、挑语料都要它）
CMEM_LLM_BASE=https://api.deepseek.com/v1
CMEM_LLM_MODEL=deepseek-chat
CMEM_LLM_KEY=

# 向量模型（可选；不填就退化成纯 BM25）
CMEM_EMBED_BASE=
CMEM_EMBED_MODEL=
CMEM_EMBED_KEY=
"@ | Out-File $EnvFile -Encoding utf8
    Info "已生成 $EnvFile（填 CMEM_LLM_KEY 才有抽取）"
  } else {
    Info "沿用已有 $EnvFile"
  }

  $server = Join-Path $ServiceDir "server.py"
  $endpoint = "http://127.0.0.1:$Port"
  $healthy = $false
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$endpoint/health"
    $healthy = ($r.StatusCode -eq 200)
  } catch { $healthy = $false }

  if ($healthy) {
    Info "服务已在 $endpoint 运行"
  } else {
    $log = Join-Path $ServiceDir "data\server.log"
    New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
    Info "启动服务（日志: $log）"
    Start-Process -FilePath $venvPy -ArgumentList "`"$server`"" -WorkingDirectory $ServiceDir `
      -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Seconds 1
      try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 "$endpoint/health"
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
      } catch { }
    }
    if ($healthy) { Info "服务已就绪: $endpoint" } else { Warn "服务还没通，看 $log / $log.err" }
  }

  Info "注册登录自启（任务计划 dsh-remembers）"
  try {
    $action = New-ScheduledTaskAction -Execute $venvPy -Argument "`"$server`"" -WorkingDirectory $ServiceDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName "dsh-remembers" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Info "任务计划已创建"
  } catch {
    Warn "任务计划创建失败：$_"
    Info "可以手动把这条命令加进启动项：`"$venvPy`" `"$server`""
  }
}

Write-Host ""
Info "===== 完成 ====="
Write-Host "  1. 填 key：$EnvFile  →  CMEM_LLM_KEY=sk-xxx（改完重启服务或重跑本脚本）"
Write-Host "  2. 重启 DSH 让它加载插件"
Write-Host "  3. 左边栏「插件 → 她的记忆」；「记忆服务」卡片里能改模型、看健康状态"
Write-Host "  4. 可选：B 站 / 贴吧 / QQ 通道需要额外组件，见 docs/features/"
Write-Host ""
