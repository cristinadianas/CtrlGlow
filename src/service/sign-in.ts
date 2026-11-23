/** Keeping Windows' sign-in shortcut in line with the "Start Lumen when you sign in" setting. */

export interface SignInShortcut {
  exists(): boolean
  /** Adds (true) or removes (false) the shortcut; false or a throw means it didn't work. */
  set(on: boolean): boolean
}

/**
 * Adds or removes the shortcut so it matches `wanted`, and returns the setting as it really is afterwards. When
 * the shortcut can't be added or removed, that is what's in place: the setting should say so, so the window shows
 * the truth instead of a switch that is on while Lumen won't start at sign-in (or off while it still will). It also
 * keeps later settings changes from trying again each time, which blocks Lumen on PowerShell for a moment.
 */
export function applyLaunchAtLogin(wanted: boolean, shortcut: SignInShortcut, log: (message: string) => void): boolean {
  if (shortcut.exists() === wanted) return wanted
  let ok = false
  let why = ''
  try {
    ok = shortcut.set(wanted)
  } catch (err) {
    why = ` (${err instanceof Error ? err.message : String(err)})`
  }
  log(`${wanted ? 'Added' : 'Removed'} sign-in shortcut: ${ok ? 'ok' : `FAILED${why}`}`)
  return ok ? wanted : shortcut.exists()
}
