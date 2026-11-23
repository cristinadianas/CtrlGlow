import type { Preset, Scene } from './types.ts'

const s = (effect: Scene['effect'], colors: string[], speed = 45, extra: Partial<Scene> = {}): Scene => ({
  effect, colors, speed, reverse: false, level: 100, ...extra
})

/** Built-in scenes. User scenes are stored alongside these but can be renamed/deleted. */
export const BUILT_IN_PRESETS: Preset[] = [
  { id: 'amber', name: 'Amber', scene: s('static', ['#d47800']), overrides: {}, builtIn: true },
  { id: 'arctic', name: 'Arctic', scene: s('static', ['#bfe3ff']), overrides: {}, builtIn: true },
  // Sakura, chosen by the user on the case (2026-11-19): the original colors (#ffb7c5 / #ff6f91 / #ffe4ec) moved three
  // quarters of the way back to how the LEDs showed them before Lumen converted colors for the LEDs. Converted
  // fully, they looked too pink; unconverted, too white. In the original, flowing Wave. Their nude three-pink
  // variant is their own scene, "Blush".
  { id: 'sakura', name: 'Sakura', scene: s('wave', ['#ffd4dc', '#ffa3bb', '#ffeff4'], 18), overrides: {}, builtIn: true },
  { id: 'sunset', name: 'Sunset', scene: s('gradient', ['#ff5e62', '#ff9966', '#ffd194'], 25), overrides: {}, builtIn: true },
  { id: 'aurora', name: 'Aurora', scene: s('aurora', ['#00f5a0', '#00b4ff', '#7b61ff'], 35), overrides: {}, builtIn: true },
  { id: 'ocean', name: 'Ocean', scene: s('wave', ['#0061ff', '#60efff'], 35), overrides: {}, builtIn: true },
  { id: 'midnight', name: 'Midnight', scene: s('breathing', ['#2f4bff'], 25), overrides: {}, builtIn: true },
  { id: 'candlelight', name: 'Candlelight', scene: s('candle', ['#ff8c2a'], 40), overrides: {}, builtIn: true },
  { id: 'rainbow', name: 'Rainbow', scene: s('rainbow', [], 45), overrides: {}, builtIn: true },
  { id: 'starlight', name: 'Starlight', scene: s('twinkle', ['#fff3d6'], 40, { background: '#101a4a' }), overrides: {}, builtIn: true }
]
