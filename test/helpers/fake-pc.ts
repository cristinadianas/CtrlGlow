/**
 * A fake PC behind a fake OpenRGB server, for testing the lighting engine end to end without hardware. It
 * behaves the way OpenRGB's SDK server does (checked against its source, NetworkServer.cpp, on 2026-11-23):
 *
 * - Each device has its own worker. LED updates, mode changes and requests for a device's details are handled
 *   in order, and each is acknowledged only after it has been applied. A device whose worker hangs therefore
 *   stops acknowledging; it never reports an error.
 * - A packet for a device that isn't in the list is acknowledged as OK but does nothing, and a request for its
 *   details gets no reply at all.
 *
 * Tests can hang and resume a device's worker, unplug a device and plug it back in, restart "OpenRGB", and read
 * what each device really shows.
 */
import { PacketId, Reader, readMode } from '../../src/service/openrgb/protocol.ts'
import { DeviceType, ZoneFlag, type RGB } from '../../src/service/openrgb/types.ts'
import { FakeOpenRGB, u32, type Packet, type Reply } from './fake-openrgb.ts'
import { encodeController, mode, type ControllerSpec } from './openrgb-encode.ts'

export const BOARD = 1
export const RAM = 2
export const GPU = 3

const BOARD_NAME = 'X870E AORUS PRO X3D ICE'
const RAM_NAME = 'Kingston Fury DDR5 DRAM'
const GPU_NAME = 'Gigabyte GeForce RTX 5080 Aero OC'

/** Light keys (controller name | zone name), as Lumen stores them. */
export const KEYS = {
  fans: `${BOARD_NAME}|ARGB_V2_1`,
  ioCover: `${BOARD_NAME}|I/O Cover`,
  chipset: `${BOARD_NAME}|Chipset Accent`,
  stick1: `${RAM_NAME}|Fury Slot 1`,
  stick2: `${RAM_NAME}|Fury Slot 2`,
  gpu: `${GPU_NAME}|Side`
} as const

const direct = (): ReturnType<typeof mode> => mode('Direct', { colorMode: 1, brightnessMax: 255, brightness: 255 })
const fixed = (brightnessMax: number): ReturnType<typeof mode> =>
  mode('Static', { colorsMin: 1, colorsMax: 1, colorMode: 2, brightnessMax, brightness: brightnessMax, colors: [{ r: 0, g: 0, b: 0 }] })

/**
 * Devices shaped like this PC: the motherboard (its fan header still at OpenRGB's default of 256 LEDs, the I/O
 * cover and the chipset light), two RAM sticks, and a graphics card that starts in its own Static mode.
 */
export function thisPc(): Map<number, ControllerSpec> {
  return new Map<number, ControllerSpec>([
    [BOARD, {
      type: DeviceType.MOTHERBOARD, name: BOARD_NAME, activeMode: 0, modes: [direct(), fixed(255)],
      zones: [
        { name: 'ARGB_V2_1', ledsMin: 0, ledsMax: 256, ledsCount: 256, flags: ZoneFlag.CONFIGURABLE_SIZE },
        { name: 'I/O Cover', ledsCount: 10 },
        { name: 'Chipset Accent', ledsCount: 4 }
      ]
    }],
    [RAM, {
      type: DeviceType.DRAM, name: RAM_NAME, activeMode: 0, modes: [direct(), fixed(100)],
      zones: [{ name: 'Fury Slot 1', ledsCount: 12 }, { name: 'Fury Slot 2', ledsCount: 12 }]
    }],
    [GPU, {
      type: DeviceType.GPU, name: GPU_NAME, activeMode: 0, modes: [fixed(10), direct()],
      zones: [{ name: 'Side', ledsCount: 1 }]
    }]
  ])
}

export interface ModeChange { devId: number; name: string; colors: RGB[] }

interface Device {
  spec: ControllerSpec
  /** What the LEDs hold (shown in Direct mode). */
  leds: number[][]
  /** Named in OpenRGB's device list. */
  listed: boolean
  /** Actually there: packets for it are applied. */
  present: boolean
  /** Its worker hangs: packets for it wait in `backlog`. */
  stuck: boolean
  backlog: (() => void)[]
  queuedFrames: number
  maxQueuedFrames: number
}

const ledTotal = (spec: ControllerSpec): number => spec.zones.reduce((n, z) => n + z.ledsCount, 0)
const blank = (n: number): number[][] => Array.from({ length: n }, () => [0, 0, 0])

const WORKER_PACKETS = [
  PacketId.REQUEST_CONTROLLER_DATA, PacketId.UPDATE_LEDS, PacketId.UPDATE_MODE, PacketId.SET_CUSTOM_MODE, PacketId.RESIZE_ZONE
]

export class FakePC {
  readonly server = new FakeOpenRGB()
  /** Every mode change a device applied, in order. */
  readonly modeChanges: ModeChange[] = []
  private readonly devices = new Map<number, Device>()

  constructor(specs: Map<number, ControllerSpec> = thisPc()) {
    for (const [id, spec] of specs) {
      this.devices.set(id, { spec, leds: blank(ledTotal(spec)), listed: true, present: true, stuck: false, backlog: [], queuedFrames: 0, maxQueuedFrames: 0 })
    }
    this.server.on(PacketId.REQUEST_CONTROLLER_COUNT, (_p, r) => {
      const ids = [...this.devices].filter(([, d]) => d.listed).map(([id]) => id)
      r.send(PacketId.REQUEST_CONTROLLER_COUNT, Buffer.concat([u32(ids.length), ...ids.map(u32)]))
    })
    for (const pktId of WORKER_PACKETS) this.server.on(pktId, (p, r) => this.toWorker(p, r))
  }

  get port(): number {
    return this.server.port
  }

  /** Starts "OpenRGB", on `port` if given (else any free port). */
  start(port?: number): Promise<void> {
    return this.server.start(port)
  }

  stop(): Promise<void> {
    return this.server.stop()
  }

  /** What a device's LEDs really show, [r, g, b] per LED: its LED colors in Direct mode, else its mode's color. */
  shown(id: number): number[][] {
    const d = this.device(id)
    const m = d.spec.modes?.[d.spec.activeMode ?? 0]
    if (!m || /^direct$/i.test(m.name)) return d.leds
    const c = m.colors[0] ?? { r: 0, g: 0, b: 0 }
    return d.leds.map(() => [c.r, c.g, c.b])
  }

  modeName(id: number): string | undefined {
    const d = this.device(id)
    return d.spec.modes?.[d.spec.activeMode ?? 0]?.name
  }

  ledCount(id: number): number {
    return ledTotal(this.device(id).spec)
  }

  /** The most LED frames that ever waited for the device at once. */
  maxQueuedFrames(id: number): number {
    return this.device(id).maxQueuedFrames
  }

  /** The device's worker hangs: nothing sent to it is applied, answered or acknowledged until resume(). */
  stall(id: number): void {
    this.device(id).stuck = true
  }

  /** The worker catches up: everything that waited is applied in order, then acknowledged. */
  resume(id: number): void {
    const d = this.device(id)
    d.stuck = false
    for (const run of d.backlog.splice(0)) run()
  }

  /**
   * The device drops off (as after a rescan): it leaves the list, and OpenRGB announces the change. With
   * `stillListed`, the list hasn't caught up yet: it still names the device, which no longer answers.
   */
  unplug(id: number, { announce = true, stillListed = false } = {}): void {
    const d = this.device(id)
    d.present = false
    d.listed = stillListed
    if (announce) this.announce()
  }

  /** OpenRGB's list catches up with an unplugged device, without announcing it. */
  unlist(id: number): void {
    this.device(id).listed = false
  }

  /**
   * The device comes back (OpenRGB may give it a new id), reset as after a power cycle: in its first mode with its
   * LEDs dark. OpenRGB announces the change.
   */
  plugIn(id: number, { newId = id } = {}): void {
    const d = this.device(id)
    this.devices.delete(id)
    d.spec.activeMode = 0
    d.leds = blank(ledTotal(d.spec))
    Object.assign(d, { listed: true, present: true, stuck: false, backlog: [] })
    this.devices.set(newId, d)
    this.announce()
  }

  /** OpenRGB's service restarts: every client is disconnected. With `resetDevices`, the devices go dark too. */
  restartOpenRGB({ resetDevices = false } = {}): void {
    this.server.dropClients()
    if (resetDevices) for (const d of this.devices.values()) d.leds = blank(d.leds.length)
  }

  /** Tells clients the device list changed. */
  announce(): void {
    this.server.broadcast(PacketId.DEVICE_LIST_UPDATED)
  }

  private device(id: number): Device {
    const d = this.devices.get(id)
    if (!d) throw new Error(`FakePC: no device ${id}`)
    return d
  }

  /** Returns false (the server then acknowledges with OK and does nothing) for a device that isn't there. */
  private toWorker(p: Packet, r: Reply): boolean {
    const d = this.devices.get(p.devId)
    if (!d?.present) return false
    const frame = p.pktId === PacketId.UPDATE_LEDS
    if (frame) d.maxQueuedFrames = Math.max(d.maxQueuedFrames, ++d.queuedFrames)
    const run = (): void => {
      if (frame) d.queuedFrames--
      this.apply(p.devId, d, p, r)
      r.ack()
    }
    if (d.stuck) d.backlog.push(run)
    else run()
    return true
  }

  private apply(devId: number, d: Device, p: Packet, r: Reply): void {
    const { spec } = d
    switch (p.pktId) {
      case PacketId.REQUEST_CONTROLLER_DATA:
        r.send(PacketId.REQUEST_CONTROLLER_DATA, encodeController(spec))
        return
      case PacketId.UPDATE_LEDS: {
        const n = p.payload.readUInt16LE(4)
        d.leds = Array.from({ length: n }, (_, i) => [...p.payload.subarray(6 + i * 4, 9 + i * 4)])
        return
      }
      case PacketId.UPDATE_MODE: {
        const index = p.payload.readInt32LE(4)
        const m = readMode(new Reader(p.payload.subarray(8)), index, 6)
        spec.modes![index] = m
        spec.activeMode = index
        this.modeChanges.push({ devId, name: m.name, colors: m.colors })
        return
      }
      case PacketId.SET_CUSTOM_MODE:
        spec.activeMode = spec.modes!.findIndex((m) => /^direct$/i.test(m.name))
        return
      case PacketId.RESIZE_ZONE: {
        spec.zones[p.payload.readInt32LE(0)].ledsCount = p.payload.readInt32LE(4)
        d.leds = blank(ledTotal(spec))
      }
    }
  }
}
