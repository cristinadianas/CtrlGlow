// LED layout test for the shared fan/pump/strip connector (ARGB_V2_1).
// Paints LED indices so the LED count of each device type can be read off visually:
//   0-9 red, 10-19 green, 20-29 blue, 30-170 off, 171 white (last LED of a 172-LED strip), 172+ magenta.
// Run: node tools/led-map-test.mts   (stop Lumen first, or it will repaint)
import { OpenRGBClient } from '../src/service/openrgb/client.ts'
import { DeviceType, type RGB } from '../src/service/openrgb/types.ts'

const client = new OpenRGBClient({ name: 'Lumen (LED map test)' })
await client.connect()
const mb = (await client.controllers()).find((c) => c.type === DeviceType.MOTHERBOARD)
if (!mb) throw new Error('Motherboard controller not found')
const zone = mb.zones.find((z) => z.name === 'ARGB_V2_1')
if (!zone) throw new Error('ARGB_V2_1 not found')
if (zone.ledsCount < 256) await client.resizeZone(mb.id, zone.index, 256)
const fresh = await client.controller(mb.id)
const z = fresh.zones.find((x) => x.name === 'ARGB_V2_1')!

const colorFor = (i: number): RGB => {
  if (i < 10) return { r: 255, g: 0, b: 0 }
  if (i < 20) return { r: 0, g: 255, b: 0 }
  if (i < 30) return { r: 0, g: 0, b: 255 }
  if (i === 171) return { r: 255, g: 255, b: 255 }
  if (i >= 172) return { r: 255, g: 0, b: 255 }
  return { r: 0, g: 0, b: 0 }
}

await client.setCustomMode(mb.id)
const colors: RGB[] = fresh.colors.slice()
for (let i = 0; i < z.ledsCount; i++) colors[z.startIdx + i] = colorFor(i)
console.log('ARGB_V2_1 pattern:', await client.updateLedsNow(mb.id, colors))
client.disconnect()
