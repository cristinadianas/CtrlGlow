// Sets every LED on every OpenRGB device to one color (software/direct mode).
// Run: node tools/set-all.mts d47800
import { OpenRGBClient } from '../src/service/openrgb/client.ts'

const hex = (process.argv[2] ?? 'd47800').replace('#', '')
const color = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }

const client = new OpenRGBClient({ name: 'Lumen (set all)' })
await client.connect()
for (const c of await client.controllers()) {
  await client.setCustomMode(c.id)
  const status = await client.updateLedsNow(c.id, c.leds.map(() => color))
  console.log(`${c.name}: ${status === 0 ? 'ok' : `status ${status}`}`)
}
client.disconnect()
