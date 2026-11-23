import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { DEFAULT_CALIBRATION } from '../../src/shared/calibration.ts'
import { DEFAULT_SCENE } from '../../src/shared/effects.ts'
import { Store } from '../../src/service/store.ts'
import { eventually } from '../helpers/wait.ts'

const FANS = 'X870E AORUS PRO X3D ICE|ARGB_V2_1'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lumen-store-test-'))
  file = join(dir, 'settings.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Writes a settings file as an older (or current) Lumen would have, then loads it. */
function load(raw: unknown, path = file): Store {
  writeFileSync(path, typeof raw === 'string' ? raw : JSON.stringify(raw))
  return new Store(path)
}

const backups = (): string[] => readdirSync(dir).filter((f) => f.includes('.backup-'))

describe('Store: defaults', () => {
  it('starts with safe defaults when there is no settings file', () => {
    const { data } = new Store(file)
    assert.equal(data.version, 3)
    assert.equal(data.power, true)
    assert.deepEqual(data.scene, DEFAULT_SCENE)
    assert.deepEqual(data.presets, [])
    assert.equal(data.prefs.launchAtLogin, false, 'starting at sign-in must be opt-in')
    assert.deepEqual(data.prefs.calibration, DEFAULT_CALIBRATION)
    assert.deepEqual(data.lights[FANS], { ledCount: 172, ring: 20 })
  })

  it('falls back to defaults for a corrupt settings file, keeping the original as a backup', () => {
    const store = load('{ this is not json')
    assert.deepEqual(store.data.scene, DEFAULT_SCENE)
    const [backup, ...more] = backups()
    assert.deepEqual(more, [])
    assert.equal(readFileSync(join(dir, backup), 'utf8'), '{ this is not json')
    assert.equal(store.problems.length, 1)
    assert.ok(store.problems[0].includes(backup), 'the log names the backup')
  })

  it('does not share default objects between stores', () => {
    const a = new Store(file)
    a.data.lights[FANS].ledCount = 5
    a.data.prefs.calibration.fans.warmth = 1
    const b = new Store(join(dir, 'other.json'))
    assert.equal(b.data.lights[FANS].ledCount, 172)
    assert.equal(b.data.prefs.calibration.fans.warmth, DEFAULT_CALIBRATION.fans.warmth)
  })
})

describe('Store: loading and migrations', () => {
  it('keeps the user\'s settings', () => {
    const scene = { effect: 'candle', colors: ['#ffced9'], speed: 22, reverse: false, level: 100 }
    const { data } = load({ version: 3, power: false, brightness: 58, scene, presets: [], activePresetId: null })
    assert.equal(data.power, false)
    assert.equal(data.brightness, 58)
    assert.deepEqual(data.scene, scene)
  })

  it('moves v1\'s 256-LED fan connector to the measured 172 + 20-LED ring', () => {
    const { data } = load({ version: 1, lights: { [FANS]: { ledCount: 256, name: 'Fans' } } })
    assert.deepEqual(data.lights[FANS], { ledCount: 172, ring: 20, name: 'Fans' })
  })

  it('moves a v2 Comet or Starlight background out of the colors', () => {
    const comet = { effect: 'comet', colors: ['#ffffff', '#1a1f4d'], speed: 45, reverse: false, level: 100 }
    const twinkle = { effect: 'twinkle', colors: ['#fff3d6', '#101a4a'], speed: 40, reverse: false, level: 100 }
    const { data } = load({
      version: 2,
      scene: comet,
      lights: { 'GPU|Side': { scene: twinkle } },
      presets: [{ id: 'user-1', name: 'Mine', scene: comet, overrides: { 'GPU|Side': twinkle } }]
    })
    const moved = (s: unknown): void => {
      const x = s as { colors: string[]; background?: string }
      assert.equal(x.colors.length, 1)
      assert.ok(x.background)
    }
    assert.deepEqual(data.scene, { ...comet, colors: ['#ffffff'], background: '#1a1f4d' })
    moved(data.lights['GPU|Side'].scene)
    moved(data.presets[0].scene)
    moved(data.presets[0].overrides['GPU|Side'])
  })

  it('leaves a palette of three or more colors alone (it is not a background)', () => {
    const comet = { effect: 'comet', colors: ['#ffd4dc', '#ffa3bb', '#ffeff4'], speed: 18, reverse: false, level: 100 }
    const { data } = load({ version: 2, scene: comet })
    assert.deepEqual(data.scene, comet)
  })

  it('does not migrate again once the file is at v3', () => {
    const comet = { effect: 'comet', colors: ['#ffffff', '#1a1f4d'], speed: 45, reverse: false, level: 100 }
    const { data } = load({ version: 3, scene: comet })
    assert.deepEqual(data.scene, comet)
  })

  it('checks every calibration value and fills in missing parts', () => {
    const { data } = load({ version: 3, prefs: { calibration: { fans: { warmth: 500, tint: 2, brightness: 100 } } } })
    assert.equal(data.prefs.calibration.fans.warmth, 100)
    assert.deepEqual(data.prefs.calibration.ram, DEFAULT_CALIBRATION.ram)
  })

  it('drops the short-lived "warmth" and "whiteBalance" settings', () => {
    const { data } = load({ version: 3, prefs: { fps: 30, warmth: 40, whiteBalance: [1, 1, 0.8] } })
    assert.equal(data.prefs.fps, 30)
    assert.equal('warmth' in data.prefs, false)
    assert.equal('whiteBalance' in data.prefs, false)
  })
})

describe('Store: malformed settings', () => {
  it('loads a valid file as it is: no problems reported, no backup, the file untouched', () => {
    const store = new Store(file)
    store.data.brightness = 58
    store.data.presets.push({ id: 'user-1', name: 'Blush', scene: { effect: 'wave', colors: ['#edb7be', '#e39fa8'], speed: 30, reverse: false, level: 100, bands: true }, overrides: {} })
    store.updateLight(FANS, { name: 'Fans', scene: null })
    store.flush()
    const saved = readFileSync(file, 'utf8')
    const again = new Store(file)
    assert.deepEqual(again.problems, [])
    assert.deepEqual(backups(), [])
    assert.equal(readFileSync(file, 'utf8'), saved)
  })

  it('treats valid JSON that holds no settings (null, a list, a number, a string) like an unreadable file', () => {
    ;['null', '[1, 2]', '42', '"text"'].forEach((raw, i) => {
      const store = load(raw, join(dir, `case${i}.json`))
      assert.deepEqual(store.data.scene, DEFAULT_SCENE, raw)
      assert.match(store.problems[0], /didn't contain settings/, raw)
    })
    assert.equal(backups().length, 4)
  })

  it('rounds brightness and clamps it to 1..100, and resets one that is not a number', () => {
    const cases: [unknown, number][] = [[250, 100], [0, 1], [57.6, 58], ['loud', 100], [true, 100]]
    cases.forEach(([raw, want], i) => {
      const store = load({ version: 3, brightness: raw }, join(dir, `b${i}.json`))
      assert.equal(store.data.brightness, want, String(raw))
      assert.match(store.problems[0], /brightness/)
    })
  })

  it('turns on starting at sign-in only for an explicit true', () => {
    ;['yes', 1, 'true', null, {}].forEach((raw, i) => {
      assert.equal(load({ version: 3, prefs: { launchAtLogin: raw } }, join(dir, `l${i}.json`)).data.prefs.launchAtLogin, false, String(raw))
    })
    assert.equal(load({ version: 3, prefs: { launchAtLogin: true } }).data.prefs.launchAtLogin, true)
  })

  it('accepts only 30 or 60 frames a second (0 would spin the CPU)', () => {
    ;[0, 144, '60', -1].forEach((raw, i) => {
      assert.equal(load({ version: 3, prefs: { fps: raw } }, join(dir, `f${i}.json`)).data.prefs.fps, 60, String(raw))
    })
    assert.equal(load({ version: 3, prefs: { fps: 30 } }).data.prefs.fps, 30)
  })

  it('replaces a light\'s defaults as a whole entry, so a fan ring the user removed stays removed', () => {
    const store = load({ version: 3, lights: { [FANS]: { ledCount: 172 } } })
    assert.deepEqual(store.data.lights[FANS], { ledCount: 172 })
    assert.deepEqual(store.problems, [])
  })

  it('makes every stored scene valid: an unknown effect becomes Solid, a broken own look follows All Lights', () => {
    const store = load({
      version: 3,
      lights: { 'GPU|Side': { scene: { effect: 'fire', colors: ['#ff0000'] } }, 'RAM|Slot 2': { scene: 'purple' } }
    })
    assert.deepEqual(store.data.lights['GPU|Side'].scene, { effect: 'static', colors: ['#ff0000'], speed: 45, reverse: false, level: 100 })
    assert.equal(store.data.lights['RAM|Slot 2'].scene, null)
  })

  it('leaves a settings file it cannot back up alone (here, a folder in its place)', () => {
    mkdirSync(file)
    const store = new Store(file)
    assert.deepEqual(store.data.scene, DEFAULT_SCENE)
    assert.match(store.problems[0], /a backup couldn't be made/)
    assert.ok(statSync(file).isDirectory(), 'nothing was written over it')
  })
})

describe('Store: saving', () => {
  it('writes the settings and reads them back the same', () => {
    const store = new Store(file)
    store.data.brightness = 58
    store.updateLight(FANS, { name: 'Fans, Pump & Light Strip' })
    store.flush()
    const again = new Store(file)
    assert.deepEqual(again.data, store.data)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).brightness, 58)
  })

  it('leaves no temporary file behind', () => {
    const store = new Store(file)
    store.flush()
    assert.deepEqual(readdirSync(dir), ['settings.json'])
  })

  it('creates the settings folder if it is missing', () => {
    const nested = join(dir, 'Lumen', 'settings.json')
    new Store(nested).flush()
    assert.ok(existsSync(nested))
  })

  it('merges light updates instead of replacing them', () => {
    const store = new Store(file)
    store.updateLight(FANS, { hidden: true })
    assert.deepEqual(store.light(FANS), { ledCount: 172, ring: 20, hidden: true })
    store.flush()
  })

  it('reports a failed save once, keeps trying until it works, then says so (a change is not lost silently)', async () => {
    const reports: string[] = []
    const store = new Store(file, { report: (m) => reports.push(m) })
    mkdirSync(file) // something holds the settings file's name, as a scanner briefly holding it does on Windows
    store.data.brightness = 42
    assert.equal(store.flush(), false)
    store.data.brightness = 43
    store.save()
    assert.equal(store.flush(), false)
    assert.equal(reports.length, 1, 'one report for the whole failure, not one per change')
    assert.match(reports[0], /^Couldn't save the settings \(.+\); Lumen will keep trying\.$/)

    rmSync(file, { recursive: true }) // the file is free again: the retry saves the latest settings on its own
    await eventually(() => assert.equal(JSON.parse(readFileSync(file, 'utf8')).brightness, 43), 4000)
    assert.deepEqual(reports.slice(1), ['The settings are saved again.'])
    assert.equal(store.flush(), true)
    assert.equal(reports.length, 2)
  })
})
