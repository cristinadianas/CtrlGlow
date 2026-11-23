/**
 * Lumen background service.
 *
 *   node src/service/index.ts            start (does nothing if Lumen is already running)
 *   node src/service/index.ts --open     start if needed, then open the Lumen window
 *   --no-tray                            don't show the tray icon
 *   --exit-after=<seconds>               stop automatically (for test runs)
 *
 * Normally launched windowless via shortcuts: conhost.exe --headless node.exe src/service/index.ts
 */
import type { ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { LightingService } from './lighting.ts'
import { APP_URL, PORT, isLumenRunning, startServer, type Actions, type LumenServer } from './server.ts'
import { Store } from './store.ts'
import { openAppWindow, setLaunchAtLogin, startTray, startupShortcutPath } from './windows.ts'
import type { Prefs, Scene, SceneTarget } from '../shared/types.ts'

const args = new Set(process.argv.slice(2))
const projectRoot = resolve(import.meta.dirname, '..', '..')
const entry = join(projectRoot, 'src', 'service', 'index.ts')
const uiRoot = join(projectRoot, 'out', 'renderer')
const appIcon = join(projectRoot, 'resources', 'icon.ico')
const trayIcon = join(projectRoot, 'resources', 'tray.ico')
const trayScript = join(projectRoot, 'src', 'service', 'tray.ps1')
const dataDir = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Lumen')
const logFile = join(dataDir, 'lumen.log')

mkdirSync(dataDir, { recursive: true })
try {
  if (existsSync(logFile) && statSync(logFile).size > 1_000_000) writeFileSync(logFile, '')
} catch { /* ignore */ }

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try {
    appendFileSync(logFile, line)
  } catch { /* ignore */ }
  if (process.stdout.isTTY) process.stdout.write(line)
}

// Single instance: if Lumen already runs, just bring up its window when asked.
if (await isLumenRunning()) {
  if (args.has('--open')) openAppWindow(APP_URL)
  process.exit(0)
}

if (!existsSync(join(uiRoot, 'index.html'))) log('UI not built yet; run "npm run build". The lighting engine still runs.')

const store = new Store(join(dataDir, 'settings.json'))
const lighting = new LightingService(store)
let server: LumenServer | null = null
let tray: ChildProcess | null = null
let shuttingDown = false

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  log('Shutting down (lights keep their current colors).')
  lighting.stop()
  store.flush()
  try {
    tray?.kill()
  } catch { /* ignore */ }
  await server?.close()
  process.exit(code)
}

function syncLaunchAtLogin(prefs: Prefs): void {
  const has = existsSync(startupShortcutPath())
  if (prefs.launchAtLogin !== has) {
    const ok = setLaunchAtLogin(prefs.launchAtLogin, entry, projectRoot, appIcon)
    log(`${prefs.launchAtLogin ? 'Added' : 'Removed'} sign-in shortcut: ${ok ? 'ok' : 'FAILED'}`)
  }
}

function isTarget(t: unknown): t is SceneTarget {
  if (!t || typeof t !== 'object') return false
  const o = t as { kind?: unknown; keys?: unknown }
  return o.kind === 'all' || (o.kind === 'lights' && Array.isArray(o.keys) && o.keys.every((k) => typeof k === 'string'))
}

const str = (v: unknown): string => String(v ?? '')

const actions: Actions = {
  getState: () => lighting.getState(),
  setScene: (target, scene) => {
    if (isTarget(target)) lighting.setScene(target, (scene ?? null) as Scene | null)
  },
  setPower: (on) => lighting.setPower(on === true),
  setBrightness: (v) => lighting.setBrightness(Number(v)),
  renameLight: (key, name) => lighting.renameLight(str(key), str(name)),
  setLightHidden: (key, hidden) => lighting.setLightHidden(str(key), hidden === true),
  setLedCount: (key, n) => lighting.setLedCount(str(key), Number(n)),
  setRingLeds: (key, n) => lighting.setRingLeds(str(key), Number(n)),
  identify: (keys) => lighting.identify(Array.isArray(keys) ? keys.map(str) : []),
  applyPreset: (id) => lighting.applyPreset(str(id)),
  savePreset: (name) => lighting.savePreset(str(name)),
  deletePreset: (id) => lighting.deletePreset(str(id)),
  renamePreset: (id, name) => lighting.renamePreset(str(id), str(name)),
  setPrefs: (patch) => syncLaunchAtLogin(lighting.setPrefs((patch ?? {}) as Partial<Prefs>)),
  showWhite: (on) => lighting.showWhite(on === true),
  reconnect: () => lighting.reconnect(),
  openWindow: () => openAppWindow(APP_URL),
  quit: () => {
    setTimeout(() => void shutdown(0), 150)
  }
}

try {
  server = await startServer({
    uiRoot,
    actions,
    initialState: () => lighting.getState(),
    onClientsChanged: (n) => lighting.setPreview(n > 0),
    log
  })
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    // Another instance won the race.
    if (args.has('--open')) openAppWindow(APP_URL)
    process.exit(0)
  }
  log(`Could not start the UI server on port ${PORT}: ${String(err)}`)
  process.exit(1)
}

lighting.on('state', (s) => server?.broadcast('state', s))
lighting.on('frame', (f) => server?.broadcast('frame', f))
lighting.on('log', log)
lighting.start()
log(`Lumen running on ${APP_URL} (pid ${process.pid})`)

const exitAfter = Number([...args].find((a) => a.startsWith('--exit-after='))?.split('=')[1])
if (exitAfter > 0) {
  log(`Test run: stopping automatically in ${exitAfter}s.`)
  setTimeout(() => void shutdown(0), exitAfter * 1000)
} else {
  syncLaunchAtLogin(store.data.prefs)
}
if (!args.has('--no-tray') && existsSync(trayScript)) tray = startTray(trayScript, trayIcon, PORT)
if (args.has('--open')) openAppWindow(APP_URL)

// Detect sleep/resume (the clock jumps) and re-send everything, as devices may have reset.
let lastTick = Date.now()
setInterval(() => {
  const now = Date.now()
  if (now - lastTick > 30_000) {
    log('Resumed from sleep; refreshing lighting.')
    lighting.refreshHardware()
  }
  lastTick = now
}, 5_000)

process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))
process.on('unhandledRejection', (err) => log(`Unhandled rejection: ${err instanceof Error ? err.stack : String(err)}`))
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err.stack ?? String(err)}`)
  void shutdown(1)
})
