# Lumen tray icon. Started by the Lumen service; talks to it over http://127.0.0.1:<Port>.
param(
  [int]$Port = 6743,
  [string]$IconPath,
  [int]$ParentPid = 0
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$base = "http://127.0.0.1:$Port/api"

function Invoke-Lumen([string]$Action, [string]$Json = '[]') {
  try { return Invoke-RestMethod -Method Post -Uri "$base/$Action" -ContentType 'application/json' -Body $Json -TimeoutSec 4 }
  catch { return $null }
}

$tray = New-Object System.Windows.Forms.NotifyIcon
if ($IconPath -and (Test-Path $IconPath)) { $tray.Icon = New-Object System.Drawing.Icon($IconPath) }
else { $tray.Icon = [System.Drawing.SystemIcons]::Application }
$tray.Text = 'Lumen'

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$open = $menu.Items.Add('Open Lumen')
$open.Font = New-Object System.Drawing.Font($open.Font, [System.Drawing.FontStyle]::Bold)
$open.add_Click({ Invoke-Lumen 'openWindow' | Out-Null })
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$power = New-Object System.Windows.Forms.ToolStripMenuItem('Lights On')
$power.add_Click({ Invoke-Lumen 'setPower' ("[" + ((-not $power.Checked).ToString().ToLower()) + "]") | Out-Null })
[void]$menu.Items.Add($power)
$scenes = New-Object System.Windows.Forms.ToolStripMenuItem('Scenes')
[void]$menu.Items.Add($scenes)
[void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
$quit = $menu.Items.Add('Quit Lumen')
$quit.add_Click({
  Invoke-Lumen 'quit' | Out-Null
  $tray.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})

$menu.add_Opening({
  $state = Invoke-Lumen 'getState'
  $scenes.DropDownItems.Clear()
  if ($null -eq $state) {
    $power.Enabled = $false
    $scenes.Enabled = $false
    return
  }
  $power.Enabled = $true
  $scenes.Enabled = $true
  $power.Checked = [bool]$state.power
  foreach ($p in $state.presets) {
    $item = New-Object System.Windows.Forms.ToolStripMenuItem($p.name)
    $item.Checked = ($p.id -eq $state.activePresetId)
    $item.Tag = $p.id
    $item.add_Click({ param($sender) Invoke-Lumen 'applyPreset' ('["' + $sender.Tag + '"]') | Out-Null })
    [void]$scenes.DropDownItems.Add($item)
  }
})

$tray.ContextMenuStrip = $menu
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Invoke-Lumen 'openWindow' | Out-Null } })
$tray.Visible = $true

# Leave when the service goes away.
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.add_Tick({
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
  }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
$tray.Dispose()
