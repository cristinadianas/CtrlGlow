// Read-only: lists every OpenRGB controller with its zones and modes.
// Run: node tools/list-devices.mts
import { OpenRGBClient } from '../src/service/openrgb/client.ts'
import { ModeFlag } from '../src/service/openrgb/types.ts'

const typeNames = ['Motherboard', 'DRAM', 'GPU', 'Cooler', 'LED strip', 'Keyboard', 'Mouse', 'Mousemat', 'Headset',
  'Headset stand', 'Gamepad', 'Light', 'Speaker', 'Virtual', 'Storage', 'Case', 'Microphone', 'Accessory', 'Keypad',
  'Laptop', 'Monitor', 'Unknown']
const zoneTypes = ['single', 'linear', 'matrix', 'linear-loop', 'matrix-loop-x', 'matrix-loop-y', 'segmented']

const client = new OpenRGBClient({ name: 'Lumen (device list)' })
await client.connect()
console.log(`Connected: server "${client.serverName}", protocol ${client.protocol}\n`)

for (const c of await client.controllers()) {
  console.log(`#${c.id}  ${c.name}  [${typeNames[c.type] ?? c.type}]  vendor=${c.vendor}  leds=${c.leds.length}  activeMode=${c.modes[c.activeMode]?.name}`)
  console.log(`    location=${c.location}  version=${c.version}`)
  for (const z of c.zones) {
    console.log(`    zone ${z.index}: "${z.displayName}" (${zoneTypes[z.type] ?? z.type}) leds=${z.ledsCount} range=${z.ledsMin}-${z.ledsMax} flags=0x${z.flags.toString(16)} zoneModes=${z.modes.length} segments=${z.segments.length}`)
  }
  const modeList = c.modes.map((m) => {
    const tags = [
      m.flags & ModeFlag.HAS_SPEED ? 'speed' : '',
      m.flags & ModeFlag.HAS_BRIGHTNESS ? 'bright' : '',
      m.flags & ModeFlag.HAS_PER_LED_COLOR ? 'perLED' : '',
      m.flags & ModeFlag.HAS_MODE_SPECIFIC_COLOR ? `colors${m.colorsMin}-${m.colorsMax}` : '',
      m.flags & ModeFlag.MANUAL_SAVE ? 'save' : ''
    ].filter(Boolean).join(',')
    return `${m.index}:${m.name}${tags ? `(${tags})` : ''}`
  })
  console.log(`    modes: ${modeList.join('  ')}\n`)
}
client.disconnect()
