import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { OpenRGBClient } from '../../../src/service/openrgb/client.ts'
import { ClientFlag, PacketId, ServerFlag, encodeHeader } from '../../../src/service/openrgb/protocol.ts'
import { DeviceType } from '../../../src/service/openrgb/types.ts'
import { FakeOpenRGB, cstr, u32 } from '../../helpers/fake-openrgb.ts'
import { encodeController, mode } from '../../helpers/openrgb-encode.ts'
import { eventually, sleep } from '../../helpers/wait.ts'

let fake: FakeOpenRGB
let client: OpenRGBClient

const connect = async (opts: { timeoutMs?: number } = {}): Promise<OpenRGBClient> => {
  client = new OpenRGBClient({ port: fake.port, name: 'Lumen (test)', ...opts })
  await client.connect()
  return client
}

const text = (payload: Buffer): string => payload.toString('utf8').replace(/\0+$/, '')

beforeEach(async () => {
  fake = new FakeOpenRGB()
  await fake.start()
})

afterEach(async () => {
  client?.disconnect()
  await fake.stop()
  assert.deepEqual(fake.protocolErrors, [])
})

describe('OpenRGBClient: connecting', () => {
  it('negotiates protocol 6 and introduces itself by name', async () => {
    await connect()
    assert.equal(client.protocol, 6)
    assert.equal(client.connected, true)
    const hello = await fake.waitFor((p) => p.pktId === PacketId.SET_CLIENT_NAME)
    assert.equal(text(hello.payload), 'Lumen (test)')
  })

  it('uses an older server\'s lower protocol version', async () => {
    fake.protocolVersion = 3
    await connect()
    assert.equal(client.protocol, 3)
  })

  it('refuses a server that reports no usable protocol', async () => {
    fake.protocolVersion = 0
    client = new OpenRGBClient({ port: fake.port })
    await assert.rejects(client.connect(), /too old/)
    assert.equal(client.connected, false)
  })

  it('fails cleanly when nothing is listening', async () => {
    const port = fake.port
    await fake.stop()
    client = new OpenRGBClient({ port })
    await assert.rejects(client.connect())
    fake = new FakeOpenRGB() // afterEach stops a fresh, unused one
    await fake.start()
  })
})

describe('OpenRGBClient: controllers', () => {
  it('lists controller ids (protocol 6 sends unique ids)', async () => {
    fake.on(PacketId.REQUEST_CONTROLLER_COUNT, (_p, r) => r.send(PacketId.REQUEST_CONTROLLER_COUNT, Buffer.concat([u32(2), u32(17), u32(23)])))
    await connect()
    assert.deepEqual(await client.controllerIds(), [17, 23])
  })

  it('reads a controller, asking for it in the negotiated protocol', async () => {
    const payload = encodeController({ type: DeviceType.DRAM, name: 'Kingston Fury DDR5 DRAM', modes: [mode('Direct')], zones: [{ name: 'Fury Slot 1', ledsCount: 12 }] })
    fake.on(PacketId.REQUEST_CONTROLLER_DATA, (p, r) => {
      assert.equal(p.payload.readUInt32LE(0), 6)
      r.send(PacketId.REQUEST_CONTROLLER_DATA, payload)
    })
    await connect()
    const c = await client.controller(17)
    assert.equal(c.id, 17)
    assert.equal(c.name, 'Kingston Fury DDR5 DRAM')
    assert.equal(c.leds.length, 12)
  })
})

describe('OpenRGBClient: commands and acknowledgements', () => {
  it('resolves a command with the status the server acknowledges', async () => {
    fake.on(PacketId.UPDATE_MODE, (_p, r) => { r.ack(4); return true })
    await connect()
    assert.equal(await client.updateMode(17, mode('Static')), 4)
  })

  it('matches acknowledgements to commands in order', async () => {
    let n = 0
    fake.on(PacketId.SET_CUSTOM_MODE, (_p, r) => { r.ack(n++); return true })
    await connect()
    assert.deepEqual(await Promise.all([client.setCustomMode(1), client.setCustomMode(1), client.setCustomMode(1)]), [0, 1, 2])
  })

  it('gives up on a command after its timeout instead of hanging', async () => {
    fake.holdAcks.add(PacketId.SET_CUSTOM_MODE)
    await connect({ timeoutMs: 100 })
    assert.equal(await client.setCustomMode(1), -2)
  })
})

describe('OpenRGBClient: LED frames', () => {
  const frame = (v: number): Uint8Array => Uint8Array.from([v, v, v])

  it('sends a frame only once the previous one is acknowledged, then the newest waiting one', async () => {
    fake.holdAcks.add(PacketId.UPDATE_LEDS)
    await connect()
    client.updateLedsPacked(5, frame(1))
    client.updateLedsPacked(5, frame(2))
    client.updateLedsPacked(5, frame(3))
    await fake.waitFor((p) => p.pktId === PacketId.UPDATE_LEDS)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(fake.packets(PacketId.UPDATE_LEDS).length, 1, 'frames 2 and 3 must wait')

    fake.holdAcks.clear()
    fake.releaseAcks()
    await fake.waitFor((p) => p.pktId === PacketId.UPDATE_LEDS && p.payload[6] === 3)
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(fake.packets(PacketId.UPDATE_LEDS).map((p) => p.payload[6]), [1, 3], 'frame 2 is replaced by frame 3')
  })

  it('keeps each device\'s frames separate', async () => {
    fake.holdAcks.add(PacketId.UPDATE_LEDS)
    await connect()
    client.updateLedsPacked(5, frame(1))
    client.updateLedsPacked(6, frame(2))
    await fake.waitFor((p) => p.pktId === PacketId.UPDATE_LEDS && p.devId === 6)
    assert.deepEqual(fake.packets(PacketId.UPDATE_LEDS).map((p) => p.devId).sort(), [5, 6])
  })

  it('does not stall forever when an acknowledgement is lost', async () => {
    fake.holdAcks.add(PacketId.UPDATE_LEDS) // never released
    await connect()
    client.updateLedsPacked(5, frame(1))
    await fake.waitFor((p) => p.pktId === PacketId.UPDATE_LEDS)
    await sleep(550)
    client.updateLedsPacked(5, frame(2))
    await fake.waitFor((p) => p.pktId === PacketId.UPDATE_LEDS && p.payload[6] === 2)
  })

  it('keeps at most 3 frames waiting for a device that stopped acknowledging, then sends the newest', async () => {
    fake.holdAcks.add(PacketId.UPDATE_LEDS)
    await connect()
    // 12 frames over 1.8 s: past the cap, a frame no longer counts as lost; it waits.
    for (let v = 1; v <= 12; v++) {
      client.updateLedsPacked(5, frame(v))
      await sleep(150)
    }
    assert.equal(fake.packets(PacketId.UPDATE_LEDS).length, 3)

    fake.holdAcks.clear()
    fake.releaseAcks()
    await fake.waitFor((p) => p.pktId === PacketId.UPDATE_LEDS && p.payload[6] === 12)
    assert.equal(fake.packets(PacketId.UPDATE_LEDS).length, 4, 'only the newest waiting frame follows')
  })

  it('reports a device as not responding once its frames go unacknowledged for the timeout, and as responding after', async () => {
    fake.holdAcks.add(PacketId.UPDATE_LEDS)
    await connect({ timeoutMs: 300 })
    assert.equal(client.isResponding(5), true, 'nothing sent yet')
    client.updateLedsPacked(5, frame(1))
    assert.equal(client.isResponding(5), true, 'just sent')
    await sleep(350)
    assert.equal(client.isResponding(5), false)
    assert.equal(client.isResponding(6), true, 'other devices are unaffected')

    fake.holdAcks.clear()
    fake.releaseAcks()
    await fake.waitFor((p) => p.pktId === PacketId.UPDATE_LEDS) // already there; give the ACK a moment
    await sleep(50)
    assert.equal(client.isResponding(5), true)
  })
})

describe('OpenRGBClient: reading the stream', () => {
  it('handles replies split across chunks and several packets in one chunk', async () => {
    fake.on(PacketId.REQUEST_CONTROLLER_COUNT, (_p, r) => {
      const reply = Buffer.concat([encodeHeader(0, PacketId.REQUEST_CONTROLLER_COUNT, 8), u32(1), u32(99)])
      const ack = Buffer.concat([encodeHeader(0, PacketId.ACK, 8), u32(PacketId.REQUEST_CONTROLLER_COUNT), u32(0)])
      const all = Buffer.concat([reply, ack])
      r.socket.write(all.subarray(0, 5))
      setTimeout(() => r.socket.write(all.subarray(5, 21)), 10)
      setTimeout(() => r.socket.write(all.subarray(21)), 20)
      return true
    })
    await connect()
    assert.deepEqual(await client.controllerIds(), [99])
  })

  it('skips garbage until the next packet', async () => {
    fake.on(PacketId.REQUEST_CONTROLLER_COUNT, (_p, r) => {
      r.socket.write(Buffer.from('junk!'))
      r.send(PacketId.REQUEST_CONTROLLER_COUNT, Buffer.concat([u32(1), u32(7)]))
    })
    await connect()
    assert.deepEqual(await client.controllerIds(), [7])
  })

  it('reports device list changes and other clients\' changes, but not plain LED updates', async () => {
    await connect()
    const changes: [number, number][] = []
    let listUpdated = 0
    client.on('controllerChanged', (id, reason) => changes.push([id, reason]))
    client.on('deviceListUpdated', () => listUpdated++)
    fake.broadcast(PacketId.SIGNAL_UPDATE, Buffer.concat([u32(0), u32(0)]), 5) // UpdateLEDs: ignored
    fake.broadcast(PacketId.SIGNAL_UPDATE, Buffer.concat([u32(0), u32(2)]), 5) // a mode change
    fake.broadcast(PacketId.DEVICE_LIST_UPDATED)
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual(changes, [[5, 2]])
    assert.equal(listUpdated, 1)
  })
})

describe('OpenRGBClient: disconnects', () => {
  it('emits "disconnected" and fails pending requests when the server goes away', async () => {
    fake.on(PacketId.REQUEST_CONTROLLER_COUNT, () => true) // never answers
    await connect()
    const disconnected = new Promise<void>((resolve) => client.once('disconnected', () => resolve()))
    const pending = client.controllerIds()
    await fake.waitFor((p) => p.pktId === PacketId.REQUEST_CONTROLLER_COUNT)
    fake.dropClients()
    await assert.rejects(pending, /closed|Disconnected/)
    await disconnected
    assert.equal(client.connected, false)
  })

  it('reconnects cleanly right after a disconnect: the old connection closing late cannot take the new one down', async () => {
    fake.on(PacketId.REQUEST_CONTROLLER_COUNT, (_p, r) => r.send(PacketId.REQUEST_CONTROLLER_COUNT, Buffer.concat([u32(1), u32(7)])))
    await connect()
    let disconnects = 0
    client.on('disconnected', () => disconnects++)

    client.disconnect() // what Lumen's Reconnect button does, immediately followed by...
    const again = client.connect()
    assert.equal(client.connected, false, 'nothing may be sent before the new handshake is done')
    await again
    await sleep(100) // the old socket's close has arrived by now

    assert.equal(client.connected, true)
    assert.deepEqual(await client.controllerIds(), [7])
    await eventually(() => assert.equal(fake.clientCount, 1, 'the old connection must not be left open in OpenRGB'))
    assert.equal(disconnects, 0, 'a disconnect Lumen asked for is not reported as a lost connection')
  })

  it('lets a newer connection attempt win when an older one is still waiting for its handshake', async () => {
    let versionRequests = 0
    fake.on(PacketId.REQUEST_PROTOCOL_VERSION, (_p, r) => {
      if (versionRequests++ > 0) r.send(PacketId.REQUEST_PROTOCOL_VERSION, u32(6)) // the first one gets no answer
      return true
    })
    client = new OpenRGBClient({ port: fake.port })
    const first = client.connect()
    await fake.waitFor((p) => p.pktId === PacketId.REQUEST_PROTOCOL_VERSION)
    const second = client.connect()

    await assert.rejects(first, /closed or replaced/)
    await second
    assert.equal(client.connected, true)
    assert.equal(client.protocol, 6)
    await eventually(() => assert.equal(fake.clientCount, 1))
  })
})

describe('OpenRGBClient: malformed packets from the server', () => {
  it('drops an acknowledgement too short to read instead of throwing (that would stop Lumen)', async () => {
    fake.on(PacketId.SET_CUSTOM_MODE, (_p, r) => {
      r.socket.write(Buffer.concat([encodeHeader(1, PacketId.ACK, 4), u32(PacketId.SET_CUSTOM_MODE)])) // no status
      return true
    })
    fake.on(PacketId.REQUEST_CONTROLLER_COUNT, (_p, r) => r.send(PacketId.REQUEST_CONTROLLER_COUNT, Buffer.concat([u32(1), u32(7)])))
    await connect({ timeoutMs: 200 })
    assert.equal(await client.setCustomMode(1), -2, 'an unreadable acknowledgement counts as none')
    assert.equal(client.connected, true)
    assert.deepEqual(await client.controllerIds(), [7], 'the connection keeps working')
  })
})

describe('OpenRGBClient: profiles and settings (the shutdown fix)', () => {
  it('asks for local-client rights without claiming to handle profiles', async () => {
    fake.on(PacketId.SET_CLIENT_FLAGS, (p, r) => {
      const flags = p.payload.readUInt32LE(0)
      assert.ok(flags & ClientFlag.REQUEST_LOCAL_CLIENT, 'must request local-client rights')
      assert.equal(flags & ClientFlag.SUPPORTS_PROFILEMANAGER, 0, 'OpenRGB would wait for us on every profile load')
      r.send(PacketId.SET_SERVER_FLAGS, u32(ServerFlag.LOCAL_CLIENT))
    })
    await connect()
    assert.equal(await client.requestLocalClient(), true)
  })

  it('reports when OpenRGB refuses local-client rights', async () => {
    fake.on(PacketId.SET_CLIENT_FLAGS, (_p, r) => r.send(PacketId.SET_SERVER_FLAGS, u32(0)))
    await connect()
    assert.equal(await client.requestLocalClient(), false)
  })

  it('saves, loads and deletes profiles by NUL-terminated name, returning OpenRGB\'s status', async () => {
    fake.on(PacketId.PROFILEMANAGER_LOAD_PROFILE, (_p, r) => { r.ack(3); return true }) // not allowed
    await connect()
    assert.equal(await client.saveProfile('Lumen Off'), 0)
    assert.equal(await client.loadProfile('Lumen Off'), 3)
    assert.equal(await client.deleteProfile('Lumen Off'), 0)
    for (const id of [PacketId.PROFILEMANAGER_SAVE_PROFILE, PacketId.PROFILEMANAGER_LOAD_PROFILE, PacketId.PROFILEMANAGER_DELETE_PROFILE]) {
      const [p] = fake.packets(id)
      assert.deepEqual(p.payload, cstr('Lumen Off'))
    }
  })

  it('reads settings as JSON, and null for a missing section', async () => {
    fake.on(PacketId.SETTINGSMANAGER_GET_SETTINGS, (p, r) => {
      const key = text(p.payload)
      const value = key === 'ProfileManager' ? { service_shutdown_profile: { enabled: true, name: 'Lumen Off' } } : null
      r.send(PacketId.SETTINGSMANAGER_GET_SETTINGS, cstr(JSON.stringify(value)))
    })
    await connect()
    assert.deepEqual(await client.getSettings('ProfileManager'), { service_shutdown_profile: { enabled: true, name: 'Lumen Off' } })
    assert.equal(await client.getSettings('AutoStart'), null)
  })

  it('sends a settings change as one JSON object, then saves', async () => {
    await connect()
    const change = { ProfileManager: { service_shutdown_profile: { enabled: true, name: 'Lumen Off' } } }
    assert.equal(await client.modifySettings(change), 0)
    assert.equal(await client.saveSettings(), 0)
    const [p] = fake.packets(PacketId.SETTINGSMANAGER_MODIFY_SETTINGS)
    assert.deepEqual(JSON.parse(text(p.payload)), change)
    assert.equal(fake.packets(PacketId.SETTINGSMANAGER_SAVE_SETTINGS).length, 1)
  })
})
