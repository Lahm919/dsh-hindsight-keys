<#
.SYNOPSIS
  卸载 dsh-hindsight-keys：移除挂载行、node_modules 链接与插件目录。

.DESCRIPTION
  默认只卸载插件，不动你的 key 池状态（<HindsightHome>\hindsight-keys.json）
  与 profiles\coding-agent.env —— 需要彻底清理时加 -Purge。

.EXAMPLE
  .\uninstall.ps1

.EXAMPLE
  .\uninstall.ps1 -Purge
#>
[CmdletBinding()]
param(
  [string]$DshHome,
  [string]$Profile = 'web',
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'

function Info($msg) { Write-Host "  $msg" }
function Step($msg) { Write-Host ""; Write-Host "== $msg" -ForegroundColor Cyan }

if (-not $DshHome) {
  if ($env:DSH_HOME) { $DshHome = $env:DSH_HOME }
  else { $DshHome = Join-Path $env:APPDATA 'dsh-desktop\harness' }
}

Write-Host ""
Write-Host "dsh-hindsight-keys 卸载程序" -ForegroundColor White
Info ("DSH_HOME : " + $DshHome)
Info ("profile  : " + $Profile)

$profileDir = Join-Path $DshHome ('profiles\' + $Profile)
if (-not (Test-Path $profileDir)) { throw "找不到 profile 目录：$profileDir" }

# --- 1. patch row ----------------------------------------------------------
Step '移除挂载行 cordis.patch.yml'
$patchPath = Join-Path $profileDir 'cordis.patch.yml'
if (Test-Path $patchPath) {
  $bytes = [System.IO.File]::ReadAllBytes($patchPath)
  $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF)
  $text = [System.IO.File]::ReadAllText($patchPath)
  $new = [regex]::Replace($text, '(?m)^- id: dsh-hindsight-keys\r?\n\s+name: dsh-hindsight-keys\r?\n?', '')
  if ($new -eq $text) {
    Info '没有挂载行，跳过'
  } else {
    Copy-Item $patchPath ($patchPath + '.bak-' + (Get-Date -Format 'yyyyMMddHHmmss')) -Force
    [System.IO.File]::WriteAllText($patchPath, $new, (New-Object System.Text.UTF8Encoding($hasBom)))
    Info '已移除挂载行（原文件已备份）'
  }
} else {
  Info '没有 cordis.patch.yml，跳过'
}

# --- 2. node_modules link --------------------------------------------------
Step '移除 node_modules 链接'
$link = Join-Path $profileDir 'node_modules\dsh-hindsight-keys'
if (Test-Path $link) {
  $item = Get-Item $link -Force
  if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    & cmd.exe /c rmdir "$link" | Out-Null
  } else {
    Remove-Item $link -Recurse -Force
  }
  Info '已移除'
} else {
  Info '没有链接，跳过'
}

# --- 3. plugin dir ---------------------------------------------------------
Step '移除插件目录'
$target = Join-Path $DshHome 'plugins\dsh-hindsight-keys'
if (Test-Path $target) {
  Remove-Item $target -Recurse -Force
  Info ("已删除 " + $target)
} else {
  Info '没有插件目录，跳过'
}

# --- 4. optional purge -----------------------------------------------------
if ($Purge) {
  Step '清理状态文件'
  $state = Join-Path (Join-Path $env:USERPROFILE '.hindsight') 'hindsight-keys.json'
  if (Test-Path $state) { Remove-Item $state -Force; Info ("已删除 " + $state) } else { Info '没有状态文件' }
  Write-Warning '注意：profiles\coding-agent.env 里的受管块未删除。若已由插件写过，请手动还原最近的 .bak-<时间戳> 备份，否则 Hindsight 仍按旧的 key 池运行。'
}

Step '完成'
Write-Host "  重启 DSH Desktop 后插件即不再加载。" -ForegroundColor Gray
