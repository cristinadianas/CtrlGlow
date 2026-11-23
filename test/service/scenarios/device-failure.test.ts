/**
 * Scenario: one device fails while a preset changes several at once. With OpenRGB, a failing device never
 * reports an error: OpenRGB applies each device's updates on that device's own worker and acknowledges them
 * only afterwards, so a device whose worker hangs (a stuck USB or SMBus write) simply stops acknowledging.
 *
 * Each test checks what the user sees (the window's state and what each device really shows) and what Lumen
 * believes (whether it counts the device as responding, and what it delivers once the device recovers).
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { PacketId } from '../../../src/service/openrgb/protocol.ts'
import type { Preset } from '../../../src/shared/types.ts'
import { BOARD, FakePC, GPU, KEYS, RAM } from '../../helpers/fake-pc.ts'
import { TEST_TIMEOUT_MS, assertAll, boardZones, driven, solid, startEngine, type Engine } from '../../helpers/engine.ts'
import { eventually, sleep } from '../../helpers/wait.ts'

let e: Engine | undefined
afterEach(async () => {
  await e?.close()
  e = undefined
})

/** A user preset that sets several devices: a pink for everything, its own color for the card and stick 2. */
const EVENING: Preset = {
  id: 'user-evening',
  name: 'Evening',
  scene: solid('#ffa3bb'),
  overrides: { [KEYS.gpu]: solid('#7a5cff'), [KEYS.stick2]: solid('#00c6ff') }
}

function assertEveningExceptGpu(engine: Engine): void {
  const board = boardZones(engine.pc.shown(BOARD))
  assertAll(board.fans, driven('fans', '#ffa3bb'), 'fans and strip')
  assertAll(board.ioCover, driven('board', '#ffa3bb'), 'I/O cover')
  assertAll(board.chipset, driven('board', '#ffa3bb'), 'chipset')
  const ram = engine.pc.shown(RAM)
  assertAll(ram.slice(0, 12), driven('ram', '#ffa3bb'), 'stick 1')
  assertAll(ram.slice(12), driven('ram', '#00c6ff'), 'stick 2 (its own color in the preset)')
}

describe('Scenario: one device stops responding while a preset applies to several', () => {
  it('applies the preset everywhere else at once, shows the stuck device as not responding, and catches it up', async () => {
    e = await startEngine({ scene: solid('#ffffff') })
    e.store.data.presets.push(EVENING)
    await eventually(() => assertAll(e!.pc.shown(GPU), driven('gpu', '#ffffff'), 'graphics card'))

    e.pc.stall(GPU)
    e.service.applyPreset(EVENING.id)

    // The stuck card doesn't hold up the others: they show their part of the preset right away.
    await eventually(() => assertEveningExceptGpu(e!), 1500)

    // The window: the preset is active with every look in place; only the card is marked as not responding.
    await eventually(() => assert.equal(e!.light(KEYS.gpu).online, false), TEST_TIMEOUT_MS + 2000)
    const state = e.service.getState()
    assert.equal(state.connection, 'connected')
    assert.equal(state.activePresetId, EVENING.id)
    assert.deepEqual(state.scene, EVENING.scene)
    assert.deepEqual(e.light(KEYS.gpu).scene, EVENING.overrides[KEYS.gpu])
    assert.deepEqual(e.light(KEYS.stick2).scene, EVENING.overrides[KEYS.stick2])
    assert.equal(e.light(KEYS.stick1).scene, null, 'stick 1 follows All Lights in this preset')
    assert.ok(state.lights.filter((l) => l.key !== KEYS.gpu).every((l) => l.online), 'only the card is not responding')
    assert.ok(e.logs.some((l) => l === "Gigabyte GeForce RTX 5080 Aero OC isn't responding: OpenRGB hasn't confirmed its lighting updates."))

    // What the card really shows: still the old white, since its worker applied nothing.
    assertAll(e.pc.shown(GPU), driven('gpu', '#ffffff'), 'graphics card while stuck')

    // It recovers: it ends on the preset's color (the newest frame, not a stale one) and is responding again.
    e.pc.resume(GPU)
    await eventually(() => {
      assertAll(e!.pc.shown(GPU), driven('gpu', '#7a5cff'), 'graphics card after recovering')
      assert.equal(e!.light(KEYS.gpu).online, true)
    })
    assert.ok(e.logs.includes('Gigabyte GeForce RTX 5080 Aero OC is responding again.'))
    assert.equal(e.service.getState().activePresetId, EVENING.id)
    assertEveningExceptGpu(e)
  })

  it('never piles up frames for a stuck device, while the others keep animating', async () => {
    e = await startEngine({ scene: solid('#ffffff') })
    e.pc.stall(GPU)
    const framesTo = (id: number): number => e!.pc.server.packets(PacketId.UPDATE_LEDS).filter((p) => p.devId === id).length
    const boardBefore = framesTo(BOARD)

    // A fast animation for 2 s: Lumen renders a new frame for every device about 60 times a second.
    e.service.setScene({ kind: 'all' }, { effect: 'breathing', colors: ['#ffa3bb'], speed: 100, reverse: false, level: 100 })
    await sleep(2000)

    // OpenRGB would apply a backlog one by one once the device recovers, replaying old frames: Lumen keeps at
    // most 3 waiting.
    assert.ok(e.pc.maxQueuedFrames(GPU) <= 3, `${e.pc.maxQueuedFrames(GPU)} frames queued for the stuck card`)
    assert.ok(framesTo(BOARD) - boardBefore > 30, 'the board kept animating')

    e.pc.resume(GPU)
    await eventually(() => assert.equal(e!.light(KEYS.gpu).online, true))
  })

  it('a device that doesn\'t answer when Lumen starts doesn\'t keep the others dark, and joins once it answers', async () => {
    const pc = new FakePC()
    pc.stall(RAM) // the RAM's worker is stuck before Lumen even connects
    e = await startEngine({ pc, scene: solid('#ffa3bb'), until: 'connected' })

    // Connected, with the board and the card under control...
    await eventually(() => {
      assertAll(boardZones(e!.pc.shown(BOARD)).fans, driven('fans', '#ffa3bb'), 'fans and strip')
      assertAll(e!.pc.shown(GPU), driven('gpu', '#ffa3bb'), 'graphics card')
    })
    assert.equal(e.service.getState().connection, 'connected')
    // ...and the RAM not listed yet: Lumen never got its details, so it can't name or show it.
    assert.equal(e.service.getState().lights.some((l) => l.kind === 'ram'), false)
    assert.ok(e.logs.some((l) => l.startsWith('No answer from #2')))

    // The RAM's worker recovers: Lumen's retry reads it, and it shows the scene like everything else.
    e.pc.resume(RAM)
    await eventually(() => {
      assert.equal(e!.light(KEYS.stick1).online, true)
      assert.equal(e!.light(KEYS.stick2).online, true)
      assertAll(e!.pc.shown(RAM), driven('ram', '#ffa3bb'), 'RAM')
    }, 10_000)
  })
})
