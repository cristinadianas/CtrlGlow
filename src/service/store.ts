/** Persistent settings, saved as JSON in the app's user-data folder. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_CALIBRATION, WHITE_GROUPS, sanitizeCalibration } from '../shared/calibration.ts'
import { DEFAULT_SCENE } from '../shared/effects.ts'
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

export class Store {
  data: StoreData
  private timer?: NodeJS.Timeout
  private readonly file: string

  constructor(file: string) {
    this.file = file
    this.data = this.load()
  }

  private load(): StoreData {
    const base = defaults()
    try {
      if (!existsSync(this.file)) return base
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Omit<StoreData, 'version'>> & { version?: number }
      const data: StoreData = {
        ...base,
        ...raw,
        version: 3,
        scene: { ...base.scene, ...(raw.scene ?? {}) },
        lights: { ...base.lights, ...(raw.lights ?? {}) },
        prefs: {
          ...base.prefs,
          ...(raw.prefs ?? {}),
          calibration: Object.fromEntries(WHITE_GROUPS.map(({ id }) =>
            [id, sanitizeCalibration(raw.prefs?.calibration?.[id], DEFAULT_CALIBRATION[id])])) as Prefs['calibration']
        },
        presets: Array.isArray(raw.presets) ? raw.presets : []
      }
      // "warmth" and "whiteBalance" were used briefly on 2026-11-18, before calibration existed.
      const legacy = data.prefs as Partial<Prefs> & { warmth?: unknown; whiteBalance?: unknown }
      delete legacy.warmth
      delete legacy.whiteBalance
      if ((raw.version ?? 1) < 2) {
        // v1 used 256 LEDs on the fan connector and no ring layout; the LED test measured 172 + 20.
        const fans = data.lights[FANS_KEY] ?? {}
        data.lights[FANS_KEY] = { ...fans, ledCount: fans.ledCount === 256 || fans.ledCount === undefined ? 172 : fans.ledCount, ring: fans.ring ?? 20 }
      }
      if ((raw.version ?? 1) < 3) {
        moveBackground(data.scene)
        for (const l of Object.values(data.lights)) moveBackground(l.scene)
        for (const p of data.presets) {
          moveBackground(p.scene)
          for (const s of Object.values(p.overrides ?? {})) moveBackground(s)
        }
      }
      return data
    } catch {
      return base
    }
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

  flush(): void {
    clearTimeout(this.timer)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2))
      renameSync(tmp, this.file)
    } catch (err) {
      console.error('Failed to save settings', err)
    }
  }
}
