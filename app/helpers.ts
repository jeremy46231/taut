export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false

  const aObject = a as Record<string, unknown>
  const bObject = b as Record<string, unknown>
  const aKeys = Object.keys(aObject)
  const bKeys = Object.keys(bObject)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.hasOwn(bObject, key)) return false
    if (!deepEqual(aObject[key], bObject[key])) return false
  }
  return true
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms))

/** runs `attempt` up to `tries` times until it returns a value, with exponential backoff and full jitter */
export async function retry<T>(
  attempt: () => Promise<T | undefined>,
  { tries = 3, baseMs = 1000, maxMs = 30_000 } = {}
): Promise<T | undefined> {
  for (let i = 0; ; i++) {
    const result = await attempt()
    if (result !== undefined || i >= tries - 1) return result
    await sleep(Math.random() * Math.min(maxMs, baseMs * 2 ** i))
  }
}
