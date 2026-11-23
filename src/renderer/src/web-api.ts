import type { AppState, FrameMap, LumenApi } from '../../shared/types'

/**
 * LumenApi over HTTP: commands are POSTed to /api/<action>, and state/frames stream in
 * through Server-Sent Events from /api/events.
 */
export type ServiceStatus = 'up' | 'down'

const stateSubs = new Set<(s: AppState) => void>()
const frameSubs = new Set<(f: FrameMap) => void>()
const statusSubs = new Set<(s: ServiceStatus) => void>()
let status: ServiceStatus = 'up'

function setStatus(s: ServiceStatus): void {
  if (s === status) return
  status = s
  for (const cb of statusSubs) cb(s)
}

const events = new EventSource('/api/events')
events.addEventListener('open', () => setStatus('up'))
events.addEventListener('error', () => {
  if (events.readyState !== EventSource.OPEN) setStatus('down')
})
events.addEventListener('state', (e) => {
  setStatus('up')
  const s = JSON.parse((e as MessageEvent<string>).data) as AppState
  for (const cb of stateSubs) cb(s)
})
events.addEventListener('frame', (e) => {
  const f = JSON.parse((e as MessageEvent<string>).data) as FrameMap
  for (const cb of frameSubs) cb(f)
})

async function call<T = void>(action: string, ...args: unknown[]): Promise<T> {
  const res = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args)
  })
  if (!res.ok) throw new Error(`${action} failed: ${res.status}`)
  return (await res.json()) as T
}

export function onServiceStatus(cb: (s: ServiceStatus) => void): () => void {
  statusSubs.add(cb)
  return () => {
    statusSubs.delete(cb)
  }
}

export function serviceStatus(): ServiceStatus {
  return status
}

export const webApi: LumenApi = {
  getState: () => call<AppState>('getState'),
  setScene: (target, scene) => call('setScene', target, scene),
  setPower: (on) => call('setPower', on),
  setBrightness: (v) => call('setBrightness', v),
  renameLight: (key, name) => call('renameLight', key, name),
  setLightHidden: (key, hidden) => call('setLightHidden', key, hidden),
  setLedCount: (key, n) => call('setLedCount', key, n),
  setRingLeds: (key, n) => call('setRingLeds', key, n),
  identify: (keys) => call('identify', keys),
  applyPreset: (id) => call('applyPreset', id),
  savePreset: (name) => call('savePreset', name),
  deletePreset: (id) => call('deletePreset', id),
  renamePreset: (id, name) => call('renamePreset', id, name),
  setPrefs: (prefs) => call('setPrefs', prefs),
  showWhite: (on) => call('showWhite', on),
  reconnect: () => call('reconnect'),
  quit: () => call('quit'),
  onState: (cb) => {
    stateSubs.add(cb)
    return () => {
      stateSubs.delete(cb)
    }
  },
  onFrame: (cb) => {
    frameSubs.add(cb)
    return () => {
      frameSubs.delete(cb)
    }
  }
}
