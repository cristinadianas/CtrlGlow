import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, beforeEach, describe, it } from 'node:test'
import { MAX_BODY, startServer, type Actions, type LumenServer } from '../../src/service/server.ts'

interface Reply {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

let server: LumenServer
let root: string
let calls: unknown[][]
let clientCounts: number[]

/** A raw HTTP request, so tests can send any Host and Origin (fetch() would not allow that). */
function request(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: server.port,
      path,
      method: opts.method ?? 'GET',
      headers: { Host: `127.0.0.1:${server.port}`, ...opts.headers }
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(opts.body)
  })
}

const post = (action: string, body = '[]', headers: Record<string, string> = {}): Promise<Reply> =>
  request(`/api/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body })

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'lumen-server-test-'))
  const ui = join(root, 'ui')
  mkdirSync(join(ui, 'assets'), { recursive: true })
  writeFileSync(join(ui, 'index.html'), '<!doctype html><title>Lumen</title>')
  writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(root, 'secret.txt'), 'outside the UI folder')

  const actions: Actions = {
    echo: (...args) => {
      calls.push(args)
      return { args }
    },
    nothing: () => undefined,
    later: async () => {
      await new Promise((r) => setTimeout(r, 10))
      return 'done'
    }
  }
  server = await startServer({
    uiRoot: ui,
    actions,
    initialState: () => ({ hello: 'state' }),
    onClientsChanged: (n) => clientCounts.push(n),
    log: () => {},
    port: 0
  })
})

beforeEach(() => {
  calls = []
  clientCounts = []
})

after(async () => {
  await server.close()
  rmSync(root, { recursive: true, force: true })
})

describe('server: actions', () => {
  it('answers the ping that tells a second Lumen one is already running', async () => {
    const res = await request('/api/ping')
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { app: 'lumen' })
  })

  it('calls the action with the JSON array as its arguments', async () => {
    const res = await post('echo', JSON.stringify([{ kind: 'all' }, 42]))
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.body), { args: [{ kind: 'all' }, 42] })
    assert.deepEqual(calls, [[{ kind: 'all' }, 42]])
  })

  it('passes a single non-array value as one argument, and an empty body as none', async () => {
    await post('echo', '"solo"')
    await post('echo', '')
    assert.deepEqual(calls, [['solo'], []])
  })

  it('waits for async actions and returns null for no result', async () => {
    assert.equal(JSON.parse((await post('later')).body), 'done')
    assert.equal(JSON.parse((await post('nothing')).body), null)
  })

  it('sends results as uncached JSON with the security headers', async () => {
    const res = await post('nothing')
    assert.match(String(res.headers['content-type']), /^application\/json/)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
  })

  it('rejects unknown actions, including names inherited from Object', async () => {
    for (const name of ['missing', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      assert.equal((await post(name)).status, 404, name)
    }
    assert.deepEqual(calls, [])
  })

  it('accepts only POST for actions', async () => {
    assert.equal((await request('/api/echo')).status, 405)
    assert.equal((await request('/api/echo', { method: 'PUT', headers: { 'Content-Type': 'application/json' } })).status, 405)
  })

  it('requires a JSON body, so plain cross-site form posts cannot reach it', async () => {
    const res = await request('/api/echo', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '[]' })
    assert.equal(res.status, 415)
    assert.deepEqual(calls, [])
  })

  it('rejects malformed JSON', async () => {
    assert.equal((await post('echo', '[1, 2')).status, 400)
  })

  it('rejects bodies over the size limit', async () => {
    const big = JSON.stringify(['x'.repeat(MAX_BODY)])
    const res = await post('echo', big).catch(() => ({ status: 413 }) as Reply) // the server may cut the upload short
    assert.equal(res.status, 413)
    assert.deepEqual(calls, [])
  })
})

describe('server: who may connect', () => {
  it('rejects a foreign Host header (DNS rebinding)', async () => {
    const res = await post('echo', '[]', { Host: `evil.example:${server.port}` })
    assert.equal(res.status, 403)
    assert.deepEqual(calls, [])
  })

  it('accepts localhost as well as 127.0.0.1', async () => {
    assert.equal((await post('nothing', '[]', { Host: `localhost:${server.port}` })).status, 200)
  })

  it('rejects requests from other websites', async () => {
    const res = await post('echo', '[]', { Origin: 'https://evil.example' })
    assert.equal(res.status, 403)
    assert.deepEqual(calls, [])
  })

  it('accepts requests from its own page', async () => {
    assert.equal((await post('nothing', '[]', { Origin: `http://127.0.0.1:${server.port}` })).status, 200)
  })
})

describe('server: the UI files', () => {
  it('serves index.html at / with a strict content security policy', async () => {
    const res = await request('/')
    assert.equal(res.status, 200)
    assert.match(res.body, /<title>Lumen<\/title>/)
    assert.equal(res.headers['cache-control'], 'no-cache')
    assert.match(String(res.headers['content-security-policy']), /default-src 'self'/)
    assert.match(String(res.headers['content-security-policy']), /frame-ancestors 'none'/)
  })

  it('caches built assets for a long time', async () => {
    const res = await request('/assets/app.js')
    assert.equal(res.status, 200)
    assert.match(String(res.headers['content-type']), /^text\/javascript/)
    assert.match(String(res.headers['cache-control']), /immutable/)
  })

  it('answers 404 for files that do not exist', async () => {
    assert.equal((await request('/nope.html')).status, 404)
  })

  it('never serves files outside the UI folder', async () => {
    for (const path of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      const res = await request(path)
      assert.ok(res.status === 403 || res.status === 404, `${path}: ${res.status}`)
      assert.doesNotMatch(res.body, /outside the UI folder/, path)
    }
  })

  it('rejects malformed percent-encoding', async () => {
    assert.equal((await request('/%E0%A4%A')).status, 400)
  })

  it('accepts only GET and HEAD for files', async () => {
    assert.equal((await request('/', { method: 'DELETE' })).status, 405)
  })
})

describe('server: live events', () => {
  it('starts with the current state, then streams broadcasts, and counts listeners', async () => {
    const received: string[] = []
    const done = new Promise<void>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: server.port, path: '/api/events', headers: { Host: `127.0.0.1:${server.port}` } }, (res) => {
        assert.equal(res.statusCode, 200)
        assert.match(String(res.headers['content-type']), /^text\/event-stream/)
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => {
          received.push(chunk)
          const text = received.join('')
          if (text.includes('event: state') && !text.includes('event: frame')) server.broadcast('frame', { led: 1 })
          if (text.includes('event: frame')) {
            req.destroy()
            resolve()
          }
        })
      })
      req.on('error', (err) => (err.message.includes('socket hang up') ? resolve() : reject(err)))
    })
    await done
    const text = received.join('')
    assert.match(text, /event: state\ndata: {"hello":"state"}/)
    assert.match(text, /event: frame\ndata: {"led":1}/)
    assert.equal(clientCounts[0], 1)
  })

  it('only allows GET', async () => {
    assert.equal((await request('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status, 405)
  })
})
