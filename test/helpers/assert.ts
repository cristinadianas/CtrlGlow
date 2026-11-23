import assert from 'node:assert/strict'

/** Asserts two RGB triples (or any equal-length number lists) match within `tolerance` per channel. */
export function assertRgbClose(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance = 0.5): void {
  assert.equal(actual.length, expected.length, 'length')
  for (let i = 0; i < expected.length; i++) {
    const d = Math.abs(actual[i] - expected[i])
    assert.ok(d <= tolerance, `channel ${i}: ${actual[i]} is not within ${tolerance} of ${expected[i]}`)
  }
}

/** Asserts a number is within `tolerance` of the expected value. */
export function assertClose(actual: number, expected: number, tolerance: number, message = ''): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message} ${actual} is not within ${tolerance} of ${expected}`.trim())
}
