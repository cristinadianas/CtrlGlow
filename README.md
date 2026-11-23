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

- **When something fails** (each case has a test in `test/service/scenarios`):
  - **OpenRGB unreachable** (its service restarts or stops): the window says so and lists every light as offline. Lumen keeps reconnecting, then re-sends every light, including changes made in the meantime. It doesn't assume the devices kept their colors.
  - **A device leaves OpenRGB's list** (after a rescan, for example): it stays listed as "Not responding" with its settings. The other devices carry on, and Lumen takes the device over again when it returns.
  - **A device stops confirming its updates** for 5 seconds: it shows as "Not responding". OpenRGB never reports an error here; it only stops acknowledging, because it acknowledges each update after applying it. The other devices carry on. At most 3 frames wait for the stuck device, so it doesn't replay a backlog, and it gets the newest look when it recovers.
  - **A device doesn't answer while Lumen reads the device list**: it doesn't hold up the others. Lumen tries again after 1 second, doubling each time up to 30 seconds.
  - **The settings file is damaged or has invalid values**: each value is checked on its own, and an invalid one falls back to its default. Lumen keeps the original as `settings.backup-<time>.json` next to it, saves the repaired file and writes what it changed to the log. Starting at sign-in only turns on with an explicit "true".
  - **The settings can't be saved** (on Windows a virus scanner can briefly hold the file): Lumen writes it to the log once and tries again every 1.5 seconds until it works, then logs that too.
  - **Reconnect or Try Again is pressed**, while connected or still connecting: the new connection replaces the old one without passing through "unreachable", OpenRGB is left with exactly one Lumen connection, and every device is sent its lighting again.
  - **The sign-in shortcut can't be added or removed**: the "Start Lumen when you sign in" switch goes back to what is really set up in Windows, and the log says why.
  - **The motherboard's re-sync comes due at the same time as the memory's 10-minute one, or while another re-sync is running**: it waits its turn instead of being dropped.

**Resource use** (measured on 2026-11-23; details in [docs/resource-usage.md](docs/resource-usage.md)):
- **Window closed:** 0.28% of the PC's CPU, most of it OpenRGB sending the colors to the hardware. Lumen's processes use 227 MB of RAM, and there is no GPU or disk use.
- **Window open in front:** Edge adds about 84% of one core and about 400 MB of memory.
- **30 fps:** lowers the CPU use to 0.19%.

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
| `npm test` | Run the tests |
| `npm run check` | Everything CI runs: typecheck, tests with the coverage floor, UI build |
| `npm run devices` | List what OpenRGB sees (read-only) |
| `node tools/set-all.mts d47800` | Paint everything one color without Lumen |
| `node tools/connector-test.mts` | Paint motherboard connectors 1/2/3 red/green/blue |
| `node tools/hw-test.mts --map 1` | Color-code the case strip to locate its sections (quit Lumen first; see the file for white/color test options) |
| `node tools/ram-mode.mts static ffffff` | Put the RAM in its built-in Static mode, or `direct` to return (quit Lumen first) |
| `node tools/effects-check.mts` | Measure how often every color of multi-color effects is visible at once |
| `node tools/shutdown-profile.mts status` | Show OpenRGB's shutdown profile setting (`install`, `test`, `remove`: quit Lumen first) |
| `node tools/usage-check.mts` | Measure Lumen's CPU, memory and wake-ups, and OpenRGB's, for 60 s (read-only; `--edge` adds the window, `--out=file.json` keeps the results) |
| `powershell -File scripts/uninstall.ps1` | Stop Lumen and remove its shortcuts |

## Tests and CI

The tests use Node's built-in test runner (`node:test`) and run the TypeScript directly, like Lumen itself, so they add no dependencies. They never touch real hardware, OpenRGB or a running Lumen:

- **Temporary folders** for the settings store.
- **A free local port** for the web server.
- **A fake OpenRGB server** (`test/helpers/fake-openrgb.ts`) for the OpenRGB client.
- **A fake PC** (`test/helpers/fake-pc.ts`) shaped like this one, for the lighting engine. It behaves like OpenRGB's server, as checked against its source on 2026-11-23:
  - Each device's updates are applied in order by that device's own worker, and acknowledged only afterwards.
  - Packets for a missing device are acknowledged as OK but do nothing.
  - Tests can hang or resume a device, unplug it and plug it back in, restart "OpenRGB", and read what each device really shows.

That makes them safe to run at any time. Each test has a 60-second limit, so a hang fails instead of blocking CI.

| Folder | Covers |
| --- | --- |
| `test/shared` | Color math, the LED color conversion and calibration, every effect on every LED layout, built-in scenes (including the user's chosen Sakura) |
| `test/service` | Scene checks, the settings store (migrations, damaged files, failed saves), the web server's security rules, the sign-in setting, the lighting engine end to end (including the memory and motherboard re-syncs) |
| `test/service/scenarios` | Failures, each checked against what the user sees (the window and the LEDs) and what Lumen believes (reachable or not, what it re-sends): OpenRGB or one device dropping out mid-update, a device that stops responding while a scene applies to several, old or broken settings at startup, Reconnect pressed while connected or connecting, OpenRGB not running yet when Lumen starts |
| `test/service/openrgb` | The SDK wire format, and the client: handshake, reconnecting, acknowledgements (including malformed ones), frame flow control (including the 3-frame limit), profiles and settings |

Not covered:
- The React UI and the Windows integration (shortcuts, tray icon, Edge window).
- The engine's per-light settings (rename, hide, LED count, fan ring; only invalid values are tested), saving and deleting scenes, Settings changes, the white check, "Flash to Find" and the live preview.
- Waking from sleep (only its re-sync is tested), and reacting when another program changes a device's mode.
- Unused client functions: `saveMode`, `updateZoneMode`, `updateLeds`, `updateZoneLeds`, `rescan`.

**CI** (`.github/workflows/ci.yml`) runs `npm ci`, the typecheck, the tests with a coverage floor (85% lines, 80% branches, 75% functions) and the UI build. It runs on every push to `main` and every pull request, on Windows and Linux. There is no deployment step: Lumen is installed locally with `npm run setup`.

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
