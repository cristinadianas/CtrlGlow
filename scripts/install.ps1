# Adds Lumen to the Start menu and starts it. Run via:  npm run setup
# Uses only trusted components: conhost.exe (headless) + node.exe + Microsoft Edge.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = Join-Path $env:ProgramFiles 'nodejs\node.exe' }
if (-not (Test-Path $node)) { throw 'Node.js was not found. Install it with: winget install OpenJS.NodeJS.LTS' }
if (-not (Test-Path (Join-Path $root 'out\renderer\index.html'))) { throw 'The UI is not built yet. Run: npm run build' }

$entry = Join-Path $root 'src\service\index.ts'
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$icon = Join-Path $root 'resources\icon.ico'
$lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Lumen.lnk'

$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = $conhost
$s.Arguments = "--headless `"$node`" `"$entry`" --open"
$s.WorkingDirectory = $root
$s.IconLocation = "$icon,0"
$s.Description = 'Lumen lighting control'
$s.WindowStyle = 7
$s.Save()
Write-Host "Added Start menu shortcut: $lnk"

Start-Process -FilePath $conhost -ArgumentList @('--headless', "`"$node`"", "`"$entry`"", '--open') -WorkingDirectory $root
Write-Host 'Lumen is starting. To have it start when you sign in, turn that on in Lumen > Settings.'
