# 安装脚本冒烟测试：完全在临时目录里跑，不碰真实 DSH_DIR。
# 用法： pwsh -File install-smoke.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $PSScriptRoot          # dsh-hindsight-keys/
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('hh-keys-smoke-' + (Get-Date -Format 'yyyyMMddHHmmss'))
$dsh = Join-Path $tmp 'harness'
$web = Join-Path $dsh 'profiles\web'

New-Item -ItemType Directory -Path $web -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $dsh '.desktop-bin') -Force | Out-Null
Copy-Item (Join-Path $env:DSH_HOME '.desktop-bin\node.cmd') (Join-Path $dsh '.desktop-bin\node.cmd') -Force

# 一个“已有别的东西”的 patch 层
@(
  '- id: some-other-plugin',
  '  name: some-other-plugin',
  ''
) -join "`r`n" | Set-Content -Path (Join-Path $web 'cordis.patch.yml') -NoNewline -Encoding UTF8

$fail = 0
function Check($name, $cond, $detail) {
  if ($cond) { Write-Host ("  OK   " + $name) -ForegroundColor Green }
  else { Write-Host ("  FAIL " + $name + "  " + $detail) -ForegroundColor Red; $script:fail++ }
}

Write-Host "`n== 第一次安装"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'install.ps1') -DshHome $dsh -Profile web -HindsightProfile coding-agent -Model deepseek-v4.1-flash -BaseUrl 'http://127.0.0.1:8787/v1'
Check 'install exit 0' ($LASTEXITCODE -eq 0) ("exit=" + $LASTEXITCODE)

$target = Join-Path $dsh 'plugins\dsh-hindsight-keys'
foreach ($f in @('index.js', 'client.js', 'panel.html', 'package.json', 'cordis.patch.yml', 'README.md', 'uninstall.ps1')) {
  Check ("copied " + $f) (Test-Path (Join-Path $target $f)) 'missing'
}

$link = Join-Path $web 'node_modules\dsh-hindsight-keys'
Check 'junction exists' (Test-Path $link) 'missing'
Check 'junction resolves to target' ((Get-Item $link -Force).Target -like "*$target*") ((Get-Item $link -Force).Target)
Check 'junction is reparse point' ([bool]((Get-Item $link -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) 'not a link'
Check 'can read index.js through link' (Test-Path (Join-Path $link 'index.js')) 'nope'

$cfgPath = Join-Path $target 'plugin-config.json'
Check 'plugin-config.json written' (Test-Path $cfgPath) 'missing'
if (Test-Path $cfgPath) {
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  Check 'config.profile' ($cfg.profile -eq 'coding-agent') $cfg.profile
  Check 'config.model' ($cfg.model -eq 'deepseek-v4.1-flash') $cfg.model
}

$patch = [System.IO.File]::ReadAllText((Join-Path $web 'cordis.patch.yml'))
$rows = ([regex]::Matches($patch, 'dsh-hindsight-keys')).Count
Check 'patch row appended once (2 occurrences)' ($rows -eq 2) ("count=" + $rows)
Check 'other plugin row kept' ($patch -match 'some-other-plugin') 'lost'
Check 'patch still CRLF' ($patch -match "`r`n") 'line endings changed'

Write-Host "`n== 第二次安装（幂等）"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'install.ps1') -DshHome $dsh -Profile web
Check 'second install exit 0' ($LASTEXITCODE -eq 0) ("exit=" + $LASTEXITCODE)
$patch2 = [System.IO.File]::ReadAllText((Join-Path $web 'cordis.patch.yml'))
Check 'no duplicate patch row' ((([regex]::Matches($patch2, '- id: dsh-hindsight-keys')).Count) -eq 1) 'duplicated'
$cfg2 = Get-Content $cfgPath -Raw | ConvertFrom-Json
Check 'existing config kept without -Force' ($cfg2.profile -eq 'coding-agent') 'overwritten'

Write-Host "`n== 卸载"
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'uninstall.ps1') -DshHome $dsh -Profile web
Check 'uninstall exit 0' ($LASTEXITCODE -eq 0) ("exit=" + $LASTEXITCODE)
Check 'junction removed' (-not (Test-Path $link)) 'still there'
Check 'plugin dir removed' (-not (Test-Path $target)) 'still there'
$patch3 = [System.IO.File]::ReadAllText((Join-Path $web 'cordis.patch.yml'))
Check 'patch row removed' (-not ($patch3 -match 'dsh-hindsight-keys')) 'still there'
Check 'other plugin row survives uninstall' ($patch3 -match 'some-other-plugin') 'lost'

Write-Host "`n临时目录：$tmp"
if ($fail -eq 0) { Write-Host "全部通过`n" -ForegroundColor Green; exit 0 }
else { Write-Host ("失败 " + $fail + " 项`n") -ForegroundColor Red; exit 1 }
