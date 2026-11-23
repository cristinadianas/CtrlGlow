import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  DEFAULT_CALIBRATION, VIOLET_CORRECTION, WHITE_GROUPS, calibrationGains, driveLed, sanitizeCalibration, srgbToLinear,
  whiteGains, whiteGroupFor, type Gains
} from '../../src/shared/calibration.ts'
import { assertClose, assertRgbClose } from '../helpers/assert.ts'

const UNITY: Gains = [1, 1, 1]

function drive(r: number, g: number, b: number, gains: Gains = UNITY): number[] {
  const out = [0, 0, 0]
  driveLed(r, g, b, gains, out, 0)
  return out
}

describe('srgbToLinear', () => {
  it('maps black to 0 and white to 1', () => {
    assert.equal(srgbToLinear(0), 0)
    assert.equal(srgbToLinear(255), 1)
  })

  it('clamps out-of-range input', () => {
    assert.equal(srgbToLinear(-10), 0)
    assert.equal(srgbToLinear(300), 1)
  })

  it('puts sRGB mid-grey at about 22% light', () => {
    assertClose(srgbToLinear(128), 0.2159, 0.001)
  })

  it('never decreases', () => {
    let previous = -1
    for (let v = 0; v <= 255; v++) {
      const l = srgbToLinear(v)
      assert.ok(l >= previous, `srgbToLinear(${v}) went down`)
      previous = l
    }
  })
})

describe('whiteGains', () => {
  it('is neutral at warmth 0 and tint 0', () => {
    assert.deepEqual(whiteGains({ warmth: 0, tint: 0 }), [1, 1, 1])
  })

  it('keeps the strongest channel at 1', () => {
    for (const warmth of [0, 25, 73, 100]) {
      for (const tint of [-50, -10, 0, 2, 50]) {
        assertClose(Math.max(...whiteGains({ warmth, tint })), 1, 1e-12, `warmth ${warmth}, tint ${tint}:`)
      }
    }
  })

  it('cuts blue more as warmth rises', () => {
    const blue = [0, 25, 50, 73, 100].map((warmth) => whiteGains({ warmth, tint: 0 })[2])
    for (let i = 1; i < blue.length; i++) assert.ok(blue[i] < blue[i - 1])
  })

  it('takes away green for a pinker tint, and red and blue for a greener one', () => {
    const [r1, g1, b1] = whiteGains({ warmth: 0, tint: -50 })
    assert.ok(g1 < r1 && g1 < b1)
    const [r2, g2, b2] = whiteGains({ warmth: 0, tint: 50 })
    assert.ok(r2 < g2 && b2 < g2)
  })

  it('gives the measured neutral for these LEDs (about 1 / 1 / 0.52)', () => {
    assertRgbClose(whiteGains(DEFAULT_CALIBRATION.fans), [0.988, 1, 0.519], 0.005)
  })
})

describe('calibrationGains', () => {
  it('equals the white balance at full brightness', () => {
    assertRgbClose(calibrationGains({ warmth: 73, tint: 2, brightness: 100 }), whiteGains({ warmth: 73, tint: 2 }), 1e-12)
  })

  it('scales by the brightness trim in linear light', () => {
    const [r] = calibrationGains({ warmth: 0, tint: 0, brightness: 80 })
    assertClose(r, srgbToLinear(0.8 * 255), 1e-12)
  })

  it('never trims below 30%', () => {
    assert.deepEqual(calibrationGains({ warmth: 0, tint: 0, brightness: 5 }), calibrationGains({ warmth: 0, tint: 0, brightness: 30 }))
  })
})

describe('sanitizeCalibration', () => {
  const fallback = DEFAULT_CALIBRATION.fans

  it('keeps valid values, rounded', () => {
    assert.deepEqual(sanitizeCalibration({ warmth: 40.4, tint: -3.6, brightness: 90 }, fallback), { warmth: 40, tint: -4, brightness: 90 })
  })

  it('clamps each value to its range', () => {
    assert.deepEqual(sanitizeCalibration({ warmth: 140, tint: -99, brightness: 2 }, fallback), { warmth: 100, tint: -50, brightness: 30 })
  })

  it('falls back for missing, non-numeric or non-finite values', () => {
    assert.deepEqual(sanitizeCalibration({ warmth: 'hot', tint: Number.NaN }, fallback), fallback)
    assert.deepEqual(sanitizeCalibration(null, fallback), fallback)
    assert.deepEqual(sanitizeCalibration('nonsense', fallback), fallback)
  })
})

describe('DEFAULT_CALIBRATION', () => {
  it('covers every white group with in-range values', () => {
    for (const { id } of WHITE_GROUPS) {
      const c = DEFAULT_CALIBRATION[id]
      assert.ok(c, `missing ${id}`)
      assert.deepEqual(sanitizeCalibration(c, c), c, `${id} is out of range`)
    }
  })
})

describe('whiteGroupFor', () => {
  it('sends ARGB headers through the fans calibration and unknown parts to the board', () => {
    assert.equal(whiteGroupFor('fans'), 'fans')
    assert.equal(whiteGroupFor('connector'), 'fans')
    assert.equal(whiteGroupFor('ram'), 'ram')
    assert.equal(whiteGroupFor('gpu'), 'gpu')
    assert.equal(whiteGroupFor('board'), 'board')
    assert.equal(whiteGroupFor('other'), 'board')
  })
})

describe('driveLed', () => {
  it('drives white fully and black not at all with unity gains', () => {
    assert.deepEqual(drive(255, 255, 255), [255, 255, 255])
    assert.deepEqual(drive(0, 0, 0), [0, 0, 0])
  })

  it('converts mid-tones to linear light', () => {
    assertRgbClose(drive(128, 128, 128), [255 * srgbToLinear(128), 255 * srgbToLinear(128), 255 * srgbToLinear(128)], 1e-9)
  })

  it('adds red to blue-violet so it does not come out plain blue', () => {
    const [r, g, b] = drive(0x7b, 0x61, 0xff)
    const lr = srgbToLinear(0x7b)
    const lb = srgbToLinear(0xff)
    assertClose(r, 255 * (lr + VIOLET_CORRECTION * (lb - Math.max(lr, srgbToLinear(0x61)))), 1e-9)
    assertClose(g, 255 * srgbToLinear(0x61), 1e-9)
    assertClose(b, 255, 1e-9)
  })

  it('leaves colors where blue does not lead untouched', () => {
    for (const [r, g, b] of [[255, 0, 0], [0, 255, 0], [0, 255, 255], [128, 128, 128], [255, 183, 197]]) {
      assertRgbClose(drive(r, g, b), [255 * srgbToLinear(r), 255 * srgbToLinear(g), 255 * srgbToLinear(b)], 1e-9)
    }
  })

  it('applies each channel gain and writes only at the given offset', () => {
    const out = [7, 7, 7, 0, 0, 0, 7]
    driveLed(255, 255, 255, [0.5, 1, 0.25], out, 3)
    assert.deepEqual(out, [7, 7, 7, 127.5, 255, 63.75, 7])
  })
})
