/**
 * Windows integration using only trusted, signed system components
 * (Smart App Control is on, so no unsigned executables):
 *  - the UI opens in a Microsoft Edge "app" window,
 *  - the service runs windowless via conhost.exe --headless + node.exe,
 *  - shortcuts are created with PowerShell's WScript.Shell COM object,
 *  - the tray icon is a small PowerShell/WinForms script.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const programFiles = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[]

export function edgePath(): string | null {
  for (const base of programFiles) {
    const p = join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    if (existsSync(p)) return p
  }
  return null
}

export function openAppWindow(url: string): void {
  const edge = edgePath()
  if (edge) {
    spawn(edge, [`--app=${url}`, '--window-size=1280,860', '--no-first-run'], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('explorer.exe', [url], { detached: true, stdio: 'ignore' }).unref()
  }
}

/** How the service is launched from shortcuts: windowless console host running Node with our entry file. */
export function serviceLaunch(entry: string, extraArgs: string[] = []): { target: string; args: string } {
  const conhost = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'conhost.exe')
  const quoted = [process.execPath, entry, ...extraArgs].map((a) => (a.startsWith('--') ? a : `"${a}"`)).join(' ')
  return { target: conhost, args: `--headless ${quoted}` }
}

const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`

function powershell(script: string): boolean {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 15_000
  })
  return r.status === 0
}

export function createShortcut(opts: { path: string; target: string; args: string; workDir: string; icon: string; description: string }): boolean {
  return powershell([
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut(' + psQuote(opts.path) + ')',
    `$s.TargetPath = ${psQuote(opts.target)}`,
    `$s.Arguments = ${psQuote(opts.args)}`,
    `$s.WorkingDirectory = ${psQuote(opts.workDir)}`,
    `$s.IconLocation = ${psQuote(`${opts.icon},0`)}`,
    `$s.Description = ${psQuote(opts.description)}`,
    '$s.WindowStyle = 7',
    '$s.Save()'
  ].join('; '))
}

export function startupShortcutPath(): string {
  return join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Lumen.lnk')
}

export function startMenuShortcutPath(): string {
  return join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Lumen.lnk')
}

/** Adds/removes the Startup-folder shortcut that starts the service (no window) at sign-in. */
export function setLaunchAtLogin(enabled: boolean, entry: string, workDir: string, icon: string): boolean {
  const lnk = startupShortcutPath()
  if (!enabled) {
    if (existsSync(lnk)) unlinkSync(lnk)
    return true
  }
  const { target, args } = serviceLaunch(entry)
  return createShortcut({ path: lnk, target, args, workDir, icon, description: 'Starts Lumen lighting in the background' })
}

/** Starts the tray icon helper; it exits on its own when the service process goes away. */
export function startTray(script: string, icon: string, port: number): ChildProcess {
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-STA',
    '-File', script, '-Port', String(port), '-IconPath', icon, '-ParentPid', String(process.pid)
  ], { windowsHide: true, stdio: 'ignore' })
  child.unref()
  return child
}
