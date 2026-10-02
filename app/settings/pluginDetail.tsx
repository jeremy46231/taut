import type { DefaultConfig } from '../../shared/Plugin'
import { withDefaults } from '../pluginConfig'
import type { PluginInfo } from '../pluginManager'
import { workspace } from '../slack/workspace'
import {
  authorsMrkdwn,
  ConfigCheckbox,
  DocumentEditor,
  ErrorBoundary,
  elements,
  errorMessage,
  ImportControls,
  LinkButton,
  modal,
  PanelHost,
  type SettingsProps,
  SlackText,
  SubScreen,
  useConfig,
} from './common'
import { ConfigForm, formEntries } from './configForm'
import { pluginSchema } from './configSchema'
import { enabledSetting, pluginGroup } from './pluginList'

export const PLUGIN_DETAIL_CSS = `
  .taut-settings__detail-head {
    margin-bottom: 16px;
  }
  .taut-settings__detail-head > * + * {
    margin-top: 4px;
  }
`

type Plugin = PluginInfo[number]

export function PluginDetail({
  id,
  onBack,
  pluginManager,
  configStore,
}: SettingsProps & { id: string; onBack: () => void }) {
  const plugins = pluginManager.pluginInfoStore.use()
  const plugin = plugins.find((p) => p.id === id)

  if (!plugin?.runsHere) {
    return (
      <SubScreen title="Plugin not found" onBack={onBack} backLabel="Plugins">
        <p className="taut-settings__muted">
          {plugin
            ? `${plugin.name} only works in the Hack Club Slack.`
            : `${id} isn't installed any more.`}
        </p>
      </SubScreen>
    )
  }

  return (
    <SubScreen title={plugin.name} onBack={onBack} backLabel="Plugins">
      <PluginHeader
        plugin={plugin}
        pluginManager={pluginManager}
        configStore={configStore}
      />
      {plugin.defaultConfig && formEntries(plugin.defaultConfig).length > 0 && (
        <SettingsSection
          plugin={plugin}
          defaults={plugin.defaultConfig}
          pluginManager={pluginManager}
          configStore={configStore}
        />
      )}
      <DataSection
        plugin={plugin}
        pluginManager={pluginManager}
        configStore={configStore}
        onDeleted={onBack}
      />
    </SubScreen>
  )
}

function PluginHeader({
  plugin,
  pluginManager,
  configStore,
}: SettingsProps & { plugin: Plugin }) {
  const [path, defaultValue] = enabledSetting(plugin)
  const hackClub = workspace.useIsHackClub()
  const authors = authorsMrkdwn(plugin.authors, hackClub)
  return (
    <div className="taut-settings__detail-head">
      {plugin.description && (
        <div className="taut-settings__muted">
          <SlackText text={plugin.description} />
        </div>
      )}
      <div className="taut-settings__small">
        <elements.MrkdwnElement
          text={[
            pluginGroup(plugin),
            authors && `by ${authors}`,
            plugin.isUser && `user plugin \`${plugin.id}\``,
          ]
            .filter(Boolean)
            .join(' · ')}
        />
      </div>
      {plugin.defaultConfig && (
        <div style={{ marginTop: '12px' }}>
          <ConfigCheckbox
            configStore={configStore}
            path={path}
            defaultValue={defaultValue}
            label={`Turn on ${plugin.name}`}
          />
        </div>
      )}
      {pluginManager.safeMode && plugin.config.enabled === true && (
        <div className="taut-settings__small">
          Not running: Taut is in safe mode.
        </div>
      )}
      {plugin.error && (
        <elements.InlineAlert>{plugin.error}</elements.InlineAlert>
      )}
    </div>
  )
}

function SettingsSection({
  plugin,
  defaults,
  pluginManager,
  configStore,
}: SettingsProps & { plugin: Plugin; defaults: DefaultConfig }) {
  const [editingJson, setEditingJson] = React.useState(false)

  return (
    <>
      <hr />
      <elements.FieldSet>
        <elements.Legend>Settings</elements.Legend>
        {!editingJson && (
          <ConfigForm
            plugin={plugin}
            defaults={defaults}
            configStore={configStore}
            pluginManager={pluginManager}
          />
        )}
        {editingJson && (
          <BlockEditor
            id={plugin.id}
            defaults={defaults}
            configStore={configStore}
            onDone={() => setEditingJson(false)}
          />
        )}
        <LinkButton onClick={() => setEditingJson(!editingJson)}>
          {editingJson ? 'Back to the form' : 'Edit as JSON'}
        </LinkButton>
      </elements.FieldSet>
    </>
  )
}

/** this plugin's options as JSON, defaults filled in */
function BlockEditor({
  id,
  defaults,
  configStore,
  onDone,
}: {
  id: string
  defaults: DefaultConfig
  configStore: SettingsProps['configStore']
  onDone: () => void
}) {
  const block = useConfig(configStore).plugins[id]
  const text = React.useMemo(
    () => JSON.stringify(withDefaults(defaults, block), null, 2),
    [defaults, block]
  )
  const schema = React.useMemo(() => pluginSchema(defaults), [defaults])
  return (
    <div className="taut-settings__field">
      <DocumentEditor
        language="json"
        schema={schema}
        value={text}
        height={240}
        saveLabel="Save"
        save={async (next) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(next)
          } catch (err) {
            return `Not saved: ${errorMessage(err)}`
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return 'Not saved: expected a JSON object'
          }
          const ok = await configStore.setPluginBlock(
            id,
            parsed as Record<string, unknown>,
            JSON.parse(text)
          )
          if (!ok) return "Couldn't save config.json"
          onDone()
          return null
        }}
      />
    </div>
  )
}

function DataSection({
  plugin,
  pluginManager,
  onDeleted,
}: SettingsProps & { plugin: Plugin; onDeleted: () => void }) {
  const pluginData = pluginManager.pluginDataStore.use()
  const flags = pluginData[plugin.id]
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [replacing, setReplacing] = React.useState(false)

  const clear = async (kind: 'storage' | 'cache') => {
    const label = kind === 'storage' ? 'data' : 'cache'
    const confirmed = await modal.confirm({
      title: `Clear ${plugin.name} ${label}?`,
      body:
        kind === 'storage'
          ? `Everything ${plugin.name} has saved will be deleted, along with its cache. This can't be undone.`
          : `${plugin.name} will fetch whatever it needs again.`,
      confirmText: `Clear ${label}`,
      danger: true,
    })
    if (!confirmed) return
    setBusy(kind)
    setError(null)
    const result = await pluginManager.resetPluginNamespace(plugin.id, kind)
    setBusy(null)
    if (!result.ok) setError(`Failed to clear ${label}: ${result.error}`)
  }

  const remove = async () => {
    const confirmed = await modal.confirm({
      title: `Delete ${plugin.name}?`,
      body: "Its code and data will be deleted. This can't be undone.",
      confirmText: 'Delete',
      danger: true,
    })
    if (!confirmed) return
    setBusy('delete')
    setError(null)
    const result = await pluginManager.deleteUserPlugin(plugin.id)
    setBusy(null)
    if (result.ok) onDeleted()
    else setError(`Failed to delete: ${result.error}`)
  }

  const canEditCode = pluginManager.supportsUserPlugins && plugin.isUser

  return (
    <>
      <hr />
      <elements.FieldSet>
        <elements.Legend>Data</elements.Legend>
        {plugin.hasDataPanel &&
          (plugin.dataPanel ? (
            <ErrorBoundary key={plugin.runId}>
              <PanelHost render={plugin.dataPanel} />
            </ErrorBoundary>
          ) : (
            <p className="taut-settings__muted" style={{ marginTop: 0 }}>
              Turn it on to see its data.
            </p>
          ))}
        <p className="taut-settings__muted" style={{ marginTop: 0 }}>
          {flags?.hasStorage
            ? `${plugin.name} has saved data on this device.`
            : flags?.hasCache
              ? `${plugin.name} only has a cache, which it can rebuild.`
              : `${plugin.name} hasn't stored anything.`}
        </p>
        <div className="taut-settings__buttons">
          {flags?.hasCache && (
            <elements.Button
              type="outline"
              size="small"
              disabled={busy !== null}
              onClick={() => clear('cache')}
            >
              {busy === 'cache' ? 'Clearing...' : 'Clear cache'}
            </elements.Button>
          )}
          {flags?.hasStorage && (
            <elements.Button
              type="outline"
              size="small"
              disabled={busy !== null}
              onClick={() => clear('storage')}
            >
              {busy === 'storage' ? 'Clearing...' : 'Clear data'}
            </elements.Button>
          )}
          {canEditCode && (
            <>
              <elements.Button
                type="outline"
                size="small"
                disabled={busy !== null}
                onClick={() => setReplacing(!replacing)}
              >
                Update code
              </elements.Button>
              <elements.Button
                size="small"
                type="danger"
                disabled={busy !== null}
                onClick={remove}
              >
                {busy === 'delete' ? 'Deleting...' : 'Delete plugin'}
              </elements.Button>
            </>
          )}
        </div>
        {replacing && canEditCode && (
          <div style={{ marginTop: '12px' }}>
            <ImportControls
              pluginManager={pluginManager}
              replacingId={plugin.id}
              onDone={() => setReplacing(false)}
            />
          </div>
        )}
        {error && <elements.InlineAlert>{error}</elements.InlineAlert>}
      </elements.FieldSet>
    </>
  )
}
