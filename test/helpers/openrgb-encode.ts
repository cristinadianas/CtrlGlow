/**
 * Builds OpenRGB SDK payloads the way an OpenRGB 1.x server sends them (protocol 6), so the parser and the
 * client can be tested without a server. Follows Documentation/OpenRGBSDK.md (REQUEST_CONTROLLER_DATA).
 */
import { encodeMode } from '../../src/service/openrgb/protocol.ts'
import type { Mode, RGB } from '../../src/service/openrgb/types.ts'

export interface ZoneSpec {
  name: string
  type?: number
  ledsMin?: number
  ledsMax?: number
  ledsCount: number
  flags?: number
  matrix?: { height: number; width: number; map: number[] }
  segments?: { name: string; type?: number; startIdx: number; ledsCount: number; flags?: number }[]
  displayName?: string
}

export interface ControllerSpec {
  type: number
  name: string
  vendor?: string
  description?: string
  version?: string
  serial?: string
  location?: string
  activeMode?: number
  modes?: Mode[]
  zones: ZoneSpec[]
  ledNames?: string[]
  ledDisplayNames?: string[]
  colors?: RGB[]
  flags?: number
  displayName?: string
  configuration?: string
}

const u16 = (v: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b }
const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }
const i32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return b }

/** u16 length (including the NUL) + UTF-8 bytes + NUL. */
export function str(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8')
  return Buffer.concat([u16(bytes.length + 1), bytes, Buffer.alloc(1)])
}

function longStr(s: string): Buffer {
  const bytes = Buffer.from(s, 'utf8')
  return Buffer.concat([u32(bytes.length + 1), bytes, Buffer.alloc(1)])
}

function colors(list: RGB[]): Buffer {
  return Buffer.concat([u16(list.length), ...list.map((c) => Buffer.from([c.r, c.g, c.b, 0]))])
}

function matrix(m?: ZoneSpec['matrix']): Buffer {
  if (!m) return u16(0)
  return Buffer.concat([u16(8 + 4 * m.map.length), u32(m.height), u32(m.width), ...m.map.map(u32)])
}

export function mode(name: string, extra: Partial<Mode> = {}): Mode {
  return {
    index: 0, name, flags: 0, speedMin: 0, speedMax: 0, brightnessMin: 0, brightnessMax: 0, colorsMin: 0, colorsMax: 0,
    speed: 0, brightness: 0, direction: 0, colorMode: 0, colors: [], ...extra
  }
}

/** A REQUEST_CONTROLLER_DATA reply payload for protocol 6. */
export function encodeController(c: ControllerSpec): Buffer {
  const modes = c.modes ?? []
  const ledCount = c.zones.reduce((n, z) => n + z.ledsCount, 0)
  const ledNames = c.ledNames ?? Array.from({ length: ledCount }, (_, i) => `LED ${i + 1}`)
  const zones = c.zones.map((z) => Buffer.concat([
    str(z.name), i32(z.type ?? 1), u32(z.ledsMin ?? z.ledsCount), u32(z.ledsMax ?? z.ledsCount), u32(z.ledsCount),
    matrix(z.matrix),
    u16(z.segments?.length ?? 0),
    ...(z.segments ?? []).map((s) => Buffer.concat([str(s.name), i32(s.type ?? 1), u32(s.startIdx), u32(s.ledsCount), u16(0), u32(s.flags ?? 0)])),
    u32(z.flags ?? 0),
    i32(-1), u16(0), // zone modes: none
    str(z.displayName ?? '')
  ]))
  const body = Buffer.concat([
    i32(c.type),
    str(c.name), str(c.vendor ?? ''), str(c.description ?? ''), str(c.version ?? ''), str(c.serial ?? ''), str(c.location ?? ''),
    u16(modes.length), i32(c.activeMode ?? 0), ...modes.map((m) => encodeMode(m, 6)),
    u16(zones.length), ...zones,
    u16(ledNames.length), ...ledNames.map(str),
    colors(c.colors ?? Array.from({ length: ledCount }, () => ({ r: 0, g: 0, b: 0 }))),
    u16(c.ledDisplayNames?.length ?? 0), ...(c.ledDisplayNames ?? []).map(str), u32(c.flags ?? 0),
    str(c.displayName ?? ''), longStr(c.configuration ?? '')
  ])
  return Buffer.concat([u32(4 + body.length), body])
}
