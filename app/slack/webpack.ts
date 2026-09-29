// Taut Webpack Utilities
// Hooks into Slack's webpack runtime before it loads
// Captures module exports for discovery

import type {
  Chunk,
  Exports,
  ModuleFactory,
  WebpackModule,
  WebpackRequire,
} from './webpackTypes'

const global = globalThis as any

// Module Registry & State

let __webpack_require__: WebpackRequire | null = null
const __webpackModuleRegistry = new Map<PropertyKey, Exports>()

// Unwrapped module factories, so their .toString() is the
// original source (for debug)
/** key: module id */
const __webpackModuleFactories = new Map<string, ModuleFactory>()
// First module to export a given value, for debug
const __webpackExportOwners = new WeakMap<object, string>()

function registerExportOwner(moduleId: string, exports: any) {
  if (
    !exports ||
    (typeof exports !== 'object' && typeof exports !== 'function')
  )
    return
  if (!__webpackExportOwners.has(exports)) {
    __webpackExportOwners.set(exports, moduleId)
  }
  for (const key in exports) {
    if (!Object.hasOwn(exports, key)) continue
    try {
      const value = exports[key]
      if (
        value &&
        (typeof value === 'object' || typeof value === 'function') &&
        !__webpackExportOwners.has(value)
      ) {
        __webpackExportOwners.set(value, moduleId)
      }
    } catch {}
  }
}

// Export Matching Helpers

type ExportMatcher<T> = (exp: any) => exp is T
type SimpleMatcher = (exp: any) => boolean

// Run a matcher against an export and each of its own enumerable properties
// Returns the first matching value, or undefined if nothing matches
function matchExportOrProps(exports: any, matcher: SimpleMatcher): any {
  if (matcher(exports)) return exports
  if (exports && typeof exports === 'object') {
    for (const key in exports) {
      if (!Object.hasOwn(exports, key)) continue
      try {
        if (matcher(exports[key])) return exports[key]
      } catch {}
    }
  }
  return undefined
}

// Export Waiting

const pendingMatchers = new Map<
  symbol,
  { matcher: SimpleMatcher; resolve: (exp: any) => void }
>()

/**
 * Wait for a webpack export matching the given filter to be loaded.
 * Resolves immediately if already found, otherwise waits for it to appear.
 */
export function waitForExport<T>(matcher: ExportMatcher<T>): Promise<T>
export function waitForExport<T>(matcher: SimpleMatcher): Promise<T>
export function waitForExport(matcher: SimpleMatcher): Promise<any> {
  const existing = getExport(matcher)
  if (existing !== undefined) return Promise.resolve(existing)

  // Not found yet, register a pending matcher
  return new Promise((resolve) => {
    const id = Symbol()
    pendingMatchers.set(id, {
      matcher,
      resolve: (exp) => {
        pendingMatchers.delete(id)
        resolve(exp)
      },
    })
  })
}

function checkPendingMatchers(exports: any) {
  for (const [_id, { matcher, resolve }] of pendingMatchers) {
    const found = matchExportOrProps(exports, matcher)
    if (found !== undefined) resolve(found)
  }
}

// Module Load Callbacks

const moduleLoadCallbacks: ((exports: any) => void)[] = []

export function onModuleLoaded(cb: (exports: any) => void): void {
  moduleLoadCallbacks.push(cb)
}

/**
 * Run a callback for every export matching the given predicate, both those
 * already in the registry and any that load in the future.
 */
export function forEachExport(
  matcher: SimpleMatcher,
  cb: (exp: any) => void
): void {
  const seen = new WeakSet<object>()
  function fire(found: any) {
    if (typeof found !== 'object' && typeof found !== 'function') return
    if (seen.has(found)) return
    seen.add(found)
    cb(found)
  }
  for (const exp of __webpackModuleRegistry.values()) {
    const found = matchExportOrProps(exp, matcher)
    if (found !== undefined) fire(found)
  }
  onModuleLoaded((exp) => {
    const found = matchExportOrProps(exp, matcher)
    if (found !== undefined) fire(found)
  })
}

// Module Exports Patching

type ModuleExportsPatcher = (exports: any, moduleId: string) => any | undefined
const moduleExportsPatchers = new Set<ModuleExportsPatcher>()

export function patchModuleExports(patcher: ModuleExportsPatcher): void {
  moduleExportsPatchers.add(patcher)
}

/**
 * Wrap a function export by name
 */
export function patchExportFunction(
  name: string,
  wrap: (original: (...args: any[]) => any) => (...args: any[]) => any
): void {
  patchModuleExports((exports) => {
    if (!exports || typeof exports !== 'object') return
    for (const key of Object.keys(exports)) {
      let value: any
      try {
        value = exports[key]
      } catch {
        continue
      }
      if (typeof value !== 'function' || value.name !== name) continue

      // Webpack defines namespace exports as non-configurable getters, so the
      // whole exports object has to be rebuilt
      const descriptors = Object.getOwnPropertyDescriptors(exports)
      descriptors[key] = {
        value: wrap(value),
        enumerable: true,
        configurable: true,
        writable: true,
      }
      return Object.create(Object.getPrototypeOf(exports), descriptors)
    }
  })
}

// Factory Wrapping

function wrapModuleFactory(
  moduleId: PropertyKey,
  factory: ModuleFactory
): ModuleFactory {
  if ((factory as any).__tautWrapped) return factory

  __webpackModuleFactories.set(String(moduleId), factory)

  const wrappedFactory = function wrappedFactory(
    module: WebpackModule,
    exports: Exports,
    require: WebpackRequire
  ): any {
    const result = factory.call(exports, module, exports, require)

    let moduleExports = module.exports
    for (const patcher of moduleExportsPatchers) {
      try {
        const replaced = patcher(moduleExports, String(moduleId))
        if (replaced !== undefined && replaced !== moduleExports) {
          module.exports = replaced
          moduleExports = replaced
        }
      } catch {}
    }
    __webpackModuleRegistry.set(moduleId, moduleExports)
    registerExportOwner(String(moduleId), moduleExports)
    checkPendingMatchers(moduleExports)
    for (const cb of moduleLoadCallbacks) cb(moduleExports)

    return result
  }

  ;(wrappedFactory as any).__tautWrapped = true
  return wrappedFactory
}

// Push Interception

type PushFn = (...items: Chunk[]) => number

function wrapWebpackPush(originalPush: PushFn): PushFn {
  return function wrappedPush(this: any, ...args: Chunk[]): number {
    for (const chunk of args) {
      if (!Array.isArray(chunk) || chunk.length < 2) continue

      const [_chunkIds, modules, runtime] = chunk

      if (modules && typeof modules === 'object') {
        for (const moduleId of Object.keys(modules)) {
          const factory = modules[moduleId]
          if (typeof factory === 'function') {
            modules[moduleId] = wrapModuleFactory(moduleId, factory)
          }
        }
      }

      if (typeof runtime === 'function' && !__webpack_require__) {
        const originalRuntime = runtime
        chunk[2] = function wrappedRuntime(require: WebpackRequire) {
          if (!__webpack_require__) {
            __webpack_require__ = require
            global.__webpack_require__ = require
          }
          return originalRuntime(require)
        }
      }
    }

    return originalPush.apply(this, args)
  }
}

// Early Hook Installation

const CHUNK_GLOBAL_NAMES = [
  'webpackChunkwebapp',
  'rspackChunkwebapp',
  'rspackChunkGantryV2',
]

function installWebpackHook(globalName: string) {
  let backingArray: Chunk[] | null = null
  let wrappedPush: PushFn | null = null

  Object.defineProperty(global, globalName, {
    configurable: true,
    enumerable: true,
    get() {
      return backingArray
    },
    set(arr: Chunk[]) {
      backingArray = arr

      let currentPush = arr.push.bind(arr)
      wrappedPush = wrapWebpackPush(currentPush)

      Object.defineProperty(arr, 'push', {
        configurable: true,
        enumerable: false,
        get() {
          return wrappedPush
        },
        set(newPush: PushFn) {
          currentPush = newPush
          wrappedPush = wrapWebpackPush(newPush)
        },
      })
    },
  })
}

for (const name of CHUNK_GLOBAL_NAMES) installWebpackHook(name)

// Snapshot Lookups

function allExports(): [string, any][] {
  return Array.from(__webpackModuleRegistry.entries()).map(([id, exp]) => [
    String(id),
    exp,
  ])
}

export function getExport<T>(matcher: ExportMatcher<T>): T | undefined
export function getExport<T>(matcher: SimpleMatcher): T | undefined
export function getExport<T>(matcher: SimpleMatcher, all: true): T[]
export function getExport(matcher: SimpleMatcher, all = false) {
  const results = new Set<any>()

  for (const [_id, exports] of __webpackModuleRegistry) {
    const candidates = [exports]
    for (const key in exports) {
      if (!Object.hasOwn(exports, key)) continue
      try {
        candidates.push(exports[key])
      } catch {}
    }
    for (const candidate of candidates) {
      try {
        if (!matcher(candidate)) continue
      } catch {
        continue
      }
      if (!all) return candidate
      results.add(candidate)
    }
  }
  return all ? [...results] : undefined
}

export function getByProps<T>(props: string[]): T | undefined
export function getByProps<T>(props: string[], all: true): T[]
export function getByProps(props: string[], all = false) {
  const matcher = (exp: any) =>
    exp && typeof exp === 'object' && props.every((prop) => prop in exp)
  return all ? getExport(matcher, true) : getExport(matcher)
}
// Source Inspection

/** Get the source of a webpack module by id */
export function getModuleSource(id: PropertyKey): string {
  const factory = __webpackModuleFactories.get(String(id))
  if (!factory) throw new Error(`[Taut] No module found with id: ${String(id)}`)
  return factory.toString()
}
/** Find the id of the module that exported the given value, if any */
export function findModuleId(value: any): string | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function'))
    return undefined
  return __webpackExportOwners.get(value)
}
/**
 * Get the source of the module that exported the given value, falls back to
 * the value's own `.toString()` if no owning module can be found
 */
export function getValueSource(value: any): string {
  const id = findModuleId(value)
  if (id !== undefined) return getModuleSource(id)
  if (typeof value === 'function') return value.toString()
  throw new Error(`[Taut] Could not find a module or source for value`, {
    cause: value,
  })
}

// Debug Globals

global.__webpackModuleRegistry = __webpackModuleRegistry
global.__webpackModuleFactories = __webpackModuleFactories
global.allExports = allExports
global.getExport = getExport
global.getByProps = getByProps
global.getModuleSource = getModuleSource
global.findModuleId = findModuleId
global.getValueSource = getValueSource
