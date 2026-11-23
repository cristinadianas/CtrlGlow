# Lumen

Lighting control for this PC: one place for the motherboard, graphics card, RAM, the AIO pump, all case fans and the case light strip. Static colors and animated effects, for everything at once or per device, with an Apple-style interface.

## How it works

```
Lumen window (Microsoft Edge app window)  ⇄  Lumen service (Node.js, 127.0.0.1:6743)  ⇄  OpenRGB service (127.0.0.1:6742)  ⇄  hardware
```

- **OpenRGB 1.1** runs as a Windows service and talks to the hardware. It uses the signed **PawnIO** driver to reach the RAM.
- **Lumen service** (`src/service`) renders the effects. It streams them to OpenRGB with per-device flow control and serves the UI. Its settings are stored in `%APPDATA%\Lumen\settings.json` and its log in `%APPDATA%\Lumen\lumen.log`.
- **Lumen window** (`src/renderer`, React) runs the same effect code (`src/shared/effects.ts`) for its live previews.
- **Scenes** keep all their colors when you try another effect; an effect that uses fewer colors uses the first ones. Comet and Starlight have their own optional **Background** color (unset = dark), so a palette's other colors never turn into a background. Wave has two styles: **Flowing** (the original, the default) and **Bands** (even bands, one per color).
- **Color conversion** (`src/shared/calibration.ts`): effects are rendered in screen colors (sRGB). Before sending, Lumen converts them to the LEDs' linear light, so the hardware matches the previews. It also adds red to blue-violet mixes (these LEDs' blue is slightly sky-ish) and applies a per-part calibration from **Settings → Color Matching**: warmth, tint and brightness, measured on this PC on 2026-11-18.
- **RAM**: OpenRGB writes the Kingston sticks slowly: 10 ms per register, so about 0.4 s to update every LED.
  - So the RAM doesn't animate. For animated scenes it shows a still version of the effect at the scene's brightness (`renderStill` in `src/shared/effects.ts`): still gradients and bands, a frozen comet or sparkles, Breathe at its average brightness.
  - Animating it looked steppy, both per LED and as one color through the sticks' Static mode. Static mode also showed mid pinks as red.
  - The sticks can also drop out of their mode on their own and go dark while OpenRGB still thinks they're lit. Lumen re-syncs them when it connects, after sleep, on Reconnect and every 10 minutes.
- **Motherboard header**: other lighting software (Gigabyte Control Center, on 2026-11-19) can leave it in a state where every update flashes the fans and strip while OpenRGB still reports Direct mode. Lumen switches it to Static and back to Direct when it connects, after sleep and on Reconnect. The Static step is black, because the board keeps that color as its own lighting and shows it on standby power while the PC is off.
- **Shutdown**: the board's own lights (the I/O cover's AORUS logo, the chipset light) keep standby power after shutdown and keep their last colors.
  - The fix uses OpenRGB's own "Load Profile on Service Shutdown" setting. At Windows shutdown, after every app has closed, the OpenRGB service loads a profile with every light off before releasing the devices.
  - `node tools/shutdown-profile.mts install` (Lumen quit first) saves that profile ("Lumen Off") and turns the setting on. Use `status`, `test` or `remove` to check, try or undo it.
  - Nothing is written to the devices' own memory.
  - A first attempt, where the tray icon reacted to Windows' shutdown notice, didn't work: Windows can close Lumen before the tray's turn. It was removed.
  - The BIOS option "LEDs in Sleep, Hibernation, and Soft Off States" → Off is the hardware-level alternative and also covers sleep.
  - The case's "be quiet!" logos aren't on any controllable header. Gigabyte Control Center's startup task ("GCC" in Task Scheduler) is disabled on this PC for this reason. Opening it by hand would take over the lights again.

Smart App Control is on for this PC, so Lumen only uses signed, trusted programs:

- `node.exe`
- Microsoft Edge
- `conhost.exe`, which runs the service without a console window
- PowerShell, for the tray icon

There are no unsigned `.exe` files.

The local server only accepts requests from itself:

- It listens on 127.0.0.1.
- It rejects foreign `Host` headers and foreign `Origin` headers.
- It only takes commands sent as JSON.

## Setup

```powershell
npm install
npm run setup      # builds the UI, adds "Lumen" to the Start menu, starts it
```

Turn on **Settings → Start Lumen when you sign in** if you want your scene restored after every restart.

Other commands:

| Command | What it does |
| --- | --- |
| `npm start` | Start the service in this terminal and open the window |
| `npm run build` | Rebuild the UI after changes |
| `npm run typecheck` | Type-check everything |
| `npm run devices` | List what OpenRGB sees (read-only) |
| `node tools/set-all.mts d47800` | Paint everything one color without Lumen |
| `node tools/connector-test.mts` | Paint motherboard connectors 1/2/3 red/green/blue |
| `node tools/hw-test.mts --map 1` | Color-code the case strip to locate its sections (quit Lumen first; see the file for white/color test options) |
| `node tools/ram-mode.mts static ffffff` | Put the RAM in its built-in Static mode, or `direct` to return (quit Lumen first) |
| `node tools/effects-check.mts` | Measure how often every color of multi-color effects is visible at once |
| `powershell -File scripts/uninstall.ps1` | Stop Lumen and remove its shortcuts |

## Hardware notes

| Device | Lighting | Control |
| --- | --- | --- |
| Gigabyte X870E AORUS PRO X3D ICE | I/O cover (10 LEDs), chipset (4), 3× ARGB, 1× 12V RGB | Per LED |
| Gigabyte RTX 5080 AERO OC | 1 zone | One color at a time |
| 2× Kingston FURY Beast RGB DDR5 | 12 LEDs per stick | Per LED, per stick |
| AIO pump, 10 fans and the case strip | All on ARGB connector 1 through be quiet! hubs | Mirrored: one signal shared by all of them |

The case strip has 172 LEDs and runs around the case's front-right frame:
- LEDs 0–38: the top, from back to front. LEDs 0–19 are also what every fan ring shows.
- LEDs 39–76: down the front edge.
- LEDs 77 onwards: along the bottom towards the back.

ARGB connectors 2 and 3 are free. Moving a hub's cable to one of them gives that group its own controls. Do this with the PC switched off, using the 3-pin 5V connectors only. Never use the 4-pin 12V connector.

Avoid running other lighting software at the same time, such as Gigabyte Control Center's RGB Fusion or Windows Dynamic Lighting. They fight over the same controllers.
