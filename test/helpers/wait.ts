export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Polls until `check` passes: it should throw (an assertion) or return false until then. Rejects with the last
 * assertion error after `timeoutMs`, so a failure says what was still wrong.
 */
export async function eventually(check: () => boolean | void, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs
  let last: unknown
  while (Date.now() < end) {
    try {
      if (check() !== false) return
    } catch (err) {
      last = err
    }
    await sleep(20)
  }
  throw last ?? new Error('condition never became true')
}
