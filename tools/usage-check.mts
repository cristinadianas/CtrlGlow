// Read-only: measures what Lumen costs this PC over a time window. For each Lumen process, and for OpenRGB (which
// does the hardware work Lumen asks for), it reports CPU, memory, threads, handles, wake-ups and local I/O. It only
// reads Windows' own process counters (no admin needed) and Lumen's state; it changes nothing.
//
//   node tools/usage-check.mts                                 60 seconds, prints a table
//   node tools/usage-check.mts --seconds=120 --label="Window closed" --out=usage.json
//   --edge         also measure Microsoft Edge's processes, with their GPU use (the Lumen window runs inside Edge)
//   --every=5      seconds between samples (for memory peaks and CPU spikes)
//   --out=<file>   add the results to a JSON file (an array of runs)
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'

interface ProcInfo { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null; Started: string | null }
interface Target { pid: number; group: 'Lumen' | 'OpenRGB' | 'Edge'; name: string; started: string | null }
interface Counters {
  ProcessId: number
  KernelModeTime: number
  UserModeTime: number
  WorkingSetSize: number
  PrivatePageCount: number
  HandleCount: number
  ThreadCount: number
  WriteTransferCount: number
  OtherTransferCount: number
  OtherOperationCount: number
}
interface Sample { t: number; procs: Map<number, Counters>; switches: Map<number, number>; gpu: Map<number, number>; systemCpu: number }

const args = process.argv.slice(2)
const opt = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const seconds = Number(opt('seconds') ?? 60)
const every = Number(opt('every') ?? 5)
const label = opt('label') ?? 'Lumen'
const out = opt('out')
const withEdge = args.includes('--edge')
const logical = cpus().length

const asArray = <T,>(v: T | T[] | null | undefined): T[] => (v == null ? [] : Array.isArray(v) ? v : [v])
const round = (v: number, digits = 2): number => Number(v.toFixed(digits))
const mb = (bytes: number): number => round(bytes / 1048576, 1)

/** Runs a PowerShell script (passed encoded, so no quoting surprises) and parses its JSON output. */
function powershell<T>(script: string): Promise<T> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, maxBuffer: 64 << 20 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message))
        try {
          resolve(JSON.parse(stdout) as T)
        } catch {
          reject(new Error(`Unexpected PowerShell output: ${stdout.slice(0, 300)}`))
        }
      })
  })
}

function edgeName(cmd: string): string {
  const type = /--type=(\S+)/.exec(cmd)?.[1]
  if (!type) return 'Edge (browser)'
  if (type === 'renderer') return 'Edge (page)'
  if (type === 'gpu-process') return 'Edge (GPU)'
  if (type === 'utility') return `Edge (${/--utility-sub-type=([\w.]+)/.exec(cmd)?.[1]?.split('.')[0] ?? 'utility'})`
  return `Edge (${type})`
}

async function findTargets(): Promise<Target[]> {
  const all = asArray(await powershell<ProcInfo | ProcInfo[]>(
    "Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, CommandLine, @{n='Started';e={ if ($_.CreationDate) { $_.CreationDate.ToString('o') } }} | ConvertTo-Json -Compress"))
  const name = (p: ProcInfo): string => p.Name.toLowerCase()
  const targets: Target[] = []
  const add = (p: ProcInfo, group: Target['group'], label: string): void => {
    targets.push({ pid: p.ProcessId, group, name: label, started: p.Started })
  }
  const service = all.find((p) => name(p) === 'node.exe' && /src[\\/]service[\\/]index\.ts/i.test(p.CommandLine ?? '') && !/--exit-after/.test(p.CommandLine ?? ''))
  if (service) {
    add(service, 'Lumen', 'Lumen service (node.exe)')
    const host = all.find((p) => p.ProcessId === service.ParentProcessId && name(p) === 'conhost.exe')
    if (host) add(host, 'Lumen', 'Windowless host (conhost.exe)')
    for (const p of all) if (p.ParentProcessId === service.ProcessId && /tray\.ps1/i.test(p.CommandLine ?? '')) add(p, 'Lumen', 'Tray icon (powershell.exe)')
  }
  for (const p of all) if (name(p) === 'openrgb.exe') add(p, 'OpenRGB', 'OpenRGB service')
  if (withEdge) for (const p of all) if (name(p) === 'msedge.exe') add(p, 'Edge', edgeName(p.CommandLine ?? ''))
  return targets
}

async function sample(pids: number[]): Promise<Sample> {
  const procFilter = pids.map((id) => `ProcessId=${id}`).join(' OR ')
  const threadFilter = pids.map((id) => `IDProcess=${id}`).join(' OR ')
  const script = [
    `$p = @(Get-CimInstance Win32_Process -Filter '${procFilter}' | Select-Object ProcessId, KernelModeTime, UserModeTime, WorkingSetSize, PrivatePageCount, HandleCount, ThreadCount, WriteTransferCount, OtherTransferCount, OtherOperationCount)`,
    // Context switches are counted per thread; their sum per process is a good measure of how often it wakes a core.
    `$c = @(Get-CimInstance Win32_PerfRawData_PerfProc_Thread -Filter '${threadFilter}' | Group-Object IDProcess | ForEach-Object { [pscustomobject]@{ ProcessId = [int]$_.Name; Switches = [double](($_.Group | Measure-Object ContextSwitchesPersec -Sum).Sum) } })`,
    // One-second readings: the whole PC's CPU and, with --edge, every process's GPU use.
    `$k = @((Get-Counter -Counter @('\\Processor(_Total)\\% Processor Time'${withEdge ? ", '\\GPU Engine(*)\\Utilization Percentage'" : ''}) -ErrorAction SilentlyContinue).CounterSamples)`,
    `$s = [double]($k | Where-Object { $_.Path -like '*\\processor(_total)\\*' } | Select-Object -First 1).CookedValue`,
    // Like Task Manager: a process's GPU use is its busiest engine.
    `$g = @($k | ForEach-Object { if ($_.InstanceName -match '^pid_(\\d+)_.*engtype_(.+)$') { [pscustomobject]@{ ProcessId = [int]$matches[1]; Engine = $matches[2]; Value = [double]$_.CookedValue } } })`,
    '[pscustomobject]@{ procs = $p; switches = $c; system = $s; gpu = $g } | ConvertTo-Json -Compress -Depth 4'
  ].join('\n')
  const raw = await powershell<{ procs: Counters | Counters[]; switches: unknown; system: number; gpu: unknown }>(script)
  const gpu = new Map<number, number>()
  const byEngine = new Map<string, number>()
  for (const g of asArray(raw.gpu as { ProcessId: number; Engine: string; Value: number }[])) {
    const k = `${g.ProcessId}|${g.Engine}`
    byEngine.set(k, (byEngine.get(k) ?? 0) + g.Value)
  }
  for (const [k, v] of byEngine) {
    const pid = Number(k.split('|')[0])
    gpu.set(pid, Math.max(gpu.get(pid) ?? 0, v))
  }
  return {
    t: performance.now(),
    procs: new Map(asArray(raw.procs).map((p) => [p.ProcessId, p])),
    switches: new Map(asArray(raw.switches as { ProcessId: number; Switches: number }[]).map((s) => [s.ProcessId, s.Switches])),
    gpu,
    systemCpu: raw.system
  }
}

async function lumenState(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch('http://127.0.0.1:6743/api/getState', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:6743' },
      body: '[]',
      signal: AbortSignal.timeout(3000)
    })
    const s = await res.json() as { connection: string; power: boolean; brightness: number; scene: { effect: string; speed: number }; prefs: { fps: number }; lights: { online: boolean; scene: unknown }[] }
    return {
      connection: s.connection,
      power: s.power,
      brightness: s.brightness,
      effect: s.scene.effect,
      speed: s.scene.speed,
      fps: s.prefs.fps,
      lights: s.lights.length,
      online: s.lights.filter((l) => l.online).length,
      ownScenes: s.lights.filter((l) => l.scene).length
    }
  } catch {
    return null
  }
}

/** Open Lumen windows: Edge's connections to Lumen (this tool's own request to Lumen is not one). */
const windowConnections = async (): Promise<number> =>
  (await powershell<number>("@(Get-NetTCPConnection -RemotePort 6743 -State Established -ErrorAction SilentlyContinue | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name -eq 'msedge' }).Count | ConvertTo-Json")) ?? 0

/* ------------------------------------------------------------------ */

const targets = await findTargets()
if (!targets.some((t) => t.group === 'Lumen')) console.log('Lumen isn\'t running: measuring the other processes only.')
const pids = targets.map((t) => t.pid)
const state = await lumenState()
const windowOpen = (await windowConnections()) > 0
console.log(`Measuring ${targets.length} processes for ${seconds} s (${label})…`)

const samples: Sample[] = []
const startedAt = new Date().toISOString()
const end = performance.now() + seconds * 1000
for (;;) {
  samples.push(await sample(pids))
  const left = end - performance.now()
  if (left <= 0) break
  await new Promise((r) => setTimeout(r, Math.min(every * 1000, left)))
}

const first = samples[0]
const last = samples[samples.length - 1]
const wallSec = (last.t - first.t) / 1000
const results = targets.flatMap((t) => {
  const a = first.procs.get(t.pid)
  const b = last.procs.get(t.pid)
  if (!a || !b) return []
  const cpuSec = (b.KernelModeTime + b.UserModeTime - a.KernelModeTime - a.UserModeTime) / 1e7
  const kernelSec = (b.KernelModeTime - a.KernelModeTime) / 1e7
  let peak = 0
  let switches = 0
  const ws: number[] = []
  const priv: number[] = []
  const gpu: number[] = []
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i].procs.get(t.pid)
    if (!s) continue
    ws.push(s.WorkingSetSize)
    priv.push(s.PrivatePageCount)
    if (withEdge) gpu.push(samples[i].gpu.get(t.pid) ?? 0)
    if (i === 0) continue
    const p = samples[i - 1].procs.get(t.pid)
    const dt = (samples[i].t - samples[i - 1].t) / 1000
    if (p && dt > 0) peak = Math.max(peak, (s.KernelModeTime + s.UserModeTime - p.KernelModeTime - p.UserModeTime) / 1e7 / dt)
    // Threads that end take their count with them, so a drop is not counted backwards.
    const before = samples[i - 1].switches.get(t.pid)
    const now = samples[i].switches.get(t.pid)
    if (before !== undefined && now !== undefined) switches += Math.max(0, now - before)
  }
  const avg = (v: number[]): number => v.reduce((x, y) => x + y, 0) / Math.max(1, v.length)
  return [{
    group: t.group,
    name: t.name,
    pid: t.pid,
    runningMinutes: t.started ? round((Date.parse(startedAt) - Date.parse(t.started)) / 60000, 0) : null,
    cpuPercentOfPC: round((cpuSec / wallSec / logical) * 100, 3),
    cpuPercentOfOneCore: round((cpuSec / wallSec) * 100),
    kernelShare: cpuSec > 0 ? round(kernelSec / cpuSec) : 0,
    peakPercentOfOneCore: round(peak * 100),
    workingSetMB: mb(avg(ws)),
    workingSetMaxMB: mb(Math.max(...ws)),
    privateMB: mb(avg(priv)),
    privateMaxMB: mb(Math.max(...priv)),
    threads: b.ThreadCount,
    handles: b.HandleCount,
    wakeupsPerSec: round(switches / wallSec, 0),
    // Device and control I/O as Windows counts it (USB and driver requests, some socket traffic). Node's socket
    // traffic usually takes a fast path Windows doesn't count, so this is not the traffic between Lumen and OpenRGB.
    otherIoKBPerSec: round((b.OtherTransferCount - a.OtherTransferCount) / 1024 / wallSec, 1),
    otherIoOpsPerSec: round((b.OtherOperationCount - a.OtherOperationCount) / wallSec, 0),
    fileWritesKBPerSec: round((b.WriteTransferCount - a.WriteTransferCount) / 1024 / wallSec, 2),
    ...(withEdge ? { gpuPercent: round(avg(gpu), 2), gpuMaxPercent: round(Math.max(0, ...gpu), 2) } : {})
  }]
})

const groups = [...new Set(results.map((r) => r.group))].map((group) => {
  const rs = results.filter((r) => r.group === group)
  const sum = (k: 'cpuPercentOfPC' | 'cpuPercentOfOneCore' | 'workingSetMB' | 'privateMB' | 'wakeupsPerSec'): number => round(rs.reduce((x, r) => x + r[k], 0), 3)
  return { group, cpuPercentOfPC: sum('cpuPercentOfPC'), cpuPercentOfOneCore: sum('cpuPercentOfOneCore'), workingSetMB: sum('workingSetMB'), privateMB: sum('privateMB'), wakeupsPerSec: sum('wakeupsPerSec') }
})

const run = {
  label,
  startedAt,
  seconds: round(wallSec, 1),
  samples: samples.length,
  machine: { logicalProcessors: logical, cpu: cpus()[0]?.model.trim(), ramGB: round(totalmem() / 1073741824, 1) },
  pcCpuPercentAverage: round(samples.reduce((x, s) => x + s.systemCpu, 0) / samples.length, 1),
  lumen: state,
  windowOpen,
  groups,
  processes: results
}

console.table(results.map((r) => ({
  process: r.name,
  'CPU % of PC': r.cpuPercentOfPC,
  '% of 1 core': r.cpuPercentOfOneCore,
  'peak % core': r.peakPercentOfOneCore,
  kernel: r.kernelShare,
  'RAM MB': r.workingSetMB,
  'private MB': r.privateMB,
  'wake-ups/s': r.wakeupsPerSec,
  threads: r.threads,
  handles: r.handles,
  ...(withEdge ? { 'GPU %': (r as { gpuPercent?: number }).gpuPercent } : {})
})))
console.table(groups)
console.log(`Whole PC CPU meanwhile: ${run.pcCpuPercentAverage}% on average. Lumen: ${JSON.stringify(state)}; window open: ${windowOpen}`)

if (out) {
  const runs: unknown[] = existsSync(out) ? asArray(JSON.parse(readFileSync(out, 'utf8')) as unknown[]) : []
  runs.push(run)
  writeFileSync(out, JSON.stringify(runs, null, 2) + '\n')
  console.log(`Added to ${out}`)
}
