import { useEffect, useId, useMemo, useRef, type ReactElement } from 'react'
import type { LightInfo } from '../../../shared/types'
import { onFrame } from '../state'

/**
 * Stylised front view of this PC (be quiet! Light Base 900 FX):
 * rear fan (left), 3 radiator fans (top), 3 side intake fans (right), 3 bottom fans,
 * AIO pump, 2 RAM sticks, RTX 5080 AERO, I/O cover & chipset accents, and the case's side light strip.
 * Every LED-ish shape is painted from the live engine frames.
 */

interface LedShape {
  d: string
  key?: string
  idx: number
  group?: string
}

const TAU = Math.PI * 2
const FAN_LEDS = 20 // be quiet! Light Wings: 20 LEDs per fan (mirrored on the shared hub)
const PUMP_LEDS = 16
const STRIP_SEGMENTS = 43
const STRIP_LEDS = 172

function ringSegments(cx: number, cy: number, rx: number, ry: number, thick: number, n: number, key: string | undefined, group: string | undefined, map: (i: number) => number = (i) => i): LedShape[] {
  const out: LedShape[] = []
  const gap = 0.16
  for (let i = 0; i < n; i++) {
    const a0 = -Math.PI / 2 + ((i + gap / 2) * TAU) / n
    const a1 = -Math.PI / 2 + ((i + 1 - gap / 2) * TAU) / n
    const pts: string[] = []
    const steps = 3
    const irx = rx - thick
    const iry = ry - (thick * ry) / rx
    for (let s = 0; s <= steps; s++) {
      const a = a0 + ((a1 - a0) * s) / steps
      pts.push(`${(cx + rx * Math.cos(a)).toFixed(1)} ${(cy + ry * Math.sin(a)).toFixed(1)}`)
    }
    for (let s = steps; s >= 0; s--) {
      const a = a0 + ((a1 - a0) * s) / steps
      pts.push(`${(cx + irx * Math.cos(a)).toFixed(1)} ${(cy + iry * Math.sin(a)).toFixed(1)}`)
    }
    out.push({ d: `M${pts.join(' L')}Z`, key, idx: map(i), group })
  }
  return out
}

function barSegments(x: number, y: number, w: number, h: number, n: number, vertical: boolean, key: string | undefined, group: string | undefined, map: (i: number) => number = (i) => i): LedShape[] {
  const out: LedShape[] = []
  const gap = 0.18
  for (let i = 0; i < n; i++) {
    if (vertical) {
      const sh = h / n
      const sy = y + i * sh + (sh * gap) / 2
      out.push({ d: `M${x} ${sy.toFixed(1)}h${w}v${(sh * (1 - gap)).toFixed(1)}h${-w}Z`, key, idx: map(i), group })
    } else {
      const sw = w / n
      const sx = x + i * sw + (sw * gap) / 2
      out.push({ d: `M${sx.toFixed(1)} ${y}h${(sw * (1 - gap)).toFixed(1)}v${h}h${(-sw * (1 - gap)).toFixed(1)}Z`, key, idx: map(i), group })
    }
  }
  return out
}

function FanFace({ cx, cy, r }: { cx: number; cy: number; r: number }): ReactElement {
  const blades = Array.from({ length: 7 }, (_, k) => k)
  const b = `M0 ${-r * 0.3} C ${r * 0.38} ${-r * 0.42} ${r * 0.5} ${-r * 0.78} ${r * 0.16} ${-r * 0.9} C ${-r * 0.02} ${-r * 0.7} ${-r * 0.1} ${-r * 0.5} 0 ${-r * 0.3}Z`
  return (
    <g>
      <rect x={cx - r - 7} y={cy - r - 7} width={2 * r + 14} height={2 * r + 14} rx={12} fill="var(--metal)" stroke="var(--metal-stroke)" />
      <circle cx={cx} cy={cy} r={r - 1} fill="var(--case-inner)" />
      {blades.map((k) => (
        <path key={k} d={b} transform={`translate(${cx} ${cy}) rotate(${(k * 360) / 7})`} fill="var(--board)" stroke="var(--metal-stroke)" strokeWidth={0.6} />
      ))}
      <circle cx={cx} cy={cy} r={r * 0.3} fill="var(--fan-hub)" stroke="var(--metal-stroke)" />
    </g>
  )
}

function FanTilted({ cx, cy, rx, ry }: { cx: number; cy: number; rx: number; ry: number }): ReactElement {
  return (
    <g>
      <rect x={cx - rx - 6} y={cy - ry - 5} width={2 * rx + 12} height={2 * ry + 10} rx={8} fill="var(--metal)" stroke="var(--metal-stroke)" />
      <ellipse cx={cx} cy={cy} rx={rx - 1} ry={ry - 1} fill="var(--case-inner)" />
      <ellipse cx={cx} cy={cy} rx={rx * 0.3} ry={ry * 0.3} fill="var(--fan-hub)" stroke="var(--metal-stroke)" />
    </g>
  )
}

export function PcPreview({ lights, focus = null, power, brightness }: {
  lights: LightInfo[]
  focus?: string | null
  power: boolean
  brightness: number
}): ReactElement {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '')
  const svgRef = useRef<SVGSVGElement>(null)

  const visible = lights.filter((l) => !l.hidden && l.ledCount > 0)
  const fans = visible.find((l) => l.kind === 'fans')
  const gpu = visible.find((l) => l.kind === 'gpu')
  const ram = visible.filter((l) => l.kind === 'ram').sort((a, b) => a.zoneName.localeCompare(b.zoneName))
  const io = visible.find((l) => l.kind === 'board' && /i\/o/i.test(l.zoneName))
  const chipset = visible.find((l) => l.kind === 'board' && /chipset/i.test(l.zoneName))
  const layoutKey = [fans, gpu, io, chipset, ...ram].map((l) => l?.key ?? '-').join('|')

  const shapes = useMemo(() => {
    const s: LedShape[] = []
    const fk = fans?.key
    const fg = fans?.group
    // rear fan (left wall)
    s.push(...ringSegments(80, 150, 36, 36, 4.5, FAN_LEDS, fk, fg))
    // radiator fans (top, seen at an angle)
    for (const x of [218, 302, 386]) s.push(...ringSegments(x, 66, 37, 11, 3.2, FAN_LEDS, fk, fg))
    // side intake fans (right wall)
    for (const y of [124, 212, 300]) s.push(...ringSegments(482, y, 38, 38, 4.5, FAN_LEDS, fk, fg))
    // bottom fans
    for (const x of [190, 288, 386]) s.push(...ringSegments(x, 398, 42, 12, 3.4, FAN_LEDS, fk, fg))
    // AIO pump ring
    s.push(...ringSegments(246, 156, 23, 23, 4, PUMP_LEDS, fk, fg))
    // case side strip (172 LEDs drawn as 43 segments)
    s.push(...barSegments(562, 46, 7, 368, STRIP_SEGMENTS, true, fk, fg, (i) => Math.round((i / (STRIP_SEGMENTS - 1)) * (STRIP_LEDS - 1))))
    // RAM sticks (12 LEDs each)
    ram.forEach((l, k) => s.push(...barSegments(307 + k * 15, 112, 5, 88, 12, true, l.key, l.group)))
    // GPU side light (single zone)
    if (gpu) s.push({ d: 'M146 247h150a2.5 2.5 0 010 5h-150a2.5 2.5 0 010-5z', key: gpu.key, idx: 0, group: gpu.group })
    // I/O cover accent (10 LEDs)
    if (io) s.push(...barSegments(178, 106, 4, 80, io.ledCount, true, io.key, io.group))
    // chipset accent (4 LEDs) along the top edge
    if (chipset) s.push(...barSegments(338, 300, 44, 3.5, chipset.ledCount, false, chipset.key, chipset.group))
    return s
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey])

  // Paint from live frames without re-rendering React.
  useEffect(() => {
    const root = svgRef.current
    if (!root) return
    const nodes = Array.from(root.querySelectorAll<SVGPathElement>('path[data-led]'))
    const items = nodes.map((n) => ({ n, key: n.dataset.key ?? '', idx: Number(n.dataset.idx) }))
    return onFrame((f) => {
      for (const it of items) {
        const arr = f[it.key]
        let css = 'var(--led-off)'
        if (arr && arr.length) {
          const c = arr[Math.min(it.idx, arr.length - 1)]
          const r = (c >> 16) & 255
          const g = (c >> 8) & 255
          const b = c & 255
          if (r + g + b > 24) css = `rgb(${r},${g},${b})`
        }
        if (it.n.style.fill !== css) it.n.style.fill = css
      }
    })
  }, [shapes])

  const ledOpacity = power ? 0.35 + 0.65 * (brightness / 100) : 0.08
  const cls = (group?: string): string => (focus && group !== focus ? 'led faded' : 'led')
  const deco = (group: string | undefined): string => (focus && group !== focus ? 'dimmable faded' : 'dimmable')

  return (
    <svg ref={svgRef} className="pc-preview" viewBox="0 0 600 460" role="img" aria-label="Live preview of your PC's lighting">
      <defs>
        <filter id={`glow${uid}`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="7" />
        </filter>
        <linearGradient id={`glass${uid}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity="0.5" />
          <stop offset="0.45" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/* case */}
      <rect x="14" y="14" width="572" height="432" rx="26" fill="var(--case-fill)" stroke="var(--case-stroke)" />
      <rect x="28" y="30" width="518" height="402" rx="16" fill="var(--case-inner)" stroke="var(--case-stroke)" />
      <rect x="555" y="40" width="21" height="380" rx="8" fill="var(--case-inner)" stroke="var(--case-stroke)" />

      {/* hardware (static decoration) */}
      <g className={deco(fans?.group)}>
        <FanFace cx={80} cy={150} r={36} />
        <rect x="162" y="34" width="282" height="14" rx="4" fill="var(--metal)" stroke="var(--metal-stroke)" />
        {[218, 302, 386].map((x) => <FanTilted key={x} cx={x} cy={66} rx={37} ry={11} />)}
        {[124, 212, 300].map((y) => <FanFace key={y} cx={482} cy={y} r={38} />)}
        {[190, 288, 386].map((x) => <FanTilted key={x} cx={x} cy={398} rx={42} ry={12} />)}
      </g>
      <g className={focus ? 'dimmable faded' : 'dimmable'}>
        <rect x="126" y="94" width="292" height="262" rx="9" fill="var(--board)" stroke="var(--metal-stroke)" />
      </g>
      <g className={deco(io?.group)}>
        <rect x="134" y="100" width="54" height="92" rx="8" fill="var(--metal)" stroke="var(--metal-stroke)" />
      </g>
      <g className={deco(fans?.group)}>
        <path d="M232 132 C 232 96, 262 96, 262 78" stroke="var(--metal)" strokeWidth="8" fill="none" strokeLinecap="round" />
        <path d="M262 132 C 262 104, 340 108, 340 78" stroke="var(--metal)" strokeWidth="8" fill="none" strokeLinecap="round" />
        <rect x="214" y="124" width="64" height="64" rx="16" fill="var(--metal)" stroke="var(--metal-stroke)" />
        <circle cx="246" cy="156" r="17" fill="var(--fan-hub)" stroke="var(--metal-stroke)" />
      </g>
      <g className={deco(ram[0]?.group)}>
        {ram.map((l, k) => <rect key={l.key} x={304 + k * 15} y="106" width="11" height="100" rx="3" fill="var(--metal)" stroke="var(--metal-stroke)" />)}
      </g>
      <g className={deco(gpu?.group)}>
        <rect x="134" y="240" width="276" height="52" rx="10" fill="var(--metal)" stroke="var(--metal-stroke)" />
        <text x="388" y="273" textAnchor="end" fontSize="12" fontWeight="700" letterSpacing="2" fill="var(--text-3)">AERO</text>
      </g>
      <g className={deco(chipset?.group)}>
        <rect x="334" y="304" width="52" height="34" rx="7" fill="var(--metal)" stroke="var(--metal-stroke)" />
      </g>

      {/* LEDs: blurred glow underneath, crisp on top */}
      <g style={{ opacity: ledOpacity, transition: 'opacity 0.35s ease' }}>
        <use href={`#leds${uid}`} filter={`url(#glow${uid})`} opacity={0.9} />
        <g id={`leds${uid}`}>
          {shapes.map((s, i) => (
            <path key={i} d={s.d} data-led="" data-key={s.key ?? ''} data-idx={s.idx} className={cls(s.group)} style={{ fill: 'var(--led-off)' }} />
          ))}
        </g>
      </g>

      {/* glass sheen */}
      <rect x="28" y="30" width="518" height="402" rx="16" fill={`url(#glass${uid})`} pointerEvents="none" opacity="0.35" />
    </svg>
  )
}
