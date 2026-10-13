# Removes ScreenLoop and everything it stored. Run in PowerShell:  .\uninstall-windows.ps1 [-KeepRecordings]
param([switch]$KeepRecordings)
$id = "com.devcom.screenloop"
if ((Read-Host "Remove ScreenLoop, your sign-in and settings$(if (-not $KeepRecordings) { ', and any UNSENT recordings' })? [y/N]") -ne "y") { exit 1 }
Get-Process ScreenLoop, ffmpeg -ErrorAction SilentlyContinue | Stop-Process -Force
$u = Get-ChildItem "$env:LOCALAPPDATA\ScreenLoop\uninstall.exe" -ErrorAction SilentlyContinue
if ($u) { Start-Process $u.FullName "/S" -Wait }
Remove-Item "$env:LOCALAPPDATA\ScreenLoop" -Recurse -Force -ErrorAction SilentlyContinue
cmdkey /delete:"master-key.$id" 2>$null | Out-Null   # sign-in key
foreach ($d in "$env:APPDATA\$id", "$env:LOCALAPPDATA\$id") {
  if ($KeepRecordings) { Remove-Item "$d\secrets.bin", "$d\shots" -Recurse -Force -ErrorAction SilentlyContinue }
  else { Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue }
}
Write-Host "Done. Reinstall from https://github.com/Dimagithub/screenloop-desktop/releases/latest"
