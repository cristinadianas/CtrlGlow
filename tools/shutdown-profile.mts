// Keeps the motherboard's own lights (the AORUS logo on the I/O cover, the chipset light) from glowing after
// Windows shuts down. They keep standby power while the PC is off and would go on showing their last colors.
//
// It uses OpenRGB's own "Load Profile on Service Shutdown" setting. When Windows shuts down, the OpenRGB service
// (after every app has closed) disconnects its clients, loads that profile onto the devices and only then lets go
// of them. This tool saves a profile with every light off ("Lumen Off") and turns that setting on. Nothing is
// written to the devices' own memory: loading a profile sends ordinary color updates, like Lumen does all the time.
//
// Lumen must be quit first (it would repaint the lights while the profile is saved or tested).
//   node tools/shutdown-profile.mts status    show the current setting
//   node tools/shutdown-profile.mts install   turn every light off, save that as "Lumen Off", turn the setting on
//   node tools/shutdown-profile.mts test      load "Lumen Off" now: every light should go off
//   node tools/shutdown-profile.mts remove    turn the setting off and delete the profile
import { OpenRGBClient } from '../src/service/openrgb/client.ts'
import type { RGB } from '../src/service/openrgb/types.ts'

const PROFILE = 'Lumen Off'
const command = (process.argv[2] ?? 'status').toLowerCase()

async function lumenRunning(): Promise<boolean> {
  try {
    const res = await fetch('http://127.0.0.1:6743/api/getState', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]', signal: AbortSignal.timeout(1500)
    })
    return res.ok
  } catch {
    return false
  }
}

function check(step: string, status: number): void {
  if (status !== 0) throw new Error(`${step} failed (OpenRGB status ${status})`)
  console.log(`${step}: ok`)
}

async function shutdownSetting(client: OpenRGBClient): Promise<unknown> {
  const pm = (await client.getSettings('ProfileManager')) as Record<string, unknown> | null
  return pm?.['service_shutdown_profile'] ?? null
}

if (!['status', 'install', 'test', 'remove'].includes(command)) {
  console.error('Usage: node tools/shutdown-profile.mts status|install|test|remove')
  process.exit(2)
}
if (command !== 'status' && (await lumenRunning())) {
  console.error('Lumen is running. Quit it first (tray icon -> Quit Lumen), then run this again.')
  process.exit(1)
}

const client = new OpenRGBClient({ name: 'Lumen (shutdown setup)' })
await client.connect()
try {
  if (client.protocol < 6) throw new Error(`OpenRGB protocol ${client.protocol}; profiles over the SDK need protocol 6`)
  if (!(await client.requestLocalClient())) throw new Error('OpenRGB did not grant local-client rights')

  if (command === 'install') {
    // Every light off, in the devices' current (Direct) modes, then saved as the profile.
    const black: RGB = { r: 0, g: 0, b: 0 }
    for (const c of await client.controllers()) {
      if (c.leds.length === 0) continue
      check(`${c.name}: all LEDs off`, await client.updateLedsNow(c.id, c.leds.map(() => black)))
    }
    await new Promise((r) => setTimeout(r, 1500)) // the RAM applies its colors slowly (~0.4 s per stick)
    check(`Save profile "${PROFILE}"`, await client.saveProfile(PROFILE))
    check('Turn on "Load Profile on Service Shutdown"', await client.modifySettings({
      ProfileManager: { service_shutdown_profile: { enabled: true, name: PROFILE } }
    }))
    check('Save OpenRGB settings', await client.saveSettings())
  } else if (command === 'test') {
    check(`Load profile "${PROFILE}"`, await client.loadProfile(PROFILE))
  } else if (command === 'remove') {
    check('Turn off "Load Profile on Service Shutdown"', await client.modifySettings({
      ProfileManager: { service_shutdown_profile: { enabled: false, name: '' } }
    }))
    check('Save OpenRGB settings', await client.saveSettings())
    check(`Delete profile "${PROFILE}"`, await client.deleteProfile(PROFILE))
  }

  console.log('Load Profile on Service Shutdown:', JSON.stringify(await shutdownSetting(client)))
} finally {
  client.disconnect()
}
