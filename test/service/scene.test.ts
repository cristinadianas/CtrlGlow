import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EFFECT_BY_ID, sanitizeScene } from '../../src/shared/effects.ts'
import type { Scene } from '../../src/shared/types.ts'
import { layoutFor, lightKey } from '../../src/service/lighting.ts'
import type { Controller, Zone } from '../../src/service/openrgb/types.ts'

/** Scenes arrive from the web UI as untrusted JSON, so anything can come in. */
const untrusted = (value: unknown): Scene => value as Scene

describe('sanitizeScene', () => {
  it('keeps a valid scene as it is', () => {
    const s: Scene = { effect: 'wave', colors: ['#ffd4dc', '#ffa3bb'], speed: 18, reverse: true, level: 70, bands: true }
    assert.deepEqual(sanitizeScene(s), s)
  })

  it('turns missing or junk input into a static scene with its default color', () => {
    for (const input of [null, undefined, 42, 'wave', {}]) {
      const s = sanitizeScene(untrusted(input))
      assert.equal(s.effect, 'static')
      assert.deepEqual(s.colors, EFFECT_BY_ID.static.colors.defaults)
    }
  })

  it('replaces an unknown effect with Solid', () => {
    assert.equal(sanitizeScene(untrusted({ effect: 'disco', colors: ['#ffffff'] })).effect, 'static')
  })

  it('drops anything that is not a #rrggbb color and keeps at most four', () => {
    const s = sanitizeScene(untrusted({
      effect: 'wave', colors: ['#111111', 'red', 12, '#22222', '#333333', '#444444', '#555555', '#666666']
    }))
    assert.deepEqual(s.colors, ['#111111', '#333333', '#444444', '#555555'])
  })

  it('gives an effect its own colors (and background) when none are valid', () => {
    const s = sanitizeScene(untrusted({ effect: 'comet', colors: ['nope'] }))
    assert.deepEqual(s.colors, EFFECT_BY_ID.comet.colors.defaults)
    assert.equal(s.background, EFFECT_BY_ID.comet.background)
  })

  it('keeps no colors for effects that use none', () => {
    assert.deepEqual(sanitizeScene(untrusted({ effect: 'rainbow', colors: [] })).colors, [])
  })

  it('clamps speed and level to 0..100 and fills in defaults', () => {
    const clamped = sanitizeScene(untrusted({ effect: 'wave', colors: ['#ffffff'], speed: 250, level: -5 }))
    assert.equal(clamped.speed, 100)
    assert.equal(clamped.level, 0)
    const filled = sanitizeScene(untrusted({ effect: 'wave', colors: ['#ffffff'], speed: 'fast', level: Number.NaN }))
    assert.equal(filled.speed, 45)
    assert.equal(filled.level, 100)
  })

  it('keeps a valid background and drops an invalid one', () => {
    assert.equal(sanitizeScene(untrusted({ effect: 'comet', colors: ['#ffffff'], background: '#101a4a' })).background, '#101a4a')
    assert.equal('background' in sanitizeScene(untrusted({ effect: 'comet', colors: ['#ffffff'], background: 'navy' })), false)
  })

  it('only sets bands for exactly true, and reverse only when truthy', () => {
    assert.equal('bands' in sanitizeScene(untrusted({ effect: 'wave', colors: ['#ffffff'], bands: 'yes' })), false)
    assert.equal(sanitizeScene(untrusted({ effect: 'wave', colors: ['#ffffff'], reverse: 1 })).reverse, true)
    assert.equal(sanitizeScene(untrusted({ effect: 'wave', colors: ['#ffffff'] })).reverse, false)
  })
})

describe('layoutFor', () => {
  it('is one run when there is no shared ring', () => {
    assert.deepEqual(layoutFor(24), [{ start: 0, length: 24, loop: false }])
    assert.deepEqual(layoutFor(24, 0), [{ start: 0, length: 24, loop: false }])
  })

  it('splits the fan connector into the shared fan ring and the strip', () => {
    assert.deepEqual(layoutFor(172, 20), [
      { start: 0, length: 20, loop: true },
      { start: 20, length: 152, loop: false }
    ])
  })

  it('ignores a ring that is too small or covers everything', () => {
    assert.deepEqual(layoutFor(20, 1), [{ start: 0, length: 20, loop: false }])
    assert.deepEqual(layoutFor(20, 20), [{ start: 0, length: 20, loop: false }])
  })
})

describe('lightKey', () => {
  it('is "controller|zone", the key stored in settings.json', () => {
    const key = lightKey({ name: 'X870E AORUS PRO X3D ICE' } as Controller, { name: 'ARGB_V2_1' } as Zone)
    assert.equal(key, 'X870E AORUS PRO X3D ICE|ARGB_V2_1')
  })
})
