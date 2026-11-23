// Measures whether every user color is visible *at the same time* in multi-color effects, on a fan ring
// (shared LEDs 0-19), on the case strip (LEDs 20-171) and on a RAM stick (12 LEDs), over 60 s of simulated time.
// Compares the old mapping (one 256-LED run) with the new layout (20-LED loop + strip run).
// Run: node tools/effects-check.mts
import { hexToRgb } from '../src/shared/color.ts'
import { renderScene, type LedSegment } from '../src/shared/effects.ts'
import type { Scene } from '../src/shared/types.ts'

const scenes: Scene[] = [
  { effect: 'gradient', colors: ['#ff0000', '#0000ff'], speed: 45, reverse: false, level: 100 },
  { effect: 'gradient', colors: ['#ff5e62', '#ffb347', '#00c6ff'], speed: 0, reverse: false, level: 100 },
  { effect: 'wave', colors: ['#00c6ff', '#7a5cff'], speed: 45, reverse: false, level: 100 },
  { effect: 'wave', colors: ['#ff0000', '#00ff00', '#0000ff'], speed: 45, reverse: false, level: 100 },
  { effect: 'aurora', colors: ['#00f5a0', '#00b4ff', '#7b61ff'], speed: 35, reverse: false, level: 100 },
  { effect: 'aurora', colors: ['#ff0080', '#ffd000'], speed: 35, reverse: false, level: 100 }
]

/** % of frames in which every color covers at least 10% of the region (blends in between don't count). */
function allVisible(scene: Scene, count: number, layout: LedSegment[] | undefined, from: number, to: number): number {
  const pal = scene.colors.map(hexToRgb)
  const buf = new Float32Array(count * 3)
  let good = 0
  const frames = 600
  for (let step = 0; step < frames; step++) {
    renderScene(scene, { t: step * 0.1, count, phase: 0, seed: 0.42, layout }, buf)
    const hits = new Array(pal.length).fill(0)
    for (let i = from; i < to; i++) {
      const r = buf[i * 3], g = buf[i * 3 + 1], b = buf[i * 3 + 2]
      const m = Math.max(r, g, b)
      if (m < 40) continue
      const k = 255 / m // compare color, not brightness
      let best = -1, bestD = 90 ** 2
      pal.forEach(([pr, pg, pb], c) => {
        const d = (r * k - pr) ** 2 + (g * k - pg) ** 2 + (b * k - pb) ** 2
        if (d < bestD) { bestD = d; best = c }
      })
      if (best >= 0) hits[best]++
    }
    const n = to - from
    if (hits.every((h) => h >= Math.max(1, n * 0.1))) good++
  }
  return Math.round((good / frames) * 100)
}

const oldLayout = undefined // one run over all 256 LEDs (previous behaviour)
const newLayout: LedSegment[] = [{ start: 0, length: 20, loop: true }, { start: 20, length: 152, loop: false }]
const pct = (v: number): string => `${String(v).padStart(3)}%`

console.log('How often ALL colors are visible at once (higher = better)\n')
console.log('effect / colors              fan ring OLD   fan ring NEW   strip OLD   strip NEW   RAM stick')
for (const s of scenes) {
  const label = `${s.effect} ${s.colors.length} colors${s.effect === 'gradient' && s.speed === 0 ? ' (still)' : ''}`.padEnd(28)
  console.log(
    label,
    pct(allVisible(s, 256, oldLayout, 0, 20)).padStart(12),
    pct(allVisible(s, 172, newLayout, 0, 20)).padStart(14),
    pct(allVisible(s, 256, oldLayout, 20, 172)).padStart(11),
    pct(allVisible(s, 172, newLayout, 20, 172)).padStart(11),
    pct(allVisible(s, 12, undefined, 0, 12)).padStart(11)
  )
}
