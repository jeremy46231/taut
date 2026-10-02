import { getFiberFromNode, reactPromise } from './react'
import {
  byMeta,
  byName,
  patchFunctionExport,
  patchModuleExports,
} from './webpack'

export type SlackStore = {
  getState(): any
  dispatch(action: any): any
  subscribe(cb: () => void): () => void
}

export type StatePatch = (state: any) => any
const statePatches = new Set<StatePatch>()
let statePatchVersion = 0

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
    for (const patch of statePatches)
      out = guarded(patch, out, () => patch(out))
    cachedRaw = raw
    cachedVersion = statePatchVersion
    cachedOut = out
    return out
  }
  wrapped.__tautWrapped = true
  wrapped.__tautRawGetState = realGetState
  store.getState = wrapped
}

// Slack makes several stores and the rendered one is only known once its <Provider> mounts
const lookingForStore = new Set<() => void>()
let resolveStore: (store: SlackStore) => void
const storePromise = new Promise<SlackStore>((resolve) => {
  resolveStore = resolve
})

patchFunctionExport(
  byName('createStore'),
  (originalCreateStore) =>
    (...args) => {
      const store = originalCreateStore(...args)
      try {
        wrapGetState(store)
        if (!cachedStore) lookingForStore.add(store.subscribe(getReduxStore))
      } catch {}
      return store
    }
)

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
      resolveStore(store)
      for (const unsubscribe of lookingForStore) unsubscribe()
      lookingForStore.clear()
      return store
    }
  }
  return null
}

/** Slack's react-redux store, once it exists */
export function waitForStore(): Promise<SlackStore> {
  return Promise.resolve(getReduxStore() ?? storePromise)
}

/** `store.subscribe` starting once the store exists, returns a disposer */
export function subscribeStore(listener: () => void): () => void {
  let unsubscribe: (() => void) | undefined
  let disposed = false
  waitForStore().then((store) => {
    if (!disposed) unsubscribe = store.subscribe(listener)
  })
  return () => {
    disposed = true
    unsubscribe?.()
  }
}

/** the first non-undefined `read()`, checked now and after every dispatch, rejects if `signal` aborts */
export function waitForState<T>(
  read: () => T | undefined,
  signal?: AbortSignal
): Promise<T> {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (signal?.aborted) return done(() => reject(signal.reason))
      let value: T | undefined
      try {
        value = read()
      } catch (err) {
        return done(() => reject(err))
      }
      if (value !== undefined) done(() => resolve(value))
    }
    const done = (settle: () => void) => {
      unsubscribe()
      signal?.removeEventListener('abort', check)
      settle()
    }
    const unsubscribe = subscribeStore(check)
    signal?.addEventListener('abort', check)
    check()
  })
}

/** Slack's state as it is stored, with Taut's read-time transforms left off */
export function getRawState(): any {
  const getState = getReduxStore()?.getState as
    | ((() => any) & { __tautRawGetState?: () => any })
    | undefined
  return (getState?.__tautRawGetState ?? getState)?.()
}

const patchListeners = new Set<() => void>()

const subscribePatches = (notify: () => void) => {
  patchListeners.add(notify)
  return () => patchListeners.delete(notify)
}
export const getPatchVersion = () => statePatchVersion

/** invalidates patched reads and nudges connected views to re-read */
export function refreshState(): void {
  statePatchVersion++
  try {
    getReduxStore()?.dispatch({ type: '@@taut/PATCH_STATE' })
  } catch {}
  for (const notify of patchListeners) {
    try {
      notify()
    } catch {}
  }
}

/** registers a read-time state transform */
export function patchState(patch: StatePatch): () => void {
  statePatches.add(patch)
  failed.delete(patch)
  refreshState()
  return () => {
    statePatches.delete(patch)
    refreshState()
  }
}

const hasOwn = (obj: object, key: PropertyKey): boolean =>
  typeof key !== 'symbol' && Object.hasOwn(obj, key)

export type MapEntry<T> = (key: string, entry: T | undefined) => T | undefined

type Memo = {
  cache: Map<string, { input: any; output: any }>
  added: Set<string>
  version: number
}

// a patch that throws has its whole registration (patchState or patchSlice call) switched off
const failed = new WeakSet<object>()
let running: object | undefined
function guarded<R>(owner: object, fallback: R, run: () => R): R {
  if (failed.has(owner)) return fallback
  const outer = running
  running = owner
  try {
    return run()
  } catch (error) {
    failed.add(owner)
    console.error('[Taut] A redux patch threw and was switched off', error)
    // drop what it already produced
    queueMicrotask(refreshState)
    return fallback
  } finally {
    running = outer
  }
}

const memos = new WeakMap<MapEntry<any>, Memo>()
const memoFor = (mapEntry: MapEntry<any>): Memo => {
  let memo = memos.get(mapEntry)
  if (!memo) {
    memo = { cache: new Map(), added: new Set(), version: -1 }
    memos.set(mapEntry, memo)
  }
  return memo
}

/** A view of an id-keyed store object, reading entries through `mapEntry` */
export function mapEntries<T = any>(
  object: object,
  mapEntry: MapEntry<T>,
  addedKeys?: () => Iterable<string>
): object {
  const memo = memoFor(mapEntry)
  // `mapEntry` is often a fresh closure per read, so a failure switches off the registration behind it
  const owner = running ?? mapEntry
  // a refresh may mean the closure's inputs changed, so the memo and added keys start over
  const sync = () => {
    if (memo.version === statePatchVersion) return
    memo.cache = new Map()
    memo.added = new Set(addedKeys ? guarded(owner, [], addedKeys) : [])
    memo.version = statePatchVersion
  }
  const run = (key: PropertyKey, value: any): any => {
    if (typeof key !== 'string') return value
    sync()
    const hit = memo.cache.get(key)
    if (hit && hit.input === value) return hit.output
    const output = guarded(owner, value, () => mapEntry(key, value))
    memo.cache.set(key, { input: value, output })
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
      memo.added.has(key) &&
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
    const extra = [...memo.added].filter((k) => !hasOwn(target, k))
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
  return new Proxy(object, {
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
  })
}

export type SliceOptions = {
  /** keys the slice doesn't have that read through `mapEntry` anyway */
  addedKeys?: () => Iterable<string>
}

type SlicePatch = {
  mapEntry: MapEntry<any>
  addedKeys?: () => Iterable<string>
}
/** a slice read through every patch on it */
type SliceView = {
  mapEntry: MapEntry<any>
  addedKeys?: () => Iterable<string>
  raw?: object
  version: number
  proxy?: object
}
type SliceLayer = {
  patches: SlicePatch[]
  // recomposed whenever `patches` changes, which also starts fresh memos
  all: SliceView
}
const sliceLayers = new Map<string, SliceLayer>()
let unpatchSlices: (() => void) | undefined

function composeView(patches: SlicePatch[]): SliceView {
  return {
    mapEntry: (key, entry) => {
      let out = entry
      for (const patch of patches)
        out = guarded(patch, out, () => patch.mapEntry(key, out))
      return out
    },
    addedKeys: patches.some((patch) => patch.addedKeys)
      ? () =>
          patches.flatMap((patch) =>
            patch.addedKeys ? [...guarded(patch, [], patch.addedKeys)] : []
          )
      : undefined,
    version: -1,
  }
}

// one proxy per slice until the slice or version changes, or whole-slice selectors rerun every action
function readView(view: SliceView, slice: object): object {
  if (!view.proxy || view.raw !== slice || view.version !== statePatchVersion) {
    view.raw = slice
    view.version = statePatchVersion
    view.proxy = mapEntries(slice, view.mapEntry, view.addedKeys)
  }
  return view.proxy
}

function patchSlices(state: any): any {
  let out = state
  for (const [sliceName, layer] of sliceLayers) {
    const slice = state?.[sliceName]
    if (!slice || typeof slice !== 'object') continue
    if (out === state) out = { ...state }
    out[sliceName] = readView(layer.all, slice)
  }
  return out
}

/** read `sliceName`'s entries through `mapEntry(key, entry)`, the third argument is `addedKeys` or options */
export function patchSlice<T = any>(
  sliceName: string,
  mapEntry: MapEntry<T>,
  options?: SliceOptions | SliceOptions['addedKeys']
): () => void {
  const addedKeys = typeof options === 'function' ? options : options?.addedKeys
  const patch: SlicePatch = { mapEntry, addedKeys }
  let layer = sliceLayers.get(sliceName)
  if (!layer) {
    layer = { patches: [], all: composeView([]) }
    sliceLayers.set(sliceName, layer)
  }
  layer.patches.push(patch)
  layer.all = composeView(layer.patches)
  if (unpatchSlices) refreshState()
  else unpatchSlices = patchState(patchSlices)

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    const current = sliceLayers.get(sliceName)
    if (!current) return
    current.patches = current.patches.filter((other) => other !== patch)
    if (current.patches.length) current.all = composeView(current.patches)
    else sliceLayers.delete(sliceName)
    if (sliceLayers.size || !unpatchSlices) {
      refreshState()
      return
    }
    const unpatch = unpatchSlices
    unpatchSlices = undefined
    unpatch()
  }
}

type ThunkWrap = {
  match: (value: any) => boolean
  wrap: (original: (...args: any[]) => any) => (...args: any[]) => any
}
const thunkWraps = new Set<ThunkWrap>()

type ThunkCreator = (...args: any[]) => any

const thunkCreators = new Map<string, ThunkCreator>()
const waitingForThunk = new Map<string, Set<(creator: ThunkCreator) => void>>()

const wrapCreator = (original: ThunkCreator): ThunkCreator =>
  new Proxy(original, {
    apply(target, thisArg, args) {
      let creator: ThunkCreator = target
      for (const { match, wrap } of thunkWraps) {
        let matched = false
        try {
          matched = match(target)
        } catch {}
        if (!matched) continue
        try {
          creator = wrap(creator)
        } catch {}
      }
      return Reflect.apply(creator, thisArg, args)
    },
  })

function registerCreator(creator: ThunkCreator): void {
  // the defining module assigns `meta` on the statement after createThunk
  queueMicrotask(() => {
    const name = (creator as any).meta?.name
    if (typeof name !== 'string') return
    thunkCreators.set(name, creator)
    const waiting = waitingForThunk.get(name)
    if (!waiting) return
    waitingForThunk.delete(name)
    for (const resolve of waiting) resolve(creator)
  })
}

const readExport = (exports: any, key: string): any => {
  try {
    return exports[key]
  } catch {
    return undefined
  }
}
const isThunkKinds = (value: any): boolean =>
  value?.Thunk === 'Thunk' && value?.Fetcher === 'Fetcher'

// every thunk and fetcher in the app uses createThunk
patchModuleExports((exports) => {
  if (!exports || typeof exports !== 'object') return
  const keys = Object.keys(exports)
  if (!keys.some((key) => isThunkKinds(readExport(exports, key)))) return
  const key = keys.find((candidate) => {
    const value = readExport(exports, candidate)
    return typeof value === 'function' && value.length === 2
  })
  if (!key) return

  const createThunk = exports[key] as (...args: any[]) => ThunkCreator
  const descriptors = Object.getOwnPropertyDescriptors(exports)
  descriptors[key] = {
    value: (description: unknown, callback: unknown, ...rest: unknown[]) => {
      const creator = wrapCreator(createThunk(description, callback, ...rest))
      registerCreator(creator)
      return creator
    },
    enumerable: true,
    configurable: true,
    writable: true,
  }
  return Object.create(Object.getPrototypeOf(exports), descriptors)
})

/** one of Slack's thunk creators, if it has been defined yet */
export function getThunkCreator(name: string): ThunkCreator | undefined {
  return thunkCreators.get(name)
}

/** one of Slack's thunk creators, resolving whenever Slack gets around to defining it */
export function waitForThunkCreator(name: string): Promise<ThunkCreator> {
  const known = thunkCreators.get(name)
  if (known) return Promise.resolve(known)
  return new Promise((resolve) => {
    let waiting = waitingForThunk.get(name)
    if (!waiting) {
      waiting = new Set()
      waitingForThunk.set(name, waiting)
    }
    waiting.add(resolve)
  })
}

export async function dispatchThunk<T = any>(
  name: string,
  ...args: any[]
): Promise<T> {
  const creator = await waitForThunkCreator(name)
  const store = getReduxStore()
  if (!store) throw new Error('[Taut] No redux store to dispatch to')
  return store.dispatch(creator(...args))
}

/** `match` is a thunk name or a test on its creator, returns a disposer */
export function patchThunk(
  match: string | ThunkWrap['match'],
  wrap: ThunkWrap['wrap']
): () => void {
  const matcher: ThunkWrap['match'] =
    typeof match === 'string' ? byMeta(match) : match
  const entry: ThunkWrap = { match: matcher, wrap }
  thunkWraps.add(entry)
  return () => {
    thunkWraps.delete(entry)
  }
}

export const reduxPromise = (async () => {
  const React = await reactPromise

  /** reactively select from the store inside a React render */
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

  // Slack's connect memoizes off the raw state, so a component reading patched state needs this to rerender
  function usePatchVersion(): number {
    return React.useSyncExternalStore(subscribePatches, getPatchVersion)
  }

  return {
    getStore: getReduxStore,
    waitForStore,
    getRawState,
    waitForState,
    useReduxState,
    usePatchVersion,
    patchState,
    patchSlice,
    mapEntries,
    patchThunk,
    getThunkCreator,
    waitForThunkCreator,
    dispatchThunk,
    refresh: refreshState,
  }
})()

export type ReduxAPI = Awaited<typeof reduxPromise>
