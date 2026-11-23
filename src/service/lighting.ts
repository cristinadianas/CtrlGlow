/**
 * LightingService: owns the OpenRGB connection, maps OpenRGB zones to user-facing "lights",
 * renders effects every frame and streams the result to the hardware.
 */
import { EventEmitter } from 'node:events'
import { OpenRGBClient } from './openrgb/client.ts'
import { DeviceType, isResizable, type Controller, type RGB, type Zone } from './openrgb/types.ts'
import { WHITE_GROUPS, calibrationGains, driveLed, sanitizeCalibration, whiteGroupFor, type Gains } from '../shared/calibration.ts'
import { EFFECT_BY_ID, isStaticScene, renderScene, renderStill, type LedSegment } from '../shared/effects.ts'
import { BUILT_IN_PRESETS } from '../shared/presets.ts'
import type {
  AppState, ConnectionState, FrameMap, LightInfo, LightKind, Prefs, Preset, Scene, SceneTarget, WhiteGroup
} from '../shared/types.ts'
import type { Store } from './store.ts'

const FADE_MS = 380
const KEEPALIVE_MS = 15_000
const IDENTIFY_MS = 2800
const PREVIEW_INTERVAL_MS = 33
const WHITE_CHECK_MS = 120_000
/** Perceptual level of the white-balance test white: about half the LEDs' full power. */
const WHITE_CHECK_LEVEL = 188
/**
 * Minimum time between frames for the RAM. OpenRGB writes Kingston FURY sticks over SMBus with a 10 ms pause
 * per register, so rewriting all 24 LEDs takes ~0.4 s; sending more often only keeps the memory bus busy.
 */
const SLOW_DEVICE_MS = 200
/**
 * How often the RAM is nudged back into Direct mode (see rearmSlowDevices). Each nudge briefly shows one color, and
 * with the RAM now still (little bus traffic) dropouts should be rare, so this is a slow safety net.
 */
const REARM_EVERY_MS = 10 * 60_000

/**
 * The RAM doesn't animate: at 2-3 updates a second, per-LED animation looked steppy, and one color through the
 * sticks' built-in Static mode (~15 updates/s) was still a little steppy and showed mid pinks as red (2026-11-18).
 * Animated scenes show a still version of the effect on the RAM instead (renderStill), as the user suggested.
 */
function isStillLight(l: RuntimeLight): boolean {
  return l.cls.kind === 'ram'
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface Classification {
  kind: LightKind
  group: string
  groupName: string
  defaultName: string
  order: number
}

interface RuntimeLight {
  key: string
  cls: Classification
  controllerId: number
  deviceName: string
  zone: Zone
  count: number
  seed: number
  /** How the LEDs are arranged (fan-ring loop + strip run for the shared fan connector). */
  layout: LedSegment[]
  /** Current colors before master brightness (count * 3, sRGB 0..255, as shown in the previews). */
  buf: Float32Array
  /** Snapshot used for crossfades. */
  from: Float32Array | null
  fadeStart: number
}

interface DeviceFrame {
  id: number
  lights: RuntimeLight[]
  /** LED drive levels for the whole device (gamma and white balance applied). */
  bytes: Uint8ClampedArray
  last: Uint8ClampedArray | null
  lastSent: number
  /** Updates are slow and go over the memory bus (RAM): frames are rate-limited. */
  slow: boolean
}

export function lightKey(c: Controller, z: Zone): string {
  return `${c.name}|${z.name}`
}

function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) / 4294967296
}

/**
 * Layout for a light. With `ring`, the first `ring` LEDs are a loop shared by every fan on a
 * mirrored hub, and the rest is a run (the case strip continues after the shared part).
 */
export function layoutFor(count: number, ring?: number): LedSegment[] {
  if (!ring || ring <= 1 || ring >= count) return [{ start: 0, length: count, loop: false }]
  return [
    { start: 0, length: ring, loop: true },
    { start: ring, length: count - ring, loop: false }
  ]
}

function classify(c: Controller, z: Zone): Classification {
  const trailingNumber = /(\d+)\s*$/.exec(z.name)?.[1]
  switch (c.type) {
    case DeviceType.DRAM:
      return { kind: 'ram', group: 'ram', groupName: 'Memory', defaultName: `Stick ${trailingNumber ?? z.index + 1}`, order: 30 + z.index }
    case DeviceType.GPU:
      return { kind: 'gpu', group: 'gpu', groupName: 'Graphics Card', defaultName: 'Graphics Card', order: 20 + z.index }
    case DeviceType.MOTHERBOARD: {
      if (/^(ARGB|D_LED)/i.test(z.name) && isResizable(z)) {
        const n = trailingNumber ?? String(z.index + 1)
        // Connector test (2026-11-18): all fans, the AIO pump and the case strip are on header 1.
        if (n === '1') return { kind: 'fans', group: 'connector-1', groupName: 'Fans & Strip', defaultName: 'Fans, Pump & Light Strip', order: 10 }
        return { kind: 'connector', group: `connector-${n}`, groupName: `Connector ${n}`, defaultName: `ARGB Connector ${n}`, order: 60 + Number(n) }
      }
      if (z.name === 'LED_C') return { kind: 'connector', group: 'connector-12v', groupName: '12V Connector', defaultName: '12V RGB Connector', order: 70 }
      const friendly: Record<string, string> = { 'I/O Cover': 'I/O Cover', 'Chipset Accent': 'Chipset' }
      return { kind: 'board', group: 'board', groupName: 'Motherboard', defaultName: friendly[z.name] ?? z.displayName, order: 40 + z.index }
    }
    default:
      return { kind: 'other', group: `device-${c.name}`, groupName: c.displayName || c.name, defaultName: z.displayName || c.name, order: 80 + z.index }
  }
}

const HEX = /^#[0-9a-f]{6}$/i

export function sanitizeScene(input: Scene): Scene {
  const effect = EFFECT_BY_ID[input?.effect] ? input.effect : 'static'
  const colors = Array.isArray(input?.colors) ? input.colors.filter((c) => typeof c === 'string' && HEX.test(c)).slice(0, 4) : []
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : d)
  const meta = EFFECT_BY_ID[effect]
  const useDefaults = !colors.length && meta.colors.max > 0
  const background = typeof input?.background === 'string' && HEX.test(input.background)
    ? input.background
    : useDefaults ? meta.background : undefined
  return {
    effect,
    colors: useDefaults ? [...meta.colors.defaults] : colors,
    speed: num(input?.speed, 45),
    reverse: !!input?.reverse,
    level: num(input?.level, 100),
    ...(background ? { background } : {}),
    ...(input?.bands === true ? { bands: true } : {})
  }
}

export class LightingService extends EventEmitter<{ state: [AppState]; frame: [FrameMap]; log: [string] }> {
  private readonly client = new OpenRGBClient({ name: 'Lumen' })
  private readonly store: Store
  private connection: ConnectionState = 'connecting'
  private lights: RuntimeLight[] = []
  private devices: DeviceFrame[] = []
  private lastInfos: LightInfo[] = []

  private readonly t0 = performance.now()
  private lastTick = performance.now()
  private timer?: NodeJS.Timeout
  private master = 0
  private previewOn = false
  private lastPreview = 0
  private identifyKeys = new Set<string>()
  private identifyUntil = 0
  private scratchBuf = new Float32Array(0)

  private stopped = false
  private reconnectTimer?: NodeJS.Timeout
  private reconnectDelay = 1000
  private syncing = false
  private syncQueued = false
  private resyncTimer?: NodeJS.Timeout
  private stateTimer?: NodeJS.Timeout
  private readonly customModeAt = new Map<number, number>()
  private ctrls = new Map<number, Controller>()

  /** Devices whose frames are held back while their mode is being re-synced. */
  private readonly paused = new Set<number>()
  /** Devices whose next frame is sent with every lit value nudged by 1, to defeat OpenRGB's write cache. */
  private readonly flipNext = new Set<number>()
  private rearmBusy = false
  private rearmTimer?: NodeJS.Timeout
  private rearmInterval?: NodeJS.Timeout
  /** When Lumen last changed a controller's mode, to ignore OpenRGB's echo of it. */
  private readonly ownModeAt = new Map<number, number>()

  private whiteUntil = 0
  private whiteTimer?: NodeJS.Timeout
  /** Calibration gains per kind of hardware (from prefs.calibration). */
  private gains: Record<WhiteGroup, Gains>

  constructor(store: Store) {
    super()
    this.store = store
    this.gains = gainsFor(store.data.prefs.calibration)
    this.client.on('disconnected', () => {
      this.setConnection('offline')
      this.devices = []
      this.scheduleReconnect(1000)
    })
    this.client.on('deviceListUpdated', () => this.requestSync())
    // Mode/zone changes made by someone else; sync is idempotent. Echoes of Lumen's own mode changes are ignored.
    this.client.on('controllerChanged', (id) => {
      if (Date.now() - (this.ownModeAt.get(id) ?? 0) < 3000) return
      this.requestSync()
    })
  }

  start(): void {
    this.stopped = false
    void this.connect()
    this.tick()
    this.rearmInterval = setInterval(() => this.scheduleRearm(0, 'routine'), REARM_EVERY_MS)
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.resyncTimer)
    clearTimeout(this.rearmTimer)
    clearTimeout(this.whiteTimer)
    clearInterval(this.rearmInterval)
    this.client.disconnect()
  }

  /* ------------------------------------------------------------------ */
  /* Connection & device sync                                           */
  /* ------------------------------------------------------------------ */

  private async connect(): Promise<void> {
    if (this.stopped) return
    clearTimeout(this.reconnectTimer)
    this.setConnection('connecting')
    try {
      await this.client.connect()
      this.reconnectDelay = 1000
      await this.sync()
      this.setConnection('connected')
      this.scheduleRearm(1500, 'connected')
    } catch {
      this.client.disconnect()
      this.setConnection('offline')
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(delay = this.reconnectDelay): void {
    if (this.stopped) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => void this.connect(), delay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000)
  }

  reconnect(): void {
    this.client.disconnect()
    this.reconnectDelay = 1000
    void this.connect()
  }

  /** After sleep/resume devices may have reset: resend everything. */
  refreshHardware(): void {
    for (const d of this.devices) d.last = null
    this.requestSync()
    this.scheduleRearm(2000, 'refresh')
  }

  private scheduleRearm(delay: number, reason: string): void {
    clearTimeout(this.rearmTimer)
    this.rearmTimer = setTimeout(() => {
      const withBoard = reason !== 'routine'
      this.rearmSlowDevices(withBoard)
        .then((n) => {
          if (n && withBoard) this.emit('log', `Re-synced memory and motherboard lighting (${reason}).`)
        })
        .catch((err: unknown) => this.emit('log', `Lighting re-sync failed (${reason}): ${String(err)}`))
    }, delay)
  }

  /**
   * Kingston FURY RAM can drop out of Direct mode on its own: on 2026-11-18 both sticks went dark (registers
   * reset, i.e. Static mode in black) while OpenRGB, which caches every register it writes, still believed
   * they showed our colors and so never sent them again. Switching to the sticks' built-in Static mode (in their
   * average color) and back to Direct, then rewriting every LED, brings them back. Runs after connecting, after
   * sleep, and every 10 minutes. Nothing is saved to the sticks.
   *
   * `withBoard` (on connect, reconnect and after sleep, not on the 10-minute routine) does the same for the
   * motherboard's lighting controller. On 2026-11-19 Gigabyte Control Center, starting with Windows, left its fan
   * header in a state where every color update flashed the fans and strip, while OpenRGB still reported Direct
   * mode; the same round trip fixed it. The board's Static step is BLACK: the board keeps that color as its own
   * built-in lighting and shows it on standby power while the PC is off. A colored Static left the chipset light
   * glowing white after shutdown (2026-11-19).
   */
  private async rearmSlowDevices(withBoard = false): Promise<number> {
    if (this.rearmBusy || !this.client.connected) return 0
    this.rearmBusy = true
    let done = 0
    try {
      for (const c of this.ctrls.values()) {
        if (c.type !== DeviceType.DRAM && !(withBoard && c.type === DeviceType.MOTHERBOARD)) continue
        this.paused.add(c.id)
        try {
          const color = c.type === DeviceType.MOTHERBOARD ? { r: 0, g: 0, b: 0 } : this.averageOutput(c.id)
          if (!(await this.setStaticMode(c, color))) continue
          await sleep(400)
          await this.setDirectMode(c)
          this.flipNext.add(c.id)
          await sleep(250)
          done++
        } finally {
          this.paused.delete(c.id)
        }
      }
    } finally {
      this.rearmBusy = false
      this.kick()
    }
    return done
  }

  /**
   * A device's built-in Static mode in one color. Its brightness is one step below Direct's so that every switch
   * between the two modes makes OpenRGB rewrite the RAM's brightness register (see rearmSlowDevices).
   */
  private async setStaticMode(c: Controller, color: RGB): Promise<boolean> {
    const fixed = c.modes.find((m) => /^static$/i.test(m.name))
    if (!fixed) return false
    this.ownModeAt.set(c.id, Date.now())
    await this.client.updateMode(c.id, {
      ...fixed,
      brightness: Math.max(fixed.brightnessMin, fixed.brightnessMax - 1),
      ...(fixed.colorsMax > 0 ? { colors: Array.from({ length: Math.max(1, fixed.colorsMin) }, () => color) } : {})
    })
    return true
  }

  /** Per-LED Direct mode at full hardware brightness (Lumen dims in software, like every other light). */
  private async setDirectMode(c: Controller): Promise<boolean> {
    const direct = c.modes.find((m) => /^direct$/i.test(m.name))
    if (!direct) return false
    this.ownModeAt.set(c.id, Date.now())
    await this.client.updateMode(c.id, { ...direct, brightness: direct.brightnessMax })
    return true
  }

  private averageOutput(id: number): RGB {
    const d = this.devices.find((x) => x.id === id)
    const n = d ? d.bytes.length / 3 : 0
    if (!d || n === 0) return { r: 0, g: 0, b: 0 }
    let r = 0, g = 0, b = 0
    for (let i = 0; i < d.bytes.length; i += 3) {
      r += d.bytes[i]
      g += d.bytes[i + 1]
      b += d.bytes[i + 2]
    }
    return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n) }
  }

  private requestSync(): void {
    clearTimeout(this.resyncTimer)
    this.resyncTimer = setTimeout(() => void this.sync().catch(() => {}), 400)
  }

  private async sync(): Promise<void> {
    if (!this.client.connected) return
    if (this.syncing) {
      this.syncQueued = true
      return
    }
    this.syncing = true
    try {
      let controllers = await this.client.controllers()

      // Apply the LED counts we want on resizable zones (ARGB headers).
      let resized = false
      for (const c of controllers) {
        for (const z of c.zones) {
          const want = this.store.light(lightKey(c, z)).ledCount
          if (want !== undefined && isResizable(z) && want !== z.ledsCount && want >= z.ledsMin && want <= z.ledsMax) {
            await this.client.resizeZone(c.id, z.index, want)
            resized = true
          }
        }
      }
      if (resized) controllers = await this.client.controllers()

      // Software control needs each device in its Direct/custom mode.
      for (const c of controllers) {
        const active = c.modes[c.activeMode]
        if (active && /direct|custom/i.test(active.name)) continue
        const last = this.customModeAt.get(c.id) ?? 0
        if (Date.now() - last < 3000) continue
        this.customModeAt.set(c.id, Date.now())
        await this.client.setCustomMode(c.id)
      }

      this.rebuild(controllers)
    } finally {
      this.syncing = false
      if (this.syncQueued) {
        this.syncQueued = false
        void this.sync().catch(() => {})
      }
    }
  }

  private rebuild(controllers: Controller[]): void {
    const previous = new Map(this.lights.map((l) => [l.key, l]))
    const lights: RuntimeLight[] = []
    const devices: DeviceFrame[] = []
    this.ctrls = new Map(controllers.map((c) => [c.id, c]))
    for (const c of controllers) {
      const device: DeviceFrame = {
        id: c.id,
        lights: [],
        bytes: new Uint8ClampedArray(c.leds.length * 3),
        last: null,
        lastSent: 0,
        slow: c.type === DeviceType.DRAM
      }
      for (const z of c.zones) {
        const key = lightKey(c, z)
        const old = previous.get(key)
        const light: RuntimeLight = {
          key,
          cls: classify(c, z),
          controllerId: c.id,
          deviceName: c.displayName || c.name,
          zone: z,
          count: z.ledsCount,
          seed: hashString(key),
          layout: layoutFor(z.ledsCount, this.store.light(key).ring),
          buf: old && old.count === z.ledsCount ? old.buf : new Float32Array(z.ledsCount * 3),
          from: null,
          fadeStart: 0
        }
        lights.push(light)
        device.lights.push(light)
      }
      devices.push(device)
    }
    lights.sort((a, b) => a.cls.order - b.cls.order)
    this.lights = lights
    this.devices = devices
    this.emitState()
    this.kick()
  }

  /* ------------------------------------------------------------------ */
  /* Rendering                                                          */
  /* ------------------------------------------------------------------ */

  private isHidden(l: RuntimeLight): boolean {
    return !!this.store.light(l.key).hidden
  }

  private sceneFor(l: RuntimeLight): Scene {
    return this.store.light(l.key).scene ?? this.store.data.scene
  }

  private kick(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(this.tick, 0)
  }

  private beginFade(lights: RuntimeLight[]): void {
    const now = performance.now()
    for (const l of lights) {
      if (isStillLight(l)) continue // a fade would only show as two or three steps on the RAM: change at once
      l.from = l.buf.slice()
      l.fadeStart = now
    }
  }

  private scratch(n: number): Float32Array {
    if (this.scratchBuf.length < n) this.scratchBuf = new Float32Array(n)
    return this.scratchBuf.subarray(0, n)
  }

  private readonly tick = (): void => {
    clearTimeout(this.timer)
    const now = performance.now()
    const dt = Math.min(0.25, (now - this.lastTick) / 1000)
    this.lastTick = now
    const t = (now - this.t0) / 1000
    const data = this.store.data
    let animating = false

    // Master brightness eases toward its target (smooth power on/off and dimming). It scales the sRGB
    // values, so the slider is perceptually even; driveLed() turns the result into LED power.
    const target = data.power ? data.brightness / 100 : 0
    this.master += (target - this.master) * (1 - Math.exp(-dt / 0.09))
    if (Math.abs(target - this.master) < 0.002) this.master = target
    else animating = true

    const identifying = now < this.identifyUntil
    const whiteCheck = now < this.whiteUntil
    const visible = this.lights.filter((l) => !this.isHidden(l) && l.count > 0)
    const phaseOf = (l: RuntimeLight): number => (visible.length > 1 ? visible.indexOf(l) / visible.length : 0)

    for (const l of this.lights) {
      if (l.count === 0) continue
      const out = this.scratch(l.count * 3)
      if (this.isHidden(l)) {
        out.fill(0)
      } else if (whiteCheck) {
        out.fill(WHITE_CHECK_LEVEL)
      } else {
        const scene = this.sceneFor(l)
        const ctx = { count: l.count, phase: phaseOf(l), seed: l.seed, layout: l.layout }
        if (isStillLight(l)) {
          renderStill(scene, ctx, out) // the RAM can't animate smoothly; see isStillLight
        } else {
          renderScene(scene, { ...ctx, t }, out)
          if (!isStaticScene(scene)) animating = true
        }
      }
      if (identifying) {
        animating = true
        if (this.identifyKeys.has(l.key)) {
          const p = (now - (this.identifyUntil - IDENTIFY_MS)) / 1000
          out.fill(255 * (0.1 + 0.9 * (0.5 + 0.5 * Math.cos(p * Math.PI * 2 * 1.4))))
        } else {
          for (let i = 0; i < out.length; i++) out[i] *= 0.1
        }
      }
      if (l.from) {
        const a = (now - l.fadeStart) / FADE_MS
        if (a >= 1 || l.from.length !== out.length) {
          l.from = null
        } else {
          animating = true
          const e = a * a * (3 - 2 * a)
          for (let i = 0; i < out.length; i++) out[i] = l.from[i] + (out[i] - l.from[i]) * e
        }
      }
      l.buf.set(out)
    }

    if (this.client.connected) {
      for (const d of this.devices) {
        if (this.paused.has(d.id)) continue
        d.bytes.fill(0)
        for (const l of d.lights) {
          if (l.count === 0) continue
          // The white check ignores master brightness so every comparison uses the same level.
          const k = whiteCheck ? 1 : identifying && this.identifyKeys.has(l.key) ? Math.max(this.master, 0.6) : this.master
          const gains = this.gains[whiteGroupFor(l.cls.kind)]
          const o = l.zone.startIdx * 3
          for (let i = 0; i < l.count * 3; i += 3) {
            driveLed(l.buf[i] * k, l.buf[i + 1] * k, l.buf[i + 2] * k, gains, d.bytes, o + i)
          }
        }
        const flip = this.flipNext.has(d.id)
        const due = flip || !d.last || now - d.lastSent > KEEPALIVE_MS || !sameBytes(d.bytes, d.last)
        if (due && (flip || !d.slow || now - d.lastSent >= SLOW_DEVICE_MS)) {
          const bytes = Uint8Array.from(d.bytes)
          if (flip) {
            // Nudge every lit value by one step so OpenRGB rewrites each LED register (see rearmSlowDevices).
            // The next frame puts the exact values back.
            for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0) bytes[i] ^= 1
            this.flipNext.delete(d.id)
          }
          this.client.updateLedsPacked(d.id, bytes)
          d.last = flip ? new Uint8ClampedArray(bytes) : d.bytes.slice()
          d.lastSent = now
        }
      }
    }

    if (this.previewOn && now - this.lastPreview >= PREVIEW_INTERVAL_MS) {
      this.lastPreview = now
      this.emit('frame', this.previewFrame())
    }

    if (this.stopped) return
    const frameMs = 1000 / data.prefs.fps
    const delay = animating ? Math.max(4, frameMs - (performance.now() - now)) : 250
    this.timer = setTimeout(this.tick, delay)
  }

  private previewFrame(): FrameMap {
    const frame: FrameMap = {}
    for (const l of this.lights) {
      const n = Math.min(l.count, 256)
      const arr = new Array<number>(n)
      for (let i = 0; i < n; i++) {
        const o = i * 3
        arr[i] = (clampByte(l.buf[o]) << 16) | (clampByte(l.buf[o + 1]) << 8) | clampByte(l.buf[o + 2])
      }
      frame[l.key] = arr
    }
    return frame
  }

  setPreview(on: boolean): void {
    this.previewOn = on
    if (on) this.kick()
  }

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */

  private setConnection(c: ConnectionState): void {
    if (this.connection === c) return
    this.connection = c
    this.emitState()
  }

  private lightInfos(): LightInfo[] {
    if (!this.lights.length) return this.lastInfos.map((l) => ({ ...l, online: false }))
    const infos = this.lights.map((l): LightInfo => {
      const stored = this.store.light(l.key)
      return {
        key: l.key,
        name: stored.name || l.cls.defaultName,
        defaultName: l.cls.defaultName,
        kind: l.cls.kind,
        group: l.cls.group,
        groupName: l.cls.groupName,
        deviceName: l.deviceName,
        zoneName: l.zone.name,
        ledCount: l.count,
        ringLeds: stored.ring,
        resizable: isResizable(l.zone),
        maxLeds: l.zone.ledsMax,
        hidden: !!stored.hidden,
        online: this.connection === 'connected',
        scene: stored.scene ?? null
      }
    })
    this.lastInfos = infos
    return infos
  }

  getState(): AppState {
    const d = this.store.data
    return {
      connection: this.connection,
      serverName: this.client.serverName,
      power: d.power,
      brightness: d.brightness,
      scene: d.scene,
      lights: this.lightInfos(),
      presets: [...BUILT_IN_PRESETS, ...d.presets],
      activePresetId: d.activePresetId,
      prefs: d.prefs,
      whiteCheck: performance.now() < this.whiteUntil
    }
  }

  private emitState(): void {
    clearTimeout(this.stateTimer)
    this.stateTimer = setTimeout(() => this.emit('state', this.getState()), 16)
  }

  /* ------------------------------------------------------------------ */
  /* Actions (called from IPC)                                          */
  /* ------------------------------------------------------------------ */

  setScene(target: SceneTarget, scene: Scene | null): void {
    const data = this.store.data
    if (target.kind === 'all') {
      if (!scene) return
      data.scene = sanitizeScene(scene)
      this.beginFade(this.lights.filter((l) => !this.store.light(l.key).scene))
    } else {
      const keys = new Set(target.keys)
      for (const key of keys) this.store.updateLight(key, { scene: scene ? sanitizeScene(scene) : null })
      this.beginFade(this.lights.filter((l) => keys.has(l.key)))
    }
    data.activePresetId = null
    this.store.save()
    this.emitState()
    this.kick()
  }

  setPower(on: boolean): void {
    this.store.data.power = !!on
    this.store.save()
    this.emitState()
    this.kick()
  }

  setBrightness(value: number): void {
    this.store.data.brightness = Math.max(1, Math.min(100, Math.round(value)))
    this.store.save()
    this.emitState()
    this.kick()
  }

  renameLight(key: string, name: string): void {
    this.store.updateLight(key, { name: String(name).trim().slice(0, 48) || undefined })
    this.emitState()
  }

  setLightHidden(key: string, hidden: boolean): void {
    this.beginFade(this.lights.filter((l) => l.key === key))
    this.store.updateLight(key, { hidden: !!hidden })
    this.emitState()
    this.kick()
  }

  async setLedCount(key: string, count: number): Promise<void> {
    const light = this.lights.find((l) => l.key === key)
    if (!light || !isResizable(light.zone)) return
    const n = Math.max(light.zone.ledsMin, Math.min(light.zone.ledsMax, Math.round(count)))
    this.store.updateLight(key, { ledCount: n })
    await this.client.resizeZone(light.controllerId, light.zone.index, n)
    await this.sync()
  }

  /** LEDs per fan ring on a mirrored connector (0 = no ring, the whole zone is one run). */
  setRingLeds(key: string, ring: number): void {
    const light = this.lights.find((l) => l.key === key)
    if (!light) return
    const n = Math.max(0, Math.min(light.count, Math.round(ring)))
    this.store.updateLight(key, { ring: n || undefined })
    this.beginFade([light])
    light.layout = layoutFor(light.count, n)
    this.emitState()
    this.kick()
  }

  identify(keys: string[]): void {
    this.identifyKeys = new Set(keys)
    this.identifyUntil = performance.now() + IDENTIFY_MS
    this.kick()
  }

  applyPreset(id: string): void {
    const preset = this.allPresets().find((p) => p.id === id)
    if (!preset) return
    const data = this.store.data
    data.scene = sanitizeScene(preset.scene)
    for (const key of new Set([...Object.keys(data.lights), ...this.lights.map((l) => l.key)])) {
      const s = preset.overrides[key]
      data.lights[key] = { ...data.lights[key], scene: s ? sanitizeScene(s) : null }
    }
    data.activePresetId = id
    this.beginFade(this.lights)
    this.store.save()
    this.emitState()
    this.kick()
  }

  savePreset(name: string): void {
    const data = this.store.data
    const overrides: Record<string, Scene> = {}
    for (const [key, l] of Object.entries(data.lights)) if (l.scene) overrides[key] = l.scene
    const preset: Preset = {
      id: `user-${Date.now().toString(36)}`,
      name: String(name).trim().slice(0, 40) || 'My Scene',
      scene: data.scene,
      overrides
    }
    data.presets.push(preset)
    data.activePresetId = preset.id
    this.store.save()
    this.emitState()
  }

  deletePreset(id: string): void {
    const data = this.store.data
    data.presets = data.presets.filter((p) => p.id !== id)
    if (data.activePresetId === id) data.activePresetId = null
    this.store.save()
    this.emitState()
  }

  renamePreset(id: string, name: string): void {
    const p = this.store.data.presets.find((x) => x.id === id)
    if (!p) return
    p.name = String(name).trim().slice(0, 40) || p.name
    this.store.save()
    this.emitState()
  }

  setPrefs(patch: Partial<Prefs>): Prefs {
    const prefs = this.store.data.prefs
    if (typeof patch.launchAtLogin === 'boolean') prefs.launchAtLogin = patch.launchAtLogin
    if (patch.fps === 30 || patch.fps === 60) prefs.fps = patch.fps
    if (patch.calibration && typeof patch.calibration === 'object') {
      const input = patch.calibration as Partial<Record<WhiteGroup, unknown>>
      for (const { id } of WHITE_GROUPS) {
        if (input[id] !== undefined) prefs.calibration[id] = sanitizeCalibration(input[id], prefs.calibration[id])
      }
      this.gains = gainsFor(prefs.calibration)
      this.kick()
    }
    this.store.save()
    this.emitState()
    return prefs
  }

  /** Shows a neutral white on every visible light, for matching the white balance to the case. */
  showWhite(on: boolean): void {
    clearTimeout(this.whiteTimer)
    this.whiteUntil = on ? performance.now() + WHITE_CHECK_MS : 0
    if (on) this.whiteTimer = setTimeout(() => this.showWhite(false), WHITE_CHECK_MS)
    this.beginFade(this.lights)
    this.emitState()
    this.kick()
  }

  allPresets(): Preset[] {
    return [...BUILT_IN_PRESETS, ...this.store.data.presets]
  }
}

function gainsFor(cal: Prefs['calibration']): Record<WhiteGroup, Gains> {
  return { fans: calibrationGains(cal.fans), ram: calibrationGains(cal.ram), gpu: calibrationGains(cal.gpu), board: calibrationGains(cal.board) }
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)
}

function sameBytes(a: Uint8ClampedArray, b: Uint8ClampedArray): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}
