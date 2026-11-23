/**
 * Scenario: connecting to OpenRGB again. The window's Reconnect / Try Again buttons start a new connection at any
 * moment, also while Lumen is connected or still connecting, and at sign-in OpenRGB may not be running yet.
 *
 * Each test checks what the user sees (the connection state the window shows, and what the LEDs really show) and
 * what Lumen believes (one connection to OpenRGB, every light reachable, every device sent its lighting again).
 */
import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { PacketId } from '../../../src/service/openrgb/protocol.ts'
import type { ConnectionState } from '../../../src/shared/types.ts'
import { u32 } from '../../helpers/fake-openrgb.ts'
import { BOARD, FakePC, GPU, RAM } from '../../helpers/fake-pc.ts'
import { assertAll, boardZones, driven, solid, startEngine, type Engine } from '../../helpers/engine.ts'
import { eventually, sleep } from '../../helpers/wait.ts'

let e: Engine | undefined
afterEach(async () => {
  await e?.close()
  e = undefined
})

function assertShows(engine: Engine, color: string): void {
  const board = boardZones(engine.pc.shown(BOARD))
  assertAll(board.fans, driven('fans', color), 'fans and strip')
  assertAll([...board.ioCover, ...board.chipset], driven('board', color), 'board lights')
  assertAll(engine.pc.shown(RAM), driven('ram', color), 'RAM')
  assertAll(engine.pc.shown(GPU), driven('gpu', color), 'graphics card')
}

/** The connection states the window is shown from now on. */
function watchConnection(engine: Engine): ConnectionState[] {
  const seen: ConnectionState[] = []
  engine.service.on('state', (s) => seen.push(s.connection))
  return seen
}

const framesTo = (engine: Engine, id: number): number =>
  engine.pc.server.packets(PacketId.UPDATE_LEDS).filter((p) => p.devId === id).length

describe('Scenario: Reconnect is pressed', () => {
  it('while connected: one connection afterwards, never shown as unreachable, and every device gets its lighting again', async () => {
    e = await startEngine({ scene: solid('#ffa3bb') })
    await eventually(() => assertShows(e!, '#ffa3bb'))
    const shown = watchConnection(e)
    const before = [BOARD, RAM, GPU].map((id) => framesTo(e!, id))
    const resyncs = (): number => e!.logs.filter((l) => l === 'Re-synced memory and motherboard lighting (connected).').length

    e.service.reconnect()

    await eventually(() => assert.equal(e!.service.getState().connection, 'connected'))
    // Wait out the re-sync that follows connecting (the board briefly shows its black Static on purpose); by then
    // the old connection's close, and anything it might set off, has long arrived.
    await eventually(() => assert.equal(resyncs(), 2))
    assert.equal(e.service.getState().connection, 'connected', 'still connected')
    assert.ok(!shown.includes('offline'), `the window showed OpenRGB as unreachable: ${shown.join(' → ')}`)
    assert.equal(e.pc.server.clientCount, 1, 'the old connection is closed, not left open in OpenRGB')
    assert.ok(e.service.getState().lights.every((l) => l.online), 'every light is reachable')

    // Lumen doesn't assume the devices kept their colors: each one is sent a full frame on the new connection.
    ;[BOARD, RAM, GPU].forEach((id, i) => assert.ok(framesTo(e!, id) > before[i], `no new frame for device ${id}`))
    await eventually(() => assertShows(e!, '#ffa3bb'))
  })

  it('while still connecting (OpenRGB slow to answer): the newer attempt wins, without a detour through "unreachable"', async () => {
    const pc = new FakePC()
    let versionRequests = 0
    pc.server.on(PacketId.REQUEST_PROTOCOL_VERSION, (_p, r) => {
      if (versionRequests++ > 0) r.send(PacketId.REQUEST_PROTOCOL_VERSION, u32(6)) // the first attempt gets no answer
      return true
    })
    e = await startEngine({ pc, scene: solid('#ffa3bb'), until: 'nothing' })
    await pc.server.waitFor((p) => p.pktId === PacketId.REQUEST_PROTOCOL_VERSION)
    assert.equal(e.service.getState().connection, 'connecting')
    const shown = watchConnection(e)

    e.service.reconnect() // Try Again, while the first attempt still waits for OpenRGB

    await eventually(() => assert.equal(e!.service.getState().connection, 'connected'))
    await sleep(300)
    assert.ok(!shown.includes('offline'), `the window showed OpenRGB as unreachable: ${shown.join(' → ')}`)
    assert.equal(pc.server.clientCount, 1)
    await eventually(() => assertShows(e!, '#ffa3bb'))
    assert.ok(e.service.getState().lights.every((l) => l.online))
  })
})

describe('Scenario: OpenRGB is not running yet when Lumen starts (still starting at sign-in)', () => {
  it('shows OpenRGB as unreachable, keeps a change made meanwhile, and lights everything once OpenRGB is up', async () => {
    e = await startEngine({ scene: solid('#ffffff'), openRGBDown: true, until: 'nothing' })

    // The window: unreachable, and no devices yet (Lumen has never seen them).
    await eventually(() => assert.equal(e!.service.getState().connection, 'offline'))
    assert.deepEqual(e.service.getState().lights, [])

    e.service.setScene({ kind: 'all' }, solid('#00c6ff'))
    await e.pc.start(e.pc.port) // OpenRGB's service is up: Lumen's next retry finds it

    await eventually(() => assert.equal(e!.service.getState().connection, 'connected'))
    await eventually(() => assertShows(e!, '#00c6ff'))
    const lights = e.service.getState().lights
    assert.equal(lights.length, 6)
    assert.ok(lights.every((l) => l.online))
    assert.equal(e.pc.ledCount(BOARD), 172 + 10 + 4, 'the fan header is set to its 172 LEDs on the first connection')
  })
})
