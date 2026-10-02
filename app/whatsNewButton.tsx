import type { Release } from '../shared/changelog'
import { compareVersions } from '../shared/updates'
import { setStyle } from './api/css'
import { type ElementsAPI, elementsAPIPromise } from './api/elements'
import { tautVersion } from './bundledData'
import type { ConfigStore } from './configStore'
import { noticeItems, updateStatus } from './loaderUpdate'
import type { PluginManager } from './pluginManager'
import {
  ChangeList,
  NewTag,
  UpdateList,
  visibleChanges,
} from './settings/changelog'
import { elements, LinkButton, useConfig } from './settings/common'
import { openTautSettings, settingsTabReady } from './settings/index'
import { patchComponentPromise } from './slack/react'
import { Store } from './store'
import type { WhatsNew } from './whatsNew'

type Context = {
  whatsNew: WhatsNew
  pluginManager: PluginManager
  configStore: ConfigStore
}

// registered at module load, before any plugin patches HelpButton, so this wrapper is innermost (megaphone right beside Help)
Promise.all([patchComponentPromise, elementsAPIPromise]).then(
  ([patchComponent, ui]) => {
    patchComponent<Record<string, unknown>>(
      'HelpButton',
      (Original) => (props) => (
        <>
          <WhatsNewButton ui={ui} />
          <Original {...props} />
        </>
      )
    )
  }
)

const context = new Store<Context | null>(null)

/** only opens once `whatsNew` has loaded and the settings tab is added */
export function addWhatsNewButton(ctx: Context) {
  setStyle(
    `
    .taut-whats-new__container {
      margin-right: 8px;
    }
    .taut-whats-new__button {
      position: relative;
    }
    .taut-whats-new__dot {
      position: absolute;
      top: 3px;
      right: 3px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: rgba(var(--sk_raspberry_red, 224, 30, 90), 1);
      pointer-events: none;
    }
    .taut-whats-new-popover {
      width: 380px;
      max-height: min(520px, calc(100vh - 80px));
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      border-radius: 8px;
      background: var(--dt_color-base-pry);
      color: var(--dt_color-content-pry);
      box-shadow: 0 0 0 1px var(--dt_color-otl-pry, rgba(var(--sk_foreground_low, 29, 28, 29), 0.13)), 0 4px 12px 0 rgba(0, 0, 0, 0.12);
      overflow: hidden;
    }
    .taut-whats-new-popover__head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      padding: 16px 20px 4px;
    }
    .taut-whats-new-popover__title {
      margin: 0;
      font-size: 18px;
      font-weight: 900;
      line-height: 1.33;
    }
    .taut-whats-new-popover__version {
      font-size: 13px;
      color: var(--dt_color-content-sec);
    }
    .taut-whats-new-popover__body {
      overflow-y: auto;
      padding: 0 20px 12px;
    }
    .taut-whats-new-popover__section {
      margin: 12px 0 2px;
      font-size: 13px;
      font-weight: 700;
      color: var(--dt_color-content-sec);
    }
    .taut-whats-new-popover__more {
      /* lines up with the change text, past its 16px icon and 8px gap */
      padding: 3px 0 3px 24px;
      line-height: 22px;
    }
    .taut-whats-new-popover__welcome {
      margin: 0;
      color: var(--dt_color-content-sec);
    }
    .taut-whats-new-popover__foot {
      display: flex;
      justify-content: space-between;
      padding: 10px 20px 14px;
      border-top: 1px solid var(--dt_color-otl-sec, rgba(var(--sk_foreground_low, 29, 28, 29), 0.13));
    }
  `,
    'whats-new'
  )
  context.set(ctx)
}

function WhatsNewButton({ ui }: { ui: ElementsAPI }) {
  const ctx = context.use()
  return ctx ? <MegaphoneButton {...ctx} ui={ui} /> : null
}

function MegaphoneButton({
  whatsNew,
  pluginManager,
  configStore,
  ui,
}: Context & { ui: ElementsAPI }) {
  const shown = useConfig(configStore).whatsNewButton !== false
  const unseen = whatsNew.unseen.use()
  const welcome = whatsNew.welcome.use()
  const updates = noticeItems(updateStatus.use()).length
  const loaded = whatsNew.loaded.use()
  const settingsReady = settingsTabReady.use()
  const ready = loaded && settingsReady
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null)
  // hiding the button doesn't hide a needed update
  if (!shown && !updates) return null

  const nudge = unseen.length > 0 || welcome || updates > 0
  const label = updates
    ? "What's new in Taut, update available"
    : nudge
      ? "What's new in Taut, new changes"
      : "What's new in Taut"
  return (
    <div className="p-top_nav__windows_controls_container taut-whats-new__container">
      <ui.Tooltip tip="What's new in Taut" position="bottom" delay={500}>
        <button
          type="button"
          className="c-button-unstyled p-top_nav__button p-top_nav__help taut-whats-new__button"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={!!anchor}
          aria-disabled={!ready}
          onClick={(e) => {
            if (ready)
              setAnchor(anchor ? null : e.currentTarget.getBoundingClientRect())
          }}
        >
          <ui.SvgIcon name="megaphone" size={20} />
          {nudge && <span className="taut-whats-new__dot" />}
        </button>
      </ui.Tooltip>
      {anchor && (
        <WhatsNewPopover
          anchor={anchor}
          whatsNew={whatsNew}
          pluginManager={pluginManager}
          onClose={() => setAnchor(null)}
        />
      )}
    </div>
  )
}

function WhatsNewPopover({
  anchor,
  whatsNew,
  pluginManager,
  onClose,
}: {
  anchor: DOMRect
  whatsNew: WhatsNew
  pluginManager: PluginManager
  onClose: () => void
}) {
  // what was new when it opened keeps its tag until it closes
  const [{ unseen, welcomeIsNew }] = React.useState(() => ({
    unseen: new Set(whatsNew.unseen.get().map((release) => release.version)),
    welcomeIsNew: whatsNew.welcome.get(),
  }))
  const installVersion = whatsNew.installVersion.use()
  const plugins = pluginManager.pluginInfoStore.use()
  const updates = noticeItems(updateStatus.use())
  const [windowRef] = React.useState(() => new WeakRef(window))
  React.useEffect(() => {
    whatsNew.markSeen()
  }, [whatsNew])

  // newest first, with the welcome just above the version this install started on
  const releases = whatsNew.releases.filter(
    (release) => visibleChanges(release.changes, plugins).length
  )
  const entries: (Release | 'welcome')[] = [...releases]
  if (installVersion) {
    const at = releases.findIndex(
      (release) => compareVersions(release.version, installVersion) <= 0
    )
    entries.splice(at === -1 ? releases.length : at, 0, 'welcome')
  }
  const then = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return (
    <elements.Popover
      isOpen
      targetBounds={anchor}
      windowRef={windowRef}
      position="bottom-left"
      offsetY={6}
      onClose={onClose}
      ariaRole="dialog"
      ariaLabel="What's new in Taut"
    >
      <div className="taut-whats-new-popover">
        <div className="taut-whats-new-popover__head">
          <h2 className="taut-whats-new-popover__title">What's new</h2>
          <span className="taut-whats-new-popover__version">
            Taut v{tautVersion}
          </span>
        </div>
        <div className="taut-whats-new-popover__body">
          {updates.length > 0 && (
            <div>
              <div className="taut-whats-new-popover__section">
                Update available
              </div>
              <UpdateList items={updates} onAction={onClose} />
            </div>
          )}
          {entries.slice(0, 5).map((entry) => {
            if (entry === 'welcome')
              return (
                <div key="welcome">
                  <div className="taut-whats-new-popover__section">
                    Welcome to Taut
                    {welcomeIsNew && <NewTag />}
                  </div>
                  <p className="taut-whats-new-popover__welcome">
                    Turn on plugins in{' '}
                    <LinkButton onClick={then(() => openTautSettings())}>
                      Taut settings
                    </LinkButton>
                    .
                  </p>
                </div>
              )
            const changes = visibleChanges(entry.changes, plugins)
            // every new plugin, then the rest up to 6 lines
            const others = changes.filter((c) => c.kind !== 'new')
            const room = 6 - (changes.length - others.length)
            const shown = changes.filter(
              (c) => c.kind === 'new' || others.indexOf(c) < room
            )
            return (
              <div key={entry.version}>
                <div className="taut-whats-new-popover__section">
                  Taut v{entry.version}
                  {unseen.has(entry.version) && <NewTag />}
                </div>
                <ChangeList
                  changes={shown}
                  pluginManager={pluginManager}
                  onOpenPlugin={(id) =>
                    then(() => openTautSettings({ name: 'plugin', id }))()
                  }
                />
                {shown.length < changes.length && (
                  <div className="taut-whats-new-popover__more">
                    <LinkButton
                      onClick={then(() =>
                        openTautSettings({ name: 'changelog' })
                      )}
                    >
                      and {changes.length - shown.length} more...
                    </LinkButton>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div className="taut-whats-new-popover__foot">
          <LinkButton
            onClick={then(() => openTautSettings({ name: 'changelog' }))}
          >
            All changes
          </LinkButton>
          <LinkButton onClick={then(() => openTautSettings())}>
            Taut settings
          </LinkButton>
        </div>
      </div>
    </elements.Popover>
  )
}
