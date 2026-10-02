// Taut Settings: the main screen's searchable, grouped plugin list

import { PLUGIN_CATEGORIES } from '../../shared/Plugin'
import type { ConfigStore } from '../configStore'
import { unwrapDefaults } from '../pluginConfig'
import type { PluginInfo } from '../pluginManager'
import { workspace } from '../slack/workspace'
import {
  elements,
  plainMrkdwn,
  type SettingsProps,
  useConfigValue,
} from './common'

export const PLUGIN_LIST_CSS = `
  .taut-settings__filters {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 12px 0 8px;
  }
  .taut-settings__group {
    margin-top: 20px;
  }
  .taut-settings__group-title {
    margin: 0 0 4px;
    font-size: 15px;
    font-weight: 700;
  }
  .taut-settings__rows {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .taut-settings__row {
    display: flex;
    align-items: center;
    gap: 8px;
    border-radius: 6px;
  }
  .taut-settings__row .c-input_checkbox,
  .taut-settings__row-spacer {
    flex: none;
    margin: 0 0 0 4px;
  }
  /* where a checkbox would be, so names line up */
  .taut-settings__row-spacer {
    width: 13px;
  }
  .taut-settings__row-main {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 4px;
    border-radius: 6px;
    text-align: left;
    cursor: pointer;
  }
  button.taut-settings__row-main:hover {
    background: var(--dt_color-surf-ter, rgba(var(--sk_foreground_min, 29, 28, 29), 0.04));
  }
  .taut-settings__row-text {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .taut-settings__row-name,
  .taut-settings__row-description {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .taut-settings__row-name {
    font-weight: 700;
    line-height: 20px;
  }
  .taut-settings__row-description {
    font-size: 13px;
    line-height: 18px;
    color: var(--dt_color-content-sec);
  }
  .taut-settings__row-icon {
    flex: none;
    display: inline-flex;
    color: var(--dt_color-content-ter);
  }
  .taut-settings__row-icon--warning {
    color: var(--dt_color-content-imp, #e01e5a);
  }
  .taut-settings__row-alert {
    margin: -4px 0 4px 28px;
  }
`

type Plugin = PluginInfo[number]

export type PluginFilter = 'all' | 'enabled' | 'disabled' | 'hack-club' | 'user'

/** the heading a plugin is listed under */
export function pluginGroup(
  plugin: Pick<Plugin, 'category' | 'isUser'>
): string {
  const categories: Record<string, string> = PLUGIN_CATEGORIES
  if (plugin.category && Object.hasOwn(categories, plugin.category)) {
    return categories[plugin.category]
  }
  return plugin.isUser ? 'User plugins' : 'Other'
}

export function enabledSetting(
  plugin: Plugin
): [path: string[], defaultValue: boolean] {
  const defaults = plugin.defaultConfig
  return [
    ['plugins', plugin.id, 'enabled'],
    defaults ? unwrapDefaults(defaults).enabled === true : false,
  ]
}

export function PluginList({
  pluginManager,
  configStore,
  query,
  setQuery,
  filter,
  setFilter,
  onOpen,
}: SettingsProps & {
  query: string
  setQuery: (query: string) => void
  filter: PluginFilter
  setFilter: (filter: PluginFilter) => void
  onOpen: (id: string) => void
}) {
  const plugins = pluginManager.pluginInfoStore
    .use()
    .filter((plugin) => plugin.runsHere)
  const hackClub = workspace.useIsHackClub()

  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  const shown = plugins.filter((plugin) => {
    if (filter === 'enabled' && plugin.config.enabled !== true) return false
    if (filter === 'disabled' && plugin.config.enabled === true) return false
    if (filter === 'hack-club' && !plugin.hackClubOnly) {
      return false
    }
    if (filter === 'user' && !plugin.isUser) return false
    const haystack = [
      plugin.name,
      plugin.id,
      plugin.description,
      pluginGroup(plugin),
    ]
      .join(' ')
      .toLowerCase()
    return words.every((word) => haystack.includes(word))
  })

  const groups = new Map<string, React.ReactNode[]>()
  const add = (group: string, row: React.ReactNode) =>
    groups.set(group, [...(groups.get(group) ?? []), row])
  for (const plugin of shown) {
    add(
      pluginGroup(plugin),
      <PluginRow
        key={plugin.id}
        plugin={plugin}
        configStore={configStore}
        onOpen={() => onOpen(plugin.id)}
      />
    )
  }
  const order: string[] = [
    ...Object.values(PLUGIN_CATEGORIES),
    'User plugins',
    'Other',
  ]
  const ordered = [...groups].sort(
    ([a], [b]) => order.indexOf(a) - order.indexOf(b)
  )

  return (
    <div>
      <div className="taut-settings__search">
        <elements.FormTextInput
          value={query}
          onChange={setQuery}
          placeholder="Search plugins"
          autoComplete="off"
        />
      </div>
      <div className="taut-settings__filters">
        {(
          [
            { id: 'all', label: 'All' },
            { id: 'enabled', label: 'Enabled' },
            { id: 'disabled', label: 'Disabled' },
            { id: 'hack-club', label: 'Hack Club only' },
            { id: 'user', label: 'User plugins' },
          ] satisfies { id: PluginFilter; label: string }[]
        )
          .filter(
            (option) =>
              (option.id !== 'user' || plugins.some((p) => p.isUser)) &&
              (option.id !== 'hack-club' || hackClub)
          )
          .map((option) => (
            <elements.FilterPill
              key={option.id}
              isActive={filter === option.id}
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </elements.FilterPill>
          ))}
      </div>
      {ordered.length === 0 && (
        <p className="taut-settings__muted">
          No plugins match{query ? ` "${query}"` : ' this filter'}.
        </p>
      )}
      {ordered.map(([group, rows]) => (
        <section className="taut-settings__group" key={group}>
          <h3 className="taut-settings__group-title">{group}</h3>
          <ul className="taut-settings__rows">{rows}</ul>
        </section>
      ))}
    </div>
  )
}

function PluginRow({
  plugin,
  configStore,
  onOpen,
}: {
  plugin: Plugin
  configStore: ConfigStore
  onOpen: () => void
}) {
  const { value, error, set } = useConfigValue(
    configStore,
    ...enabledSetting(plugin)
  )
  const warning =
    plugin.error || Object.keys(plugin.problems).length
      ? 'Needs attention'
      : null
  const description = plugin.error ?? plainMrkdwn(plugin.description)

  return (
    <li>
      <div className="taut-settings__row">
        {plugin.defaultConfig ? (
          <elements.Checkbox
            checked={value}
            aria-label={`Enable ${plugin.name}`}
            onChange={(e) => set(e.target.checked)}
          />
        ) : (
          <span className="taut-settings__row-spacer" />
        )}
        <button
          type="button"
          className="c-button-unstyled taut-settings__row-main"
          onClick={onOpen}
          title={description}
        >
          <span className="taut-settings__row-text">
            <span className="taut-settings__row-name">{plugin.name}</span>
            {description && (
              <span className="taut-settings__row-description">
                {description}
              </span>
            )}
          </span>
          {warning && (
            <span
              className="taut-settings__row-icon taut-settings__row-icon--warning"
              title={warning}
            >
              <elements.SvgIcon name="warning" size={16} inline />
            </span>
          )}
          <span className="taut-settings__row-icon">
            <elements.SvgIcon name="caret-right" size={16} inline />
          </span>
        </button>
      </div>
      {error && (
        <div className="taut-settings__row-alert">
          <elements.InlineAlert>{error}</elements.InlineAlert>
        </div>
      )}
    </li>
  )
}
