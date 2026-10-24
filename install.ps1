<#
.SYNOPSIS
  dsh-remembers 一键安装（Windows）

.DESCRIPTION
  把 dsh-remembers 插件装进 DSH profile，并启动记忆服务（Python）。
  默认装到 web profile；用 -Profile 指定别的。
  用 -NoService 只装插件不起服务（服务已经手动跑着）。

.PARAMETER Profile
  DSH profile 名（默认 web）

.PARAMETER NoService
  只装插件，不启动记忆服务

.EXAMPLE
  .\install.ps1
  .\install.ps1 -Profile desktop
  .\install.ps1 -NoService

.NOTES
  要求：Node.js >= 22.19，Python >= 3.10（-NoService 时可不装），DSH >= 0.2.x
#>

param(
  [string]$Profile = "web",
  [switch]$NoService
)

$ErrorActionPreference = "Stop"

function Info($msg) { Write-Host "[install] $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "[warn] $msg" -ForegroundColor Yellow }
function Die($msg)  { Write-Host "[error] $msg" -ForegroundColor Red; exit 1 }

# ---------- 路径 ----------
$KitDir     = Split-Path -Parent $MyInvocation.MyCommand.Path
$ServiceDir = Join-Path $KitDir "service"
$DshHome    = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$ProfileDir = Join-Path $DshHome "profiles\$Profile"
$PluginDir  = Join-Path $ProfileDir "node_modules\dsh-remembers"
$DataDir    = Join-Path $DshHome "remembers-data"
$VenvDir    = Join-Path $ServiceDir ".venv-win"

Info "Kit:      $KitDir"
Info "Profile:  $ProfileDir"
Info "Data:     $DataDir"

# ---------- 1. Node 检查 ----------
Info "检查 Node.js"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { Die "没找到 node。先装 Node.js >= 22.19（https://nodejs.org）" }
$nodeVer = (& node -p "process.versions.node")
$parts = $nodeVer.Split(".")
$major = [int]$parts[0]
$minor = [int]$parts[1]
if ($major -lt 22 -or ($major -eq 22 -and $minor -lt 19)) {
  Warn "Node $nodeVer，插件要求 >= 22.19（可能起不来）"
} else {
  Info "Node $nodeVer OK"
}

# ---------- 2. 装插件 ----------
Info "安装插件到 $Profile 的 node_modules"
if (-not (Test-Path $ProfileDir)) {
  Die "profile 目录不存在: $ProfileDir（先跑一次 dsh --profile $Profile 让它创建）"
}
$nmDir = Join-Path $ProfileDir "node_modules"
if (-not (Test-Path $nmDir)) { New-Item -ItemType Directory -Path $nmDir -Force | Out-Null }
if (Test-Path $PluginDir) {
  Info "已有 dsh-remembers，覆盖更新"
  Remove-Item $PluginDir -Recurse -Force
}
New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null
foreach ($f in @("index.mjs", "client.js", "client.mjs", "config.mjs", "cordis.patch.yml", "package.json", "README.md")) {
  $src = Join-Path $KitDir $f
  if (Test-Path $src) { Copy-Item $src $PluginDir -Force }
}
Info "插件文件已复制"

# ---------- 3. 注册插件 ----------
$patchFile = Join-Path $ProfileDir "cordis.patch.yml"
$needInsert = $true
if (Test-Path $patchFile) {
  if ((Get-Content $patchFile -Raw) -match "dsh-remembers") { $needInsert = $false }
}
if ($needInsert) {
  Info "注册插件到 cordis.patch.yml"
  if (-not (Test-Path $patchFile)) {
    "# dsh-remembers`nplugins:`n  - insert:`n      - dsh-remembers`n" | Out-File $patchFile -Encoding utf8
  } else {
    Add-Content $patchFile "`nplugins:`n  - insert:`n      - dsh-remembers`n" -Encoding utf8
  }
  Info "已写入（如果已有 plugins 段，请手动合并）"
} else {
  Info "cordis.patch.yml 已包含 dsh-remembers，跳过"
}

# ---------- 4. 服务端 ----------
if ($NoService) {
  Info "跳过服务端（-NoService）"
} else {
  Info "检查 Python"
  $python = $null
  $pyVer = $null
  foreach ($cand in @("python", "python3", "py")) {
    $p = Get-Command $cand -ErrorAction SilentlyContinue
    if ($p) {
      $ver = (& $p.Source -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null)
      if ($ver -match "^\d+\.\d+$") { $python = $p.Source; $pyVer = $ver; break }
    }
  }
  if (-not $python) {
    Die "没找到真正的 Python（>= 3.10）。去 python.org 装，不要在 Microsoft Store 装占位版"
  }
  Info "Python $pyVer OK"

  Info "准备 venv（$VenvDir）"
  if (-not (Test-Path $VenvDir)) {
    & $python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { Die "venv 创建失败" }
  }
  $venvPy = Join-Path $VenvDir "Scripts\python.exe"
  if (-not (Test-Path $venvPy)) { Die "venv Python 不存在: $venvPy" }

  Info "安装依赖（numpy）"
  & $venvPy -m pip install --quiet --disable-pip-version-check -r (Join-Path $ServiceDir "requirements.txt")

  if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
  Info "数据目录: $DataDir"

  $envFile = Join-Path $ServiceDir ".env.win"
  if (-not (Test-Path $envFile)) {
    $lines = @("CMEM_PORT=8081", "CMEM_HOST=127.0.0.1", "CMEM_DATA_DIR=$DataDir", "CMEM_EXTRACT=1")
    $lines -join "`n" | Out-File $envFile -Encoding utf8
    Info "已生成 $envFile（请填入 CMEM_LLM_KEY）"
  }

  Info "启动记忆服务（后台）"
  $env:CMEM_DATA_DIR = $DataDir
  $proc = Start-Process -FilePath $venvPy -ArgumentList (Join-Path $ServiceDir "server.py") -WorkingDirectory $ServiceDir -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 2
  if ($proc.HasExited) {
    Warn "服务进程已退出（前台跑一遍看报错）"
  } else {
    Info "服务已启动，PID=$($proc.Id)"
    Info "健康检查: http://127.0.0.1:8081/state"
  }

  Info "配置开机自启"
  try {
    $action = New-ScheduledTaskAction -Execute $venvPy -Argument (Join-Path $ServiceDir "server.py") -WorkingDirectory $ServiceDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName "dsh-remembers" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
    Info "任务计划已创建（dsh-remembers，登录时启动）"
  } catch {
    Warn "任务计划创建失败（需要管理员）：$_"
    Info "可以手动把启动命令加到启动项"
  }
}

# ---------- 5. 收尾 ----------
Write-Host ""
Info "===== 完成 ====="
Write-Host ""
Write-Host "接下来要做的：" -ForegroundColor Yellow
Write-Host "  1. 填 LLM key（记忆抽取/日记/想法都要它）"
if (-not $NoService) {
  Write-Host "     $envFile  ->  CMEM_LLM_KEY=sk-xxx"
}
Write-Host "  2. 重启 DSH 让它加载插件"
Write-Host "     dsh --profile $Profile web"
Write-Host "  3. 打开 DSH 设置 -> 记忆服务 -> 填 API Key 和模型"
Write-Host "  4. （可选）B 站：需要 bili-cli + 登录凭据"
Write-Host ""
