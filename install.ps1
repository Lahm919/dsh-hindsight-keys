<#
.SYNOPSIS
  把 dsh-hindsight-keys 插件安装到 DSH Desktop 的 harness 里。

.DESCRIPTION
  做三件事（都可重复执行 / 幂等）：
    1. 把插件文件复制到  <DSH_HOME>\plugins\dsh-hindsight-keys
    2. 在          <DSH_HOME>\profiles\<profile>\node_modules 里建立 junction
    3. 在          <DSH_HOME>\profiles\<profile>\cordis.patch.yml 末尾追加挂载行
  改完需要重启 DSH Desktop 才会装载（新增 patch 行不会热挂载）。

  可选参数会把本机差异写进插件目录的 plugin-config.json：
    -HindsightProfile / -Model / -BaseUrl / -EmbedSpec / -EmbedPython

.EXAMPLE
  .\install.ps1

.EXAMPLE
  .\install.ps1 -Profile web -HindsightProfile coding-agent -Force

.EXAMPLE
  # 不用 junction（例如目标盘符不支持 / 需要独立副本）
  .\install.ps1 -Copy
#>
[CmdletBinding()]
param(
  [string]$DshHome,
  [string]$Profile = 'web',
  [string]$HindsightProfile,
  [string]$Model,
  [string]$BaseUrl,
  [string]$EmbedSpec,
  [string]$EmbedPython,
  [switch]$Copy,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Info($msg) { Write-Host "  $msg" }
function Step($msg) { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }

$src = $PSScriptRoot
$payload = @('index.js', 'client.js', 'panel.html', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'uninstall.ps1')

if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  else { $DshHome = Join-Path $env:APPDATA 'dsh-desktop\harness' }
}

Write-Host ""
Write-Host "dsh-hindsight-keys 安装程序" -ForegroundColor White
Info ("源目录   : " + $src)
Info ("DSH_HOME : " + $DshHome)
Info ("profile  : " + $Profile)

if (-not (Test-Path (Join-Path $DshHome 'profiles'))) {
  throw "这里不像 DSH harness 目录（缺 profiles\）：$DshHome`n用 -DshHome 指定，例如 -DshHome `"$env:APPDATA\dsh-desktop\harness`""
}
$profileDir = Join-Path $DshHome ('profiles\' + $Profile)
if (-not (Test-Path $profileDir)) {
  throw "找不到 profile 目录：$profileDir`n现有 profile：" + ((Get-ChildItem (Join-Path $DshHome 'profiles') -Directory | Select-Object -ExpandProperty Name) -join ', ')
}

# --- 1. copy payload -------------------------------------------------------
Step '复制插件文件'
$target = Join-Path $DshHome 'plugins\dsh-hindsight-keys'
New-Item -ItemType Directory -Path $target -Force | Out-Null
foreach ($f in $payload) {
  $from = Join-Path $src $f
  if (-not (Test-Path $from)) { throw "安装包不完整，缺少 $f" }
  Copy-Item $from (Join-Path $target $f) -Force
}
Info ("已写入 " + $target)

# optional per-install overrides
$cfg = @{}
if ($HindsightProfile) { $cfg.profile = $HindsightProfile }
if ($Model) { $cfg.model = $Model }
if ($BaseUrl) { $cfg.baseUrl = $BaseUrl }
if ($EmbedSpec) { $cfg.embedSpec = $EmbedSpec }
if ($EmbedPython) { $cfg.embedPython = $EmbedPython }
$cfgPath = Join-Path $target 'plugin-config.json'
if ($cfg.Count -gt 0) {
  ($cfg | ConvertTo-Json) | Set-Content -Path $cfgPath -Encoding UTF8
  Info ("已写入本机配置 " + $cfgPath + "：" + ($cfg.Keys -join ', '))
} elseif (Test-Path $cfgPath) {
  if ($Force) { Remove-Item $cfgPath -Force; Info '已删除旧的 plugin-config.json' }
  else { Info '保留已有的 plugin-config.json（要重写请加 -Force）' }
}

# --- 2. node_modules link --------------------------------------------------
Step '挂到 profile 的 node_modules'
$linkRoot = Join-Path $profileDir 'node_modules'
New-Item -ItemType Directory -Path $linkRoot -Force | Out-Null
$link = Join-Path $linkRoot 'dsh-hindsight-keys'
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    # rmdir 只删链接本身，不会跟进目标目录
    & cmd.exe /c rmdir "$link" | Out-Null
  } else {
    Remove-Item $link -Recurse -Force
  }
}
if ($Copy) {
  Copy-Item $target $link -Recurse -Force
  Info '已复制（-Copy 模式，不会跟随源码更新）'
} else {
  try {
    New-Item -ItemType Junction -Path $link -Target $target | Out-Null
    Info ("junction: " + $link + " -> " + $target)
  } catch {
    Write-Warning ('建立 junction 失败（' + $_.Exception.Message + '），改为复制一份')
    Copy-Item $target $link -Recurse -Force
    Info '已复制（junction 不可用时的退路）'
  }
}

# --- 3. patch row ----------------------------------------------------------
Step '挂载行 cordis.patch.yml'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
$row = '- id: dsh-hindsight-keys'
$row2 = '  name: dsh-hindsight-keys'
$utf8 = New-Object System.Text.UTF8Encoding($false)
if (Test-Path $patchPath) {
  $bytes = [System.IO.File]::ReadAllBytes($patchPath)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = [System.IO.File]::ReadAllText($patchPath)
  if ($text -match 'dsh-hindsight-keys') {
    Info '挂载行已存在，跳过'
  } else {
    Copy-Item $patchPath ($patchPath + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
    $nl = "`n"
    if ($text -match "`r`n") { $nl = "`r`n" }
    $append = $nl + $row + $nl + $row2 + $nl
    [System.IO.File]::WriteAllText($patchPath, $text + $append, (New-Object System.Text.UTF8Encoding($hasBom)))
    Info '已追加挂载行（原文件已备份为 .bak-<时间戳>）'
  }
} else {
  [System.IO.File]::WriteAllText($patchPath, ($row + "`r`n" + $row2 + "`r`n"), $utf8)
  Info '已新建 cordis.patch.yml（该 profile 之前没有 patch 层）'
}

# --- 4. syntax check -------------------------------------------------------
$nodeCmd = Join-Path $DshHome '.desktop-bin\node.cmd'
if (Test-Path $nodeCmd) {
  Step '语法检查'
  & $nodeCmd --check (Join-Path $target 'index.js')
  if ($LASTEXITCODE -ne 0) { throw 'node --check 失败，安装包里 index.js 可能损坏' }
  & $nodeCmd --check (Join-Path $target 'client.js')
  if ($LASTEXITCODE -ne 0) { throw 'node --check 失败，安装包里 client.js 可能损坏' }
  Info 'index.js / client.js 语法正常'
}

# --- 5. next steps ---------------------------------------------------------
Step '完成'
Write-Host @"
  下一步：重启 DSH Desktop（关闭再打开），然后

      设置 -> 插件 -> Hindsight API Key 池

  也可以直接打开  http://127.0.0.1:<端口>/api/hindsight-keys/panel
  重启后 harness 日志里应出现：
      [hindsight-keys] control panel served at /api/hindsight-keys/panel

  前提（插件只管 key 池，不起服务）：
    * Hindsight daemon  : http://127.0.0.1:9077/health
    * 本地桥            : http://127.0.0.1:8787/health   （key 经它转发到上游）
    * 已装 uv/uvx，能跑  uvx --python 3.12 hindsight-embed daemon --profile coding-agent

  第一次打开面板时会把现有 profiles\coding-agent.env 里的 key 迁进池
  （只读，不会改 env；直到你在面板里点保存）。
"@
