import type { Release } from '../shared/changelog'

declare const __TAUT_BUNDLED_PLUGINS__: Record<string, string>
declare const __TAUT_VERSION__: string
declare const __TAUT_CHANGELOG__: Release[]

export const bundledPlugins: Record<string, string> = __TAUT_BUNDLED_PLUGINS__
export const tautVersion: string = __TAUT_VERSION__
export const changelog: Release[] = __TAUT_CHANGELOG__
