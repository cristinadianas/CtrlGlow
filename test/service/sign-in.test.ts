/**
 * "Start Lumen when you sign in": the setting must say what is really set up in Windows, also when adding or
 * removing the shortcut fails. A fake shortcut stands in for the real one; nothing here touches Windows.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { applyLaunchAtLogin, type SignInShortcut } from '../../src/service/sign-in.ts'

function fakeShortcut(present: boolean, works: boolean | 'throws' = true): SignInShortcut & { present: boolean; calls: boolean[] } {
  return {
    present,
    calls: [],
    exists() {
      return this.present
    },
    set(on) {
      this.calls.push(on)
      if (works === 'throws') throw new Error('EBUSY: resource busy or locked')
      if (works) this.present = on
      return works
    }
  }
}

describe('Start Lumen when you sign in', () => {
  it('does nothing when the shortcut already matches the setting', () => {
    for (const on of [true, false]) {
      const shortcut = fakeShortcut(on)
      const log: string[] = []
      assert.equal(applyLaunchAtLogin(on, shortcut, (m) => log.push(m)), on)
      assert.deepEqual(shortcut.calls, [], 'no PowerShell run when nothing needs changing')
      assert.deepEqual(log, [])
    }
  })

  it('adds or removes the shortcut when the setting changes', () => {
    const add = fakeShortcut(false)
    const log: string[] = []
    assert.equal(applyLaunchAtLogin(true, add, (m) => log.push(m)), true)
    assert.equal(add.present, true)
    const remove = fakeShortcut(true)
    assert.equal(applyLaunchAtLogin(false, remove, (m) => log.push(m)), false)
    assert.equal(remove.present, false)
    assert.deepEqual(log, ['Added sign-in shortcut: ok', 'Removed sign-in shortcut: ok'])
  })

  it('reports the setting as off when the shortcut could not be added (the switch must not claim Lumen will start)', () => {
    const shortcut = fakeShortcut(false, false)
    const log: string[] = []
    assert.equal(applyLaunchAtLogin(true, shortcut, (m) => log.push(m)), false)
    assert.deepEqual(log, ['Added sign-in shortcut: FAILED'])
  })

  it('reports the setting as on, without throwing, when a locked shortcut could not be removed (Lumen will still start)', () => {
    const shortcut = fakeShortcut(true, 'throws')
    const log: string[] = []
    assert.equal(applyLaunchAtLogin(false, shortcut, (m) => log.push(m)), true)
    assert.deepEqual(log, ['Removed sign-in shortcut: FAILED (EBUSY: resource busy or locked)'])
  })
})
