import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EFFECT_BY_ID, sanitizeScene } from '../../src/shared/effects.ts'
import { BUILT_IN_PRESETS } from '../../src/shared/presets.ts'

describe('built-in scenes', () => {
  it('have unique ids and are marked built in', () => {
    const ids = BUILT_IN_PRESETS.map((p) => p.id)
    assert.equal(new Set(ids).size, ids.length)
    for (const p of BUILT_IN_PRESETS) assert.equal(p.builtIn, true, p.id)
  })

  it('use known effects with a valid number of colors', () => {
    for (const { id, scene } of BUILT_IN_PRESETS) {
      const meta = EFFECT_BY_ID[scene.effect]
      assert.ok(meta, `${id}: unknown effect ${scene.effect}`)
      if (meta.colors.max === 0) assert.equal(scene.colors.length, 0, id)
      else assert.ok(scene.colors.length >= meta.colors.min && scene.colors.length <= meta.colors.max, `${id}: ${scene.colors.length} colors`)
    }
  })

  it('pass the service\'s scene check unchanged', () => {
    for (const { id, scene } of BUILT_IN_PRESETS) assert.deepEqual(sanitizeScene(scene), scene, id)
  })

  it('keep Starlight\'s navy background as a background, not as a second color', () => {
    const starlight = BUILT_IN_PRESETS.find((p) => p.id === 'starlight')
    assert.deepEqual(starlight?.scene.colors, ['#fff3d6'])
    assert.equal(starlight?.scene.background, '#101a4a')
  })

  // The user chose these colors on their PC on 2026-11-19, after a long search for the original look. If this test
  // fails, the change must have been agreed with them first.
  it('keep the Sakura the user chose', () => {
    const sakura = BUILT_IN_PRESETS.find((p) => p.id === 'sakura')
    assert.deepEqual(sakura?.scene, { effect: 'wave', colors: ['#ffd4dc', '#ffa3bb', '#ffeff4'], speed: 18, reverse: false, level: 100 })
  })
})
