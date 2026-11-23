/**
 * Binary encoding/decoding for the OpenRGB SDK protocol.
 * All integers are little-endian. Strings are length-prefixed (u16) and include a null terminator.
 */
import type { Controller, Led, MatrixMap, Mode, RGB, Segment, Zone } from './types.ts'

export const CLIENT_PROTOCOL_VERSION = 6
export const HEADER_SIZE = 16
export const MAGIC = 'ORGB'

export const PacketId = {
  REQUEST_CONTROLLER_COUNT: 0,
  REQUEST_CONTROLLER_DATA: 1,
  ACK: 10,
  REQUEST_PROTOCOL_VERSION: 40,
  SET_CLIENT_NAME: 50,
  SET_SERVER_NAME: 51,
  SET_CLIENT_FLAGS: 52,
  SET_SERVER_FLAGS: 53,
  DEVICE_LIST_UPDATED: 100,
  DETECTION_STARTED: 101,
  DETECTION_PROGRESS_CHANGED: 102,
  DETECTION_COMPLETE: 103,
  REQUEST_RESCAN_DEVICES: 140,
  PROFILEMANAGER_SAVE_PROFILE: 151,
  PROFILEMANAGER_LOAD_PROFILE: 152,
  PROFILEMANAGER_DELETE_PROFILE: 153,
  SETTINGSMANAGER_GET_SETTINGS: 250,
  SETTINGSMANAGER_MODIFY_SETTINGS: 252,
  SETTINGSMANAGER_SAVE_SETTINGS: 254,
  RESIZE_ZONE: 1000,
  UPDATE_LEDS: 1050,
  UPDATE_ZONE_LEDS: 1051,
  UPDATE_SINGLE_LED: 1052,
  SET_CUSTOM_MODE: 1100,
  UPDATE_MODE: 1101,
  SAVE_MODE: 1102,
  UPDATE_ZONE_MODE: 1103,
  SIGNAL_UPDATE: 1150
} as const

export const ClientFlag = {
  SUPPORTS_RGBCONTROLLER: 1 << 0,
  SUPPORTS_PROFILEMANAGER: 1 << 2,
  REQUEST_LOCAL_CLIENT: 1 << 16
} as const

export const ServerFlag = {
  /** Confirms the client was granted local-client rights (profiles, settings). */
  LOCAL_CLIENT: 1 << 16
} as const

export function encodeHeader(devId: number, pktId: number, size: number): Buffer {
  const b = Buffer.alloc(HEADER_SIZE)
  b.write(MAGIC, 0, 'ascii')
  b.writeUInt32LE(devId >>> 0, 4)
  b.writeUInt32LE(pktId >>> 0, 8)
  b.writeUInt32LE(size >>> 0, 12)
  return b
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
/* ------------------------------------------------------------------ */

export class Reader {
  private off = 0
  private readonly buf: Buffer
  constructor(buf: Buffer) {
    this.buf = buf
  }

  get offset(): number {
    return this.off
  }
  get remaining(): number {
    return this.buf.length - this.off
  }
  u16(): number {
    const v = this.buf.readUInt16LE(this.off)
    this.off += 2
    return v
  }
  u32(): number {
    const v = this.buf.readUInt32LE(this.off)
    this.off += 4
    return v
  }
  i32(): number {
    const v = this.buf.readInt32LE(this.off)
    this.off += 4
    return v
  }
  bytes(n: number): Buffer {
    const v = this.buf.subarray(this.off, this.off + n)
    this.off += n
    return v
  }
  /** u16 length (including null terminator) + chars */
  str(): string {
    return decodeCString(this.bytes(this.u16()))
  }
  /** u32 length (including null terminator) + chars */
  longStr(): string {
    return decodeCString(this.bytes(this.u32()))
  }
  color(): RGB {
    const r = this.buf[this.off]
    const g = this.buf[this.off + 1]
    const b = this.buf[this.off + 2]
    this.off += 4
    return { r, g, b }
  }
  colors(n: number): RGB[] {
    const out: RGB[] = new Array(n)
    for (let i = 0; i < n; i++) out[i] = this.color()
    return out
  }
}

function decodeCString(b: Buffer): string {
  let end = b.length
  while (end > 0 && b[end - 1] === 0) end--
  return b.toString('utf8', 0, end)
}

function readMatrix(r: Reader, len: number): MatrixMap | undefined {
  if (len === 0) return undefined
  const height = r.u32()
  const width = r.u32()
  const cells = Math.max(0, Math.floor((len - 8) / 4))
  const map: number[] = new Array(cells)
  for (let i = 0; i < cells; i++) map[i] = r.u32()
  return { height, width, map }
}

export function readMode(r: Reader, index: number, protocol: number): Mode {
  const name = r.str()
  const value = protocol < 6 ? r.i32() : undefined
  const flags = r.u32()
  const speedMin = r.u32()
  const speedMax = r.u32()
  const brightnessMin = protocol >= 3 ? r.u32() : 0
  const brightnessMax = protocol >= 3 ? r.u32() : 0
  const colorsMin = r.u32()
  const colorsMax = r.u32()
  const speed = r.u32()
  const brightness = protocol >= 3 ? r.u32() : 0
  const direction = r.u32()
  const colorMode = r.u32()
  const colors = r.colors(r.u16())
  return {
    index, name, value, flags, speedMin, speedMax, brightnessMin, brightnessMax,
    colorsMin, colorsMax, speed, brightness, direction, colorMode, colors
  }
}

function readSegment(r: Reader, protocol: number): Segment {
  const name = r.str()
  const type = r.i32()
  const startIdx = r.u32()
  const ledsCount = r.u32()
  let matrix: MatrixMap | undefined
  let flags = 0
  if (protocol >= 6) {
    matrix = readMatrix(r, r.u16())
    flags = r.u32()
  }
  return { name, type, startIdx, ledsCount, matrix, flags }
}

function readZone(r: Reader, index: number, startIdx: number, protocol: number): Zone {
  const name = r.str()
  const type = r.i32()
  const ledsMin = r.u32()
  const ledsMax = r.u32()
  const ledsCount = r.u32()
  const matrix = readMatrix(r, r.u16())
  const segments: Segment[] = []
  if (protocol >= 4) {
    const n = r.u16()
    for (let i = 0; i < n; i++) segments.push(readSegment(r, protocol))
  }
  const flags = protocol >= 5 ? r.u32() : 0
  let activeMode = -1
  const modes: Mode[] = []
  let displayName = name
  if (protocol >= 6) {
    activeMode = r.i32()
    const n = r.u16()
    for (let i = 0; i < n; i++) modes.push(readMode(r, i, protocol))
    displayName = r.str() || name
  }
  return { index, name, displayName, type, ledsMin, ledsMax, ledsCount, startIdx, matrix, segments, flags, activeMode, modes }
}

/** Parses a NET_PACKET_ID_REQUEST_CONTROLLER_DATA response payload. */
export function parseController(payload: Buffer, id: number, protocol: number): Controller {
  const r = new Reader(payload)
  r.u32() // data_size
  const type = r.i32()
  const name = r.str()
  const vendor = protocol >= 1 ? r.str() : ''
  const description = r.str()
  const version = r.str()
  const serial = r.str()
  const location = r.str()

  const numModes = r.u16()
  const activeMode = r.i32()
  const modes: Mode[] = []
  for (let i = 0; i < numModes; i++) modes.push(readMode(r, i, protocol))

  const numZones = r.u16()
  const zones: Zone[] = []
  let ledCursor = 0
  for (let i = 0; i < numZones; i++) {
    const z = readZone(r, i, ledCursor, protocol)
    ledCursor += z.ledsCount
    zones.push(z)
  }

  const numLeds = r.u16()
  const leds: Led[] = []
  for (let i = 0; i < numLeds; i++) {
    const ledName = r.str()
    if (protocol < 6) r.u32() // led value
    leds.push({ name: ledName })
  }

  const colors = r.colors(r.u16())

  let flags = 0
  if (protocol >= 5) {
    const numDisplay = r.u16()
    for (let i = 0; i < numDisplay; i++) {
      const dn = r.str()
      if (leds[i]) leds[i].displayName = dn
    }
    flags = r.u32()
  }
  let displayName = name
  let configuration = ''
  if (protocol >= 6) {
    displayName = r.str() || name
    configuration = r.longStr()
  }

  return {
    id, type, name, displayName, vendor, description, version, serial, location,
    activeMode, modes, zones, leds, colors, flags, configuration
  }
}

/* ------------------------------------------------------------------ */
/* Writing                                                            */
/* ------------------------------------------------------------------ */

export function encodeColors(colors: readonly RGB[]): Buffer {
  const b = Buffer.alloc(colors.length * 4)
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i]
    const o = i * 4
    b[o] = clampByte(c.r)
    b[o + 1] = clampByte(c.g)
    b[o + 2] = clampByte(c.b)
  }
  return b
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)
}

function cString(s: string): Buffer {
  return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])])
}

function u16(v: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(v)
  return b
}
function u32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(v >>> 0)
  return b
}
function i32(v: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeInt32LE(v | 0)
  return b
}

export function encodeClientName(name: string): Buffer {
  return cString(name)
}

/** UpdateLEDs payload: data_size(u32) num_colors(u16) colors */
export function encodeUpdateLeds(colors: readonly RGB[]): Buffer {
  const body = Buffer.concat([u16(colors.length), encodeColors(colors)])
  return Buffer.concat([u32(4 + body.length), body])
}

/** UpdateLEDs payload from packed r,g,b bytes (3 per LED). */
export function encodeUpdateLedsPacked(rgb: Uint8Array): Buffer {
  const n = Math.floor(rgb.length / 3)
  const b = Buffer.alloc(4 + 2 + n * 4)
  b.writeUInt32LE(b.length, 0)
  b.writeUInt16LE(n, 4)
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 4
    b[o] = rgb[i * 3]
    b[o + 1] = rgb[i * 3 + 1]
    b[o + 2] = rgb[i * 3 + 2]
  }
  return b
}

/** UpdateZoneLEDs payload: data_size(u32) zone_idx(u32) num_colors(u16) colors */
export function encodeUpdateZoneLeds(zoneIdx: number, colors: readonly RGB[]): Buffer {
  const body = Buffer.concat([u32(zoneIdx), u16(colors.length), encodeColors(colors)])
  return Buffer.concat([u32(4 + body.length), body])
}

export function encodeResizeZone(zoneIdx: number, size: number): Buffer {
  return Buffer.concat([i32(zoneIdx), i32(size)])
}

export function encodeMode(mode: Mode, protocol: number): Buffer {
  const parts: Buffer[] = [u16(Buffer.byteLength(mode.name, 'utf8') + 1), cString(mode.name)]
  if (protocol < 6) parts.push(i32(mode.value ?? 0))
  parts.push(u32(mode.flags), u32(mode.speedMin), u32(mode.speedMax))
  if (protocol >= 3) parts.push(u32(mode.brightnessMin), u32(mode.brightnessMax))
  parts.push(u32(mode.colorsMin), u32(mode.colorsMax), u32(mode.speed))
  if (protocol >= 3) parts.push(u32(mode.brightness))
  parts.push(u32(mode.direction), u32(mode.colorMode), u16(mode.colors.length), encodeColors(mode.colors))
  return Buffer.concat(parts)
}

/** UpdateMode / SaveMode payload: data_size(u32) mode_idx(i32) mode */
export function encodeUpdateMode(modeIdx: number, mode: Mode, protocol: number): Buffer {
  const body = Buffer.concat([i32(modeIdx), encodeMode(mode, protocol)])
  return Buffer.concat([u32(4 + body.length), body])
}

/** UpdateZoneMode payload: data_size(u32) zone_idx(i32) mode_idx(i32) mode */
export function encodeUpdateZoneMode(zoneIdx: number, modeIdx: number, mode: Mode, protocol: number): Buffer {
  const body = Buffer.concat([i32(zoneIdx), i32(modeIdx), encodeMode(mode, protocol)])
  return Buffer.concat([u32(4 + body.length), body])
}

export { u32 as encodeU32 }
