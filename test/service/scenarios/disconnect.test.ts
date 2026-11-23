/**
 * Scenario: a device disconnects in the middle of an update. Two ways this happens on this PC:
 * - OpenRGB itself goes away (its service restarts or crashes): every device is unreachable at once.
 * - One device drops out of OpenRGB's list (after a rescan, or a USB/SMBus hiccup) while the rest carry on.
 *
 * Each test checks what the user sees (the state sent to the window, and what the LEDs really show) and what
 * Lumen believes about the device (whether it counts it as reachable, and whether it re-sends rather than
 * assuming the hardware kept its last colors).
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { PacketId } from '../../../src/service/openrgb/protocol.ts'
import { BOARD, GPU, KEYS, RAM } from '../../helpers/fake-pc.ts'
import { assertAll, boardZones, driven, solid, startEngine, type Engine } from '../../helpers/engine.ts'
import { eventually, sleep } from '../../helpers/wait.ts'

let e: Engine | undefined
afterEach(async () => {
  await e?.close()
  e = undefined
})

/** Every device really shows `color` (RAM and the GPU at their own calibration). */
function assertShows(engine: Engine, color: string, gpuId = GPU): void {
  const board = boardZones(engine.pc.shown(BOARD))
  assertAll(board.fans, driven('fans', color), 'fans and strip')
  assertAll(board.ioCover, driven('board', color), 'I/O cover')
  assertAll(board.chipset, driven('board', color), 'chipset')
  assertAll(engine.pc.shown(RAM), driven('ram', color), 'RAM')
  assertAll(engine.pc.shown(gpuId), driven('gpu', color), 'graphics card')
}

describe('Scenario: OpenRGB goes away in the middle of an update', () => {
  it('shows OpenRGB as unreachable with every light offline, keeps a change made meanwhile, and applies it once back', async () => {
    e = await startEngine({ scene: solid('#ffffff') })
    const keys = e.service.getState().lights.map((l) => l.key)

    e.service.setScene({ kind: 'all' }, solid('#ffa3bb')) // frames for this are on their way...
    e.pc.restartOpenRGB() // ...when OpenRGB drops every connection

    // The window: OpenRGB unreachable, every light still listed but offline, the new look kept.
    await eventually(() => assert.equal(e!.service.getState().connection, 'offline'))
    const offline = e.service.getState()
    assert.deepEqual(offline.lights.map((l) => l.key), keys, 'lights stay listed while OpenRGB is away')
    assert.ok(offline.lights.every((l) => !l.online), 'no light may look reachable')
    assert.deepEqual(offline.scene, solid('#ffa3bb'))

    // A change made while OpenRGB is away is saved, and is what the lights show once it's back.
    e.service.setScene({ kind: 'all' }, solid('#00c6ff'))
    await eventually(() => assert.equal(e!.service.getState().connection, 'connected'))
    await eventually(() => assertShows(e!, '#00c6ff'))
    assert.ok(e.service.getState().lights.every((l) => l.online))
    assert.deepEqual(e.store.data.scene, solid('#00c6ff'))
  })

  it('puts every light back when OpenRGB restarts and the devices reset, without being asked', async () => {
    e = await startEngine({ scene: solid('#ffa3bb') })
    await eventually(() => assertShows(e!, '#ffa3bb'))

    e.pc.restartOpenRGB({ resetDevices: true }) // the scene didn't change, but the LEDs went dark

    // Lumen doesn't assume the devices kept their colors: it sends every device a full frame again.
    await eventually(() => assertShows(e!, '#ffa3bb'))
    assert.equal(e.service.getState().connection, 'connected')
  })

  it('leaves the board in Direct mode showing the scene when the drop comes mid re-sync (not stuck in black Static)', async () => {
    e = await startEngine({ scene: solid('#ffa3bb'), until: 'connected' })
    // The re-sync after connecting puts the board in a black Static mode, then back to Direct. Drop in between.
    await eventually(() => assert.equal(e!.pc.modeName(BOARD), 'Static'))
    e.pc.restartOpenRGB()
    assert.equal(e.pc.modeName(BOARD), 'Static', 'the board really is left in black Static by the drop')

    await eventually(() => assert.equal(e!.service.getState().connection, 'connected'))
    await eventually(() => {
      assert.equal(e!.pc.modeName(BOARD), 'Direct')
      assertShows(e!, '#ffa3bb')
    })
  })
})

describe('Scenario: one device drops out of OpenRGB\'s list mid-update', () => {
  it('keeps it listed as offline with its own look, keeps the others updating, and restores it when it returns', async () => {
    e = await startEngine({ scene: solid('#ffffff') })
    e.service.setScene({ kind: 'lights', keys: [KEYS.gpu] }, solid('#7a5cff')) // the graphics card's own look
    await eventually(() => assertAll(e!.pc.shown(GPU), driven('gpu', '#7a5cff'), 'graphics card'))

    e.pc.unplug(GPU) // it leaves the list; OpenRGB announces the change

    // The window: still listed under its name, offline, with its own look kept. Everything else is fine.
    await eventually(() => assert.equal(e!.light(KEYS.gpu).online, false))
    const state = e.service.getState()
    assert.equal(state.connection, 'connected')
    assert.equal(e.light(KEYS.gpu).name, 'Graphics Card')
    assert.deepEqual(e.light(KEYS.gpu).scene, solid('#7a5cff'))
    assert.ok(state.lights.filter((l) => l.key !== KEYS.gpu).every((l) => l.online), 'the other lights stay online')

    // Lumen knows it's gone: it stops sending it frames, while the others still get every change.
    const sentToGpu = (): number => e!.pc.server.packets(PacketId.UPDATE_LEDS).filter((p) => p.devId === GPU).length
    const before = sentToGpu()
    e.service.setScene({ kind: 'all' }, solid('#ffa3bb'))
    await eventually(() => {
      assertAll(boardZones(e!.pc.shown(BOARD)).fans, driven('fans', '#ffa3bb'), 'fans and strip')
      assertAll(e!.pc.shown(RAM), driven('ram', '#ffa3bb'), 'RAM')
    })
    await sleep(300)
    assert.equal(sentToGpu(), before, 'no frames to a device that is gone')

    // It comes back reset (dark, in its own Static mode) under a new OpenRGB id: Lumen takes it over again.
    e.pc.plugIn(GPU, { newId: 7 })
    await eventually(() => {
      assert.equal(e!.light(KEYS.gpu).online, true)
      assert.equal(e!.pc.modeName(7), 'Direct')
      assertAll(e!.pc.shown(7), driven('gpu', '#7a5cff'), 'graphics card, back with its own look')
    })
  })

  it('finds out on its own when a device vanished between OpenRGB listing it and Lumen reading it', async () => {
    e = await startEngine({ scene: solid('#ffffff') })

    // OpenRGB's list still names the graphics card, but it no longer answers. A change notice makes Lumen read
    // the devices; the card's details never come.
    e.pc.unplug(GPU, { announce: false, stillListed: true })
    e.pc.announce()
    await eventually(() => assert.ok(e!.logs.some((l) => l.startsWith('No answer from Gigabyte GeForce RTX 5080 Aero OC'))))

    // The rest still works while Lumen waits.
    assert.equal(e.service.getState().connection, 'connected')
    e.service.setScene({ kind: 'all' }, solid('#ffa3bb'))
    await eventually(() => assertAll(boardZones(e!.pc.shown(BOARD)).fans, driven('fans', '#ffa3bb'), 'fans and strip'))

    // OpenRGB's list catches up without another notice: Lumen's own retry notices that the card is gone.
    e.pc.unlist(GPU)
    await eventually(() => assert.equal(e!.light(KEYS.gpu).online, false))
    assert.equal(e.service.getState().connection, 'connected')
  })
})
