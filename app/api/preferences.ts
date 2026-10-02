// the Taut tab's patch of Slack's `Tabs` renders these

import { Store } from '../store'

export type PreferencesTab = {
  /** the tab's name in Preferences' list */
  label: string
  /** an `SvgIcon` name */
  icon: string
  /** the tab's content, title included, not a component so keep hooks in one it returns */
  render: () => React.ReactNode
}

/** every tab added, sorted by label, with the id Slack knows it by */
export const preferencesTabs = new Store<
  readonly (PreferencesTab & { id: string })[]
>([])

let lastId = 0

/** adds a tab to Preferences after Taut's, returns a disposer */
function addTab(tab: PreferencesTab): () => void {
  const added = { ...tab, id: `taut-tab-${++lastId}` }
  preferencesTabs.update((tabs) =>
    [...tabs, added].sort((a, b) => a.label.localeCompare(b.label))
  )
  return () => preferencesTabs.update((tabs) => tabs.filter((t) => t !== added))
}

export const preferences = { addTab }
