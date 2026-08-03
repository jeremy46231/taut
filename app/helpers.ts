// Taut App Helpers
// Shared utilities for the Taut app

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
