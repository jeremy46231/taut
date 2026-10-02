// Taut Settings: the "Taut" tab in Slack's Preferences dialog

import { setStyle } from '../api/css'
import { preferencesTabs } from '../api/preferences'
import { tautVersion } from '../bundledData'
import { initMonaco } from '../cdn'
import type { ConfigStore } from '../configStore'
import type { PluginManager } from '../pluginManager'
import { reloadWithoutSafeMode } from '../safeMode'
import { patchComponentPromise, reactPromise } from '../slack/react'
import { dispatchThunk } from '../slack/redux'
import { Store } from '../store'
import type { WhatsNew } from '../whatsNew'
import { CHANGELOG_CSS, ChangelogScreen } from './changelog'
import {
  ErrorBoundary,
  elements,
  LinkButton,
  loaderName,
  PanelHost,
  SETTINGS_CSS,
  type SettingsProps,
  SlackText,
  setSettingsDeps,
} from './common'
import { CONFIG_FORM_CSS } from './configForm'
import { PLUGIN_DETAIL_CSS, PluginDetail } from './pluginDetail'
import { PLUGIN_LIST_CSS, type PluginFilter, PluginList } from './pluginList'
import {
  AboutScreen,
  AdvancedScreen,
  AppearanceScreen,
  SCREENS_CSS,
} from './screens'

export const settingsTabReady = new Store(false)

const requestedScreen = new Store<Screen | null>(null)
/** opens Preferences > Taut on `screen`, or moves an open Taut tab there */
export function openTautSettings(screen: Screen = { name: 'main' }) {
  requestedScreen.set(screen)
  if (!document.querySelector('.taut-settings'))
    dispatchThunk('openPrefsModal', { activeSection: 'advanced' })
}

export async function addSettingsTab(
  pluginManager: PluginManager,
  configStore: ConfigStore,
  whatsNew: WhatsNew
) {
  await reactPromise

  initMonaco()
  setStyle(
    `${SETTINGS_CSS}${PLUGIN_LIST_CSS}${CONFIG_FORM_CSS}${PLUGIN_DETAIL_CSS}${SCREENS_CSS}${CHANGELOG_CSS}
    .taut-settings__header {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 4px 8px;
      margin-bottom: 16px;
    }
    .taut-settings__nav {
      margin-bottom: 16px;
    }
    .taut-settings__nav .taut-settings__row-text {
      flex-direction: row;
      align-items: baseline;
      gap: 8px;
    }
    .taut-settings__row-lead {
      flex: none;
      width: 17px;
      display: inline-flex;
      color: var(--dt_color-content-sec);
    }
    .p-prefs_dialog__tabs { min-height: 0; }
    .p-prefs_dialog__menu { min-height: 0; overflow-y: auto; }
    .p-prefs_dialog__menu > * { flex-shrink: 0; }
  `,
    'settings-ui'
  )

  setSettingsDeps(await pluginManager.baseAPI)
  const patchComponent = await patchComponentPromise

  patchComponent<{
    tabs: {
      label: React.ReactElement
      content: React.ReactElement
      svgIcon: {
        name: string
      }
      id?: string
      'aria-labelledby'?: string
      'aria-label'?: string
    }[]
    onTabChange?: (id: string, e: React.UIEvent) => void
    currentTabId?: string
    collapsible?: boolean
  }>('Tabs', (OriginalTabs) => (props) => {
    const isPrefs = props.tabs[props.tabs.length - 1]?.id === 'advanced'
    const requested = requestedScreen.use()
    const added = preferencesTabs.use()
    /** which of our tabs is open */
    const [selected, setSelected] = React.useState<string | null>(() =>
      isPrefs && requested !== null ? 'taut' : null
    )
    React.useEffect(() => {
      if (isPrefs && requested) setSelected('taut')
    }, [isPrefs, requested])

    if (!isPrefs) return <OriginalTabs {...props} />

    const ours = [
      {
        id: 'taut',
        label: <>Taut</>,
        content: (
          <TautSettings
            pluginManager={pluginManager}
            configStore={configStore}
            whatsNew={whatsNew}
          />
        ),
        svgIcon: { name: 'code' },
        'aria-label': 'taut',
      },
      ...added.map((tab) => ({
        id: tab.id,
        label: <>{tab.label}</>,
        content: (
          <ErrorBoundary key={tab.id}>
            <PanelHost render={tab.render} />
          </ErrorBoundary>
        ),
        svgIcon: { name: tab.icon },
        'aria-label': tab.label,
      })),
    ]
    const isOurs = (id: string) => ours.some((tab) => tab.id === id)

    // Slack has no section for our tabs, so its own selection stays on advanced
    const handleTabChange = (id: string, e: React.UIEvent) => {
      setSelected(isOurs(id) ? id : null)
      props.onTabChange?.(isOurs(id) ? 'advanced' : id, e)
    }

    return (
      <OriginalTabs
        {...props}
        tabs={[...props.tabs, ...ours]}
        // a custom tab that went away falls back to taut
        currentTabId={
          selected === null
            ? props.currentTabId
            : isOurs(selected)
              ? selected
              : 'taut'
        }
        onTabChange={handleTabChange}
        // disable the ... menu (css fixes scrolling)
        collapsible={false}
      />
    )
  })
  settingsTabReady.set(true)
}

export type Screen =
  | { name: 'main' }
  | { name: 'changelog' }
  | { name: 'plugin'; id: string }
  | { name: 'appearance' }
  | { name: 'advanced' }
  | { name: 'about' }

/** the nearest ancestor that scrolls, which is the Preferences dialog's body */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node)
    if (overflowY === 'auto' || overflowY === 'scroll') return node
  }
  return null
}

function TautSettings(props: SettingsProps & { whatsNew: WhatsNew }) {
  const { pluginManager, whatsNew } = props
  const [screen, setScreen] = React.useState<Screen>(() => {
    const requested = requestedScreen.get()
    requestedScreen.set(null)
    return requested ?? { name: 'main' }
  })
  const [query, setQuery] = React.useState('')
  const [filter, setFilter] = React.useState<PluginFilter>('all')
  const rootRef = React.useRef<HTMLDivElement | null>(null)
  const mainScroll = React.useRef(0)

  const go = (next: Screen) => {
    const scroller = scrollParent(rootRef.current)
    if (screen.name === 'main' && scroller) {
      mainScroll.current = scroller.scrollTop
    }
    setScreen(next)
  }

  // new screens start at the top, the list comes back where it was left
  React.useLayoutEffect(() => {
    const scroller = scrollParent(rootRef.current)
    if (scroller) {
      scroller.scrollTop = screen.name === 'main' ? mainScroll.current : 0
    }
  }, [screen])

  const requested = requestedScreen.use()
  React.useEffect(() => {
    if (!requested) return
    requestedScreen.set(null)
    go(requested)
  }, [requested])

  const back = () => go({ name: 'main' })
  const openPlugin = (id: string) => go({ name: 'plugin', id })

  let content: React.ReactNode
  switch (screen.name) {
    case 'plugin':
      content = <PluginDetail {...props} id={screen.id} onBack={back} />
      break
    case 'appearance':
      content = <AppearanceScreen {...props} onBack={back} />
      break
    case 'advanced':
      content = (
        <AdvancedScreen {...props} onBack={back} onOpenPlugin={openPlugin} />
      )
      break
    case 'about':
      content = <AboutScreen {...props} onBack={back} />
      break
    case 'changelog':
      content = (
        <ChangelogScreen {...props} onBack={back} onOpenPlugin={openPlugin} />
      )
      break
    case 'main':
      content = (
        <>
          <Header
            pluginManager={pluginManager}
            whatsNew={whatsNew}
            onChangelog={() => go({ name: 'changelog' })}
          />
          <ul className="taut-settings__rows taut-settings__nav">
            {(
              [
                {
                  name: 'appearance',
                  label: 'Appearance',
                  description: 'Custom CSS',
                  icon: 'paintbrush',
                },
                {
                  name: 'advanced',
                  label: 'Advanced',
                  description: 'Safe mode, installing plugins, config.json',
                  icon: 'settings',
                },
                {
                  name: 'about',
                  label: 'About',
                  description: 'Credits',
                  icon: 'info',
                },
              ] as const
            ).map((sub) => (
              <li key={sub.name}>
                <div className="taut-settings__row">
                  <button
                    type="button"
                    className="c-button-unstyled taut-settings__row-main"
                    onClick={() => go({ name: sub.name })}
                  >
                    <span className="taut-settings__row-lead">
                      <elements.SvgIcon name={sub.icon} size={16} inline />
                    </span>
                    <span className="taut-settings__row-text">
                      <span className="taut-settings__row-name">
                        {sub.label}
                      </span>
                      <span className="taut-settings__row-description">
                        {sub.description}
                      </span>
                    </span>
                    <span className="taut-settings__row-icon">
                      <elements.SvgIcon name="caret-right" size={16} inline />
                    </span>
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <PluginList
            {...props}
            query={query}
            setQuery={setQuery}
            filter={filter}
            setFilter={setFilter}
            onOpen={openPlugin}
          />
        </>
      )
      break
  }

  return (
    <div className="taut-settings" ref={rootRef}>
      {content}
    </div>
  )
}

function Header({
  pluginManager,
  whatsNew,
  onChangelog,
}: {
  pluginManager: PluginManager
  whatsNew: WhatsNew
  onChangelog: () => void
}) {
  const bridge = pluginManager.bridge
  const unseen = whatsNew.unseen
    .use()
    .reduce((count, release) => count + release.changes.length, 0)
  return (
    <>
      <div className="taut-settings__header">
        <SlackText text={`*Taut v${tautVersion}*`} />
        <span aria-hidden="true">·</span>
        <LinkButton className="taut-settings__whats-new" onClick={onChangelog}>
          What's new
          {unseen > 0 && (
            <span className="taut-settings__whats-new-count">{unseen}</span>
          )}
        </LinkButton>
        <span aria-hidden="true">·</span>
        <span>
          {loaderName(bridge.loader)} v{bridge.loaderVersion}
        </span>
        <span aria-hidden="true">·</span>
        <SlackText text="<#C0A057686SF>" />
      </div>
      {pluginManager.safeMode && (
        <div className="taut-settings__field">
          <elements.InlineAlert>
            Safe mode: no plugins or custom CSS are running.{' '}
            <LinkButton onClick={reloadWithoutSafeMode}>
              Reload normally
            </LinkButton>
          </elements.InlineAlert>
        </div>
      )}
    </>
  )
}
