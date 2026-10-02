# Запуск Windows-кассы на одну проверку (windows-smoke.yml): касса работает
# [Seconds] секунд и должна дойти до экрана входа. Упала — печатаем журнал
# запуска (StartupLog), стек из отладчика cdb и записи журнала Windows.
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$SymbolDirs = '',
  [int]$Seconds = 75
)

$ErrorActionPreference = 'Continue'
$log = Join-Path $env:LOCALAPPDATA 'ZalPOS\startup.log'
$out = Join-Path $env:RUNNER_TEMP "smoke-$Name"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$before = if (Test-Path $log) { (Get-Content $log).Count } else { 0 }
$started = Get-Date

$cdb = 'C:\Program Files (x86)\Windows Kits\10\Debuggers\x64\cdb.exe'
$cdbLog = Join-Path $out 'cdb.txt'
if (Test-Path $cdb) {
  # Под отладчиком: первое-шансовые исключения не трогаем (их ловит сам
  # Firestore), на необработанном — стек всех потоков и разбор.
  $cmd = "sxd av; sxd eh; .symopt+ 0x40; g; .echo ===CRASH===; .lastevent; .ecxr; kn 80; ~*kn 30; !analyze -v; q"
  $env:_NT_SYMBOL_PATH = "$SymbolDirs;srv*$env:RUNNER_TEMP\syms*https://msdl.microsoft.com/download/symbols"
  $p = Start-Process -FilePath $cdb -ArgumentList @('-G', '-lines', '-logo', "`"$cdbLog`"", '-c', "`"$cmd`"", "`"$Exe`"") -PassThru
} else {
  Write-Host "::warning::cdb не найден — запуск без отладчика"
  $p = Start-Process -FilePath $Exe -PassThru
}

$alive = $true
for ($i = 0; $i -lt $Seconds; $i++) {
  Start-Sleep -Seconds 1
  if ($p.HasExited) { $alive = $false; break }
}
$crashed = (Test-Path $cdbLog) -and (Select-String -Path $cdbLog -Pattern '===CRASH===' -Quiet)
if ($crashed) { $alive = $false }
if ($alive) {
  Get-Process -Name 'hookah_pos' -ErrorAction SilentlyContinue | Stop-Process -Force
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
} else {
  Start-Sleep -Seconds 3
}

$lines = if (Test-Path $log) { Get-Content $log | Select-Object -Skip $before } else { @('(журнала нет)') }
$reachedLogin = ($lines -match 'экран входа').Count -gt 0
$ok = $alive -and $reachedLogin

Write-Host "================ $Name — $(if ($ok) { 'OK' } else { 'СБОЙ' }) (жива: $alive, экран входа: $reachedLogin, секунд: $([int]((Get-Date) - $started).TotalSeconds))"
Write-Host '---- журнал запуска (StartupLog)'
$lines | ForEach-Object { Write-Host $_ }
if (Test-Path $cdbLog) {
  Write-Host '---- отладчик (cdb)'
  if ($crashed) { Get-Content $cdbLog | ForEach-Object { Write-Host $_ } }
  else { Get-Content $cdbLog -Tail 15 | ForEach-Object { Write-Host $_ } }
}
Write-Host '---- журнал Windows (Application)'
Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = $started } -ErrorAction SilentlyContinue |
  Where-Object { $_.ProviderName -in @('Application Error', 'Windows Error Reporting', 'Application Hang') } |
  ForEach-Object { Write-Host "$($_.TimeCreated) $($_.ProviderName)`n$($_.Message)`n" }

"$Name=$(if ($ok) { 'ok' } else { 'fail' })" | Out-File -Append -Encoding utf8 (Join-Path $env:RUNNER_TEMP 'smoke-results.txt')
