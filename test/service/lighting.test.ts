/**
 * The lighting engine end to end, against a fake OpenRGB server shaped like this PC (test/helpers/fake-pc.ts):
 * the motherboard (its fan header still at OpenRGB's default of 256 LEDs, the I/O cover and the chipset light),
 * two RAM sticks and a graphics card that starts in a hardware mode. Nothing here can reach real hardware.
 *
 * Failure cases (disconnects, a stuck device, broken settings) are in test/service/scenarios.
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { PacketId } from '../../src/service/openrgb/protocol.ts'
import { BOARD, GPU, KEYS, RAM } from '../helpers/fake-pc.ts'
import { assertAll, boardZones, driven, solid, startEngine, type Engine } from '../helpers/engine.ts'
import { eventually, sleep } from '../helpers/wait.ts'

let e: Engine

before(async () => {
  e = await startEngine({ scene: solid('#ffffff') })
})

after(async () => {
  await e.close()
})

describe('LightingService with a PC like this one', () => {
  it('resizes the fan connector to its measured 172 LEDs', () => {
    const resize = e.pc.server.packets(PacketId.RESIZE_ZONE).find((p) => p.devId === BOARD)
    assert.ok(resize, 'no resize sent')
    assert.deepEqual([resize.payload.readInt32LE(0), resize.payload.readInt32LE(4)], [0, 172])
    assert.equal(e.pc.ledCount(BOARD), 172 + 10 + 4)
  })

  it('puts a device that is in a hardware mode into Direct mode', () => {
    const custom = e.pc.server.packets(PacketId.SET_CUSTOM_MODE)
    assert.ok(custom.some((p) => p.devId === GPU))
    assert.equal(custom.some((p) => p.devId === BOARD), false, 'the board was already in Direct mode')
    assert.equal(e.pc.modeName(GPU), 'Direct')
  })

  it('lists every light with its friendly name and kind', () => {
    const lights = e.service.getState().lights.map((l) => [l.name, l.kind, l.ledCount, l.online])
    assert.deepEqual(lights, [
      ['Fans, Pump & Light Strip', 'fans', 172, true],
      ['Graphics Card', 'gpu', 1, true],
      ['Stick 1', 'ram', 12, true],
      ['Stick 2', 'ram', 12, true],
      ['I/O Cover', 'board', 10, true],
      ['Chipset', 'board', 4, true]
    ])
  })

  it('drives every LED with the colour conversion and calibration', async () => {
    await eventually(() => {
      const board = boardZones(e.pc.shown(BOARD))
      assertAll(board.fans, driven('fans', '#ffffff'), 'fans and strip')
      assertAll([...board.ioCover, ...board.chipset], driven('board', '#ffffff'), 'board lights')
      assertAll(e.pc.shown(RAM), driven('ram', '#ffffff'), 'RAM')
      assertAll(e.pc.shown(GPU), driven('gpu', '#ffffff'), 'graphics card')
    })
  })

  it('after connecting, switches the board to BLACK Static and back to Direct, so it never keeps a colour while off', () => {
    const board = e.pc.modeChanges.filter((m) => m.devId === BOARD)
    assert.equal(board[0].name, 'Static')
    assert.deepEqual(board[0].colors, [{ r: 0, g: 0, b: 0 }])
    assert.equal(board[1].name, 'Direct')
    assert.equal(e.pc.modeName(BOARD), 'Direct')
  })

  it('re-syncs the RAM the same way (Static, then Direct)', () => {
    assert.deepEqual(e.pc.modeChanges.filter((m) => m.devId === RAM).map((m) => m.name).slice(0, 2), ['Static', 'Direct'])
    assert.equal(e.pc.modeName(RAM), 'Direct')
  })

  it('checks scenes from the UI before using and saving them', () => {
    e.service.setScene({ kind: 'all' }, { effect: 'disco', colors: ['#ffd4dc', 'pink'], speed: 999, reverse: false, level: 100 } as never)
    assert.deepEqual(e.store.data.scene, { effect: 'static', colors: ['#ffd4dc'], speed: 100, reverse: false, level: 100 })
    assert.deepEqual(e.service.getState().scene, e.store.data.scene)
  })

  it('ignores a brightness that is not a number (it would leave every light dark until a restart)', async () => {
    e.service.setScene({ kind: 'all' }, solid('#ffffff'))
    e.service.setBrightness(Number.NaN)
    assert.equal(e.store.data.brightness, 100)
    await eventually(() => assertAll(boardZones(e.pc.shown(BOARD)).fans, driven('fans', '#ffffff'), 'fans and strip'))
  })

  it('ignores an LED count or fan ring that is not a number (OpenRGB would get 0 and every fan would go dark)', async () => {
    e.service.setScene({ kind: 'all' }, solid('#ffffff'))
    await e.service.setLedCount(KEYS.fans, Number(undefined)) // what the server makes of a missing value
    e.service.setRingLeds(KEYS.fans, Number('twenty'))

    assert.equal(e.pc.server.packets(PacketId.RESIZE_ZONE).length, 1, 'only the resize to 172 when Lumen connected')
    assert.equal(e.pc.ledCount(BOARD), 172 + 10 + 4)
    assert.deepEqual(e.store.data.lights[KEYS.fans], { ledCount: 172, ring: 20 })
    assert.equal(e.light(KEYS.fans).ledCount, 172)
    assert.equal(e.light(KEYS.fans).ringLeds, 20)
    await eventually(() => assertAll(boardZones(e.pc.shown(BOARD)).fans, driven('fans', '#ffffff'), 'fans and strip'))
  })

  it('applies a built-in scene to everything and remembers which one is active', async () => {
    e.service.applyPreset('arctic')
    const state = e.service.getState()
    assert.equal(state.activePresetId, 'arctic')
    assert.deepEqual(state.scene, solid('#bfe3ff'))
    assert.ok(state.lights.every((l) => l.scene === null), 'no light keeps its own look')
    await eventually(() => assertAll(e.pc.shown(GPU), driven('gpu', '#bfe3ff'), 'graphics card'))
  })

  it('turns every light off when switched off', async () => {
    e.service.setPower(false)
    assert.equal(e.store.data.power, false)
    await eventually(() => {
      for (const id of [BOARD, RAM, GPU]) assertAll(e.pc.shown(id), [0, 0, 0], `device ${id}`)
    })
  })
})

/**
 * The re-sync (see rearmSlowDevices) that fixes the motherboard's flashing must not get lost when it comes due at
 * the same time as the 10-minute one for the memory, or while another re-sync is still running.
 */
describe('LightingService: re-syncing the memory and the motherboard', () => {
  const boardStatics = (engine: Engine): number => engine.pc.modeChanges.filter((m) => m.devId === BOARD && m.name === 'Static').length

  it('still re-syncs the motherboard after connecting when the routine memory re-sync comes due just before', async () => {
    // The routine one comes due 1 s after starting, inside the 1.5 s before the re-sync that follows connecting.
    const engine = await startEngine({ scene: solid('#ffa3bb'), until: 'connected', rearmEveryMs: 1000 })
    try {
      await eventually(() => assert.ok(engine.logs.includes('Re-synced memory and motherboard lighting (connected).')), 6000)
      assert.deepEqual(engine.pc.modeChanges.filter((m) => m.devId === BOARD).map((m) => m.name).slice(0, 2), ['Static', 'Direct'])
      await eventually(() => {
        assert.equal(engine.pc.modeName(BOARD), 'Direct')
        assertAll(boardZones(engine.pc.shown(BOARD)).fans, driven('fans', '#ffa3bb'), 'fans and strip')
      })
    } finally {
      await engine.close()
    }
  })

  it('runs a re-sync that comes due while another is still running once that one is done, instead of skipping it', async () => {
    const engine = await startEngine({ scene: solid('#ffa3bb') })
    try {
      assert.equal(boardStatics(engine), 1, 'the re-sync after connecting')
      // A stuck RAM stick makes a re-sync slow: each of its mode changes waits for the 1 s timeout.
      engine.pc.stall(RAM)
      engine.service.refreshHardware() // as after sleep: its re-sync starts in 2 s, and then waits on the RAM
      await eventually(() => assert.equal(boardStatics(engine), 2))
      await sleep(500)
      engine.service.refreshHardware() // comes due while the first one still waits on the RAM

      await eventually(() => assert.equal(boardStatics(engine), 3), 8000)
      await eventually(() => assert.equal(engine.pc.modeName(BOARD), 'Direct'))
      // It logs once it is through, after waiting on the RAM again.
      await eventually(() => assert.equal(engine.logs.filter((l) => l === 'Re-synced memory and motherboard lighting (refresh).').length, 2), 6000)
    } finally {
      engine.pc.resume(RAM)
      await engine.close()
    }
  })
})
