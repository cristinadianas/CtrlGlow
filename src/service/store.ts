/** Persistent settings, saved as JSON in the app's user-data folder. */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DEFAULT_CALIBRATION, WHITE_GROUPS, sanitizeCalibration } from '../shared/calibration.ts'
import { DEFAULT_SCENE, sanitizeScene } from '../shared/effects.ts'
import type { Prefs, Preset, Scene } from '../shared/types.ts'

export interface StoredLight {
  name?: string
  hidden?: boolean
  /** Own scene; absent/null = follows All Lights */
  scene?: Scene | null
  /** Desired LED count for resizable zones (e.g. ARGB headers). */
  ledCount?: number
  /**
   * For connectors whose devices share one mirrored signal: the first `ring` LEDs form a loop
   * (every fan ring shows them), the remaining LEDs are a run (the case strip).
   */
  ring?: number
}

export interface StoreData {
  version: 3
  power: boolean
  brightness: number
  scene: Scene
  lights: Record<string, StoredLight>
  presets: Preset[]
  activePresetId: string | null
  prefs: Prefs
}

/**
 * Defaults for this PC, from the connector test and LED layout test on 2026-11-18:
 * every fan (20 LEDs each, 120 and 140 mm), the AIO pump and the case strip (172 LEDs, LED 0 at the top)
 * share motherboard header ARGB_V2_1 through be quiet! hubs; headers 2 and 3 and the 12 V header are empty.
 */
const BOARD = 'X870E AORUS PRO X3D ICE'
const FANS_KEY = `${BOARD}|ARGB_V2_1`
const DEFAULT_LIGHTS: Record<string, StoredLight> = {
  [FANS_KEY]: { ledCount: 172, ring: 20 },
  [`${BOARD}|ARGB_V2_2`]: { ledCount: 0, hidden: true },
  [`${BOARD}|ARGB_V2_3`]: { ledCount: 0, hidden: true },
  [`${BOARD}|LED_C`]: { hidden: true }
}

/**
 * Before v3, Comet and Starlight kept their background as the second color. A two-color scene of theirs is
 * converted; one with more colors came from a palette (kept since 2026-11-18), so it gets no background.
 */
function moveBackground(scene: Scene | null | undefined): void {
  if (!scene || (scene.effect !== 'comet' && scene.effect !== 'twinkle') || scene.background) return
  if (Array.isArray(scene.colors) && scene.colors.length === 2) {
    scene.background = scene.colors[1]
    scene.colors = [scene.colors[0]]
  }
}

function defaults(): StoreData {
  return {
    version: 3,
    power: true,
    brightness: 100,
    scene: { ...DEFAULT_SCENE },
    lights: structuredClone(DEFAULT_LIGHTS),
    presets: [],
    activePresetId: 'amber',
    // Opt-in: Lumen only adds itself to Windows startup when the user turns this on in Settings.
    prefs: { launchAtLogin: false, fps: 60, calibration: structuredClone(DEFAULT_CALIBRATION) }
  }
}

/* ---------------- reading a settings file ---------------- */

type Json = Record<string, unknown>
/** Records the path of a value that was present but invalid (and so was dropped or reset). */
type Note = (path: string) => void

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const isString = (v: unknown): v is string => typeof v === 'string'
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean'
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 10_000

/** A field's value if it's valid; `fallback` (noted) if it's present but invalid; undefined if it's absent. */
function pick<T>(src: Json, key: string, ok: (v: unknown) => v is T, fallback: T | undefined, note: Note): T | undefined {
  if (src[key] === undefined) return undefined
  if (ok(src[key])) return src[key]
  note(key)
  return fallback
}

/** A scene from the file, made valid (noted if that changed it). */
function readScene(v: unknown, note: Note, path: string, base?: Scene): Scene {
  const input = isObject(v) ? { ...base, ...v } : (note(path), { ...base })
  const scene = sanitizeScene(input as unknown as Scene)
  if (isObject(v) && !isDeepStrictEqual(scene, input)) note(path)
  return scene
}

/**
 * A light's stored settings. Present fields replace the defaults as a whole entry (so a ring the user removed
 * doesn't come back), but an invalid field falls back to that light's default.
 */
function readLight(v: unknown, fallback: StoredLight, note: Note): StoredLight | null {
  if (!isObject(v)) {
    note('')
    return null
  }
  const out: StoredLight = {}
  const name = pick(v, 'name', isString, fallback.name, (f) => note(`.${f}`))
  const hidden = pick(v, 'hidden', isBoolean, fallback.hidden, (f) => note(`.${f}`))
  const ledCount = pick(v, 'ledCount', isCount, fallback.ledCount, (f) => note(`.${f}`))
  const ring = pick(v, 'ring', isCount, fallback.ring, (f) => note(`.${f}`))
  if (name !== undefined) out.name = name
  if (hidden !== undefined) out.hidden = hidden
  if (isObject(v.scene)) out.scene = readScene(v.scene, note, '.scene')
  else if (v.scene !== undefined) {
    if (v.scene !== null) note('.scene') // an unreadable own look: the light follows All Lights
    out.scene = null
  }
  if (ledCount !== undefined) out.ledCount = ledCount
  if (ring !== undefined) out.ring = ring
  return out
}

function readPreset(v: unknown, note: Note): Preset | null {
  if (!isObject(v) || !isString(v.id) || !v.id) {
    note('')
    return null
  }
  const overrides: Record<string, Scene> = {}
  if (isObject(v.overrides)) {
    for (const [key, s] of Object.entries(v.overrides)) {
      if (isObject(s)) overrides[key] = readScene(s, note, `.overrides.${key}`)
      else note(`.overrides.${key}`)
    }
  } else if (v.overrides !== undefined) {
    note('.overrides')
  }
  const name = isString(v.name) && v.name.trim() ? v.name : (note('.name'), 'My Scene')
  return { id: v.id, name, scene: readScene(v.scene, note, '.scene'), overrides }
}

/**
 * Settings from a parsed file, never throwing: every value is checked on its own, so one bad entry is reset
 * (and noted) instead of costing the user everything else. Then older versions are migrated.
 */
function readSettings(raw: Json, note: Note): StoreData {
  const data = defaults()
  const from = typeof raw.version === 'number' ? raw.version : 1

  data.power = pick(raw, 'power', isBoolean, data.power, note) ?? data.power
  if (raw.brightness !== undefined) {
    const b = typeof raw.brightness === 'number' && Number.isFinite(raw.brightness)
      ? Math.max(1, Math.min(100, Math.round(raw.brightness)))
      : data.brightness
    if (b !== raw.brightness) note('brightness')
    data.brightness = b
  }
  if (raw.scene !== undefined) data.scene = readScene(raw.scene, note, 'scene', data.scene)

  if (isObject(raw.lights)) {
    for (const [key, v] of Object.entries(raw.lights)) {
      const light = readLight(v, data.lights[key] ?? {}, (f) => note(`lights["${key}"]${f}`))
      if (light) data.lights[key] = light
    }
  } else if (raw.lights !== undefined) {
    note('lights')
  }

  if (Array.isArray(raw.presets)) {
    raw.presets.forEach((p, i) => {
      const preset = readPreset(p, (f) => note(`presets[${i}]${f}`))
      if (preset) data.presets.push(preset)
    })
  } else if (raw.presets !== undefined) {
    note('presets')
  }

  if (raw.activePresetId === null || isString(raw.activePresetId)) data.activePresetId = raw.activePresetId
  else if (raw.activePresetId !== undefined) {
    note('activePresetId')
    data.activePresetId = null
  }

  if (isObject(raw.prefs)) {
    const p = raw.prefs
    // Only an explicit true adds Lumen to Windows startup.
    data.prefs.launchAtLogin = pick(p, 'launchAtLogin', isBoolean, false, (f) => note(`prefs.${f}`)) ?? false
    data.prefs.fps = pick(p, 'fps', (v): v is 30 | 60 => v === 30 || v === 60, 60, (f) => note(`prefs.${f}`)) ?? 60
    const cal = isObject(p.calibration) ? p.calibration : {}
    if (p.calibration !== undefined && !isObject(p.calibration)) note('prefs.calibration')
    for (const { id } of WHITE_GROUPS) {
      data.prefs.calibration[id] = sanitizeCalibration(cal[id], DEFAULT_CALIBRATION[id])
      if (cal[id] !== undefined && !isDeepStrictEqual(data.prefs.calibration[id], cal[id])) note(`prefs.calibration.${id}`)
    }
    // "warmth" and "whiteBalance" were used briefly on 2026-11-18, before calibration existed; they're dropped.
  } else if (raw.prefs !== undefined) {
    note('prefs')
  }

  if (from < 2) {
    // v1 used 256 LEDs on the fan connector and no ring layout; the LED test measured 172 + 20.
    const fans = data.lights[FANS_KEY] ?? {}
    data.lights[FANS_KEY] = { ...fans, ledCount: fans.ledCount === 256 || fans.ledCount === undefined ? 172 : fans.ledCount, ring: fans.ring ?? 20 }
  }
  if (from < 3) {
    moveBackground(data.scene)
    for (const l of Object.values(data.lights)) moveBackground(l.scene)
    for (const p of data.presets) {
      moveBackground(p.scene)
      for (const s of Object.values(p.overrides)) moveBackground(s)
    }
  }
  return data
}

/**
 * How long a failed save waits before it is tried again. On Windows a virus scanner or backup tool can hold the
 * file for a moment, and replacing it then fails.
 */
export const SAVE_RETRY_MS = 1500

export interface StoreOptions {
  /** Told when saving the settings starts failing, and when it works again (Lumen writes it to its log). */
  report?: (message: string) => void
}

export class Store {
  data: StoreData
  /** What was wrong with the settings file when it was loaded, for the log. Empty when it was fine. */
  readonly problems: string[] = []
  private timer?: NodeJS.Timeout
  private readonly file: string
  private readonly report: (message: string) => void
  /** Saving is failing (and being retried). */
  private failing = false

  constructor(file: string, opts: StoreOptions = {}) {
    this.file = file
    this.report = opts.report ?? ((message) => console.error(message))
    const { data, problem } = this.read()
    this.data = data
    if (problem) this.repair(problem)
  }

  private read(): { data: StoreData; problem?: string } {
    if (!existsSync(this.file)) return { data: defaults() }
    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch (err) {
      return { data: defaults(), problem: `it couldn't be read (${err instanceof Error ? err.message : String(err)}), so Lumen started with its defaults` }
    }
    if (!isObject(raw)) return { data: defaults(), problem: "it didn't contain settings, so Lumen started with its defaults" }
    const invalid: string[] = []
    try {
      const data = readSettings(raw, (path) => invalid.push(path))
      return invalid.length ? { data, problem: `these values were invalid and were reset: ${invalid.join(', ')}` } : { data }
    } catch (err) {
      return { data: defaults(), problem: `it couldn't be understood (${String(err)}), so Lumen started with its defaults` }
    }
  }

  /**
   * Keeps a copy of a settings file that had problems, then saves the repaired settings over it, so the next
   * start is clean and the user's original can still be recovered. If no copy can be made, the file is left
   * alone for now.
   */
  private repair(problem: string): void {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = join(dirname(this.file), `${basename(this.file, '.json')}.backup-${stamp}.json`)
    try {
      copyFileSync(this.file, backup)
    } catch (err) {
      this.problems.push(`The settings file has problems (${problem}); a backup couldn't be made (${String(err)}).`)
      return
    }
    this.problems.push(`The settings file was repaired: ${problem}. The original was kept as ${basename(backup)}.`)
    this.flush()
  }

  light(key: string): StoredLight {
    return this.data.lights[key] ?? {}
  }

  updateLight(key: string, patch: Partial<StoredLight>): void {
    this.data.lights[key] = { ...this.light(key), ...patch }
    this.save()
  }

  /** Debounced atomic write. */
  save(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), 400)
  }

  /**
   * Writes the settings now. A failed write is reported once and tried again every SAVE_RETRY_MS until it works,
   * so a change isn't lost because the file was briefly locked. Returns whether it was saved.
   */
  flush(): boolean {
    clearTimeout(this.timer)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      renameSync(tmp, this.file)
    } catch (err) {
      if (!this.failing) this.report(`Couldn't save the settings (${err instanceof Error ? err.message : String(err)}); Lumen will keep trying.`)
      this.failing = true
      this.timer = setTimeout(() => this.flush(), SAVE_RETRY_MS)
      this.timer.unref() // a retry alone never keeps Lumen (or a test run) from exiting
      return false
    }
    if (this.failing) this.report('The settings are saved again.')
    this.failing = false
    return true
  }
}
