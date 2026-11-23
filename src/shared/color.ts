/** Color utilities shared by the engine and the UI. RGB components are 0..255 floats. */

export type RGBTuple = [number, number, number]

export function hexToRgb(hex: string): RGBTuple {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h.padEnd(6, '0')
  const n = parseInt(full.slice(0, 6), 16)
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function rgbToHex(r: number, g: number, b: number): string {
  const to = (v: number): string => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`
}

export function packRgb(r: number, g: number, b: number): number {
  return (clamp255(r) << 16) | (clamp255(g) << 8) | clamp255(b)
}

export function unpackRgb(n: number): RGBTuple {
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function packedToCss(n: number): string {
  return `#${(n & 0xffffff).toString(16).padStart(6, '0')}`
}

function clamp255(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v)
}

/** h, s, v in 0..1 → RGB 0..255 */
export function hsvToRgb(h: number, s: number, v: number): RGBTuple {
  h = ((h % 1) + 1) % 1
  const i = Math.floor(h * 6)
  const f = h * 6 - i
  const p = v * (1 - s)
  const q = v * (1 - f * s)
  const t = v * (1 - (1 - f) * s)
  let r: number, g: number, b: number
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break
    case 1: r = q; g = v; b = p; break
    case 2: r = p; g = v; b = t; break
    case 3: r = p; g = q; b = v; break
    case 4: r = t; g = p; b = v; break
    default: r = v; g = p; b = q
  }
  return [r * 255, g * 255, b * 255]
}

/** RGB 0..255 → [h, s, v] in 0..1 */
export function rgbToHsv(r: number, g: number, b: number): RGBTuple {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
    if (h < 0) h += 1
  }
  return [h, max === 0 ? 0 : d / max, max]
}

/* ---------------- OKLab (perceptual blending) ---------------- */

function toLinear(c: number): number {
  c /= 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}
function fromLinear(c: number): number {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(Math.max(0, c), 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, v * 255))
}

export function rgbToOklab([r, g, b]: RGBTuple): RGBTuple {
  const lr = toLinear(r), lg = toLinear(g), lb = toLinear(b)
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb)
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb)
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  ]
}

export function oklabToRgb([L, a, b]: RGBTuple): RGBTuple {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3)
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3)
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3)
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)
  ]
}

/** Below this OKLab chroma a color counts as white/grey/black and has no meaningful hue. */
const NEUTRAL_CHROMA = 0.04

/**
 * Blends two colors. Saturated pairs are blended by hue (OKLCH, shortest way round the color
 * wheel), so red → blue passes through vivid magenta instead of a greyish purple. Pairs that
 * involve white/grey/black fall back to OKLab, which has no hue to get confused by.
 */
export function mixColors(a: RGBTuple, b: RGBTuple, f: number): RGBTuple {
  return mixLab(rgbToOklab(a), rgbToOklab(b), f)
}

function mixLab(a: RGBTuple, b: RGBTuple, f: number): RGBTuple {
  if (f <= 0) return oklabToRgb(a)
  if (f >= 1) return oklabToRgb(b)
  const ca = Math.hypot(a[1], a[2])
  const cb = Math.hypot(b[1], b[2])
  if (ca < NEUTRAL_CHROMA || cb < NEUTRAL_CHROMA) {
    return oklabToRgb([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f])
  }
  const ha = Math.atan2(a[2], a[1])
  let dh = Math.atan2(b[2], b[1]) - ha
  if (dh > Math.PI) dh -= 2 * Math.PI
  if (dh < -Math.PI) dh += 2 * Math.PI
  const L = a[0] + (b[0] - a[0]) * f
  const C = ca + (cb - ca) * f
  const h = ha + dh * f
  return oklabToRgb([L, C * Math.cos(h), C * Math.sin(h)])
}

/** A list of colors that can be sampled smoothly (blended by hue, see mixColors). */
export class Palette {
  readonly size: number
  private readonly labs: RGBTuple[]
  private readonly rgbs: RGBTuple[]

  constructor(hexes: string[]) {
    const list = hexes.length ? hexes : ['#ffffff']
    this.rgbs = list.map(hexToRgb)
    this.labs = this.rgbs.map(rgbToOklab)
    this.size = list.length
  }

  color(i: number): RGBTuple {
    return this.rgbs[((i % this.size) + this.size) % this.size]
  }

  /** Blend between color i and color i+1 (wrapping), f in 0..1. */
  between(i: number, f: number): RGBTuple {
    const a = ((i % this.size) + this.size) % this.size
    const b = (a + 1) % this.size
    if (f <= 1e-4) return this.rgbs[a]
    if (f >= 1 - 1e-4) return this.rgbs[b]
    return mixLab(this.labs[a], this.labs[b], f)
  }

  /**
   * u in 0..1. Cyclic palettes wrap from the last color back to the first,
   * non-cyclic ones span first → last.
   */
  sample(u: number, cyclic: boolean): RGBTuple {
    if (this.size === 1) return this.rgbs[0]
    const pos = cyclic ? (((u % 1) + 1) % 1) * this.size : Math.max(0, Math.min(1, u)) * (this.size - 1)
    const i = Math.floor(pos)
    return this.between(i, pos - i)
  }
}

const paletteCache = new Map<string, Palette>()
export function paletteFor(hexes: string[]): Palette {
  const key = hexes.join(',')
  let p = paletteCache.get(key)
  if (!p) {
    if (paletteCache.size > 64) paletteCache.clear()
    p = new Palette(hexes)
    paletteCache.set(key, p)
  }
  return p
}
