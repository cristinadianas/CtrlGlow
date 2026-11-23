/**
 * Scenario: Lumen starts with an old or malformed settings file (from an older Lumen, a hand edit, or a disk
 * problem). Each test starts the whole engine from that file and checks what the user sees (the window's state
 * and what the LEDs really show) and what Lumen believes (the settings it runs on and saves back).
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { DEFAULT_CALIBRATION } from '../../../src/shared/calibration.ts'
import { DEFAULT_SCENE, EFFECT_BY_ID } from '../../../src/shared/effects.ts'
import type { Preset, Scene } from '../../../src/shared/types.ts'
import { PacketId } from '../../../src/service/openrgb/protocol.ts'
import { Store } from '../../../src/service/store.ts'
import { BOARD, KEYS } from '../../helpers/fake-pc.ts'
import { assertAll, boardZones, driven, startEngine, type Engine } from '../../helpers/engine.ts'
import { eventually } from '../../helpers/wait.ts'

let e: Engine | undefined
afterEach(async () => {
  await e?.close()
  e = undefined
})

const CANDLE: Scene = { effect: 'candle', colors: ['#ffc5d0', '#ffa3bb', '#ffeff4'], speed: 46, reverse: false, level: 100 }
const BLUSH: Preset = {
  id: 'user-blush',
  name: 'Blush',
  scene: { effect: 'wave', colors: ['#edb7be', '#e39fa8', '#f7cad0'], speed: 30, reverse: false, level: 100, bands: true },
  overrides: {}
}

const backups = (engine: Engine): string[] => readdirSync(engine.dir).filter((f) => f.startsWith('settings.backup-'))
const fansShow = (engine: Engine, expected: number[]): void => assertAll(boardZones(engine.pc.shown(BOARD)).fans, expected, 'fans and strip')

describe('Scenario: old or malformed settings on startup', () => {
  it('an unreadable file: starts with the defaults, keeps the original as a backup, and saves a clean file', async () => {
    const broken = '{ "power": true, "scene": { "effect": "wave", '
    e = await startEngine({ settings: broken })

    // What the user sees: the default look, on every light.
    await eventually(() => fansShow(e!, driven('fans', DEFAULT_SCENE.colors[0])))
    const state = e.service.getState()
    assert.deepEqual(state.scene, DEFAULT_SCENE)
    assert.equal(state.prefs.launchAtLogin, false)

    // Nothing is lost for good: the original is kept next to the settings, byte for byte, and the log says where.
    assert.equal(backups(e).length, 1)
    assert.equal(readFileSync(join(e.dir, backups(e)[0]), 'utf8'), broken)
    assert.match(e.store.problems.join('\n'), /couldn't be read.*The original was kept as settings\.backup-/)

    // The settings file is valid again, so the next start is clean and makes no second backup.
    assert.deepEqual(new Store(e.settingsFile).problems, [])
    assert.equal(backups(e).length, 1)
  })

  it('an oldest-format (v1) file: the fans get their measured 172 LEDs and 20-LED rings; the look and names stay', async () => {
    e = await startEngine({
      settings: {
        power: true, brightness: 80,
        scene: { effect: 'static', colors: ['#ffc5d0'], speed: 46, reverse: false }, // v1 scenes had no level
        lights: { [KEYS.fans]: { ledCount: 256, name: 'Case fans' } }
      }
    })

    const resize = e.pc.server.packets(PacketId.RESIZE_ZONE).find((p) => p.devId === BOARD)
    assert.ok(resize, 'the fan header was not resized')
    assert.deepEqual([resize.payload.readInt32LE(0), resize.payload.readInt32LE(4)], [0, 172])
    const fans = e.light(KEYS.fans)
    assert.deepEqual([fans.name, fans.ledCount, fans.ringLeds], ['Case fans', 172, 20])
    await eventually(() => fansShow(e!, driven('fans', '#ffc5d0', 0.8)))

    // An old but valid file is migrated, not "repaired": no warning, no backup.
    assert.deepEqual(e.store.problems, [])
    assert.deepEqual(backups(e), [])
  })

  it('a v2 file with Comet over a background: the comet runs over that background, not as a second streak color', async () => {
    e = await startEngine({ settings: { version: 2, scene: { effect: 'comet', colors: ['#ffffff', '#1a1f4d'], speed: 45, reverse: false, level: 100 } } })

    const { scene } = e.service.getState()
    assert.deepEqual(scene.colors, ['#ffffff'])
    assert.equal(scene.background, '#1a1f4d')
    const bg = driven('fans', '#1a1f4d')
    await eventually(() => {
      const leds = boardZones(e!.pc.shown(BOARD)).fans
      const onBackground = leds.filter((led) => led.every((v, i) => v === bg[i])).length
      assert.ok(onBackground > leds.length / 2, `${onBackground} of ${leds.length} LEDs show the background`)
    })
    assert.deepEqual(e.store.problems, [])
  })

  it('one broken entry in an older file no longer wipes every setting, saved scenes included', async () => {
    // Until 2026-11-23, a single null light entry in a pre-v3 file made Lumen start from its defaults and then
    // save them over the file: every saved scene was gone.
    e = await startEngine({ settings: { version: 2, scene: CANDLE, lights: { 'Old device|Zone': null }, presets: [BLUSH] } })

    const state = e.service.getState()
    assert.deepEqual(state.scene, CANDLE)
    assert.deepEqual(state.presets.filter((p) => !p.builtIn), [BLUSH])
    assert.match(e.store.problems.join('\n'), /invalid and were reset: lights\["Old device\|Zone"\]\./)
    assert.equal(backups(e).length, 1)
  })

  it('wrong values everywhere: Lumen still starts, lights everything, keeps what is valid, and never turns on starting at sign-in', async () => {
    const raw = {
      version: 3, power: 'yes', brightness: 'loud',
      scene: { effect: 'disco', colors: 'pink', speed: 'fast' },
      lights: {
        [KEYS.gpu]: null,
        [KEYS.stick2]: { name: 'Bottom stick', scene: 'purple', hidden: 'no' },
        [KEYS.fans]: { ledCount: '172', ring: 'twenty' }
      },
      presets: [null, 'Blush', { ...BLUSH, overrides: null }, { name: 'No id' }],
      activePresetId: 42,
      prefs: { launchAtLogin: 'yes', fps: 0, calibration: 'warm' }
    }
    e = await startEngine({ settings: raw })
    const state = e.service.getState()

    // The window only ever gets valid settings (an unknown effect would break the window, too).
    assert.equal(state.connection, 'connected')
    assert.deepEqual([state.power, state.brightness, state.activePresetId], [true, 100, null])
    assert.deepEqual(state.prefs, { launchAtLogin: false, fps: 60, calibration: DEFAULT_CALIBRATION })
    const scenes = [state.scene, ...state.lights.map((l) => l.scene), ...state.presets.flatMap((p) => [p.scene, ...Object.values(p.overrides)])]
    for (const s of scenes) if (s) assert.ok(EFFECT_BY_ID[s.effect], `unknown effect ${s.effect}`)

    // Every light is lit at full brightness: a brightness that isn't a number doesn't leave them dark.
    assert.equal(state.scene.effect, 'static')
    await eventually(() => fansShow(e!, driven('fans', state.scene.colors[0])))

    // Invalid values fall back to the defaults (the fan header keeps its measured layout); valid ones stay.
    const fans = e.light(KEYS.fans)
    assert.deepEqual([fans.ledCount, fans.ringLeds], [172, 20])
    const stick2 = e.light(KEYS.stick2)
    assert.deepEqual([stick2.name, stick2.scene, stick2.hidden], ['Bottom stick', null, false])
    assert.equal(e.light(KEYS.gpu).name, 'Graphics Card')

    // The valid saved scene survives, and applying it works (its broken overrides became "none").
    assert.deepEqual(state.presets.filter((p) => !p.builtIn), [BLUSH])
    e.service.applyPreset(BLUSH.id)
    assert.equal(e.service.getState().activePresetId, BLUSH.id)
    assert.deepEqual(e.service.getState().scene, BLUSH.scene)

    // The log names every invalid value, and the original file was kept.
    const problems = e.store.problems.join('\n')
    for (const path of [
      'power', 'brightness', 'scene', `lights["${KEYS.gpu}"]`, `lights["${KEYS.stick2}"].scene`, `lights["${KEYS.stick2}"].hidden`,
      `lights["${KEYS.fans}"].ledCount`, `lights["${KEYS.fans}"].ring`, 'presets[0]', 'presets[1]', 'presets[2].overrides', 'presets[3]',
      'activePresetId', 'prefs.launchAtLogin', 'prefs.fps', 'prefs.calibration'
    ]) assert.ok(problems.includes(path), `not reported: ${path}`)
    assert.equal(backups(e).length, 1)
    assert.deepEqual(JSON.parse(readFileSync(join(e.dir, backups(e)[0]), 'utf8')), raw)
  })
})
