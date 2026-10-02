import path from 'node:path'

export const ROOT = path.resolve(import.meta.dirname, '..', '..')
export const APP = path.join(ROOT, 'app')
export const PLUGINS = path.join(ROOT, 'plugins')
export const SHARED = path.join(ROOT, 'shared')
export const ASSETS = path.join(ROOT, 'assets')
export const EXTENSION = path.join(ROOT, 'extension')
export const USERSCRIPT = path.join(ROOT, 'userscript')
export const DESKTOP = path.join(ROOT, 'desktop')
export const SERVER = path.join(ROOT, 'server')

export const DIST = path.join(ROOT, 'dist')
export const TAUT_JS = path.join(DIST, 'taut.js')
export const TAUT_DEBUG_JS = path.join(DIST, 'taut.debug.js')
export const SERVER_VERSIONS = path.join(DIST, 'server-versions.json')
