# What Lumen costs this PC

Measured on 23 November 2026 between 22:14 and 22:27 with `node tools/usage-check.mts`. The raw numbers for every run are in [resource-usage-2026-11-23.json](resource-usage-2026-11-23.json).

- **PC:** AMD Ryzen 9 9950X3D (16 cores, 32 threads), 61.5 GB RAM, RTX 5080, a 3440×1440 display at 180 Hz.
- **Lumen's settings:** the Candle scene (`#ffc5d0`, `#ffa3bb`, `#ffeff4`, speed 46) on all 9 lights, 60 fps, full brightness.
- **Before each run:** Lumen had been running for 2½ hours, and the PC was otherwise idle (1–3% CPU).

## In short

- **Normal use, with the window closed:**
  - Lumen and the work it causes in OpenRGB together use **0.28% of the PC's CPU** (about 9% of one core).
  - Lumen's processes use **227 MB of RAM** (0.4% of 61.5 GB). OpenRGB's own 31 MB is there with or without Lumen.
  - Lumen doesn't use the graphics card and writes nothing to disk.
  - It only talks to OpenRGB on this PC (127.0.0.1), never to the internet.
- **Most of that CPU time is OpenRGB sending the colors to the hardware, not Lumen itself.**
  - Lumen's own service uses 0.7% of one core.
  - OpenRGB goes from 0.4% of one core without Lumen to 8.1% with Lumen's 60 updates a second.
  - 97% of OpenRGB's time is in the kernel, which is where drivers run. It goes to the transfers to the motherboard's lighting controller and the graphics card.
- **The open window is the only heavy case.**
  - In front of other windows, it costs **about 84% of one core** (2.6% of the PC), 11% of the graphics card's busiest engine, and **about 400 MB of extra memory** in Edge.
  - Behind other windows, Edge stops drawing it, and it costs about 1% of one core.
  - Closing the window ends the cost.
- **The 30 fps setting** ("Extra-smooth animations" off) cuts the total from 0.28% to 0.19% of the PC's CPU.
- **Memory over time:**
  - The service stayed at the same size: 77 MB when freshly started, 76–86 MB after 2½ hours.
  - The tray icon was larger after 2½ hours (132 MB) than when fresh (96 MB). It's worth checking again after a day.

## Each scenario

| Scenario | Length | Lumen (% of one core) | OpenRGB (% of one core) | Lumen window in Edge (% of one core) | Total (% of the PC) | Lumen's RAM (private) |
| --- | --- | --- | --- | --- | --- | --- |
| **Normal use**: window closed, 60 fps | 2 min | 0.88 | 8.12 | — | **0.28%** | 227 MB (168 MB) |
| 30 fps, window closed | 1½ min | 0.62 | 5.41 | — | **0.19%** | 217 MB (158 MB) |
| Window open, behind other windows | 1½ min | 1.03 | 8.11 | 1.2 | **0.32%** | 225 MB (198 MB) |
| **Window open and in front** | 1 min | 1.10 | 8.34 | 84.3 | **2.93%** | 215 MB (187 MB) |
| Lumen quit (OpenRGB alone) | 1 min | — | 0.36 | — | **0.01%** | — |
| Lumen freshly restarted | 1 min | 1.00 | 8.92 | — | **0.31%** | 190 MB (127 MB) |

- "% of one core" is CPU time divided by elapsed time.
- "% of the PC" divides that by the 32 logical processors. This matches Task Manager's CPU column.
- "Lumen" is the service, its windowless host and the tray icon.
- The window's column counts only what opening it added to Edge. Edge had 5 background processes running before the window opened (about 290 MB, 0% CPU). They are Edge's own startup boost, not Lumen's.

## Each process, in normal use

| Process | CPU (% of one core) | Busiest 5 s | RAM | Private | Threads | Handles | Wake-ups/s |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Lumen service (`node.exe`) | 0.67 | 1.37 | 86 MB | 56 MB | 9 | 245 | 123 |
| Windowless host (`conhost.exe`) | 0 | 0 | 9 MB | 1 MB | 3 | 111 | 0 |
| Tray icon (`powershell.exe`) | 0.21 | 0.28 | 132 MB | 110 MB | 9 | 429 | 1 |
| OpenRGB service | 8.12 | 10.0 | 31 MB | 11 MB | 16 | 330 | 1,869 |

- **RAM** is the process's working set: the physical memory it occupies, including shared system DLLs.
- **Private** is the memory only that process has committed.
- **Wake-ups** are thread context switches: how often the process wakes a core.
  - The service wakes about 120 times a second at 60 fps and about 76 at 30 fps.
  - OpenRGB wakes about 1,800–2,000 times a second whether Lumen runs or not, so those wake-ups are OpenRGB's own.
- **The tray icon uses the most memory of Lumen's processes.** It is PowerShell with Windows Forms loaded, and it asks the service for its state every 3 seconds.

## The open window

With the window in front for a minute:

| Edge process | CPU (% of one core) | RAM | Private | GPU |
| --- | --- | --- | --- | --- |
| GPU process (draws the window) | 59.4 | 112 MB | 301 MB (58 MB before) | 11.4% |
| The Lumen page | 24.5 | 169 MB | 110 MB | — |
| Browser and network | 0.4 | — | — | — |

- The service itself used 0.2–0.3% of a core more, because it sends the window 30 preview frames a second.
- The PC's total CPU went from about 1% to 5.8%.

**Likely cause:**
- The PC picture on the home page draws every LED twice: once through an SVG blur filter for the glow, then sharp on top ([PcPreview.tsx](../src/renderer/src/components/PcPreview.tsx)).
- It redraws on every display refresh: 180 times a second on this monitor, although the colors only change 30–60 times a second.
- This is likely but not yet verified. Limiting the redraw rate, or drawing the glow more cheaply, should cut the window's cost several times over.

## Other effects

- **Disk:**
  - Nothing measurable: 0 KB/s for every Lumen process.
  - The log is 8 KB after 5 days and is emptied when it reaches 1 MB.
  - The settings file (1.9 KB) is only written when a setting changes.
- **Graphics card:** 0% with the window closed.
- **Traffic between Lumen and OpenRGB:** about 48 KB/s at 60 fps, and half that at 30 fps. It stays on this PC.
  - This is calculated, not measured: Windows doesn't count Node's socket traffic.
  - The motherboard gets a 770-byte frame for its 187 LEDs, and the graphics card a 26-byte one, 60 times a second. OpenRGB's acknowledgements add about 3 KB/s.
  - The memory sticks get a frame only every 15 seconds, because they show a still image.
- **OpenRGB's requests to the hardware:** about 960 a second (31 KB/s) at 60 fps, 785 a second at 30 fps, and none while Lumen isn't running.

## How it was measured

- `node tools/usage-check.mts` reads only Windows' own process counters, through PowerShell, and needs no admin rights. It changes nothing.
  - **CPU** is the process's kernel plus user CPU time between the first and last sample.
  - **Memory** is sampled every 5 seconds and averaged.
  - **Wake-ups** are the context switches of all the process's threads.
  - **GPU** is the busiest engine's utilization, as in Task Manager.
- **To measure again:**
  - `node tools/usage-check.mts --seconds=120` prints a table.
  - Add `--edge` to include Edge's processes and GPU use.
  - Add `--label="…" --out=docs/resource-usage-<date>.json` to keep the results.
- **What was temporarily changed for these measurements:**
  - The frame rate was set to 30 fps for 1½ minutes, then back to 60.
  - The window was opened, brought to the front for one minute, then closed.
  - Lumen was quit for 1½ minutes, then restarted the way Windows starts it at sign-in.
  - Afterwards, every setting was identical to before, all 9 lights were online, and Lumen had one connection to OpenRGB.
- **Limits:**
  - Each run lasted 1–2 minutes.
  - The memory-over-time comparison covers only 2½ hours.
  - Gaming and other heavy loads weren't measured.
  - Which device's transfers cost OpenRGB the most wasn't measured either.
