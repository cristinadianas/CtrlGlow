/** Types shared by the main process (lighting engine) and the renderer (UI). */

export type EffectId =
  | 'static'
  | 'breathing'
  | 'gradient'
  | 'spectrum'
  | 'rainbow'
  | 'wave'
  | 'comet'
  | 'twinkle'
  | 'aurora'
  | 'candle'

export interface Scene {
  effect: EffectId
  /** '#rrggbb' strings; how many are used depends on the effect. */
  colors: string[]
  /** 0 (slowest) .. 100 (fastest) */
  speed: number
  reverse: boolean
  /** Brightness of this scene, 0..100 (applied before the master brightness). */
  level: number
  /**
   * Background for effects that draw over one (Comet, Starlight); unset = dark. Kept apart from `colors`, so a
   * palette's second color never turns into a background when the user tries one of these effects.
   */
  background?: string
  /** Wave only: distinct, even bands of color instead of the original flowing style. */
  bands?: boolean
}

export type LightKind = 'fans' | 'gpu' | 'ram' | 'board' | 'connector' | 'other'

/** One independently controllable lighting zone, as shown in the UI. */
export interface LightInfo {
  /** Stable identifier: `${controllerName}|${zoneName}` */
  key: string
  name: string
  defaultName: string
  kind: LightKind
  group: string
  groupName: string
  deviceName: string
  zoneName: string
  ledCount: number
  /** LEDs per fan ring when several fans mirror one signal (the rest of the zone is a strip). */
  ringLeds?: number
  resizable: boolean
  maxLeds: number
  hidden: boolean
  online: boolean
  /** Own scene; null means it follows "All Lights". */
  scene: Scene | null
}

export interface Preset {
  id: string
  name: string
  scene: Scene
  /** Per-light scenes, keyed by LightInfo.key */
  overrides: Record<string, Scene>
  builtIn?: boolean
}

/** Kinds of hardware that get their own calibration. */
export type WhiteGroup = 'fans' | 'ram' | 'gpu' | 'board'

/** Per-part correction so every kind of hardware shows the same white at the same brightness. */
export interface Calibration {
  /** 0 = the LEDs' own (bluish) white .. 100 = much warmer (less blue). */
  warmth: number
  /** -50 = towards magenta (less green) .. 0 .. +50 = towards green (less red and blue). */
  tint: number
  /** 30..100 (perceptual): trims parts that look brighter than the rest. */
  brightness: number
}

export interface Prefs {
  launchAtLogin: boolean
  fps: 30 | 60
  calibration: Record<WhiteGroup, Calibration>
}

export type ConnectionState = 'connecting' | 'connected' | 'offline'

export interface AppState {
  connection: ConnectionState
  serverName: string
  power: boolean
  brightness: number
  scene: Scene
  lights: LightInfo[]
  presets: Preset[]
  activePresetId: string | null
  prefs: Prefs
  /** Every light temporarily shows a neutral white, for setting the white balance. */
  whiteCheck: boolean
}

/** Live preview: per light key, LED colors packed as 0xRRGGBB. */
export type FrameMap = Record<string, number[]>

export type SceneTarget = { kind: 'all' } | { kind: 'lights'; keys: string[] }

/** API exposed by the preload script as window.lumen */
export interface LumenApi {
  getState(): Promise<AppState>
  setScene(target: SceneTarget, scene: Scene | null): Promise<void>
  setPower(on: boolean): Promise<void>
  setBrightness(value: number): Promise<void>
  renameLight(key: string, name: string): Promise<void>
  setLightHidden(key: string, hidden: boolean): Promise<void>
  setLedCount(key: string, count: number): Promise<void>
  setRingLeds(key: string, ring: number): Promise<void>
  identify(keys: string[]): Promise<void>
  applyPreset(id: string): Promise<void>
  savePreset(name: string): Promise<void>
  deletePreset(id: string): Promise<void>
  renamePreset(id: string, name: string): Promise<void>
  setPrefs(prefs: Partial<Prefs>): Promise<void>
  /** Shows a neutral white on every light (turns itself off after two minutes). */
  showWhite(on: boolean): Promise<void>
  reconnect(): Promise<void>
  /** Stops the background service (lights keep their last colors). */
  quit(): Promise<void>
  onState(cb: (state: AppState) => void): () => void
  onFrame(cb: (frame: FrameMap) => void): () => void
}
