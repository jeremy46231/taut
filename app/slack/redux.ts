// Taut Redux Utilities
// Access to Slack's react-redux store, plus read-time state patching

import { getFiberFromNode, reactPromise } from './react'
import { patchModuleExports } from './webpack'

export type SlackStore = {
  getState(): any
  dispatch(action: any): any
  subscribe(cb: () => void): () => void
}

export type StatePatch = (state: any) => any
const statePatches = new Set<StatePatch>()
// Bumped on register/unregister to invalidate each store's getState memo
let statePatchVersion = 0

// Wrap a store's getState so reads flow through statePatches
function wrapGetState(store: SlackStore): void {
  if ((store.getState as any).__tautWrapped) return
  const realGetState = store.getState.bind(store)
  let cachedRaw: any
  let cachedVersion = -1
  let cachedOut: any
  const wrapped = () => {
    const raw = realGetState()
    if (statePatches.size === 0) return raw
    if (raw === cachedRaw && cachedVersion === statePatchVersion)
      return cachedOut
    let out = raw
    for (const patch of statePatches) {
      try {
        out = patch(out)
      } catch {}
    }
    cachedRaw = raw
    cachedVersion = statePatchVersion
    cachedOut = out
    return out
  }
  wrapped.__tautWrapped = true
  store.getState = wrapped
}

// Hook redux's createStore to wrap the getState of every store it creates
patchModuleExports((exports) => {
  if (!exports || typeof exports !== 'object') return
  for (const key of Object.keys(exports)) {
    let value: any
    try {
      value = exports[key]
    } catch {
      continue
    }
    if (typeof value !== 'function' || value.name !== 'createStore') continue

    const originalCreateStore = value
    const hookedCreateStore = (...args: any[]) => {
      const store = originalCreateStore(...args)
      try {
        wrapGetState(store)
      } catch {}
      return store
    }
    const descriptors = Object.getOwnPropertyDescriptors(exports)
    descriptors[key] = {
      value: hookedCreateStore,
      enumerable: true,
      configurable: true,
      writable: true,
    }
    return Object.create(Object.getPrototypeOf(exports), descriptors)
  }
})

let cachedStore: SlackStore | null = null

/** Slack's react-redux store, found via the <Provider> value on the fiber tree (cached) */
export function getReduxStore(): SlackStore | null {
  if (cachedStore) return cachedStore
  const start = document.querySelector('.p-client_container')?.firstElementChild
  if (!start) return null
  for (let fiber = getFiberFromNode(start); fiber; fiber = fiber.return) {
    const value = fiber.memoizedProps?.value
    const store = value?.store ?? value
    if (
      store &&
      typeof store.getState === 'function' &&
      typeof store.subscribe === 'function'
    ) {
      cachedStore = store
      return store
    }
  }
  return null
}

/** Invalidate patched reads and nudge connected views to re-read */
export function refreshState(): void {
  statePatchVersion++
  try {
    getReduxStore()?.dispatch({ type: '@@taut/PATCH_STATE' })
  } catch {}
}

/** Register a read-time state transform */
export function patchState(patch: StatePatch): () => void {
  statePatches.add(patch)
  refreshState()
  return () => {
    statePatches.delete(patch)
    refreshState()
  }
}

const hasOwn = (obj: object, key: PropertyKey): boolean =>
  typeof key !== 'symbol' && Object.hasOwn(obj, key)

export function patchSlice<T = any>(
  sliceName: string,
  mapEntry: (key: string, entry: T | undefined) => T | undefined,
  addedKeys?: () => Iterable<string>
): () => void {
  // A refresh (version bump) means the closure's inputs may have changed, so
  // memoized results and the added-key set are dropped and recomputed.
  let cache = new Map<string, { input: any; output: any }>()
  let cacheVersion = -1
  let added = new Set<string>()
  const sync = () => {
    if (cacheVersion === statePatchVersion) return
    cache = new Map()
    if (addedKeys) {
      try {
        added = new Set(addedKeys())
      } catch {
        added = new Set()
      }
    }
    cacheVersion = statePatchVersion
  }
  const run = (key: PropertyKey, value: any): any => {
    if (typeof key !== 'string') return value
    sync()
    const hit = cache.get(key)
    if (hit && hit.input === value) return hit.output
    const output = mapEntry(key, value as T | undefined)
    cache.set(key, { input: value, output })
    return output
  }
  const describe = (target: object, key: PropertyKey) => {
    const desc = Object.getOwnPropertyDescriptor(target, key)
    if (desc) {
      if (!('value' in desc) || desc.configurable === false) return desc
      return { ...desc, value: run(key, desc.value) }
    }
    sync()
    if (
      typeof key === 'string' &&
      added.has(key) &&
      Object.isExtensible(target)
    )
      return {
        value: run(key, undefined),
        enumerable: true,
        configurable: true,
        writable: true,
      }
    return undefined
  }
  const ownKeysWith = (target: object): (string | symbol)[] => {
    const keys = Reflect.ownKeys(target)
    if (!addedKeys || !Object.isExtensible(target)) return keys
    sync()
    const extra = [...added].filter((k) => !hasOwn(target, k))
    return extra.length ? [...keys, ...extra] : keys
  }
  const protoProxies = new WeakMap<object, object>()
  const proxyProto = (proto: object): object => {
    let proxied = protoProxies.get(proto)
    if (!proxied) {
      proxied = new Proxy(proto, {
        get: (target, key) => run(key, (target as any)[key]),
        getOwnPropertyDescriptor: describe,
        ownKeys: ownKeysWith,
      })
      protoProxies.set(proto, proxied)
    }
    return proxied
  }
  return patchState((state) => {
    const slice = state?.[sliceName]
    if (!slice || typeof slice !== 'object') return state
    return {
      ...state,
      [sliceName]: new Proxy(slice, {
        get: (target, key) => run(key, (target as any)[key]),
        getOwnPropertyDescriptor: (target, key) => {
          const desc = Object.getOwnPropertyDescriptor(target, key)
          if (!desc || !('value' in desc) || desc.configurable === false)
            return desc
          return { ...desc, value: run(key, desc.value) }
        },
        getPrototypeOf: (target) => {
          const proto = Object.getPrototypeOf(target)
          if (!proto || typeof proto !== 'object' || proto === Object.prototype)
            return proto
          return proxyProto(proto)
        },
      }),
    }
  })
}

type ThunkWrap = {
  match: (value: any) => boolean
  wrap: (original: (...args: any[]) => any) => (...args: any[]) => any
}
const thunkWraps = new Set<ThunkWrap>()

const isThunkCreator = (v: any): boolean =>
  typeof v === 'function' && (v as any).isThunkCreator === true

function wrapThunkCreator(original: (...args: any[]) => any) {
  const wrapper = (...args: any[]) => {
    let creator = original
    for (const { match, wrap } of thunkWraps) {
      let matched = false
      try {
        matched = match(original)
      } catch {}
      if (!matched) continue
      try {
        creator = wrap(creator)
      } catch {}
    }
    return creator(...args)
  }
  // Keep the creator's identity
  for (const k of Object.keys(original)) {
    try {
      ;(wrapper as any)[k] = (original as any)[k]
    } catch {}
  }
  return wrapper
}

patchModuleExports((exports) => {
  if (isThunkCreator(exports)) return wrapThunkCreator(exports)
  if (!exports || typeof exports !== 'object') return
  let changed = false
  const descriptors = Object.getOwnPropertyDescriptors(exports)
  for (const key of Object.keys(exports)) {
    let value: any
    try {
      value = exports[key]
    } catch {
      continue
    }
    if (!isThunkCreator(value)) continue
    descriptors[key] = {
      value: wrapThunkCreator(value),
      enumerable: descriptors[key]?.enumerable ?? true,
      configurable: true,
      writable: true,
    }
    changed = true
  }
  if (changed) return Object.create(Object.getPrototypeOf(exports), descriptors)
})

/** Observe or alter a Slack redux thunk */
export function patchThunk(
  match: string | ThunkWrap['match'],
  wrap: ThunkWrap['wrap']
): () => void {
  const matcher: ThunkWrap['match'] =
    typeof match === 'string' ? (v) => v?.meta?.name === match : match
  const entry: ThunkWrap = { match: matcher, wrap }
  thunkWraps.add(entry)
  return () => {
    thunkWraps.delete(entry)
  }
}

/** Reactively select from the store inside a React render */
export const reduxPromise = (async () => {
  const React = await reactPromise

  function useReduxState<T>(selector: (state: any) => T): T | undefined {
    const store = getReduxStore()
    const selectorRef = React.useRef(selector)
    selectorRef.current = selector
    const subscribe = React.useCallback(
      (cb: () => void) => (store ? store.subscribe(cb) : () => {}),
      [store]
    )
    const getSnapshot = React.useCallback(
      () => (store ? selectorRef.current(store.getState()) : undefined),
      [store]
    )
    return React.useSyncExternalStore(subscribe, getSnapshot)
  }

  return {
    getStore: getReduxStore,
    useReduxState,
    patchState,
    patchSlice,
    patchThunk,
    refresh: refreshState,
  }
})()

export type ReduxAPI = Awaited<typeof reduxPromise>
