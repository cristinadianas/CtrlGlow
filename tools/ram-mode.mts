// RAM diagnostics: switches the Kingston sticks to a hardware mode (not saved to the sticks) or back to Direct.
// Lumen must be quit first.
// Run: node tools/ram-mode.mts static ffffff     (hardware Static mode, full brightness)
//      node tools/ram-mode.mts direct ffffff     (Direct mode at brightness 100, then this color on every LED)
import { OpenRGBClient } from '../src/service/openrgb/client.ts'
import { ColorMode, DeviceType, type RGB } from '../src/service/openrgb/types.ts'

const which = (process.argv[2] ?? 'static').toLowerCase()
const hex = (process.argv[3] ?? 'ffffff').replace('#', '')
const color: RGB = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) }

const client = new OpenRGBClient({ name: 'Lumen (RAM test)' })
await client.connect()
const ram = (await client.controllers()).find((c) => c.type === DeviceType.DRAM)
if (!ram) throw new Error('No RAM controller found')
const mode = ram.modes.find((m) => m.name.toLowerCase() === which)
if (!mode) throw new Error(`No "${which}" mode; available: ${ram.modes.map((m) => m.name).join(', ')}`)

const updated = { ...mode, brightness: mode.brightnessMax }
if (mode.colorMode === ColorMode.MODE_SPECIFIC || mode.colorsMax > 0) updated.colors = Array.from({ length: Math.max(1, mode.colorsMin) }, () => color)
console.log(`${ram.name}: ${mode.name} (was ${ram.modes[ram.activeMode]?.name}), brightness ${updated.brightness} -> status ${await client.updateMode(ram.id, updated)}`)
if (mode.colorMode === ColorMode.PER_LED) console.log(`colors -> status ${await client.updateLedsNow(ram.id, ram.leds.map(() => color))}`)
client.disconnect()
