// Taut Settings: the What's new screen, and the change list the What's new popover shares

import type { Change, Release } from '../../shared/changelog'
import { noticeItems, type UpdateItem, updateStatus } from '../loaderUpdate'
import type { PluginInfo, PluginManager } from '../pluginManager'
import type { WhatsNew } from '../whatsNew'
import { elements, type SettingsProps, SubScreen } from './common'

export const CHANGELOG_CSS = `
  .taut-changes {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .taut-changes__item {
    display: flex;
    gap: 8px;
    padding: 3px 0;
    line-height: 22px;
  }
  .taut-changes__icon {
    flex: none;
    display: flex;
    align-items: center;
    height: 1lh;
    color: var(--dt_color-content-ter);
  }
  .taut-changes__icon svg {
    display: block;
  }
  .taut-changes__item--new .taut-changes__icon {
    color: var(--dt_color-content-hgl-1, rgba(var(--sk_highlight, 18, 100, 163), 1));
  }
  .taut-changes__body {
    flex: 1 1 auto;
    min-width: 0;
    color: var(--dt_color-content-sec);
  }
  .taut-changes__body .p-rich_text_section,
  .taut-changes__body .p-mrkdwn_element {
    display: inline;
  }
  .taut-changes__plugin {
    font-weight: 700;
    color: var(--dt_color-content-pry);
  }
  button.taut-changes__plugin:hover {
    text-decoration: underline;
  }
  .taut-changes__tag {
    margin-left: 6px;
    vertical-align: 1px;
  }
  .taut-changelog__release + .taut-changelog__release {
    margin-top: 20px;
  }
  .taut-updates {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .taut-updates__item {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 8px;
    min-height: 32px;
  }
  .taut-updates__what {
    min-width: 0;
    color: var(--dt_color-content-sec);
  }
  .taut-updates__item > :last-child {
    flex: none;
  }
  button.taut-updates__command {
    max-width: 100%;
    text-align: left;
    cursor: copy;
  }
  .taut-settings__whats-new {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .taut-settings__whats-new-count {
    min-width: 18px;
    padding: 0 5px;
    box-sizing: border-box;
    border-radius: 9px;
    background: rgba(var(--sk_raspberry_red, 224, 30, 90), 1);
    color: #fff;
    font-size: 12px;
    font-weight: 700;
    line-height: 18px;
    text-align: center;
  }
`

export function markdownToMrkdwn(text: string): string {
  // code spans are left exactly as written
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>')
            .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, '$1_$2_')
            .replace(/\*\*([^*]+)\*\*/g, '*$1*')
            .replace(/~~([^~]+)~~/g, '~$1~')
    )
    .join('')
}

export function visibleChanges(
  changes: Change[],
  plugins: PluginInfo
): Change[] {
  return changes.filter(
    (change) =>
      !change.plugin ||
      plugins.find((p) => p.id === change.plugin)?.runsHere !== false
  )
}

function ChangeLine({
  change,
  plugins,
  onOpenPlugin,
  tagNewPlugins,
}: {
  change: Change
  plugins: PluginInfo
  onOpenPlugin?: (id: string) => void
  tagNewPlugins: boolean
}) {
  const plugin = change.plugin
    ? plugins.find((p) => p.id === change.plugin)
    : undefined
  const name = plugin?.name ?? change.pluginName
  const icon = { new: 'plus', plugin: 'plug', feature: 'sparkles', fix: 'bug' }[
    change.kind
  ]
  return (
    <li className={`taut-changes__item taut-changes__item--${change.kind}`}>
      <span className="taut-changes__icon">
        <elements.SvgIcon name={icon} size={16} />
      </span>
      <span className="taut-changes__body">
        {name &&
          (plugin && onOpenPlugin ? (
            <button
              type="button"
              className="c-button-unstyled taut-changes__plugin"
              onClick={() => onOpenPlugin(plugin.id)}
            >
              {name}
            </button>
          ) : (
            <span className="taut-changes__plugin">{name}</span>
          ))}
        {change.kind === 'new' && tagNewPlugins && (
          <span className="taut-changes__tag">
            <elements.Tag style="informative" isMicro>
              New plugin
            </elements.Tag>
          </span>
        )}
        {name && ' '}
        <elements.MrkdwnElement text={markdownToMrkdwn(change.text)} />
      </span>
    </li>
  )
}

export function ChangeList({
  changes,
  pluginManager,
  onOpenPlugin,
  tagNewPlugins = true,
}: {
  changes: Change[]
  pluginManager: PluginManager
  onOpenPlugin?: (id: string) => void
  /** false where a heading already says they are new plugins */
  tagNewPlugins?: boolean
}) {
  const plugins = pluginManager.pluginInfoStore.use()
  return (
    <ul className="taut-changes">
      {visibleChanges(changes, plugins).map((change, i) => (
        <ChangeLine
          key={i}
          change={change}
          plugins={plugins}
          onOpenPlugin={onOpenPlugin}
          tagNewPlugins={tagNewPlugins}
        />
      ))}
    </ul>
  )
}

/** what's out of date, one row each with its one action */
export function UpdateList({
  items,
  onAction,
}: {
  items: UpdateItem[]
  /** after an action runs, e.g. to close a popover */
  onAction?: () => void
}) {
  return (
    <ul className="taut-updates">
      {items.map(({ what, latest, action }) => (
        <li className="taut-updates__item" key={what}>
          <span className="taut-updates__what">
            {what} v{latest}
          </span>
          {action.command ? (
            <button
              type="button"
              className="c-button-unstyled taut-updates__command"
              title="Copy"
              onClick={() => action.run?.()}
            >
              <code>{action.label}</code>
            </button>
          ) : action.run ? (
            <elements.Button
              type="primary"
              size="small"
              onClick={() => {
                action.run?.()
                onAction?.()
              }}
            >
              {action.label}
            </elements.Button>
          ) : (
            <a
              className="c-link"
              href={action.href}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onAction}
            >
              {action.label}
            </a>
          )}
        </li>
      ))}
    </ul>
  )
}

export function ChangelogScreen({
  pluginManager,
  whatsNew,
  onBack,
  onOpenPlugin,
}: SettingsProps & {
  whatsNew: WhatsNew
  onBack: () => void
  onOpenPlugin: (id: string) => void
}) {
  // what was new when the screen opened keeps its tag until it closes
  const [unseen] = React.useState(
    () => new Set(whatsNew.unseen.get().map((release) => release.version))
  )
  React.useEffect(() => {
    whatsNew.markSeen()
  }, [whatsNew])
  const plugins = pluginManager.pluginInfoStore.use()
  const updates = noticeItems(updateStatus.use())
  const releases = whatsNew.releases.filter(
    (release: Release) => visibleChanges(release.changes, plugins).length
  )
  return (
    <SubScreen title="What's new" onBack={onBack}>
      {updates.length > 0 && (
        <div className="taut-changelog__release">
          <elements.FieldSet>
            <elements.Legend>Update available</elements.Legend>
            <UpdateList items={updates} />
          </elements.FieldSet>
        </div>
      )}
      {releases.length === 0 && (
        <p className="taut-settings__muted">No changes to show.</p>
      )}
      {releases.map((release) => (
        <div className="taut-changelog__release" key={release.version}>
          <elements.FieldSet>
            <elements.Legend>
              Taut v{release.version}
              {unseen.has(release.version) && (
                <span className="taut-changes__tag">
                  <elements.Tag style="informative" isMicro>
                    New
                  </elements.Tag>
                </span>
              )}
            </elements.Legend>
            <ChangeList
              changes={release.changes}
              pluginManager={pluginManager}
              onOpenPlugin={onOpenPlugin}
            />
          </elements.FieldSet>
        </div>
      ))}
      <p className="taut-settings__small">
        <elements.MrkdwnElement text="Older changes are in <https://github.com/jeremy46231/taut/blob/main/CHANGELOG.md|CHANGELOG.md> on GitHub." />
      </p>
    </SubScreen>
  )
}
