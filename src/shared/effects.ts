/**
 * Lighting effects. Pure functions of (scene, time, LED position) so the same code drives the
 * real hardware (service) and the live previews in the UI.
 *
 * A light's LEDs are described by a layout of segments: a *loop* (e.g. a fan ring, where the last
 * LED sits next to the first) or a *run* (a strip or RAM stick). Every effect draws its complete
 * pattern on each segment, so every color shows up on every fan ring and along the strip.
 */
import { hexToRgb, hsvToRgb, mixColors, paletteFor, type RGBTuple } from './color.ts'
import type { EffectId, Scene } from './types.ts'

export interface EffectMeta {
  id: EffectId
  name: string
  blurb: string
  /** Number of user colors the effect uses (0 = none, e.g. rainbow). */
  colors: { min: number; max: number; defaults: string[]; labels?: string[] }
  /** For effects drawn over a background (Scene.background): the background of the effect's own default look. */
  background?: string
  speed: boolean
  direction: boolean
}

export const EFFECTS: EffectMeta[] = [
  { id: 'static', name: 'Solid', blurb: 'One steady color', colors: { min: 1, max: 1, defaults: ['#ff8a1f'] }, speed: false, direction: false },
  { id: 'breathing', name: 'Breathe', blurb: 'A slow, calm pulse', colors: { min: 1, max: 4, defaults: ['#4f7cff'] }, speed: true, direction: false },
  { id: 'gradient', name: 'Gradient', blurb: 'A smooth blend that drifts', colors: { min: 2, max: 4, defaults: ['#ff5e62', '#ffb347'] }, speed: true, direction: true },
  { id: 'wave', name: 'Wave', blurb: 'Colors roll across the lights', colors: { min: 1, max: 4, defaults: ['#00c6ff', '#7a5cff'] }, speed: true, direction: true },
  { id: 'spectrum', name: 'Spectrum', blurb: 'Glides through every color', colors: { min: 0, max: 0, defaults: [] }, speed: true, direction: true },
  { id: 'rainbow', name: 'Rainbow', blurb: 'A flowing rainbow', colors: { min: 0, max: 0, defaults: [] }, speed: true, direction: true },
  { id: 'aurora', name: 'Aurora', blurb: 'Drifting northern lights', colors: { min: 2, max: 4, defaults: ['#00f5a0', '#00b4ff', '#7b61ff'] }, speed: true, direction: true },
  { id: 'comet', name: 'Comet', blurb: 'A bright streak racing around', colors: { min: 1, max: 1, defaults: ['#ffffff'], labels: ['Streak'] }, background: '#1a1f4d', speed: true, direction: true },
  { id: 'twinkle', name: 'Starlight', blurb: 'Gentle, random sparkles', colors: { min: 1, max: 1, defaults: ['#fff3d6'], labels: ['Sparkle'] }, background: '#1b2a6b', speed: true, direction: false },
  { id: 'candle', name: 'Candle', blurb: 'A warm, flickering glow', colors: { min: 1, max: 1, defaults: ['#ff8c2a'] }, speed: true, direction: false }
]

export const EFFECT_BY_ID: Record<EffectId, EffectMeta> = Object.fromEntries(EFFECTS.map((e) => [e.id, e])) as Record<EffectId, EffectMeta>

export const DEFAULT_SCENE: Scene = { effect: 'static', colors: ['#d47800'], speed: 45, reverse: false, level: 100 }

/** Effects whose output never changes over time (lets the engine idle). */
export function isStaticScene(scene: Scene): boolean {
  return scene.effect === 'static' || (scene.effect === 'gradient' && scene.speed === 0)
}

/**
 * Returns a scene adapted to another effect, keeping colors/speed where it makes sense. All colors are kept even
 * when the new effect uses fewer (it uses the first ones; see effectColors), so trying Solid or Candle and going
 * back to Wave doesn't lose a palette. Comet and Starlight only get a background the user set (else they stay
 * dark around the streak or sparkles), never one of the palette's colors.
 */
export function withEffect(scene: Scene, effect: EffectId): Scene {
  const meta = EFFECT_BY_ID[effect]
  if (meta.colors.max === 0 || scene.colors.length >= Math.max(1, meta.colors.min)) return { ...scene, effect }
  // Too few colors to look right: start from the effect's own look, background included.
  const next: Scene = { ...scene, effect, colors: [...meta.colors.defaults] }
  if (meta.background && !scene.background) next.background = meta.background
  return next
}

const HEX = /^#[0-9a-f]{6}$/i

/**
 * A valid scene from untrusted input (the window, or a settings file): unknown effects become Solid, colors must
 * be '#rrggbb' (at most 4), numbers are clamped to 0..100, and an effect with no usable colors gets its own
 * default look. A valid scene comes back unchanged.
 */
export function sanitizeScene(input: Scene): Scene {
  const effect = EFFECT_BY_ID[input?.effect] ? input.effect : 'static'
  const colors = Array.isArray(input?.colors) ? input.colors.filter((c) => typeof c === 'string' && HEX.test(c)).slice(0, 4) : []
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : d)
  const meta = EFFECT_BY_ID[effect]
  const useDefaults = !colors.length && meta.colors.max > 0
  const background = typeof input?.background === 'string' && HEX.test(input.background)
    ? input.background
    : useDefaults ? meta.background : undefined
  return {
    effect,
    colors: useDefaults ? [...meta.colors.defaults] : colors,
    speed: num(input?.speed, 45),
    reverse: !!input?.reverse,
    level: num(input?.level, 100),
    ...(background ? { background } : {}),
    ...(input?.bands === true ? { bands: true } : {})
  }
}

/** The colors an effect actually uses: the first `max` of the scene's colors (scenes may keep more for later). */
export function effectColors(scene: Scene): string[] {
  const max = EFFECT_BY_ID[scene.effect]?.colors.max ?? 4
  return max === 0 ? [] : scene.colors.slice(0, max)
}

/** A stretch of LEDs: a loop (fan ring) or a run (strip, bar). */
export interface LedSegment {
  start: number
  length: number
  loop: boolean
}

export interface RenderContext {
  /** Seconds since the engine started. */
  t: number
  /** Number of LEDs in this light. */
  count: number
  /** 0..1 position of this light within the PC; spreads synced effects across devices. */
  phase: number
  /** Stable per-light random seed. */
  seed: number
  /** How the LEDs are arranged. Defaults to one run over all LEDs. LEDs outside every segment stay off. */
  layout?: LedSegment[]
}

/** Maps the 0..100 speed slider to a rate multiplier (exponential feels natural). */
export function speedFactor(speed: number): number {
  return 0.08 * Math.pow(25, Math.max(0, Math.min(100, speed)) / 100)
}

/* ---------------- noise helpers ---------------- */

function hash(n: number): number {
  let x = Math.imul((n | 0) ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

/** Smooth value noise in 0..1. With `period`, the lattice wraps so the noise tiles seamlessly (for loops). */
function noise(x: number, period = 0, salt = 0): number {
  const i = Math.floor(x)
  const f = x - i
  const s = f * f * (3 - 2 * f)
  const wrap = (k: number): number => (period > 0 ? ((k % period) + period) % period : k)
  const a = hash(wrap(i) * 7 + salt * 1013)
  const b = hash(wrap(i + 1) * 7 + salt * 1013)
  return a + (b - a) * s
}

function fract(x: number): number {
  return x - Math.floor(x)
}

/** Brightness (0..1, perceptual) of a breath at position p (0..1) in its cycle. */
function breathLevel(p: number): number {
  const wave = 0.5 - 0.5 * Math.cos(2 * Math.PI * p)
  return 0.03 + 0.97 * Math.pow(wave, 1.6)
}

/** The steady level (perceptual) that gives off as much light as a breath does on average. */
const BREATH_AVERAGE = (() => {
  const steps = 512
  let light = 0
  for (let k = 0; k < steps; k++) light += Math.pow(breathLevel(k / steps), 2.2)
  return Math.pow(light / steps, 1 / 2.2)
})()

/** Aurora's color field: two octaves of value noise (periodic when `period` > 0, for loops). */
function auroraField(a: number, b: number, period: number): number {
  return 0.6 * noise(a, period, 1) + 0.4 * noise(b, period ? period * 2 : 0, 2)
}

/** Sorted samples of auroraField: its distribution, used to spread its values evenly over 0..1. */
const AURORA_QUANTILES = (() => {
  const samples = new Float64Array(4096)
  for (let k = 0; k < samples.length; k++) samples[k] = auroraField(k * 0.6180339887 * 7.3, k * 0.4142135623 * 5.1, 0)
  return samples.sort()
})()

/** Maps an auroraField value to 0..1 so that every part of the range is equally common. */
function auroraEven(v: number): number {
  const q = AURORA_QUANTILES
  let lo = 0
  let hi = q.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (q[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo / q.length
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)))
  return t * t * (3 - 2 * t)
}

/** Where one LED sits within its segment. */
interface Spot {
  /** Index into the light's LEDs. */
  i: number
  /** 0..1 around a loop / along a run, wrapping (LED length-1 sits just before 1). */
  u: number
  /** 0..1 from the first to the last LED of a run (end to end, no wrap). */
  v: number
  seg: LedSegment
}

/**
 * Renders a scene into `out` (count * 3 floats, 0..255).
 * Scene.level (0..100) scales the result.
 */
export function renderScene(scene: Scene, ctx: RenderContext, out: Float32Array): void {
  const { t, count, phase, seed } = ctx
  const layout = ctx.layout ?? [{ start: 0, length: count, loop: false }]
  const dir = scene.reverse ? -1 : 1
  const sf = speedFactor(scene.speed)
  const used = effectColors(scene)
  const colors = used.length ? used : ['#ffffff']
  const level = Math.max(0, Math.min(100, scene.level ?? 100)) / 100
  const pal = paletteFor(colors)

  out.fill(0)
  const shade = shader(scene, pal, colors, { t, dir, sf, phase, seed })
  for (const seg of layout) {
    const n = Math.min(seg.length, count - seg.start)
    for (let j = 0; j < n; j++) {
      const i = seg.start + j
      const spot: Spot = {
        i,
        u: seg.length > 1 ? j / seg.length : 0,
        v: seg.length > 1 ? j / (seg.length - 1) : 0.5,
        seg
      }
      const [r, g, b] = shade(spot)
      const o = i * 3
      out[o] = r * level
      out[o + 1] = g * level
      out[o + 2] = b * level
    }
  }
}

/**
 * A still version of a scene, for lights too slow to animate smoothly (the RAM: ~0.4 s per update through
 * OpenRGB). It keeps the effect's colors and its mix of bright and dim parts, so it sits well next to the
 * animated lights: gradients lie still end to end, Spectrum becomes a still rainbow, Breathe shows its colors
 * at the breath's average brightness, and every other effect is frozen at one moment (bands, a comet and its
 * tail, sparkles on their background, an uneven candle glow).
 */
export function renderStill(scene: Scene, ctx: Omit<RenderContext, 't'>, out: Float32Array): void {
  const at: RenderContext = { ...ctx, t: 0 }
  switch (scene.effect) {
    case 'gradient':
      renderScene({ ...scene, speed: 0 }, at, out)
      return
    case 'spectrum':
      renderScene({ ...scene, effect: 'rainbow' }, at, out)
      return
    case 'breathing':
      renderScene({ ...scene, effect: 'gradient', speed: 0 }, at, out)
      for (let i = 0; i < out.length; i++) out[i] *= BREATH_AVERAGE
      return
    default:
      renderScene(scene, at, out)
  }
}

interface Frame {
  t: number
  dir: number
  sf: number
  phase: number
  seed: number
}

type Palette = ReturnType<typeof paletteFor>

function scale([r, g, b]: RGBTuple, k: number): RGBTuple {
  return [r * k, g * k, b * k]
}

/** Builds the per-LED color function for one frame (per-frame constants are computed once here). */
function shader(scene: Scene, pal: Palette, colors: string[], f: Frame): (s: Spot) => RGBTuple {
  const { t, dir, sf, phase, seed } = f

  switch (scene.effect) {
    case 'static': {
      const c = hexToRgb(colors[0])
      return () => c
    }

    case 'breathing': {
      // Each breath shows one color; the color changes at the darkest moment.
      const x = t * 0.6 * sf + phase * 0.12
      const c = scale(pal.color(Math.floor(x)), breathLevel(fract(x)))
      return () => c
    }

    case 'gradient': {
      const still = scene.speed === 0
      const shift = still ? 0 : dir * t * 0.15 * sf
      return ({ u, v, seg }) => {
        if (seg.length === 1) return pal.sample(phase - shift, true) // single LED: its color by position in the PC
        if (still && !seg.loop) return pal.sample(v, false) // first color at one end, last at the other
        return pal.sample(u - shift + phase * 0.25, true) // seamless loop around rings, flowing along runs
      }
    }

    case 'wave': {
      if (scene.bands) {
        // Bands style: distinct bands, one per color, with soft edges; each color gets an equal share.
        const list = colors.length === 1 ? [colors[0], '#000000'] : colors
        const bands = paletteFor(list)
        const n = list.length
        const shift = dir * t * 0.3 * sf
        return ({ u, seg }) => {
          const x = ((seg.length === 1 ? phase : u + phase * 0.5) - shift) * n
          const k = Math.floor(x)
          return bands.between(k, smoothstep(0.62, 1, x - k))
        }
      }
      // The original, flowing Wave (the default again since 2026-11-18, at the user's request): the colors flow into
      // each other around each ring and along the strip, with two deep brightness swells per lap.
      const flow = paletteFor(colors.length === 1 ? [colors[0], '#000000'] : colors)
      const shift = dir * t * 0.35 * sf
      return ({ u, seg }) => {
        const x = (seg.length === 1 ? phase : u + phase * 0.35) - shift
        const [r, g, b] = flow.sample(x, true)
        const k = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (x * 2)))
        return [r * k, g * k, b * k]
      }
    }

    case 'spectrum': {
      const c = hsvToRgb(dir * t * 0.25 * sf + phase * 0.12, 1, 1)
      return () => c
    }

    case 'rainbow': {
      const shift = dir * t * 0.3 * sf
      return ({ u, seg }) => hsvToRgb((seg.length === 1 ? phase : u + phase * 0.3) - shift, 1, 1)
    }

    case 'aurora': {
      // Slowly evolving noise picks the color. Its values bunch up around the middle, which used to hand one
      // color most of the LEDs, so they are first spread evenly (auroraEven). Each color then holds for 60% of
      // its stretch with a short blend to the next, so every color gets a clear, equal share. Always at full
      // brightness: darker patches turned almost black on the LEDs once colors were converted to linear light.
      const d1 = t * 0.22 * sf * dir
      const d2 = t * 0.15 * sf * dir
      const drift = t * 0.05 * sf
      const n = pal.size
      return ({ u, seg }) => {
        let field: number
        if (seg.loop) {
          const x = u * 3 // 3 noise cells around a ring, tiled seamlessly
          field = auroraField(x + d1, x * 2 - d2, 3)
        } else {
          const cells = seg.length === 1 ? 1 : Math.max(2.5, 1 + seg.length / 16) // short runs (RAM) still get variety
          const x = (seg.length === 1 ? phase * 3 : u * cells) + seed * 17
          field = auroraField(x + d1, x * 2 - d2, 0)
        }
        const pos = fract(auroraEven(field) * 2 + drift + phase * 0.3) * n
        const i = Math.floor(pos)
        return pal.between(i, smoothstep(0.6, 1, pos - i))
      }
    }

    case 'comet': {
      const head = hexToRgb(colors[0])
      const bg: RGBTuple = scene.background ? hexToRgb(scene.background) : [0, 0, 0]
      const pos = fract(dir * t * 0.45 * sf + phase * 0.5)
      return ({ u, seg }) => {
        const tail = seg.loop ? 0.5 : seg.length === 1 ? 0.3 : 0.25
        const d = fract((pos - u) * dir) // distance behind the head, in laps
        const k = d < tail ? Math.pow(1 - d / tail, 2.2) : 0
        return k <= 0 ? bg : mixColors(bg, head, k)
      }
    }

    case 'twinkle': {
      const spark = hexToRgb(colors[0])
      const bg: RGBTuple = scene.background ? hexToRgb(scene.background) : scale(spark, 0.06)
      const rate = 0.3 + 1.6 * sf
      return ({ i }) => {
        const h1 = hash(i * 7919 + Math.floor(seed * 104729))
        const h2 = hash(i * 104723 + 17 + Math.floor(seed * 7))
        const s = Math.sin(2 * Math.PI * (t * rate * (0.45 + h1) + h2))
        const k = Math.pow(Math.max(0, s), 6)
        return [bg[0] + (spark[0] - bg[0]) * k, bg[1] + (spark[1] - bg[1]) * k, bg[2] + (spark[2] - bg[2]) * k]
      }
    }

    case 'candle': {
      const [r, g, b] = hexToRgb(colors[0])
      const rate = 1.5 + 9 * sf
      return ({ i }) => {
        const n = noise(t * rate + i * 0.35 + seed * 13) * 0.7 + noise(t * rate * 2.7 + i * 0.9 + 91 + seed) * 0.3
        // The original, deep flicker (restored 2026-11-18 at the user's request): with the LED conversion its dim
        // moments fall to ~17% of full light and drift toward coral and red, so one pink shows several tones.
        const k = 0.45 + 0.55 * n
        // dimmer moments drift slightly redder, like a real flame
        return [r * k, g * (0.8 + 0.2 * k) * k, b * (0.6 + 0.4 * k) * k]
      }
    }
  }
}
