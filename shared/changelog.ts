// CHANGELOG.md once parsed (scripts/lib/changelog.ts), bundled into the app by app/bundledData.ts

/** `new` plugin, `plugin` update, `feature` of Taut itself, `fix` to the `plugin` if set, else to Taut */
export type ChangeKind = 'new' | 'plugin' | 'feature' | 'fix'

export type Change = {
  kind: ChangeKind
  /** the plugin it is about, by id */
  plugin?: string
  pluginName?: string
  /** markdown */
  text: string
}

export type Release = { version: string; changes: Change[] }
