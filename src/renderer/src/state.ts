import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { AppState, FrameMap, LightInfo, LumenApi, Scene, SceneTarget } from '../../shared/types'
import { onServiceStatus, serviceStatus, webApi, type ServiceStatus } from './web-api'

export const api: LumenApi = webApi

/** Whether the Lumen background service is reachable. */
export function useServiceStatus(): ServiceStatus {
  return useSyncExternalStore(onServiceStatus, serviceStatus)
}

/* ---------------- App state ---------------- */

let state: AppState | null = null
const stateSubs = new Set<() => void>()

function setState(next: AppState): void {
  state = next
  for (const cb of stateSubs) cb()
}

api.onState(setState)
void api.getState().then(setState)

export function useAppState(): AppState | null {
  return useSyncExternalStore(
    (cb) => {
      stateSubs.add(cb)
      return () => {
        stateSubs.delete(cb)
      }
    },
    () => state
  )
}

/** Optimistic local update; the main process echoes the authoritative state right after. */
export function patchState(fn: (s: AppState) => AppState): void {
  if (state) setState(fn(state))
}

/* ---------------- Live frames ---------------- */

let frame: FrameMap = {}
const frameSubs = new Set<(f: FrameMap) => void>()
api.onFrame((f) => {
  frame = f
  for (const cb of frameSubs) cb(f)
})

export function onFrame(cb: (f: FrameMap) => void): () => void {
  frameSubs.add(cb)
  cb(frame)
  return () => {
    frameSubs.delete(cb)
  }
}

/** Latest frame, re-rendering at most every `ms`. */
export function useFrame(ms = 120): FrameMap {
  const [f, setF] = useState<FrameMap>(frame)
  useEffect(() => {
    let last = 0
    return onFrame((nf) => {
      const now = performance.now()
      if (now - last >= ms) {
        last = now
        setF(nf)
      }
    })
  }, [ms])
  return f
}

/* ---------------- Shared animation loop ---------------- */

const drawers = new Set<(t: number) => void>()
let running = false
function loop(now: number): void {
  if (!drawers.size) {
    running = false
    return
  }
  if (!document.hidden) for (const d of drawers) d(now / 1000)
  requestAnimationFrame(loop)
}

export function animate(draw: (t: number) => void): () => void {
  drawers.add(draw)
  if (!running) {
    running = true
    requestAnimationFrame(loop)
  }
  return () => {
    drawers.delete(draw)
  }
}

/* ---------------- Scene sending (throttled to animation frames) ---------------- */

/**
 * Returns a function that sends scene changes at most once per animation frame,
 * always delivering the latest value. Keeps sliders and color dragging smooth.
 */
export function useSceneSender(): (target: SceneTarget, scene: Scene | null) => void {
  const pending = useRef<{ target: SceneTarget; scene: Scene | null } | null>(null)
  const scheduled = useRef(false)
  return (target, scene) => {
    pending.current = { target, scene }
    patchState((s) => applyLocal(s, target, scene))
    if (scheduled.current) return
    scheduled.current = true
    requestAnimationFrame(() => {
      scheduled.current = false
      const p = pending.current
      pending.current = null
      if (p) void api.setScene(p.target, p.scene)
    })
  }
}

/** Calls `fn` with the latest value at most once per animation frame. */
export function useRafThrottle<T>(fn: (value: T) => void): (value: T) => void {
  const latest = useRef<{ v: T } | null>(null)
  const scheduled = useRef(false)
  const fnRef = useRef(fn)
  fnRef.current = fn
  return (v: T) => {
    latest.current = { v }
    if (scheduled.current) return
    scheduled.current = true
    requestAnimationFrame(() => {
      scheduled.current = false
      if (latest.current) fnRef.current(latest.current.v)
      latest.current = null
    })
  }
}

function applyLocal(s: AppState, target: SceneTarget, scene: Scene | null): AppState {
  if (target.kind === 'all') return scene ? { ...s, scene, activePresetId: null } : s
  const keys = new Set(target.keys)
  return {
    ...s,
    activePresetId: null,
    lights: s.lights.map((l) => (keys.has(l.key) ? { ...l, scene } : l))
  }
}

/* ---------------- Helpers ---------------- */

export interface LightGroup {
  id: string
  name: string
  kind: LightInfo['kind']
  lights: LightInfo[]
}

/** Visible lights grouped the way they appear in the sidebar. */
export function groupLights(lights: LightInfo[], includeHidden = false): LightGroup[] {
  const groups: LightGroup[] = []
  for (const l of lights) {
    if (!includeHidden && (l.hidden || l.ledCount === 0)) continue
    let g = groups.find((x) => x.id === l.group)
    if (!g) {
      g = { id: l.group, name: l.groupName, kind: l.kind, lights: [] }
      groups.push(g)
    }
    g.lights.push(l)
  }
  // A single-light group shows the light's (possibly renamed) name.
  for (const g of groups) if (g.lights.length === 1 && g.lights[0].name !== g.lights[0].defaultName) g.name = g.lights[0].name
  return groups
}

export function averageColor(f: FrameMap, keys: string[]): string {
  let r = 0, g = 0, b = 0, n = 0
  for (const k of keys) {
    const arr = f[k]
    if (!arr) continue
    const step = Math.max(1, Math.floor(arr.length / 32))
    for (let i = 0; i < arr.length; i += step) {
      const c = arr[i]
      r += (c >> 16) & 255
      g += (c >> 8) & 255
      b += c & 255
      n++
    }
  }
  if (!n) return 'rgba(128,128,128,0.35)'
  return `rgb(${Math.round(r / n)}, ${Math.round(g / n)}, ${Math.round(b / n)})`
}
