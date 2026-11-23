import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  HEADER_SIZE, MAGIC, Reader, encodeColors, encodeHeader, encodeMode, encodeResizeZone, encodeUpdateLeds,
  encodeUpdateLedsPacked, encodeUpdateMode, encodeUpdateZoneLeds, parseController, readMode
} from '../../../src/service/openrgb/protocol.ts'
import { DeviceType, ZoneFlag, isResizable, type Mode, type Zone } from '../../../src/service/openrgb/types.ts'
import { encodeController, mode, str } from '../../helpers/openrgb-encode.ts'

describe('encodeHeader', () => {
  it('writes the ORGB magic, then device id, packet id and size as little-endian u32s', () => {
    const h = encodeHeader(7, 1050, 99)
    assert.equal(h.length, HEADER_SIZE)
    assert.equal(h.toString('ascii', 0, 4), MAGIC)
    assert.deepEqual([h.readUInt32LE(4), h.readUInt32LE(8), h.readUInt32LE(12)], [7, 1050, 99])
  })
})

describe('LED color payloads', () => {
  it('encodes each color as 4 bytes (r, g, b, padding), rounded and clamped', () => {
    assert.deepEqual([...encodeColors([{ r: 255.4, g: -3, b: 127.6 }, { r: 300, g: 1, b: 2 }])], [255, 0, 128, 0, 255, 1, 2, 0])
  })

  it('writes UpdateLEDs as data size, count and colors', () => {
    const p = encodeUpdateLeds([{ r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }])
    assert.equal(p.readUInt32LE(0), p.length)
    assert.equal(p.readUInt16LE(4), 2)
    assert.deepEqual([...p.subarray(6)], [1, 2, 3, 0, 4, 5, 6, 0])
  })

  it('encodes packed r,g,b bytes exactly like the same colors as objects', () => {
    const packed = encodeUpdateLedsPacked(Uint8Array.from([10, 20, 30, 40, 50, 60]))
    assert.deepEqual(packed, encodeUpdateLeds([{ r: 10, g: 20, b: 30 }, { r: 40, g: 50, b: 60 }]))
  })

  it('ignores a trailing partial LED in packed bytes', () => {
    assert.equal(encodeUpdateLedsPacked(Uint8Array.from([1, 2, 3, 4])).readUInt16LE(4), 1)
  })

  it('writes UpdateZoneLEDs with the zone index', () => {
    const p = encodeUpdateZoneLeds(2, [{ r: 9, g: 8, b: 7 }])
    assert.equal(p.readUInt32LE(0), p.length)
    assert.equal(p.readUInt32LE(4), 2)
    assert.equal(p.readUInt16LE(8), 1)
  })

  it('writes ResizeZone as zone index and size', () => {
    const p = encodeResizeZone(0, 172)
    assert.deepEqual([p.readInt32LE(0), p.readInt32LE(4)], [0, 172])
  })
})

describe('modes', () => {
  const direct: Mode = mode('Direct', { flags: 0x20, brightnessMin: 0, brightnessMax: 255, brightness: 255, colorMode: 1 })
  const fixed: Mode = mode('Static', {
    value: 1, flags: 0x50, brightnessMax: 100, brightness: 99, colorsMin: 1, colorsMax: 1, colorMode: 2,
    colors: [{ r: 255, g: 212, b: 220 }]
  })

  for (const protocol of [6, 3, 2]) {
    it(`round-trips through encodeMode and readMode on protocol ${protocol}`, () => {
      for (const m of [direct, fixed]) {
        const back = readMode(new Reader(encodeMode(m, protocol)), 0, protocol)
        assert.equal(back.name, m.name)
        assert.deepEqual(back.colors, m.colors)
        assert.equal(back.colorMode, m.colorMode)
        assert.equal(back.brightness, protocol >= 3 ? m.brightness : 0)
        assert.equal(back.value, protocol < 6 ? (m.value ?? 0) : undefined)
      }
    })
  }

  it('prefixes UpdateMode with its data size and the mode index', () => {
    const p = encodeUpdateMode(3, fixed, 6)
    assert.equal(p.readUInt32LE(0), p.length)
    assert.equal(p.readInt32LE(4), 3)
  })
})

describe('Reader strings', () => {
  it('drops the NUL terminator', () => {
    assert.equal(new Reader(str('Fury Slot 1')).str(), 'Fury Slot 1')
  })
})

describe('parseController (protocol 6)', () => {
  const payload = encodeController({
    type: DeviceType.MOTHERBOARD,
    name: 'X870E AORUS PRO X3D ICE',
    vendor: 'Gigabyte',
    location: 'HID: /dev/hidraw0',
    activeMode: 0,
    modes: [mode('Direct', { colorMode: 1 }), mode('Static', { colorsMin: 1, colorsMax: 1, colorMode: 2, colors: [{ r: 0, g: 0, b: 0 }] })],
    zones: [
      { name: 'ARGB_V2_1', ledsMin: 0, ledsMax: 256, ledsCount: 3, flags: ZoneFlag.CONFIGURABLE_SIZE, displayName: 'Header 1' },
      { name: 'Chipset Accent', ledsCount: 2, segments: [{ name: 'Left', startIdx: 0, ledsCount: 1 }] }
    ],
    colors: [{ r: 1, g: 2, b: 3 }, { r: 4, g: 5, b: 6 }, { r: 7, g: 8, b: 9 }, { r: 10, g: 11, b: 12 }, { r: 13, g: 14, b: 15 }],
    ledDisplayNames: ['First'],
    configuration: '{"persist_lighting_on_exit":false}'
  })
  const c = parseController(payload, 42, 6)

  it('reads the controller fields', () => {
    assert.equal(c.id, 42)
    assert.equal(c.type, DeviceType.MOTHERBOARD)
    assert.equal(c.name, 'X870E AORUS PRO X3D ICE')
    assert.equal(c.vendor, 'Gigabyte')
    assert.equal(c.location, 'HID: /dev/hidraw0')
    assert.equal(c.configuration, '{"persist_lighting_on_exit":false}')
  })

  it('reads the modes with their indexes', () => {
    assert.deepEqual(c.modes.map((m) => [m.index, m.name]), [[0, 'Direct'], [1, 'Static']])
    assert.equal(c.activeMode, 0)
  })

  it('works out where each zone starts in the LED list', () => {
    assert.deepEqual(c.zones.map((z) => [z.name, z.startIdx, z.ledsCount]), [['ARGB_V2_1', 0, 3], ['Chipset Accent', 3, 2]])
    assert.equal(c.zones[1].segments[0].name, 'Left')
  })

  it('falls back to the name when a display name is empty', () => {
    assert.equal(c.displayName, c.name)
    assert.equal(c.zones[0].displayName, 'Header 1')
    assert.equal(c.zones[1].displayName, 'Chipset Accent')
  })

  it('reads the LEDs, their display names and colors', () => {
    assert.equal(c.leds.length, 5)
    assert.equal(c.leds[0].displayName, 'First')
    assert.equal(c.leds[1].displayName, undefined)
    assert.deepEqual(c.colors[4], { r: 13, g: 14, b: 15 })
  })
})

describe('isResizable', () => {
  const zone = (extra: Partial<Zone>): Zone => ({
    index: 0, name: 'z', displayName: 'z', type: 1, ledsMin: 12, ledsMax: 12, ledsCount: 12, startIdx: 0,
    segments: [], flags: 0, activeMode: -1, modes: [], ...extra
  })

  it('is true for zones flagged as resizable or with a size range', () => {
    assert.equal(isResizable(zone({ flags: ZoneFlag.CONFIGURABLE_SIZE })), true)
    assert.equal(isResizable(zone({ ledsMin: 0, ledsMax: 256 })), true)
    assert.equal(isResizable(zone({})), false)
  })
})
