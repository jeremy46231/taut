// Taut Settings Tab
// Adds a "Taut" tab to Slack's Preferences dialog
// Shows installed plugins, config info, and credits

import { setStyle } from './api/css'
import { type ElementsAPI, elementsAPIPromise } from './api/elements'
import { type ModalAPI, modalAPIPromise } from './api/modal'
import { tautVersion } from './bundledData'
import { initMonaco, type Monaco } from './cdn'
import type { ConfigStore } from './configStore'
import type { PluginInfo, PluginManager } from './pluginManager'
import { patchComponentPromise, reactPromise } from './slack/react'

type MonacoEditorInstance = ReturnType<Monaco['editor']['create']>

let elements: ElementsAPI
let modal: ModalAPI

const SETTINGS_UI_CSS = `
  .taut-inline-input {
    margin-bottom: 0 !important;
  }
`

export async function addSettingsTab(
  pluginManager: PluginManager,
  configStore: ConfigStore
) {
  await reactPromise

  void initMonaco()
  setStyle('settings-ui', SETTINGS_UI_CSS)

  const [resolvedElements, resolvedModal] = await Promise.all([
    elementsAPIPromise,
    modalAPIPromise,
  ])
  elements = resolvedElements
  modal = resolvedModal
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
  }>('Tabs', (OriginalTabs) => (props) => {
    const [isTautSelected, setIsTautSelected] = React.useState(false)

    const tabs = [...props.tabs]
    if (tabs[tabs.length - 1]?.id === 'advanced') {
      tabs.push({
        id: 'taut',
        label: <>Taut</>,
        content: (
          <TautSettings
            pluginManager={pluginManager}
            configStore={configStore}
          />
        ),
        svgIcon: { name: 'code' },
        'aria-label': 'taut',
      })
    }

    const handleTabChange = (id: string, e: React.UIEvent) => {
      if (id === 'taut') {
        setIsTautSelected(true)
        if (props.onTabChange) props.onTabChange('advanced', e)
      } else {
        setIsTautSelected(false)
        if (props.onTabChange) props.onTabChange(id, e)
      }
    }

    const activeTabId = isTautSelected ? 'taut' : props.currentTabId

    return (
      <OriginalTabs
        {...props}
        tabs={tabs}
        currentTabId={activeTabId}
        onTabChange={handleTabChange}
      />
    )
  })
}

const LOADER_DISPLAY_NAMES: Record<string, string> = {
  'chrome-extension': 'Chrome extension',
  'firefox-extension': 'Firefox extension',
  electron: 'Desktop',
  userscript: 'Userscript',
}

function TautSettings({
  pluginManager,
  configStore,
}: {
  pluginManager: PluginManager
  configStore: ConfigStore
}) {
  const bridge = window.TautBridge
  const paths = bridge.PATHS
  const loaderName = LOADER_DISPLAY_NAMES[bridge.loader] ?? bridge.loader

  return (
    <div>
      <div
        style={{
          fontWeight: 'bold',
          marginBottom: '8px',
        }}
      >
        Taut Settings
      </div>
      <elements.MrkdwnElement
        text={`<#C0A057686SF> v${tautVersion} | ${loaderName} v${bridge.loaderVersion} | <https://github.com/jeremy46231/taut|Repository>`}
      />
      {paths && (
        <elements.MrkdwnElement
          text={`Config Directory: \`${paths.display.tautDir}\``}
        />
      )}
      <hr />
      <PluginList pluginManager={pluginManager} configStore={configStore} />
      <hr />
      <div style={{ marginTop: '16px' }}>
        <div style={{ fontWeight: 'bold', marginBottom: '8px' }}>
          Edit Configuration
        </div>
        <ConfigEditor configStore={configStore} />
        <div style={{ height: '24px' }} />
        <UserCssEditor configStore={configStore} />
      </div>
      <hr />
      <elements.MrkdwnElement text="Created by <@U06UYA5GMB5>, <https://github.com/jeremy46231/taut#credits|credits>" />
    </div>
  )
}

function ConfigEditor({ configStore }: { configStore: ConfigStore }) {
  const [text, setText] = React.useState<string>('')
  const [dirty, setDirty] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const bridge = window.TautBridge
  const paths = bridge.PATHS

  React.useEffect(() => {
    setText(configStore.getConfigText())
  }, [])

  React.useEffect(() => {
    return configStore.onConfigTextChange((newText) => {
      if (!dirty) {
        setText(newText)
      }
    })
  }, [dirty])

  const handleSave = async () => {
    setSaving(true)
    await configStore.updateConfigText(text)
    setDirty(false)
    setSaving(false)
  }

  return (
    <div>
      {paths && (
        <elements.MrkdwnElement text={`Editing \`${paths.display.config}\``} />
      )}
      {!paths && (
        <elements.MrkdwnElement
          text={`Editing config (stored in ${LOADER_DISPLAY_NAMES[bridge.loader] ?? bridge.loader} storage)`}
        />
      )}
      <MonacoEditor
        language="json"
        value={text}
        onChange={(newText) => {
          setText(newText)
          setDirty(true)
        }}
        style={{ height: '300px', marginTop: '8px' }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: '8px',
        }}
      >
        <elements.Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving...' : 'Save config.jsonc'}
        </elements.Button>
        <div style={{ fontSize: '12px', color: 'var(--sk_foreground_low)' }}>
          {dirty ? 'Unsaved changes' : 'Saved'}
        </div>
      </div>
    </div>
  )
}

function UserCssEditor({ configStore }: { configStore: ConfigStore }) {
  const [text, setText] = React.useState<string>('')
  const [dirty, setDirty] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const bridge = window.TautBridge
  const paths = bridge.PATHS

  React.useEffect(() => {
    setText(configStore.getUserCssText())
  }, [])

  React.useEffect(() => {
    return configStore.onUserCssChange((newText) => {
      if (!dirty) {
        setText(newText)
      }
    })
  }, [dirty])

  const handleSave = async () => {
    setSaving(true)
    await configStore.updateUserCssText(text)
    setDirty(false)
    setSaving(false)
  }

  return (
    <div>
      {paths && (
        <elements.MrkdwnElement text={`Editing \`${paths.display.userCss}\``} />
      )}
      {!paths && (
        <elements.MrkdwnElement
          text={`Editing user.css (stored in ${LOADER_DISPLAY_NAMES[bridge.loader] ?? bridge.loader} storage)`}
        />
      )}
      <MonacoEditor
        language="css"
        value={text}
        onChange={(newText) => {
          setText(newText)
          setDirty(true)
        }}
        style={{ height: '300px', marginTop: '8px' }}
      />
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginTop: '8px',
        }}
      >
        <elements.Button onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving...' : 'Save user.css'}
        </elements.Button>
        <div style={{ fontSize: '12px', color: 'var(--sk_foreground_low)' }}>
          {dirty ? 'Unsaved changes' : 'Saved'}
        </div>
      </div>
    </div>
  )
}

interface EditorProps {
  language?: 'json' | 'css'
  value: string
  onChange: (value: string) => void
}

function MonacoEditor({
  language,
  value,
  onChange,
  style,
  ...props
}: EditorProps &
  Omit<React.HTMLAttributes<HTMLDivElement>, keyof EditorProps>) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const editorRef = React.useRef<MonacoEditorInstance | null>(null)
  const valueRef = React.useRef(value)
  /** if the editor is currently updating its value externally, so don't fire onChange */
  const isUpdatingRef = React.useRef(false)
  const [loading, setLoading] = React.useState(true)

  React.useEffect(() => {
    valueRef.current = value
  }, [value])

  React.useEffect(() => {
    if (!containerRef.current) return
    let cancelled = false
    let cleanup = () => {}

    ;(async () => {
      const monaco = await initMonaco()
      if (cancelled || !containerRef.current) return

      const editor = monaco.editor.create(containerRef.current, {
        value: valueRef.current,
        language,
        automaticLayout: true,
        theme: 'taut',
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        tabSize: 2,
      })
      editorRef.current = editor
      setLoading(false)

      const sub = editor.onDidChangeModelContent(() => {
        if (isUpdatingRef.current) return
        onChange(editor.getValue())
      })

      cleanup = () => {
        sub.dispose()
        editor.dispose()
        editorRef.current = null
      }
    })()

    return () => {
      cancelled = true
      cleanup()
    }
  }, [language])

  React.useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    if (editor.getValue() !== value) {
      const position = editor.getPosition()
      isUpdatingRef.current = true
      editor.setValue(value)
      if (position) editor.setPosition(position)
      isUpdatingRef.current = false
    }
  }, [value])

  return (
    <div style={style} {...props}>
      {loading && (
        <div
          style={{
            padding: '8px',
            fontSize: '12px',
            color: 'var(--sk_foreground_low)',
          }}
        >
          Monaco loading...
        </div>
      )}
      <div ref={containerRef} style={{ height: loading ? '0' : '100%' }} />
    </div>
  )
}

function PluginList({
  pluginManager,
  configStore,
}: {
  pluginManager: PluginManager
  configStore: ConfigStore
}) {
  const pluginInfo = pluginManager.pluginInfoStore.use()

  return (
    <>
      <div
        style={{ marginTop: '16px', marginBottom: '8px', fontWeight: 'bold' }}
      >
        Installed Plugins:
      </div>
      <ul style={{ marginLeft: '0' }}>
        {pluginInfo.map((info) => (
          <PluginRow
            key={info.id}
            info={info}
            pluginManager={pluginManager}
            configStore={configStore}
          />
        ))}
      </ul>
      {pluginManager.supportsUserPlugins && (
        <div style={{ marginTop: '8px' }}>
          <div style={{ fontWeight: 'bold' }}>Add a plugin</div>
          <div style={{ marginTop: '8px' }}>
            <ImportControls pluginManager={pluginManager} />
          </div>
        </div>
      )}
    </>
  )
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{ color: 'var(--sk_raspberry_red, #e01e5a)', fontSize: '12px' }}
    >
      {children}
    </div>
  )
}

function PluginRow({
  info,
  pluginManager,
  configStore,
}: {
  info: PluginInfo[number]
  pluginManager: PluginManager
  configStore: ConfigStore
}) {
  const [pendingEnabled, setPendingEnabled] = React.useState<boolean | null>(
    null
  )
  const [toggleError, setToggleError] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState(false)
  const [deleteError, setDeleteError] = React.useState<string | null>(null)
  const [clearing, setClearing] = React.useState<'storage' | 'cache' | null>(
    null
  )
  const [clearError, setClearError] = React.useState<string | null>(null)
  const pluginData = pluginManager.pluginDataStore.use()
  const flags = pluginData[info.id]

  React.useEffect(() => {
    if (pendingEnabled !== null && info.enabled === pendingEnabled) {
      setPendingEnabled(null)
    }
  }, [info.enabled, pendingEnabled])

  // Any in-flight operation on this plugin, prevent race conditions
  const busy = pendingEnabled !== null || deleting || clearing !== null

  const handleToggle = async (enabled: boolean) => {
    setPendingEnabled(enabled)
    setToggleError(null)
    const success = await configStore.setPluginEnabled(info.id, enabled)
    if (!success) {
      setToggleError('Failed to save config change')
      setPendingEnabled(null)
    } else {
      setTimeout(() => {
        setPendingEnabled((cur) => (cur === enabled ? null : cur))
      }, 5000)
    }
  }

  const handleDelete = async () => {
    const confirmed = await modal.confirm({
      title: `Delete ${info.name}?`,
      body: 'This will permanently delete the user plugin and its stored data.',
      confirmText: 'Delete',
      danger: true,
    })
    if (!confirmed) return

    setDeleting(true)
    setDeleteError(null)
    const result = await pluginManager.deleteUserPlugin(info.id)
    setDeleting(false)
    if (!result.ok) setDeleteError(`Failed to delete: ${result.error}`)
  }

  const handleClear = async (kind: 'storage' | 'cache') => {
    const label = kind === 'storage' ? 'data' : 'cache'
    const confirmed = await modal.confirm({
      title: `Clear ${info.name} ${label}?`,
      body: `This will permanently clear this plugin's ${label}.`,
      confirmText: `Clear ${label}`,
      danger: true,
    })
    if (!confirmed) return

    setClearing(kind)
    setClearError(null)
    const result = await pluginManager.resetPluginNamespace(info.id, kind)
    setClearing(null)
    if (!result.ok) {
      setClearError(
        `Failed to clear ${kind === 'storage' ? 'data' : 'cache'}: ${result.error}`
      )
    }
  }

  const openEditor = () => {
    let handle: ReturnType<ModalAPI['openModal']> = null
    handle = modal.openModal({
      title: `Edit ${info.name}`,
      body: (
        <ImportControls
          pluginManager={pluginManager}
          replacingId={info.id}
          onDone={() => handle?.close()}
        />
      ),
      submitText: 'Close',
      showCancelButton: false,
    })
  }

  return (
    <li style={{ marginBottom: '12px', listStyle: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'start', gap: '8px' }}>
        <label
          style={{ display: 'flex', alignItems: 'start', flex: '1 1 auto' }}
        >
          <input
            type="checkbox"
            checked={pendingEnabled ?? info.enabled}
            disabled={busy}
            onChange={(e) => handleToggle(e.target.checked)}
            className="c-input_checkbox"
            style={{ marginRight: '8px', marginTop: '5px' }}
          />
          <div>
            <span style={{ fontWeight: 'bold' }}>{info.name}</span>{' '}
            {info.isUser && (
              <span
                style={{
                  fontWeight: 'normal',
                  color: 'var(--sk_foreground_low)',
                }}
              >
                ({info.id})
              </span>
            )}
            <div>
              <elements.MrkdwnElement text={info.description} />
            </div>
            <div>
              <small>
                <elements.MrkdwnElement text={`Authors: ${info.authors}`} />
              </small>
            </div>
            {toggleError && <ErrorLine>{toggleError}</ErrorLine>}
            {deleteError && <ErrorLine>{deleteError}</ErrorLine>}
            {clearError && <ErrorLine>{clearError}</ErrorLine>}
          </div>
        </label>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <elements.Tooltip tip="Clear cache">
              <elements.Button
                size="medium"
                className="c-button--icon"
                aria-label="Clear cache"
                disabled={busy || !flags?.hasCache}
                onClick={() => handleClear('cache')}
              >
                <elements.SvgIcon name="refresh" size={16} inline />
              </elements.Button>
            </elements.Tooltip>
            <elements.Tooltip tip="Clear data">
              <elements.Button
                size="medium"
                type="danger"
                className="c-button--icon"
                aria-label="Clear data"
                disabled={busy || !flags?.hasStorage}
                onClick={() => handleClear('storage')}
              >
                <elements.SvgIcon name="clear" size={16} inline />
              </elements.Button>
            </elements.Tooltip>

            {pluginManager.supportsUserPlugins && info.isUser && (
              <>
                <elements.Tooltip tip="Edit plugin">
                  <elements.Button
                    size="medium"
                    className="c-button--icon"
                    aria-label="Edit plugin"
                    disabled={busy}
                    onClick={openEditor}
                  >
                    <elements.SvgIcon name="edit" size={16} inline />
                  </elements.Button>
                </elements.Tooltip>
                <elements.Tooltip tip="Delete plugin">
                  <elements.Button
                    size="medium"
                    className="c-button--icon"
                    type="danger"
                    aria-label="Delete plugin"
                    disabled={busy}
                    onClick={handleDelete}
                  >
                    <elements.SvgIcon name="trash" size={16} inline />
                  </elements.Button>
                </elements.Tooltip>
              </>
            )}
          </div>
        </div>
      </div>
    </li>
  )
}

function ImportControls({
  pluginManager,
  replacingId,
  onDone,
}: {
  pluginManager: PluginManager
  replacingId?: string
  onDone?: () => void
}) {
  const bridge = window.TautBridge
  const [url, setUrl] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const run = async (getCode: () => Promise<string>) => {
    setBusy(true)
    setError(null)
    try {
      const code = await getCode()
      const result = await pluginManager.installUserPlugin(code, replacingId)
      if (!result.ok) {
        setError(result.error)
        return
      }
      setUrl('')
      onDone?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pickFile = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.js,text/javascript,application/javascript'
    input.onchange = () => {
      const file = input.files?.[0]
      if (file) run(() => file.text())
    }
    input.click()
  }

  const importUrl = () => {
    const urlString = url.trim()
    if (!urlString) return
    run(async () => {
      const res = await bridge.fetch(urlString)
      if (!res.ok) throw new Error(`Failed to fetch (HTTP ${res.status})`)
      return res.text()
    })
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <elements.Button size="small" onClick={pickFile} disabled={busy}>
          Choose file...
        </elements.Button>
        <div style={{ flex: '1 1 auto' }}>
          <elements.FormTextInput
            size="small"
            className="taut-inline-input"
            value={url}
            placeholder="or paste a URL to a .js file"
            onChange={setUrl}
            onKeyDown={(e) => {
              if (e.key === 'Enter') importUrl()
            }}
            isDisabled={busy}
          />
        </div>
        <elements.Button
          size="small"
          onClick={importUrl}
          disabled={busy || !url.trim()}
        >
          {busy ? 'Importing...' : 'Import URL'}
        </elements.Button>
      </div>
      {error && (
        <div
          style={{
            marginTop: '4px',
            color: 'var(--sk_raspberry_red, #e01e5a)',
          }}
        >
          {error}
        </div>
      )}
    </div>
  )
}
