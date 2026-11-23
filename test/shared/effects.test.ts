import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { hexToRgb } from '../../src/shared/color.ts'
import {
  DEFAULT_SCENE, EFFECTS, EFFECT_BY_ID, effectColors, isStaticScene, renderScene, renderStill, speedFactor, withEffect,
  type LedSegment, type RenderContext
} from '../../src/shared/effects.ts'
import type { EffectId, Scene } from '../../src/shared/types.ts'
import { assertRgbClose } from '../helpers/assert.ts'

const scene = (effect: EffectId, colors: string[], extra: Partial<Scene> = {}): Scene => ({
  effect, colors, speed: 45, reverse: false, level: 100, ...extra
})

/** The case's fan connector: one fan ring (20 LEDs, a loop) followed by the strip (152 LEDs, a run). */
const FAN_CONNECTOR: LedSegment[] = [{ start: 0, length: 20, loop: true }, { start: 20, length: 152, loop: false }]

const LAYOUTS: { name: string; count: number; layout?: LedSegment[] }[] = [
  { name: 'a single LED (graphics card)', count: 1 },
  { name: 'a 12-LED run (RAM stick)', count: 12 },
  { name: 'ring + strip (fan connector)', count: 172, layout: FAN_CONNECTOR }
]

function render(s: Scene, count: number, t: number, layout?: LedSegment[], phase = 0.25): Float32Array {
  const out = new Float32Array(count * 3)
  renderScene(s, { t, count, phase, seed: 0.42, layout }, out)
  return out
}

/** Color of LED i in a render buffer. */
const led = (out: Float32Array, i: number): number[] => [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]]

describe('EFFECTS metadata', () => {
  it('has unique ids, all reachable through EFFECT_BY_ID', () => {
    const ids = EFFECTS.map((e) => e.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const e of EFFECTS) assert.equal(EFFECT_BY_ID[e.id], e)
  })

  it('has default colors within each effect\'s own limits', () => {
    for (const e of EFFECTS) {
      const n = e.colors.defaults.length
      assert.ok(n <= e.colors.max && (e.colors.max === 0 || n >= e.colors.min), `${e.id}: ${n} defaults`)
      for (const c of e.colors.defaults) assert.match(c, /^#[0-9a-f]{6}$/i)
      if (e.colors.labels) assert.ok(e.colors.labels.length <= e.colors.max, `${e.id}: too many labels`)
    }
  })

  it('gives a background only to the effects drawn over one (Comet, Starlight)', () => {
    assert.deepEqual(EFFECTS.filter((e) => e.background !== undefined).map((e) => e.id).sort(), ['comet', 'twinkle'])
  })
})

describe('withEffect', () => {
  const sakura = scene('wave', ['#ffd4dc', '#ffa3bb', '#ffeff4'])

  it('keeps every color when trying an effect that uses fewer, so switching back loses nothing', () => {
    const solid = withEffect(sakura, 'static')
    assert.deepEqual(effectColors(solid), ['#ffd4dc'])
    assert.deepEqual(withEffect(solid, 'wave').colors, sakura.colors)
  })

  it('starts from the effect\'s own colors when the scene has too few', () => {
    assert.deepEqual(withEffect(scene('static', ['#ffd4dc']), 'gradient').colors, EFFECT_BY_ID.gradient.colors.defaults)
  })

  it('keeps colors for effects that use none (Rainbow, Spectrum)', () => {
    assert.deepEqual(withEffect(sakura, 'rainbow').colors, sakura.colors)
  })

  it('never turns a palette color into a Comet or Starlight background', () => {
    for (const effect of ['comet', 'twinkle'] as const) {
      const s = withEffect(sakura, effect)
      assert.equal(s.background, undefined, effect)
      assert.deepEqual(effectColors(s), ['#ffd4dc'], effect)
    }
  })

  it('brings the effect\'s own background along with its own colors', () => {
    const s = withEffect(scene('rainbow', []), 'comet')
    assert.deepEqual(s.colors, EFFECT_BY_ID.comet.colors.defaults)
    assert.equal(s.background, EFFECT_BY_ID.comet.background)
  })

  it('keeps a background the user set', () => {
    assert.equal(withEffect(scene('wave', [], { background: '#101a4a' }), 'twinkle').background, '#101a4a')
  })

  it('does not change the scene it is given', () => {
    const before = structuredClone(sakura)
    withEffect(sakura, 'comet')
    assert.deepEqual(sakura, before)
  })
})

describe('effectColors', () => {
  it('returns the first colors up to the effect\'s maximum', () => {
    assert.deepEqual(effectColors(scene('comet', ['#111111', '#222222', '#333333'])), ['#111111'])
    assert.deepEqual(effectColors(scene('wave', ['#111111', '#222222'])), ['#111111', '#222222'])
    assert.deepEqual(effectColors(scene('rainbow', ['#111111'])), [])
  })
})

describe('isStaticScene', () => {
  it('is true only for scenes that never change', () => {
    assert.equal(isStaticScene(scene('static', ['#ffffff'])), true)
    assert.equal(isStaticScene(scene('gradient', ['#ff0000', '#0000ff'], { speed: 0 })), true)
    assert.equal(isStaticScene(scene('gradient', ['#ff0000', '#0000ff'], { speed: 10 })), false)
    assert.equal(isStaticScene(scene('candle', ['#ff8c2a'])), false)
  })
})

describe('speedFactor', () => {
  it('grows with the slider and clamps it to 0..100', () => {
    assert.ok(speedFactor(0) < speedFactor(50) && speedFactor(50) < speedFactor(100))
    assert.equal(speedFactor(-20), speedFactor(0))
    assert.equal(speedFactor(250), speedFactor(100))
  })
})

describe('renderScene: every effect on every layout', () => {
  for (const e of EFFECTS) {
    const s = scene(e.id, [...e.colors.defaults])
    for (const { name, count, layout } of LAYOUTS) {
      it(`${e.id} on ${name} stays within 0..255 and repeats exactly`, () => {
        for (const t of [0, 0.7, 13.37, 600]) {
          const out = render(s, count, t, layout)
          for (const v of out) assert.ok(Number.isFinite(v) && v >= 0 && v <= 255.0001, `${e.id} t=${t}: value ${v}`)
          assert.deepEqual(render(s, count, t, layout), out, `${e.id} t=${t}: not deterministic`)
        }
      })
    }
  }
})

describe('renderScene: behaviour', () => {
  it('fills a static scene with exactly its color', () => {
    const out = render(scene('static', ['#ffd4dc']), 12, 5)
    for (let i = 0; i < 12; i++) assert.deepEqual(led(out, i), hexToRgb('#ffd4dc'))
  })

  it('scales everything by the scene level', () => {
    const full = render(scene('wave', ['#ffd4dc', '#ffa3bb']), 172, 3, FAN_CONNECTOR)
    const half = render(scene('wave', ['#ffd4dc', '#ffa3bb'], { level: 50 }), 172, 3, FAN_CONNECTOR)
    for (let i = 0; i < full.length; i++) assert.ok(Math.abs(half[i] - full[i] / 2) < 1e-3)
  })

  it('leaves LEDs outside the layout off', () => {
    const out = render(scene('static', ['#ffffff']), 30, 0, [{ start: 0, length: 20, loop: true }])
    for (let i = 20; i < 30; i++) assert.deepEqual(led(out, i), [0, 0, 0])
  })

  it('keeps Comet dark around the streak when it has no background', () => {
    const out = render(scene('comet', ['#ffd4dc']), 172, 2, FAN_CONNECTOR)
    const ring = Array.from({ length: 20 }, (_, i) => led(out, i))
    const dark = ring.filter(([r, g, b]) => r + g + b === 0).length
    assert.ok(dark >= 8, `expected most of the ring dark, got ${dark} of 20 dark LEDs`)
    assert.ok(ring.some(([r]) => r > 200), 'expected a bright streak')
  })

  it('draws Comet over its background when one is set', () => {
    const out = render(scene('comet', ['#ffffff'], { background: '#101a4a' }), 172, 2, FAN_CONNECTOR)
    const ring = Array.from({ length: 20 }, (_, i) => led(out, i))
    assert.ok(ring.some((c) => c.every((v, k) => Math.abs(v - hexToRgb('#101a4a')[k]) < 1e-6)), 'expected background LEDs')
    assert.ok(ring.every(([r, g, b]) => r + g + b > 0), 'no LED should be off')
  })

  it('flickers Candle deeply, its dim moments drifting toward red', () => {
    const [cr, cg] = hexToRgb('#ffb7c5')
    let minR = 255
    let maxR = 0
    for (let t = 0; t < 30; t += 0.37) {
      const out = render(scene('candle', ['#ffb7c5']), 12, t)
      for (let i = 0; i < 12; i++) {
        const [r, g] = led(out, i)
        minR = Math.min(minR, r)
        maxR = Math.max(maxR, r)
        assert.ok(r <= cr + 1e-6, 'never brighter than its color')
        assert.ok(g / r <= cg / cr + 1e-9, 'dimmer moments are never greener than the color')
      }
    }
    assert.ok(minR >= 0.45 * cr - 1e-6, `dimmest flicker ${minR} below 45%`)
    assert.ok(maxR - minR > 0.3 * cr, `flicker too shallow: ${minR}..${maxR}`)
  })

  it('draws Wave in two styles: flowing by default, even bands when asked', () => {
    const colors = ['#ff0000', '#0000ff']
    const flowing = render(scene('wave', colors), 172, 4, FAN_CONNECTOR)
    const bands = render(scene('wave', colors, { bands: true }), 172, 4, FAN_CONNECTOR)
    assert.notDeepEqual(flowing, bands)
  })

  it('alternates a one-color Wave with dark', () => {
    for (const bands of [false, true]) {
      const out = render(scene('wave', ['#ffb7c5'], { bands }), 172, 1, FAN_CONNECTOR)
      const levels = Array.from({ length: 20 }, (_, i) => led(out, i)[0])
      assert.ok(Math.min(...levels) < 0.2 * Math.max(...levels), `bands=${bands}: no dark part, ${levels.join(', ')}`)
    }
  })

  it('reverses direction with the reverse flag', () => {
    const s = scene('gradient', ['#ff0000', '#00ff00', '#0000ff'])
    const ahead = render(s, 172, 1.5, FAN_CONNECTOR)
    assert.deepEqual(render({ ...s, reverse: true }, 172, -1.5, FAN_CONNECTOR), ahead)
  })
})

describe('renderStill', () => {
  const ctx: Omit<RenderContext, 't'> = { count: 12, phase: 0.5, seed: 0.42 }

  it('freezes every effect: the same output every time', () => {
    for (const e of EFFECTS) {
      const a = new Float32Array(36)
      const b = new Float32Array(36)
      renderStill(scene(e.id, [...e.colors.defaults]), ctx, a)
      renderStill(scene(e.id, [...e.colors.defaults]), ctx, b)
      assert.deepEqual(a, b, e.id)
    }
  })

  it('shows Breathe as its still colors at a lower, average level', () => {
    const breathe = new Float32Array(36)
    const gradient = new Float32Array(36)
    const colors = ['#ffd4dc', '#ffa3bb']
    renderStill(scene('breathing', colors), ctx, breathe)
    renderScene(scene('gradient', colors, { speed: 0 }), { ...ctx, t: 0 }, gradient)
    const k = breathe[0] / gradient[0]
    assert.ok(k > 0.2 && k < 1, `average level ${k}`)
    for (let i = 0; i < 36; i++) assert.ok(Math.abs(breathe[i] - gradient[i] * k) < 1e-3)
  })

  it('shows Spectrum as a still rainbow', () => {
    const still = new Float32Array(36)
    const rainbow = new Float32Array(36)
    renderStill(scene('spectrum', []), ctx, still)
    renderScene(scene('rainbow', []), { ...ctx, t: 0 }, rainbow)
    assertRgbClose(still, rainbow, 1e-6)
  })
})

describe('DEFAULT_SCENE', () => {
  it('is a valid static scene', () => {
    assert.equal(DEFAULT_SCENE.effect, 'static')
    assert.equal(DEFAULT_SCENE.colors.length, 1)
  })
})
