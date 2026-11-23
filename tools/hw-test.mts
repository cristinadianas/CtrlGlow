// Shows fixed test colors per device so they can be judged by eye (gamma, white balance, RAM response).
// Lumen must be quit first, otherwise it immediately paints over the test.
// Run: node tools/hw-test.mts [--ring-a a0a0a0] [--ring-b 282828] [--strip 000000] [--board 000000] [--gpu 000000]
//                             [--ram1 a0a0a0] [--ram2 282828] [--sections 736b5c,73734a,...]
//   ring-a / ring-b: first / second half of the shared fan-ring LEDs (0-9 / 10-19) on ARGB headers
//   strip:           ARGB LEDs from 20 up (the rest of the case strip)
//   sections:        instead of --strip, split LEDs [--from 20, --to end) into equal sections, top to bottom,
//                    one color each, with --gap dark LEDs between them; or explicit ranges: 20-38:73673f,42-76:657331
//                    Strip geometry (photo, 2026-11-18): 0-38 top (rear to front), 39-76 front edge (top to bottom),
//                    77+ along the bottom towards the back
//   map:             color-code the whole ARGB zone (see MAP below) to locate parts of the strip in a photo
// Values are raw bytes sent to the hardware (no gamma or calibration applied).
import { OpenRGBClient } from '../src/service/openrgb/client.ts'
import { DeviceType, type RGB } from '../src/service/openrgb/types.ts'

const args = new Map<string, string>()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1] ?? '')
const color = (name: string, fallback: string): RGB => {
  const hex = (args.get(name) ?? fallback).replace('#', '')
  return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }
}
const ringA = color('ring-a', 'a0a0a0')
const ringB = color('ring-b', '282828')
const strip = color('strip', '000000')
const board = color('board', '000000')
const gpu = color('gpu', '000000')
const ram = [color('ram1', 'a0a0a0'), color('ram2', '282828')]
const off: RGB = { r: 0, g: 0, b: 0 }
const parseHex = (hex: string): RGB => {
  const h = hex.replace('#', '')
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}
// --sections entries are either plain colors (equal split, below) or explicit ranges "first-last:color".
const sectionArgs = (args.get('sections') ?? '').split(',').filter(Boolean)
const ranges = sectionArgs.filter((s) => s.includes(':')).map((s) => {
  const [span, hex] = s.split(':')
  const [a, b] = span.split('-').map(Number)
  return { first: a, last: b ?? a, color: parseHex(hex) }
})
const sections = sectionArgs.filter((s) => !s.includes(':')).map(parseHex)
// Sections cover LEDs [from, to) of the zone, with `gap` dark LEDs between them so they're easy to tell apart.
const from = Number(args.get('from') ?? 20)
const gap = Number(args.get('gap') ?? 0)
const stripColor = (i: number, count: number): RGB => {
  if (ranges.length) return ranges.find((r) => i >= r.first && i <= r.last)?.color ?? off
  if (!sections.length) return strip
  const to = Math.min(count, Number(args.get('to') ?? count))
  if (i < from || i >= to) return off
  const n = sections.length
  const len = (to - from - gap * (n - 1)) / n
  const k = Math.floor((i - from) / (len + gap))
  return k < n && i - from - k * (len + gap) < len ? sections[k] : off
}

// --map: color-codes the whole ARGB zone in runs of ~19 LEDs (one dark LED between runs), to find where each
// part of the strip sits in the case from a photo. LEDs 0-19 are also what every fan ring shows.
const MAP: [number, RGB][] = [
  [0, { r: 200, g: 0, b: 0 }], // red (fans show this too)
  [20, { r: 200, g: 70, b: 0 }], // orange
  [39, { r: 170, g: 150, b: 0 }], // yellow
  [58, { r: 0, g: 190, b: 0 }], // green
  [77, { r: 0, g: 160, b: 160 }], // cyan
  [96, { r: 0, g: 0, b: 220 }], // blue
  [115, { r: 110, g: 0, b: 200 }], // purple
  [134, { r: 200, g: 0, b: 100 }], // pink
  [153, { r: 130, g: 130, b: 130 }] // white, to the end
]
const mapColor = (i: number): RGB => {
  const run = [...MAP].reverse().find(([start]) => i >= start)
  if (!run) return off
  const next = MAP.find(([start]) => start > i)
  return next && i === next[0] - 1 ? off : run[1] // dark separator before each new run
}
const useMap = args.has('map')

const client = new OpenRGBClient({ name: 'Lumen (hardware test)' })
await client.connect()
for (const c of await client.controllers()) {
  await client.setCustomMode(c.id)
  const colors: RGB[] = c.leds.map(() => off)
  for (const z of c.zones) {
    for (let i = 0; i < z.ledsCount; i++) {
      let fill: RGB
      if (c.type === DeviceType.DRAM) fill = ram[z.index] ?? off
      else if (c.type === DeviceType.GPU) fill = gpu
      else if (/^ARGB/i.test(z.name)) fill = useMap ? mapColor(i) : ranges.length ? stripColor(i, z.ledsCount) : i < 10 ? ringA : i < 20 ? ringB : stripColor(i, z.ledsCount)
      else if (/^LED_C$/i.test(z.name)) fill = off // 12V header, nothing connected
      else fill = board
      colors[z.startIdx + i] = fill
    }
  }
  const status = await client.updateLedsNow(c.id, colors)
  console.log(`${c.name}: ${status === 0 ? 'ok' : `status ${status}`}`)
}
client.disconnect()
