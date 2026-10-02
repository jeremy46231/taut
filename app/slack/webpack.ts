import type {
  Chunk,
  Exports,
  ModuleFactory,
  WebpackModule,
  WebpackRequire,
} from './webpackTypes'

const global = globalThis as any

let __webpack_require__: WebpackRequire | null = null
const __webpackModuleRegistry = new Map<PropertyKey, Exports>()

// by module id, unwrapped so `.toString()` gives the original source
const __webpackModuleFactories = new Map<string, ModuleFactory>()
// the first module to export each value, for debug
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

type ExportMatcher<T> = (exp: any) => exp is T
type SimpleMatcher = (exp: any) => boolean

/** matches a function export by its own name */
export const byName =
  (name: string): SimpleMatcher =>
  (exp) =>
    typeof exp === 'function' && exp.name === name

/** matches a function export by the `meta.name` Slack gives its selectors, thunks and actions */
export const byMeta =
  (name: string): SimpleMatcher =>
  (exp) =>
    typeof exp === 'function' && exp.meta?.name === name

function matchExportOrProps(exports: any, matcher: SimpleMatcher): any {
  try {
    if (matcher(exports)) return exports
  } catch {}
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

const pendingMatchers = new Map<
  symbol,
  { matcher: SimpleMatcher; resolve: (exp: any) => void }
>()

/** resolves once a matching export loads, right away if one has */
export function waitForExport<T>(matcher: ExportMatcher<T>): Promise<T>
export function waitForExport<T>(matcher: SimpleMatcher): Promise<T>
export function waitForExport(matcher: SimpleMatcher): Promise<any> {
  const existing = getExport(matcher)
  if (existing !== undefined) return Promise.resolve(existing)

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

const moduleLoadCallbacks: ((exports: any) => void)[] = []

export function onModuleLoaded(cb: (exports: any) => void): void {
  moduleLoadCallbacks.push(cb)
}

/** runs for every matching export, loaded now or later */
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

type ModuleExportsPatcher = (exports: any, moduleId: string) => any | undefined
const moduleExportsPatchers = new Set<ModuleExportsPatcher>()

export function patchModuleExports(patcher: ModuleExportsPatcher): void {
  moduleExportsPatchers.add(patcher)
}

type FunctionWrap = (
  original: (...args: any[]) => any
) => (...args: any[]) => any

/** `exports` rebuilt with each function export `match` accepts replaced by `replace(it)`, or undefined if none matched */
function replaceFunctionExports(
  exports: any,
  match: SimpleMatcher,
  replace: FunctionWrap
): any {
  if (!exports || typeof exports !== 'object') return
  let descriptors: PropertyDescriptorMap | undefined
  for (const key of Object.keys(exports)) {
    let value: any
    try {
      value = exports[key]
    } catch {
      continue
    }
    if (typeof value !== 'function' || !match(value)) continue
    // webpack defines namespace exports as non-configurable getters, so rebuild the whole exports object
    descriptors ??= Object.getOwnPropertyDescriptors(exports)
    descriptors[key] = {
      value: replace(value),
      enumerable: true,
      configurable: true,
      writable: true,
    }
  }
  return (
    descriptors && Object.create(Object.getPrototypeOf(exports), descriptors)
  )
}

/** wraps each exported function that `match` (like `byName('x')`) finds, as its module loads, returns a disposer */
export function patchFunctionExport(
  match: SimpleMatcher,
  wrap: FunctionWrap
): () => void {
  let active = true
  const patcher: ModuleExportsPatcher = (exports) =>
    replaceFunctionExports(
      exports,
      (value) => {
        try {
          return match(value)
        } catch {
          return false
        }
      },
      (original) => {
        const wrapped = wrap(original)
        // a loaded module keeps the export it was given, so disposing only turns the wrap off
        const patched = Object.assign(function (this: unknown, ...args: any[]) {
          return (active ? wrapped : original).apply(this, args)
        }, original)
        // keeps byName lookups finding it
        return Object.defineProperty(patched, 'name', { value: original.name })
      }
    )
  moduleExportsPatchers.add(patcher)
  return () => {
    active = false
    moduleExportsPatchers.delete(patcher)
  }
}

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
    for (const cb of moduleLoadCallbacks) {
      try {
        cb(moduleExports)
      } catch (err) {
        console.error('[Taut] Module load callback failed:', err)
      }
    }

    return result
  }

  ;(wrappedFactory as any).__tautWrapped = true
  return wrappedFactory
}

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

      wrappedPush = wrapWebpackPush(arr.push.bind(arr))

      Object.defineProperty(arr, 'push', {
        configurable: true,
        enumerable: false,
        get() {
          return wrappedPush
        },
        set(newPush: PushFn) {
          wrappedPush = wrapWebpackPush(newPush)
        },
      })
    },
  })
}

export const CHUNK_GLOBALS = [
  'webpackChunkwebapp',
  'rspackChunkwebapp',
  'rspackChunkGantryV2',
]
export const slackLoadedFirst = CHUNK_GLOBALS.some((name) => global[name])
// if slackLoadedFirst, app/main.ts will handle it
if (!slackLoadedFirst)
  for (const name of CHUNK_GLOBALS) installWebpackHook(name)

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

export function getModuleSource(id: PropertyKey): string {
  const factory = __webpackModuleFactories.get(String(id))
  if (!factory) throw new Error(`[Taut] No module found with id: ${String(id)}`)
  return factory.toString()
}
/** `[id, source]` of every module defined so far, for searching the bundle */
export function* getModuleSources(): Generator<[string, string]> {
  for (const [id, factory] of __webpackModuleFactories) {
    yield [id, factory.toString()]
  }
}
export function findModuleId(value: any): string | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function'))
    return undefined
  return __webpackExportOwners.get(value)
}
/** falls back to the value's own `.toString()` without an owning module */
export function getValueSource(value: any): string {
  const id = findModuleId(value)
  if (id !== undefined) return getModuleSource(id)
  if (typeof value === 'function') return value.toString()
  throw new Error(`[Taut] Could not find a module or source for value`, {
    cause: value,
  })
}

global.__webpackModuleRegistry = __webpackModuleRegistry
global.__webpackModuleFactories = __webpackModuleFactories
global.allExports = allExports
global.getExport = getExport
global.getByProps = getByProps
global.getModuleSource = getModuleSource
global.findModuleId = findModuleId
global.getValueSource = getValueSource
