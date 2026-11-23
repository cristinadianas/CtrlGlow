/**
 * Data model for the OpenRGB SDK (protocol version 6, OpenRGB 1.x).
 * Mirrors the RGBController structures described in OpenRGB's Documentation/OpenRGBSDK.md.
 */

export interface RGB {
  r: number
  g: number
  b: number
}

export interface MatrixMap {
  height: number
  width: number
  /** Row-major LED indices; 0xFFFFFFFF marks an empty cell. */
  map: number[]
}

export interface Mode {
  index: number
  name: string
  /** Only sent by servers on protocol < 6; must be echoed back for those versions. */
  value?: number
  flags: number
  speedMin: number
  speedMax: number
  brightnessMin: number
  brightnessMax: number
  colorsMin: number
  colorsMax: number
  speed: number
  brightness: number
  direction: number
  colorMode: number
  colors: RGB[]
}

export interface Segment {
  name: string
  type: number
  startIdx: number
  ledsCount: number
  matrix?: MatrixMap
  flags: number
}

export interface Zone {
  index: number
  name: string
  displayName: string
  type: number
  ledsMin: number
  ledsMax: number
  ledsCount: number
  /** Index of this zone's first LED within the controller's LED list (computed client-side). */
  startIdx: number
  matrix?: MatrixMap
  segments: Segment[]
  flags: number
  activeMode: number
  modes: Mode[]
}

export interface Led {
  name: string
  displayName?: string
}

export interface Controller {
  /** Unique controller ID assigned by the server (protocol 6+). Stable while the server runs. */
  id: number
  type: number
  name: string
  displayName: string
  vendor: string
  description: string
  version: string
  serial: string
  location: string
  activeMode: number
  modes: Mode[]
  zones: Zone[]
  leds: Led[]
  colors: RGB[]
  flags: number
  configuration: string
}

export const DeviceType = {
  MOTHERBOARD: 0,
  DRAM: 1,
  GPU: 2,
  COOLER: 3,
  LEDSTRIP: 4,
  KEYBOARD: 5,
  MOUSE: 6,
  MOUSEMAT: 7,
  HEADSET: 8,
  HEADSET_STAND: 9,
  GAMEPAD: 10,
  LIGHT: 11,
  SPEAKER: 12,
  VIRTUAL: 13,
  STORAGE: 14,
  CASE: 15,
  MICROPHONE: 16,
  ACCESSORY: 17,
  KEYPAD: 18,
  LAPTOP: 19,
  MONITOR: 20,
  UNKNOWN: 21
} as const

export const ModeFlag = {
  HAS_SPEED: 1 << 0,
  HAS_DIRECTION_LR: 1 << 1,
  HAS_DIRECTION_UD: 1 << 2,
  HAS_DIRECTION_HV: 1 << 3,
  HAS_BRIGHTNESS: 1 << 4,
  HAS_PER_LED_COLOR: 1 << 5,
  HAS_MODE_SPECIFIC_COLOR: 1 << 6,
  HAS_RANDOM_COLOR: 1 << 7,
  MANUAL_SAVE: 1 << 8,
  AUTOMATIC_SAVE: 1 << 9,
  REQUIRES_ENTIRE_DEVICE: 1 << 10,
  HAS_DIRECTION_DIAG: 1 << 11
} as const

export const ColorMode = {
  NONE: 0,
  PER_LED: 1,
  MODE_SPECIFIC: 2,
  RANDOM: 3
} as const

export const ZoneType = {
  SINGLE: 0,
  LINEAR: 1,
  MATRIX: 2,
  LINEAR_LOOP: 3,
  MATRIX_LOOP_X: 4,
  MATRIX_LOOP_Y: 5,
  SEGMENTED: 6
} as const

export const ZoneFlag = {
  CONFIGURABLE_SIZE_EFFECTS_ONLY: 1 << 0,
  CONFIGURABLE_SIZE: 1 << 1,
  CONFIGURABLE_NAME: 1 << 2,
  CONFIGURED_SIZE: 1 << 12,
  GEOMETRY_MAY_CHANGE: 1 << 24
} as const

export const AckStatus = {
  OK: 0,
  ERROR_GENERIC: 1,
  ERROR_UNSUPPORTED: 2,
  ERROR_NOT_ALLOWED: 3,
  ERROR_INVALID_ID: 4,
  ERROR_INVALID_DATA: 5
} as const

export function isResizable(zone: Zone): boolean {
  return (zone.flags & (ZoneFlag.CONFIGURABLE_SIZE | ZoneFlag.CONFIGURABLE_SIZE_EFFECTS_ONLY)) !== 0 ||
    zone.ledsMin !== zone.ledsMax
}
