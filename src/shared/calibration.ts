/**
 * Turning the colors Lumen renders into LED drive levels.
 *
 * Effects and previews work in sRGB, the color space of the screen: '#808080' is a perceptual mid-grey.
 * A monitor turns those values into light along the sRGB curve, so mid-grey emits only ~22% of white's light.
 * The LEDs here (fans, strip, motherboard, GPU and the Kingston RAM, checked by eye on 2026-11-18) emit light in
 * proportion to the value they get instead: sent raw, '#808080' glows at 50%. Every mid-tone came out far too
 * strong, which washed pastels and blends out towards the LEDs' own white. Converting to linear light first
 * makes the LEDs match the previews.
 *
 * White balance then fixes that white. Addressable (WS2812-class) LEDs have a strong blue die and a cyan-leaning
 * green: at full power their white sits around x 0.26, y 0.24 (bluish-violet; neutral D65 is 0.313, 0.329), so
 * blue outweighs everything it is mixed with. A neutral white needs blue cut to roughly half. A brightness trim
 * evens out parts that are brighter than the rest. Gains are in linear light and are applied per kind of hardware.
 */
import type { Calibration, LightKind, WhiteGroup } from './types.ts'

export type Gains = [number, number, number]

/**
 * Recommended calibration per kind of hardware, from side-by-side white tests on the case strip (2026-11-18):
 * gains 1 / 0.9 / 0.55 looked slightly purple and 0.88 / 1 / 0.43 slightly turquoise, so neutral sits between,
 * at about 1 / 1 / 0.52 (warmth 73, tint +2); confirmed neutral with Lumen's white check. The GPU and motherboard
 * looked like the fans; the RAM's own white was only a little bluish, and the RAM looked brighter than the rest.
 */
export const DEFAULT_CALIBRATION: Record<WhiteGroup, Calibration> = {
  fans: { warmth: 73, tint: 2, brightness: 100 },
  ram: { warmth: 25, tint: 0, brightness: 80 },
  gpu: { warmth: 73, tint: 2, brightness: 100 },
  board: { warmth: 73, tint: 2, brightness: 100 }
}

export const WHITE_GROUPS: { id: WhiteGroup; name: string }[] = [
  { id: 'fans', name: 'Fans & Strip' },
  { id: 'ram', name: 'Memory' },
  { id: 'gpu', name: 'Graphics Card' },
  { id: 'board', name: 'Motherboard' }
]

export function whiteGroupFor(kind: LightKind): WhiteGroup {
  switch (kind) {
    case 'fans':
    case 'connector': // ARGB headers drive the same kind of addressable LEDs as the fans
      return 'fans'
    case 'ram':
      return 'ram'
    case 'gpu':
      return 'gpu'
    default:
      return 'board'
  }
}

export function sanitizeCalibration(input: unknown, fallback: Calibration): Calibration {
  const o = (input && typeof input === 'object' ? input : {}) as Partial<Record<keyof Calibration, unknown>>
  const num = (v: unknown, min: number, max: number, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : d
  return {
    warmth: num(o.warmth, 0, 100, fallback.warmth),
    tint: num(o.tint, -50, 50, fallback.tint),
    brightness: num(o.brightness, 30, 100, fallback.brightness)
  }
}

/** Calibration → linear-light channel gains: white balance (strongest channel at 1) times the brightness trim. */
export function calibrationGains(c: Calibration): Gains {
  const k = srgbToLinear((Math.max(30, Math.min(100, c.brightness)) / 100) * 255)
  const [r, g, b] = whiteGains(c)
  return [r * k, g * k, b * k]
}

/** White balance → linear-light channel gains (the strongest channel stays at 1). */
export function whiteGains({ warmth, tint }: Pick<Calibration, 'warmth' | 'tint'>): Gains {
  const w = Math.max(0, Math.min(100, warmth)) / 100
  const t = Math.max(-50, Math.min(50, tint)) / 50
  let r = 1
  let g = 1
  let b = 1 - 0.65 * w // warmer = less blue
  if (t > 0) {
    r *= 1 - 0.3 * t // greener = less red and blue
    b *= 1 - 0.3 * t
  } else {
    g *= 1 + 0.3 * t // more magenta = less green
  }
  const max = Math.max(r, g, b)
  return [r / max, g / max, b / max]
}

/** sRGB value (0..255) → linear light (0..1). */
export function srgbToLinear(v: number): number {
  const c = v <= 0 ? 0 : v >= 255 ? 1 : v / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

/**
 * The LEDs' blue (~470 nm) is a slightly sky-ish blue next to a screen's, so blue-violet mixes came out plain blue:
 * on 2026-11-18, '#7b61ff' only looked violet with about twice its red (and a little more in Aurora). Wherever blue exceeds both red and green,
 * this share of the excess is added as red. Greys, white, reds, greens and cyans are left exactly as they are.
 */
export const VIOLET_CORRECTION = 0.33

/**
 * One LED: sRGB values (0..255) → drive levels (0..255) written to out[o..o+2]. Converts to linear light,
 * applies the violet correction, then the part's calibration gains.
 */
export function driveLed(r: number, g: number, b: number, gains: Gains, out: { [i: number]: number }, o: number): void {
  let lr = srgbToLinear(r)
  const lg = srgbToLinear(g)
  const lb = srgbToLinear(b)
  const excess = lb - Math.max(lr, lg)
  if (excess > 0) lr += VIOLET_CORRECTION * excess
  out[o] = lr * gains[0] * 255
  out[o + 1] = lg * gains[1] * 255
  out[o + 2] = lb * gains[2] * 255
}
