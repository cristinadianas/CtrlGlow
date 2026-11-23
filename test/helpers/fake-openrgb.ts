/**
 * A small stand-in for the OpenRGB SDK server (protocol 6) on 127.0.0.1, for testing the client without
 * OpenRGB or hardware. Like the real server it acknowledges every packet once a client has negotiated
 * protocol 6. Tests can add handlers, hold back acknowledgements and drop the connection.
 */
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { HEADER_SIZE, MAGIC, PacketId, encodeHeader } from '../../src/service/openrgb/protocol.ts'

export interface Packet {
  devId: number
  pktId: number
  payload: Buffer
}

export interface Reply {
  /** Sends a packet to the client. */
  send(pktId: number, payload?: Buffer, devId?: number): void
  /** Acknowledges the packet being handled (the real server does this after processing it). */
  ack(status?: number): void
  readonly socket: net.Socket
}

/** Return true to say the handler sent its own acknowledgement (or deliberately none). */
export type Handler = (packet: Packet, reply: Reply) => boolean | void

export const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b }

/** A NUL-terminated string, as the server sends names and JSON. */
export const cstr = (s: string): Buffer => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.alloc(1)])

export class FakeOpenRGB {
  readonly received: Packet[] = []
  /** Malformed packets the client sent (should stay empty). */
  readonly protocolErrors: string[] = []
  /** The protocol version the server reports. */
  protocolVersion = 6
  /** Packet ids whose acknowledgement is held until releaseAcks(). */
  readonly holdAcks = new Set<number>()
  private readonly handlers = new Map<number, Handler>()
  private readonly sockets = new Set<net.Socket>()
  private readonly waiters: { match: (p: Packet) => boolean; resolve: (p: Packet) => void }[] = []
  private held: (() => void)[] = []
  private readonly server = net.createServer((socket) => this.accept(socket))
  port = 0

  /** Listens on `port` (0 = any free port). */
  async start(port = 0): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, '127.0.0.1', () => {
        this.server.off('error', reject)
        resolve()
      })
    })
    this.port = (this.server.address() as AddressInfo).port
  }

  /** How many clients are connected right now. */
  get clientCount(): number {
    return this.sockets.size
  }

  async stop(): Promise<void> {
    this.dropClients()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  on(pktId: number, handler: Handler): void {
    this.handlers.set(pktId, handler)
  }

  /** Resolves with the next received packet that matches (or one already received). */
  waitFor(match: (p: Packet) => boolean, timeoutMs = 2000): Promise<Packet> {
    const seen = this.received.find(match)
    if (seen) return Promise.resolve(seen)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FakeOpenRGB: expected packet never arrived')), timeoutMs)
      this.waiters.push({ match, resolve: (p) => { clearTimeout(timer); resolve(p) } })
    })
  }

  packets(pktId: number): Packet[] {
    return this.received.filter((p) => p.pktId === pktId)
  }

  /** Sends every held acknowledgement. */
  releaseAcks(): void {
    const held = this.held
    this.held = []
    for (const send of held) send()
  }

  /** Sends a packet to every connected client (server-initiated notifications). */
  broadcast(pktId: number, payload: Buffer = Buffer.alloc(0), devId = 0): void {
    for (const s of this.sockets) s.write(Buffer.concat([encodeHeader(devId, pktId, payload.length), payload]))
  }

  /** Closes every client connection, as if OpenRGB stopped. */
  dropClients(): void {
    for (const s of this.sockets) s.destroy()
    this.sockets.clear()
  }

  private accept(socket: net.Socket): void {
    this.sockets.add(socket)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => {})
    let rx = Buffer.alloc(0)
    let negotiated = false
    socket.on('data', (chunk: Buffer) => {
      rx = Buffer.concat([rx, chunk])
      while (rx.length >= HEADER_SIZE) {
        if (rx.toString('ascii', 0, 4) !== MAGIC) {
          this.protocolErrors.push('client sent a packet without the ORGB magic')
          socket.destroy()
          return
        }
        const size = rx.readUInt32LE(12)
        if (rx.length < HEADER_SIZE + size) break
        const packet: Packet = { devId: rx.readUInt32LE(4), pktId: rx.readUInt32LE(8), payload: Buffer.from(rx.subarray(HEADER_SIZE, HEADER_SIZE + size)) }
        rx = rx.subarray(HEADER_SIZE + size)
        this.received.push(packet)
        this.handle(socket, packet, negotiated)
        if (packet.pktId === PacketId.REQUEST_PROTOCOL_VERSION) negotiated = this.protocolVersion >= 6
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          if (this.waiters[i].match(packet)) this.waiters.splice(i, 1)[0].resolve(packet)
        }
      }
    })
  }

  private handle(socket: net.Socket, packet: Packet, negotiated: boolean): void {
    const send = (pktId: number, payload: Buffer = Buffer.alloc(0), devId = packet.devId): void => {
      if (!socket.destroyed) socket.write(Buffer.concat([encodeHeader(devId, pktId, payload.length), payload]))
    }
    const ack = (status = 0): void => {
      if (!negotiated) return
      const sendAck = (): void => send(PacketId.ACK, Buffer.concat([u32(packet.pktId), u32(status)]))
      if (this.holdAcks.has(packet.pktId)) this.held.push(sendAck)
      else sendAck()
    }
    if (packet.pktId === PacketId.REQUEST_PROTOCOL_VERSION && !this.handlers.has(packet.pktId)) {
      send(PacketId.REQUEST_PROTOCOL_VERSION, u32(this.protocolVersion))
      return
    }
    const handler = this.handlers.get(packet.pktId)
    if (handler?.(packet, { send, ack, socket }) === true) return
    ack()
  }
}
