/**
 * Minimal, dependency-free OpenRGB SDK client (protocol 6, OpenRGB 1.x).
 *
 * - Request/response packets are matched FIFO per (packet id, device id).
 * - Every client packet is acknowledged by protocol-6 servers; ACKs are matched FIFO the same way.
 * - LED frames are flow-controlled per device: a new frame is only sent once the previous one was
 *   acknowledged, and the newest pending frame replaces older ones. This keeps animations smooth and
 *   prevents a backlog building up in the server's per-controller queue.
 */
import { EventEmitter } from 'node:events'
import net from 'node:net'
import {
  CLIENT_PROTOCOL_VERSION, HEADER_SIZE, MAGIC, PacketId,
  encodeClientName, encodeHeader, encodeResizeZone, encodeU32, encodeUpdateLeds,
  encodeUpdateLedsPacked, encodeUpdateMode, encodeUpdateZoneLeds, encodeUpdateZoneMode, parseController
} from './protocol.ts'
import type { Controller, Mode, RGB } from './types.ts'

/** Client/server flags (protocol 6). */
const CLIENT_FLAG_SUPPORTS_RGBCONTROLLER = 1 << 0
const CLIENT_FLAG_REQUEST_LOCAL_CLIENT = 1 << 16
const SERVER_FLAG_LOCAL_CLIENT = 1 << 16

/** A NUL-terminated UTF-8 string, as OpenRGB expects for names, keys and JSON. */
const cString = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.alloc(1)])

export interface ClientOptions {
  host?: string
  port?: number
  name?: string
  /** Timeout for request/response round trips (ms). */
  timeoutMs?: number
}

interface Waiter {
  resolve: (payload: Buffer) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

interface FrameSlot {
  busy: boolean
  sentAt: number
  pending?: { pktId: number; payload: Buffer }
}

export interface OpenRGBClientEvents {
  connected: []
  disconnected: [error?: Error]
  deviceListUpdated: []
  controllerChanged: [id: number, reason: number]
  detectionStarted: []
  detectionComplete: []
}

export class OpenRGBClient extends EventEmitter<OpenRGBClientEvents> {
  readonly host: string
  readonly port: number
  readonly name: string
  private readonly timeoutMs: number

  private socket?: net.Socket
  private rx: Buffer = Buffer.alloc(0)
  private responses = new Map<string, Waiter[]>()
  private acks = new Map<string, Array<((status: number) => void) | null>>()
  private frames = new Map<number, FrameSlot>()

  protocol = 0
  serverName = ''

  constructor(opts: ClientOptions = {}) {
    super()
    this.host = opts.host ?? '127.0.0.1'
    this.port = opts.port ?? 6742
    this.name = opts.name ?? 'Lumen'
    this.timeoutMs = opts.timeoutMs ?? 5000
  }

  get connected(): boolean {
    return !!this.socket && !this.socket.destroyed && this.protocol > 0
  }

  /* ---------------------------------------------------------------- */
  /* Connection                                                       */
  /* ---------------------------------------------------------------- */

  async connect(): Promise<void> {
    if (this.socket) this.disconnect()
    const socket = net.connect({ host: this.host, port: this.port })
    socket.setNoDelay(true)
    this.socket = socket
    this.rx = Buffer.alloc(0)

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        socket.off('connect', onConnect)
        reject(err)
      }
      const onConnect = (): void => {
        socket.off('error', onError)
        resolve()
      }
      socket.once('error', onError)
      socket.once('connect', onConnect)
    })

    socket.on('data', (chunk: Buffer) => this.onData(chunk))
    socket.on('error', () => { /* surfaced through 'close' */ })
    socket.on('close', () => this.onClose())

    // Negotiate protocol version (min of ours and the server's).
    const reply = await this.request(0, PacketId.REQUEST_PROTOCOL_VERSION, encodeU32(CLIENT_PROTOCOL_VERSION), 2000)
      .catch(() => null)
    const serverVersion = reply && reply.length >= 4 ? reply.readUInt32LE(0) : 0
    this.protocol = Math.min(CLIENT_PROTOCOL_VERSION, serverVersion)
    if (this.protocol < 1) {
      this.disconnect()
      throw new Error(`OpenRGB server protocol ${serverVersion} is too old (need 1+)`)
    }
    this.send(0, PacketId.SET_CLIENT_NAME, encodeClientName(this.name))
    this.emit('connected')
  }

  disconnect(): void {
    const s = this.socket
    this.socket = undefined
    if (s && !s.destroyed) s.destroy()
    this.failAll(new Error('Disconnected'))
  }

  private onClose(): void {
    const wasConnected = this.protocol > 0
    this.socket = undefined
    this.protocol = 0
    this.failAll(new Error('Connection closed'))
    if (wasConnected) this.emit('disconnected')
  }

  private failAll(err: Error): void {
    for (const list of this.responses.values()) for (const w of list) { clearTimeout(w.timer); w.reject(err) }
    this.responses.clear()
    for (const list of this.acks.values()) for (const cb of list) cb?.(-1)
    this.acks.clear()
    this.frames.clear()
  }

  /* ---------------------------------------------------------------- */
  /* Packet I/O                                                       */
  /* ---------------------------------------------------------------- */

  private onData(chunk: Buffer): void {
    this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk
    while (this.rx.length >= HEADER_SIZE) {
      if (this.rx.toString('ascii', 0, 4) !== MAGIC) {
        // Out of sync: drop until next magic.
        const next = this.rx.indexOf(MAGIC, 1, 'ascii')
        this.rx = next < 0 ? Buffer.alloc(0) : this.rx.subarray(next)
        continue
      }
      const devId = this.rx.readUInt32LE(4)
      const pktId = this.rx.readUInt32LE(8)
      const size = this.rx.readUInt32LE(12)
      if (this.rx.length < HEADER_SIZE + size) break
      const payload = Buffer.from(this.rx.subarray(HEADER_SIZE, HEADER_SIZE + size))
      this.rx = this.rx.subarray(HEADER_SIZE + size)
      this.dispatch(devId, pktId, payload)
    }
  }

  private dispatch(devId: number, pktId: number, payload: Buffer): void {
    switch (pktId) {
      case PacketId.ACK: {
        const ackedPkt = payload.readUInt32LE(0)
        const status = payload.readUInt32LE(4)
        const list = this.acks.get(`${ackedPkt}:${devId}`)
        const cb = list?.shift()
        if (list && list.length === 0) this.acks.delete(`${ackedPkt}:${devId}`)
        cb?.(status)
        return
      }
      case PacketId.SET_SERVER_NAME:
        this.serverName = payload.toString('utf8').replace(/\0+$/, '')
        return
      case PacketId.DEVICE_LIST_UPDATED:
        this.emit('deviceListUpdated')
        return
      case PacketId.DETECTION_STARTED:
        this.emit('detectionStarted')
        return
      case PacketId.DETECTION_COMPLETE:
        this.emit('detectionComplete')
        return
      case PacketId.SIGNAL_UPDATE: {
        const reason = payload.length >= 8 ? payload.readUInt32LE(4) : -1
        if (reason !== 0) this.emit('controllerChanged', devId, reason) // 0 = UpdateLEDs (often our own frames)
        return
      }
    }
    const key = `${pktId}:${devId}`
    const list = this.responses.get(key)
    const w = list?.shift()
    if (list && list.length === 0) this.responses.delete(key)
    if (w) {
      clearTimeout(w.timer)
      w.resolve(payload)
    }
  }

  /** Sends a packet; for protocol 6+ registers an ACK slot so ACK matching stays in order. */
  private send(devId: number, pktId: number, payload: Buffer = Buffer.alloc(0), onAck?: (status: number) => void): boolean {
    const s = this.socket
    if (!s || s.destroyed) return false
    if (this.protocol >= 6) {
      const key = `${pktId}:${devId}`
      const list = this.acks.get(key) ?? []
      list.push(onAck ?? null)
      this.acks.set(key, list)
    }
    s.write(Buffer.concat([encodeHeader(devId, pktId, payload.length), payload]))
    return true
  }

  private request(devId: number, pktId: number, payload?: Buffer, timeoutMs = this.timeoutMs): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const key = `${pktId}:${devId}`
      const timer = setTimeout(() => {
        const list = this.responses.get(key)
        const i = list?.findIndex((w) => w.timer === timer) ?? -1
        if (list && i >= 0) list.splice(i, 1)
        reject(new Error(`OpenRGB request ${pktId} timed out`))
      }, timeoutMs)
      const list = this.responses.get(key) ?? []
      list.push({ resolve, reject, timer })
      this.responses.set(key, list)
      if (!this.send(devId, pktId, payload)) {
        clearTimeout(timer)
        list.pop()
        reject(new Error('Not connected'))
      }
    })
  }

  /** Sends a command and resolves with the ACK status (0 = OK). Protocol < 6 resolves immediately. */
  private command(devId: number, pktId: number, payload?: Buffer): Promise<number> {
    if (this.protocol < 6) {
      return Promise.resolve(this.send(devId, pktId, payload) ? 0 : -1)
    }
    return new Promise((resolve) => {
      let done = false
      const timer = setTimeout(() => { if (!done) { done = true; resolve(-2) } }, this.timeoutMs)
      const ok = this.send(devId, pktId, payload, (status) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(status)
      })
      if (!ok) { done = true; clearTimeout(timer); resolve(-1) }
    })
  }

  /* ---------------------------------------------------------------- */
  /* Controllers                                                      */
  /* ---------------------------------------------------------------- */

  /** Returns controller IDs (protocol 6+: unique IDs; older: indices). */
  async controllerIds(): Promise<number[]> {
    const reply = await this.request(0, PacketId.REQUEST_CONTROLLER_COUNT)
    const count = reply.readUInt32LE(0)
    if (this.protocol >= 6) {
      const ids: number[] = []
      for (let i = 0; i < count; i++) ids.push(reply.readUInt32LE(4 + i * 4))
      return ids
    }
    return Array.from({ length: count }, (_, i) => i)
  }

  async controller(id: number): Promise<Controller> {
    const reply = await this.request(id, PacketId.REQUEST_CONTROLLER_DATA, encodeU32(this.protocol))
    return parseController(reply, id, this.protocol)
  }

  async controllers(): Promise<Controller[]> {
    const ids = await this.controllerIds()
    const out: Controller[] = []
    for (const id of ids) out.push(await this.controller(id))
    return out
  }

  rescan(): void {
    this.send(0, PacketId.REQUEST_RESCAN_DEVICES)
  }

  /* ---------------------------------------------------------------- */
  /* Profiles and settings (protocol 6, local clients only)           */
  /* ---------------------------------------------------------------- */

  /**
   * Asks the server for "local client" rights, which saving profiles and changing settings need; granted to
   * connections from the same PC. Deliberately doesn't claim ProfileManager support: the server would then wait
   * for this client to acknowledge every profile load. Resolves true if granted.
   */
  async requestLocalClient(): Promise<boolean> {
    const flags = CLIENT_FLAG_SUPPORTS_RGBCONTROLLER | CLIENT_FLAG_REQUEST_LOCAL_CLIENT
    const reply = await this.requestReply(0, PacketId.SET_CLIENT_FLAGS, PacketId.SET_SERVER_FLAGS, encodeU32(flags))
    return reply.length >= 4 && (reply.readUInt32LE(0) & SERVER_FLAG_LOCAL_CLIENT) !== 0
  }

  /** Saves the devices' current state as a server profile. Resolves with the status (0 = OK) once saved. */
  saveProfile(name: string): Promise<number> {
    return this.command(0, PacketId.PROFILEMANAGER_SAVE_PROFILE, cString(name))
  }

  loadProfile(name: string): Promise<number> {
    return this.command(0, PacketId.PROFILEMANAGER_LOAD_PROFILE, cString(name))
  }

  deleteProfile(name: string): Promise<number> {
    return this.command(0, PacketId.PROFILEMANAGER_DELETE_PROFILE, cString(name))
  }

  /** The server's settings object stored under a top-level key (e.g. "ProfileManager"), or null. */
  async getSettings(key: string): Promise<unknown> {
    const reply = await this.request(0, PacketId.SETTINGSMANAGER_GET_SETTINGS, cString(key))
    return JSON.parse(reply.toString('utf8').replace(/\0+$/, '') || 'null')
  }

  /** Merges `{ key: {...} }` into the server's settings (in memory; call saveSettings to keep it). */
  modifySettings(settings: Record<string, unknown>): Promise<number> {
    return this.command(0, PacketId.SETTINGSMANAGER_MODIFY_SETTINGS, cString(JSON.stringify(settings)))
  }

  /** Writes the server's settings to its settings file. */
  saveSettings(): Promise<number> {
    return this.command(0, PacketId.SETTINGSMANAGER_SAVE_SETTINGS)
  }

  /** Like request(), for commands whose reply comes back under a different packet id. */
  private requestReply(devId: number, pktId: number, replyId: number, payload?: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const key = `${replyId}:${devId}`
      const timer = setTimeout(() => {
        const list = this.responses.get(key)
        const i = list?.findIndex((w) => w.timer === timer) ?? -1
        if (list && i >= 0) list.splice(i, 1)
        reject(new Error(`OpenRGB request ${pktId} timed out`))
      }, this.timeoutMs)
      const list = this.responses.get(key) ?? []
      list.push({ resolve, reject, timer })
      this.responses.set(key, list)
      if (!this.send(devId, pktId, payload)) {
        clearTimeout(timer)
        list.pop()
        reject(new Error('Not connected'))
      }
    })
  }

  /* ---------------------------------------------------------------- */
  /* Lighting                                                         */
  /* ---------------------------------------------------------------- */

  /** Switches a controller to its software-controlled ("Direct"/custom) mode. */
  setCustomMode(id: number): Promise<number> {
    return this.command(id, PacketId.SET_CUSTOM_MODE)
  }

  updateMode(id: number, mode: Mode): Promise<number> {
    return this.command(id, PacketId.UPDATE_MODE, encodeUpdateMode(mode.index, mode, this.protocol))
  }

  /** Like updateMode, but also stores the mode in the device's flash (if supported). */
  saveMode(id: number, mode: Mode): Promise<number> {
    return this.command(id, PacketId.SAVE_MODE, encodeUpdateMode(mode.index, mode, this.protocol))
  }

  updateZoneMode(id: number, zoneIdx: number, mode: Mode): Promise<number> {
    return this.command(id, PacketId.UPDATE_ZONE_MODE, encodeUpdateZoneMode(zoneIdx, mode.index, mode, this.protocol))
  }

  resizeZone(id: number, zoneIdx: number, size: number): Promise<number> {
    return this.command(id, PacketId.RESIZE_ZONE, encodeResizeZone(zoneIdx, size))
  }

  /** Sets every LED of a controller. Flow-controlled: safe to call every animation frame. */
  updateLeds(id: number, colors: readonly RGB[]): void {
    this.sendFrame(id, PacketId.UPDATE_LEDS, encodeUpdateLeds(colors))
  }

  /** Same as updateLeds, from packed r,g,b bytes (3 per LED). */
  updateLedsPacked(id: number, rgb: Uint8Array): void {
    this.sendFrame(id, PacketId.UPDATE_LEDS, encodeUpdateLedsPacked(rgb))
  }

  /** Sets every LED of one zone. Shares the device's flow-control slot with updateLeds. */
  updateZoneLeds(id: number, zoneIdx: number, colors: readonly RGB[]): void {
    this.sendFrame(id, PacketId.UPDATE_ZONE_LEDS, encodeUpdateZoneLeds(zoneIdx, colors))
  }

  /** Sends immediately and resolves once applied (use for one-off updates, not animation). */
  updateLedsNow(id: number, colors: readonly RGB[]): Promise<number> {
    return this.command(id, PacketId.UPDATE_LEDS, encodeUpdateLeds(colors))
  }

  private sendFrame(id: number, pktId: number, payload: Buffer): void {
    let slot = this.frames.get(id)
    if (!slot) {
      slot = { busy: false, sentAt: 0 }
      this.frames.set(id, slot)
    }
    // A frame that has waited >500 ms for its ACK is considered lost; don't stall forever.
    if (slot.busy && Date.now() - slot.sentAt < 500) {
      slot.pending = { pktId, payload }
      return
    }
    this.transmitFrame(id, slot, pktId, payload)
  }

  private transmitFrame(id: number, slot: FrameSlot, pktId: number, payload: Buffer): void {
    if (this.protocol < 6) {
      this.send(id, pktId, payload)
      return
    }
    slot.busy = true
    slot.sentAt = Date.now()
    slot.pending = undefined
    const ok = this.send(id, pktId, payload, () => {
      slot.busy = false
      const next = slot.pending
      if (next) this.transmitFrame(id, slot, next.pktId, next.payload)
    })
    if (!ok) slot.busy = false
  }
}
