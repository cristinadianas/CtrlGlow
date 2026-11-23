import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  Palette, hexToRgb, hsvToRgb, mixColors, oklabToRgb, packRgb, packedToCss, paletteFor, rgbToHex, rgbToHsv,
  rgbToOklab, unpackRgb, type RGBTuple
} from '../../src/shared/color.ts'
import { assertRgbClose } from '../helpers/assert.ts'

describe('hexToRgb', () => {
  it('parses six-digit hex, with or without #', () => {
    assert.deepEqual(hexToRgb('#ffb7c5'), [255, 183, 197])
    assert.deepEqual(hexToRgb('00c6ff'), [0, 198, 255])
  })

  it('expands three-digit shorthand', () => {
    assert.deepEqual(hexToRgb('#f80'), [255, 136, 0])
  })

  it('returns black for input that is not hex', () => {
    assert.deepEqual(hexToRgb('#zzzzzz'), [0, 0, 0])
  })
})

describe('rgbToHex', () => {
  it('rounds and clamps each channel', () => {
    assert.equal(rgbToHex(254.6, -12, 300), '#ff00ff')
    assert.equal(rgbToHex(30.6, 21.6, 23.6), '#1f1618')
  })

  it('round-trips with hexToRgb', () => {
    for (const hex of ['#000000', '#ffffff', '#ffd4dc', '#7b61ff', '#0061ff']) {
      assert.equal(rgbToHex(...hexToRgb(hex)), hex)
    }
  })
})

describe('packRgb / unpackRgb / packedToCss', () => {
  it('packs into 0xRRGGBB and back', () => {
    const n = packRgb(255, 183, 197)
    assert.equal(n, 0xffb7c5)
    assert.deepEqual(unpackRgb(n), [255, 183, 197])
    assert.equal(packedToCss(n), '#ffb7c5')
  })

  it('clamps out-of-range channels', () => {
    assert.equal(packRgb(-5, 400, 127.6), 0x00ff80)
  })
})

describe('hsvToRgb / rgbToHsv', () => {
  it('maps the primaries', () => {
    assertRgbClose(hsvToRgb(0, 1, 1), [255, 0, 0])
    assertRgbClose(hsvToRgb(1 / 3, 1, 1), [0, 255, 0])
    assertRgbClose(hsvToRgb(2 / 3, 1, 1), [0, 0, 255])
  })

  it('wraps hue outside 0..1', () => {
    assertRgbClose(hsvToRgb(1.5, 1, 1), hsvToRgb(0.5, 1, 1))
    assertRgbClose(hsvToRgb(-0.25, 1, 1), hsvToRgb(0.75, 1, 1))
  })

  it('round-trips colors', () => {
    for (const hex of ['#ffb7c5', '#00f5a0', '#7b61ff', '#d47800', '#808080']) {
      const rgb = hexToRgb(hex)
      assertRgbClose(hsvToRgb(...rgbToHsv(...rgb)), rgb, 0.001)
    }
  })

  it('gives greys zero saturation', () => {
    const [, s, v] = rgbToHsv(128, 128, 128)
    assert.equal(s, 0)
    assert.ok(Math.abs(v - 128 / 255) < 1e-9)
  })
})

describe('OKLab', () => {
  it('round-trips colors', () => {
    for (const hex of ['#ffb7c5', '#00b4ff', '#7b61ff', '#101a4a', '#ffffff']) {
      const rgb = hexToRgb(hex)
      assertRgbClose(oklabToRgb(rgbToOklab(rgb)), rgb, 0.01)
    }
  })

  it('puts white at lightness 1 and black at 0', () => {
    assert.ok(Math.abs(rgbToOklab([255, 255, 255])[0] - 1) < 1e-3)
    assert.ok(Math.abs(rgbToOklab([0, 0, 0])[0]) < 1e-9)
  })
})

describe('mixColors', () => {
  const red: RGBTuple = [255, 0, 0]
  const blue: RGBTuple = [0, 0, 255]

  it('returns the end colors at f = 0 and f = 1', () => {
    assertRgbClose(mixColors(red, blue, 0), red, 0.01)
    assertRgbClose(mixColors(red, blue, 1), blue, 0.01)
  })

  it('blends saturated colors by hue, through vivid magenta rather than grey', () => {
    const [r, g, b] = mixColors(red, blue, 0.5)
    assert.ok(r > 120 && b > 120, `expected a vivid mix, got ${r}, ${g}, ${b}`)
    assert.ok(g < 40, `expected little green, got ${g}`)
  })

  it('blends with white in OKLab, keeping greys neutral', () => {
    const [r, g, b] = mixColors([255, 255, 255], [0, 0, 0], 0.5)
    assert.ok(Math.abs(r - g) < 1 && Math.abs(g - b) < 1, `expected a neutral grey, got ${r}, ${g}, ${b}`)
  })
})

describe('Palette', () => {
  it('falls back to white when empty', () => {
    const p = new Palette([])
    assert.equal(p.size, 1)
    assert.deepEqual(p.color(0), [255, 255, 255])
  })

  it('wraps color indexes in both directions', () => {
    const p = new Palette(['#ff0000', '#00ff00', '#0000ff'])
    assert.deepEqual(p.color(3), [255, 0, 0])
    assert.deepEqual(p.color(-1), [0, 0, 255])
  })

  it('blends between neighbours and wraps from the last to the first', () => {
    const p = new Palette(['#ff0000', '#0000ff'])
    assert.deepEqual(p.between(0, 0), [255, 0, 0])
    assert.deepEqual(p.between(0, 1), [0, 0, 255])
    assert.deepEqual(p.between(1, 1), [255, 0, 0])
  })

  it('samples a cyclic palette with wrap-around and a linear one end to end', () => {
    const p = new Palette(['#ff0000', '#00ff00', '#0000ff'])
    assert.deepEqual(p.sample(0, true), [255, 0, 0])
    assert.deepEqual(p.sample(1, true), [255, 0, 0])
    assert.deepEqual(p.sample(0, false), [255, 0, 0])
    assert.deepEqual(p.sample(1, false), [0, 0, 255])
  })

  it('returns its only color for any sample', () => {
    const p = new Palette(['#ffd4dc'])
    assert.deepEqual(p.sample(0.37, true), [255, 212, 220])
  })
})

describe('paletteFor', () => {
  it('reuses the palette for the same colors', () => {
    assert.equal(paletteFor(['#ffd4dc', '#ffa3bb']), paletteFor(['#ffd4dc', '#ffa3bb']))
    assert.notEqual(paletteFor(['#ffd4dc', '#ffa3bb']), paletteFor(['#ffa3bb', '#ffd4dc']))
  })
})
