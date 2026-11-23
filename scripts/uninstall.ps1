# Stops Lumen and removes its shortcuts. Settings stay in %APPDATA%\Lumen (delete that folder to remove them too).
$ErrorActionPreference = 'Continue'
try {
  Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:6743/api/quit' -ContentType 'application/json' -Body '[]' -TimeoutSec 3 | Out-Null
  Write-Host 'Stopped the Lumen service.'
} catch { Write-Host 'Lumen was not running.' }
foreach ($lnk in @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Lumen.lnk'),
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\Lumen.lnk'))) {
  if (Test-Path $lnk) { Remove-Item $lnk; Write-Host "Removed $lnk" }
}
