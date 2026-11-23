/**
 * Local HTTP server for the Lumen UI.
 *  - Serves the built UI (out/renderer) to the Edge app window.
 *  - GET  /api/events   Server-Sent Events: "state" and live "frame" updates.
 *  - POST /api/<action> JSON array of arguments → JSON result.
 *
 * Security: listens on 127.0.0.1 only; rejects foreign Host headers (DNS rebinding) and
 * foreign Origins (other websites); actions require a JSON body (no simple cross-site form posts).
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { extname, resolve, sep } from 'node:path'

export const PORT = 6743
export const APP_URL = `http://127.0.0.1:${PORT}/`

export const MAX_BODY = 256 * 1024

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml'
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
}

export type Actions = Record<string, (...args: unknown[]) => unknown>

export interface LumenServer {
  broadcast(event: 'state' | 'frame', data: unknown): void
  readonly clientCount: number
  /** The port it listens on (127.0.0.1). */
  readonly port: number
  close(): Promise<void>
}

export function startServer(opts: {
  uiRoot: string
  actions: Actions
  initialState: () => unknown
  onClientsChanged: (count: number) => void
  log: (msg: string) => void
  /** Defaults to PORT; 0 picks a free port (used by the tests). */
  port?: number
}): Promise<LumenServer> {
  const uiRoot = resolve(opts.uiRoot)
  const clients = new Set<http.ServerResponse>()
  // Set once listening, from the actual port.
  let allowedHosts = new Set<string>()
  let allowedOrigins = new Set<string>()

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      opts.log(`request error: ${String(err)}`)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!allowedHosts.has(req.headers.host ?? '')) return deny(res, 403)
    const origin = req.headers.origin
    if (origin !== undefined && !allowedOrigins.has(origin)) return deny(res, 403)

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname

    if (path === '/api/events') {
      if (req.method !== 'GET') return deny(res, 405)
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      res.write(`retry: 1500\nevent: state\ndata: ${JSON.stringify(opts.initialState())}\n\n`)
      clients.add(res)
      opts.onClientsChanged(clients.size)
      req.on('close', () => {
        clients.delete(res)
        opts.onClientsChanged(clients.size)
      })
      return
    }

    if (path.startsWith('/api/')) {
      if (req.method === 'GET' && path === '/api/ping') return json(res, { app: 'lumen' })
      if (req.method !== 'POST') return deny(res, 405)
      if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return deny(res, 415)
      const name = path.slice(5)
      const action = Object.hasOwn(opts.actions, name) ? opts.actions[name] : undefined
      if (typeof action !== 'function') return deny(res, 404)
      const body = await readBody(req)
      if (body === null) return deny(res, 413)
      let args: unknown
      try {
        args = body.length ? JSON.parse(body) : []
      } catch {
        return deny(res, 400)
      }
      const result = await action(...(Array.isArray(args) ? args : [args]))
      return json(res, result ?? null)
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') return deny(res, 405)
    return serveStatic(res, path)
  }

  async function serveStatic(res: http.ServerResponse, path: string): Promise<void> {
    let rel: string
    try {
      rel = decodeURIComponent(path)
    } catch {
      return deny(res, 400)
    }
    if (rel === '/' || rel === '') rel = '/index.html'
    const file = resolve(uiRoot, `.${rel}`)
    if (file !== uiRoot && !file.startsWith(uiRoot + sep)) return deny(res, 403)
    try {
      const data = await readFile(file)
      const isHtml = file.endsWith('.html')
      res.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': isHtml ? 'no-cache' : rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
      })
      res.end(data)
    } catch {
      deny(res, 404)
    }
  }

  // Keep SSE connections alive through idle periods.
  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(': ping\n\n')
  }, 20_000)

  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? PORT, '127.0.0.1', () => {
      server.off('error', reject)
      const port = (server.address() as AddressInfo).port
      allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
      allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])
      resolvePromise({
        port,
        broadcast(event, data) {
          if (!clients.size) return
          const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
          for (const c of clients) c.write(msg)
        },
        get clientCount() {
          return clients.size
        },
        close() {
          clearInterval(heartbeat)
          for (const c of clients) c.end()
          clients.clear()
          return new Promise((r) => server.close(() => r()))
        }
      })
    })
  })
}

function deny(res: http.ServerResponse, code: number): void {
  res.writeHead(code, SECURITY_HEADERS)
  res.end()
}

function json(res: http.ServerResponse, value: unknown): void {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(value))
}

function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolvePromise, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
        resolvePromise(null)
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** True if a Lumen service is already answering on our port. */
export async function isLumenRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${APP_URL}api/ping`, { signal: AbortSignal.timeout(1500) })
    const body = (await res.json()) as { app?: string }
    return body.app === 'lumen'
  } catch {
    return false
  }
}
