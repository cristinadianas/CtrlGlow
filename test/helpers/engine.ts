/**
 * Starts Lumen's lighting engine against a FakePC, with its settings in a temporary folder, and records what it
 * tells the window (state events) and the log. Nothing here can reach real hardware or the user's settings.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CALIBRATION, calibrationGains, driveLed, whiteGroupFor } from '../../src/shared/calibration.ts'
import { hexToRgb } from '../../src/shared/color.ts'
import type { AppState, LightInfo, LightKind, Scene } from '../../src/shared/types.ts'
import { LightingService } from '../../src/service/lighting.ts'
import { OpenRGBClient } from '../../src/service/openrgb/client.ts'
import { Store } from '../../src/service/store.ts'
import { FakePC } from './fake-pc.ts'
import { eventually } from './wait.ts'

/**
 * The engine's timeout for OpenRGB replies, which is also how long a device may leave its frames unacknowledged
 * before it counts as not responding (5 s in Lumen; shorter here to keep the tests quick).
 */
export const TEST_TIMEOUT_MS = 1000

export interface Engine {
  pc: FakePC
  store: Store
  service: LightingService
  dir: string
  settingsFile: string
  /** Every state the engine sent to the window, oldest first. */
  states: AppState[]
  logs: string[]
  light(key: string): LightInfo
  close(): Promise<void>
}

export interface EngineOptions {
  /** A settings file to start from: a string is written as is, anything else as JSON. */
  settings?: unknown
  /** Sets the All Lights scene before starting (for tests that don't start from a settings file). */
  scene?: Scene
  pc?: FakePC
  /**
   * What to wait for before returning: 'settled' (default) also waits for the re-sync Lumen runs after
   * connecting (the board's and RAM's Static → Direct round trip), so tests start from steady lights.
   */
  until?: 'settled' | 'connected' | 'nothing'
  /** OpenRGB isn't running yet when Lumen starts: the test starts it later with `e.pc.start(e.pc.port)`. */
  openRGBDown?: boolean
  /** How often the memory is re-synced (10 minutes in Lumen). */
  rearmEveryMs?: number
}

export async function startEngine(opts: EngineOptions = {}): Promise<Engine> {
  const dir = mkdtempSync(join(tmpdir(), 'lumen-engine-test-'))
  const settingsFile = join(dir, 'settings.json')
  if (opts.settings !== undefined) {
    writeFileSync(settingsFile, typeof opts.settings === 'string' ? opts.settings : JSON.stringify(opts.settings))
  }
  const store = new Store(settingsFile)
  if (opts.scene) store.data.scene = opts.scene
  const pc = opts.pc ?? new FakePC()
  await pc.start() // before the client, which takes the server's port
  if (opts.openRGBDown) await pc.stop() // the port stays known, with nothing listening on it
  const client = new OpenRGBClient({ port: pc.port, name: 'Lumen (test)', timeoutMs: TEST_TIMEOUT_MS })
  const service = new LightingService(store, client, { rearmEveryMs: opts.rearmEveryMs })
  const states: AppState[] = []
  const logs: string[] = []
  service.on('state', (s) => states.push(s))
  service.on('log', (l) => logs.push(l))

  const engine: Engine = {
    pc, store, service, dir, settingsFile, states, logs,
    light(key) {
      const l = service.getState().lights.find((x) => x.key === key)
      assert.ok(l, `no light ${key} in the window's list`)
      return l
    },
    async close() {
      service.stop()
      store.flush() // clears its pending save, which would otherwise write after the folder is gone
      await pc.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
  const until = opts.until ?? 'settled'
  try {
    service.start()
    if (until !== 'nothing') await eventually(() => service.getState().connection === 'connected')
    if (until === 'settled') await eventually(() => logs.some((l) => l.startsWith('Re-synced memory and motherboard')))
  } catch (err) {
    await engine.close().catch(() => {}) // a running engine would keep the test process alive
    throw err
  }
  return engine
}

/** A Solid scene. */
export const solid = (color: string, extra: Partial<Scene> = {}): Scene =>
  ({ effect: 'static', colors: [color], speed: 45, reverse: false, level: 100, ...extra })

/** The drive levels Lumen sends for an sRGB color on a kind of light, at `level` (0..1) of full brightness. */
export function driven(kind: LightKind, hex: string, level = 1): number[] {
  const [r, g, b] = hexToRgb(hex)
  const out = new Uint8ClampedArray(3)
  driveLed(r * level, g * level, b * level, calibrationGains(DEFAULT_CALIBRATION[whiteGroupFor(kind)]), out, 0)
  return [...out]
}

/** Asserts every LED in `leds` shows `expected` (an [r, g, b] drive level). */
export function assertAll(leds: number[][], expected: number[], what: string): void {
  assert.ok(leds.length > 0, `${what}: no LEDs`)
  leds.forEach((led, i) => assert.deepEqual(led, expected, `${what}: LED ${i}`))
}

/** The board's LEDs by zone (fan header first, then the I/O cover and the chipset light). */
export function boardZones(leds: number[][], fans = 172): { fans: number[][]; ioCover: number[][]; chipset: number[][] } {
  return { fans: leds.slice(0, fans), ioCover: leds.slice(fans, fans + 10), chipset: leds.slice(fans + 10, fans + 14) }
}
