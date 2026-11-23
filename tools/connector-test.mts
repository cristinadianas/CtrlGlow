// Connector identification test: paints each motherboard ARGB header a different primary color
// (plus the onboard zones, RAM and GPU) so you can see which physical parts are on which header.
// Run: node tools/connector-test.mts
import { OpenRGBClient } from '../src/service/openrgb/client.ts'
import { DeviceType, type Controller, type RGB } from '../src/service/openrgb/types.ts'

const OFF: RGB = { r: 0, g: 0, b: 0 }
const RED: RGB = { r: 255, g: 0, b: 0 }
const GREEN: RGB = { r: 0, g: 255, b: 0 }
const BLUE: RGB = { r: 0, g: 0, b: 255 }
const MAGENTA: RGB = { r: 255, g: 0, b: 255 }
const CYAN: RGB = { r: 0, g: 255, b: 255 }
const YELLOW: RGB = { r: 255, g: 170, b: 0 }

const HEADER_TEST_SIZE = 256 // max the board allows; longer than any chain (case strip = 172 LEDs)

const plan: Record<string, RGB> = {
  ARGB_V2_1: RED,
  ARGB_V2_2: GREEN,
  ARGB_V2_3: BLUE,
  LED_C: OFF,
  'I/O Cover': MAGENTA,
  'Chipset Accent': MAGENTA
}

const client = new OpenRGBClient({ name: 'Lumen (connector test)' })
await client.connect()

const find = (all: Controller[], type: number): Controller | undefined => all.find((c) => c.type === type)
let all = await client.controllers()

// Motherboard: direct mode, size the ARGB headers, paint per zone.
let mb = find(all, DeviceType.MOTHERBOARD)
if (mb) {
  console.log('Motherboard custom mode:', await client.setCustomMode(mb.id))
  for (const z of mb.zones) {
    if (z.name.startsWith('ARGB') && z.ledsCount !== HEADER_TEST_SIZE) {
      console.log(`Resize ${z.name} -> ${HEADER_TEST_SIZE}:`, await client.resizeZone(mb.id, z.index, HEADER_TEST_SIZE))
    }
  }
  mb = await client.controller(mb.id)
  const colors: RGB[] = []
  for (const z of mb.zones) {
    const c = plan[z.name] ?? OFF
    for (let i = 0; i < z.ledsCount; i++) colors.push(c)
  }
  console.log(`Motherboard LEDs (${colors.length}):`, await client.updateLedsNow(mb.id, colors))
  for (const z of mb.zones) console.log(`   ${z.name.padEnd(15)} ${String(z.ledsCount).padStart(3)} LEDs -> ${JSON.stringify(plan[z.name] ?? OFF)}`)
}

const gpu = find(all, DeviceType.GPU)
if (gpu) {
  console.log('GPU custom mode:', await client.setCustomMode(gpu.id))
  console.log('GPU -> yellow:', await client.updateLedsNow(gpu.id, gpu.leds.map(() => YELLOW)))
}

const ram = find(all, DeviceType.DRAM)
if (ram) {
  console.log('RAM custom mode:', await client.setCustomMode(ram.id))
  console.log('RAM -> cyan:', await client.updateLedsNow(ram.id, ram.leds.map(() => CYAN)))
}

client.disconnect()
