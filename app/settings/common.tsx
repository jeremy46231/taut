// Taut Settings: pieces every screen uses

import { authorBySlackId, resolveAuthors } from '../../shared/authors'
import type { JsonValue } from '../../shared/Plugin'
import type { ElementsAPI } from '../api/elements'
import type { ModalAPI } from '../api/modal'
import { initMonaco, type Monaco, setJsonSchema } from '../cdn'
import type { ConfigStore, TautConfig } from '../configStore'
import type { BaseTautAPI, PluginManager } from '../pluginManager'
import { getReduxStore } from '../slack/redux'
import { workspace } from '../slack/workspace'

type MonacoEditorInstance = ReturnType<Monaco['editor']['create']>

export let elements: ElementsAPI
export let modal: ModalAPI
/** what options' own editors get, see `OptEditorProps` */
export let baseAPI: BaseTautAPI

/** call once before the tab can render */
export function setSettingsDeps(api: BaseTautAPI) {
  elements = api.elements
  modal = api.modal
  baseAPI = api
  ErrorBoundary = makeErrorBoundary()
}

export type SettingsProps = {
  pluginManager: PluginManager
  configStore: ConfigStore
}

export const SETTINGS_CSS = `
  .taut-settings fieldset {
    min-inline-size: 0;
  }
  .taut-settings__title {
    margin: 0;
    font-size: 18px;
    font-weight: 700;
    line-height: 1.33;
  }
  .taut-settings__muted {
    color: var(--dt_color-content-sec);
  }
  .taut-settings__small {
    font-size: 13px;
    color: var(--dt_color-content-ter);
  }
  .taut-settings__search .c-input_text {
    margin-bottom: 0;
  }
  .taut-settings__back {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 12px;
  }
  .taut-settings__field {
    margin-bottom: 20px;
  }
  .taut-settings__field .c-input_text,
  .taut-settings__field .c-input_textarea {
    margin-bottom: 0;
  }
  .taut-settings__field .c-label {
    margin-bottom: 4px;
  }
  .taut-settings__inline {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .taut-settings__inline > .taut-settings__grow {
    flex: 1 1 auto;
    min-width: 0;
  }
  .taut-settings__buttons {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .taut-settings__editor-bar {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }
  .taut-settings__editor {
    border: 1px solid var(--dt_color-otl-sec);
    border-radius: 8px;
    overflow: hidden;
  }
`

/** `inSentence` gives the mid-sentence form, like "desktop app" */
export function loaderName(
  loader: string,
  options?: { inSentence?: boolean }
): string {
  const names: Record<string, [label: string, inSentence: string]> = {
    'chrome-extension': ['Chrome extension', 'Chrome extension'],
    'firefox-extension': ['Firefox extension', 'Firefox extension'],
    electron: ['Desktop', 'desktop app'],
    userscript: ['Userscript', 'userscript'],
  }
  return names[loader]?.[options?.inSentence ? 1 : 0] ?? loader
}

function memberName(id: string): string | undefined {
  const member = getReduxStore()?.getState().members?.[id]
  return member?.profile?.display_name || member?.real_name || undefined
}

/** names of the Hack Club Slack channels settings links to */
const KNOWN_CHANNELS: Record<string, string> = { C0A057686SF: 'taut' }

const channelUrl = (id: string) => `https://hackclub.slack.com/archives/${id}`

/** mentions only resolve in the Hack Club Slack, elsewhere they become names and links */
export function mrkdwnHere(text: string, hackClub: boolean): string {
  if (hackClub) return text
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label) => {
      const author = authorBySlackId(id)
      if (author)
        return author.url ? `<${author.url}|${author.name}>` : author.name
      return label || 'a Hack Club Slack member'
    })
    .replace(/<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label) => {
      const name = KNOWN_CHANNELS[id] ?? label
      return name
        ? `<${channelUrl(id)}|#${name} on the Hack Club Slack>`
        : `<${channelUrl(id)}|a channel on the Hack Club Slack>`
    })
}

/** mrkdwn as one line of plain text: link labels kept, markup dropped */
export function plainMrkdwn(text: string): string {
  return text
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (_, id: string, label) => {
      const name = authorBySlackId(id)?.name ?? memberName(id) ?? label
      return name ? `@${name}` : '@someone'
    })
    .replace(
      /<#(C[A-Z0-9]+)(?:\|([^>]*))?>/g,
      (_, id: string, label) => `#${KNOWN_CHANNELS[id] ?? label ?? 'channel'}`
    )
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** a plugin's `authors` as mrkdwn for this workspace */
export function authorsMrkdwn(authors: unknown, hackClub: boolean): string {
  const list = resolveAuthors(authors)
  if (typeof list === 'string') return mrkdwnHere(list, hackClub)
  const names = list.map((author) => {
    if (hackClub && author.slackId) return `<@${author.slackId}>`
    return author.url ? `<${author.url}|${author.name}>` : author.name
  })
  return names.join(', ')
}

/** mrkdwn with mentions that work in this workspace, see `mrkdwnHere` */
export function SlackText({ text }: { text: string }) {
  const hackClub = workspace.useIsHackClub()
  return <elements.MrkdwnElement text={mrkdwnHere(text, hackClub)} />
}

export function useConfig(configStore: ConfigStore): TautConfig {
  return React.useSyncExternalStore(
    (onChange) => configStore.onConfigChange(onChange),
    () => configStore.getConfig()
  )
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

export function useConfigValue<T extends JsonValue>(
  configStore: ConfigStore,
  path: string[],
  defaultValue: T,
  check?: (value: T) => string | null
) {
  const config = useConfig(configStore)
  const stored = path.reduce<unknown>(
    (node, key) => (isObject(node) ? node[key] : undefined),
    config
  )
  // so controls stay usable while it saves, and edits build on each other
  const [pending, setPending] = React.useState<{
    value: T
    isSet: boolean
  } | null>(null)
  const value = pending
    ? pending.value
    : ((typeof stored === typeof defaultValue ? stored : defaultValue) as T)
  const isSet = pending ? pending.isSet : stored !== undefined
  const [error, setError] = React.useState<string | null>(null)
  const save = async (saving: { value: T; isSet: boolean }) => {
    setPending(saving)
    setError(null)
    const ok = saving.isSet
      ? await configStore.setConfigValue(path, saving.value)
      : await configStore.removeConfigValue(path)
    setPending((current) => (current === saving ? null : current))
    if (!ok) setError("Couldn't save config.json")
  }
  const set = async (next: T) => {
    const problem = check?.(next)
    if (problem) {
      setError(sentence(problem))
      return
    }
    await save({ value: next, isSet: true })
  }
  /** back to unset, following the default */
  const reset = () => save({ value: defaultValue, isSet: false })
  return { value, isSet, saving: pending !== null, error, set, reset }
}

export function ConfigCheckbox({
  configStore,
  path,
  defaultValue,
  label,
  subtext,
}: {
  configStore: ConfigStore
  path: string[]
  defaultValue: boolean
  label: string
  subtext?: string
}) {
  const { value, error, set } = useConfigValue(configStore, path, defaultValue)
  return (
    <>
      <elements.Label type="inline" text={label} subtext={subtext}>
        <elements.Checkbox
          checked={value}
          onChange={(e) => set(e.target.checked)}
        />
      </elements.Label>
      {error && <elements.InlineAlert>{error}</elements.InlineAlert>}
    </>
  )
}

export function useConfigText(configStore: ConfigStore): string {
  return React.useSyncExternalStore(
    (onChange) => configStore.onConfigTextChange(onChange),
    () => configStore.getConfigText()
  )
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function LinkButton({
  onClick,
  children,
  className,
}: {
  onClick: () => void
  children: React.ReactNode
  className?: string
}) {
  return (
    <button
      type="button"
      className={`c-link--button${className ? ` ${className}` : ''}`}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** the top of every screen but the main one */
export function SubScreen({
  title,
  onBack,
  backLabel = 'Taut',
  children,
}: {
  title: React.ReactNode
  onBack: () => void
  backLabel?: string
  children: React.ReactNode
}) {
  return (
    <div>
      <LinkButton className="taut-settings__back" onClick={onBack}>
        <elements.SvgIcon name="arrow-left" size={16} inline />
        {backLabel}
      </LinkButton>
      <h2 className="taut-settings__title">{title}</h2>
      <div style={{ marginTop: '16px' }}>{children}</div>
    </div>
  )
}

/** follows the outside text until edited, then keeps the edit until saved */
export function DocumentEditor({
  language,
  schema,
  value,
  save,
  saveLabel,
  height = 300,
}: {
  language: 'json' | 'css'
  /** a JSON schema to validate against (memoize it, a new object re-registers) */
  schema?: object
  value: string
  /** resolves to an error message, or null once saved */
  save: (text: string) => Promise<string | null>
  saveLabel: string
  height?: number
}) {
  const [text, setText] = React.useState(value)
  const [dirty, setDirty] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!dirty) setText(value)
  }, [value, dirty])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    const problem = await save(text).catch(errorMessage)
    setSaving(false)
    if (problem) setError(problem)
    else setDirty(false)
  }

  return (
    <div>
      <MonacoEditor
        className="taut-settings__editor"
        language={language}
        schema={schema}
        value={text}
        onChange={(next) => {
          setText(next)
          setDirty(true)
        }}
        style={{ height: `${height}px` }}
      />
      {error && <elements.InlineAlert>{error}</elements.InlineAlert>}
      <div className="taut-settings__editor-bar">
        <div className="taut-settings__buttons">
          <elements.Button
            type="outline"
            size="small"
            onClick={handleSave}
            disabled={!dirty || saving}
          >
            {saving ? 'Saving...' : saveLabel}
          </elements.Button>
          {dirty && (
            <elements.Button
              size="small"
              type="outline"
              onClick={() => {
                setDirty(false)
                setError(null)
                setText(value)
              }}
              disabled={saving}
            >
              Discard
            </elements.Button>
          )}
        </div>
        <div className="taut-settings__small">
          {dirty ? 'Unsaved changes' : 'Saved'}
        </div>
      </div>
    </div>
  )
}

interface EditorProps {
  language?: 'json' | 'css'
  schema?: object
  value: string
  onChange: (value: string) => void
}

let editorCount = 0

function MonacoEditor({
  language,
  schema,
  value,
  onChange,
  style,
  ...props
}: EditorProps &
  Omit<React.HTMLAttributes<HTMLDivElement>, keyof EditorProps>) {
  // schemas are matched to models by uri
  const [uri] = React.useState(
    () => `taut://settings/editor-${++editorCount}.${language ?? 'txt'}`
  )
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const editorRef = React.useRef<MonacoEditorInstance | null>(null)
  const valueRef = React.useRef(value)
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange
  /** set while the value is applied from outside, so onChange doesn't fire */
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

      const model = monaco.editor.createModel(
        valueRef.current,
        language,
        monaco.Uri.parse(uri)
      )
      const editor = monaco.editor.create(containerRef.current, {
        model,
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
        onChangeRef.current(editor.getValue())
      })

      cleanup = () => {
        sub.dispose()
        editor.dispose()
        model.dispose()
        editorRef.current = null
      }
    })()

    return () => {
      cancelled = true
      cleanup()
    }
  }, [language])

  React.useEffect(() => {
    if (!schema) return
    setJsonSchema(uri, schema)
    return () => setJsonSchema(uri, null)
  }, [uri, schema])

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
        <div className="taut-settings__small" style={{ padding: '8px' }}>
          Monaco loading...
        </div>
      )}
      <div ref={containerRef} style={{ height: loading ? '0' : '100%' }} />
    </div>
  )
}

/** install a user plugin, or replace one, from a file or a URL */
export function ImportControls({
  pluginManager,
  replacingId,
  onDone,
}: {
  pluginManager: PluginManager
  replacingId?: string
  onDone?: (id: string) => void
}) {
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
      onDone?.(result.id)
    } catch (err) {
      setError(errorMessage(err))
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
      const res = await pluginManager.bridge.fetch(urlString)
      if (!res.ok) throw new Error(`Failed to fetch (HTTP ${res.status})`)
      return res.text()
    })
  }

  return (
    <div>
      <div className="taut-settings__inline taut-settings__search">
        <elements.Button
          type="outline"
          size="small"
          onClick={pickFile}
          disabled={busy}
        >
          Choose file...
        </elements.Button>
        <div className="taut-settings__grow">
          <elements.FormTextInput
            size="small"
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
          type="outline"
          size="small"
          onClick={importUrl}
          disabled={busy || !url.trim()}
        >
          {busy ? 'Importing...' : 'Import URL'}
        </elements.Button>
      </div>
      {error && <elements.InlineAlert>{error}</elements.InlineAlert>}
    </div>
  )
}

type ErrorBoundaryType = React.ComponentType<{ children: React.ReactNode }>

/** renders a plugin's panel inside `ErrorBoundary`, so its throws are caught too */
export function PanelHost({ render }: { render: () => React.ReactNode }) {
  return <>{render()}</>
}

export let ErrorBoundary: ErrorBoundaryType

/** a class, so it can only be declared once React has loaded */
function makeErrorBoundary(): ErrorBoundaryType {
  return class extends React.Component<
    { children: React.ReactNode },
    { error: string | null }
  > {
    state = { error: null as string | null }
    static getDerivedStateFromError(err: unknown) {
      return { error: errorMessage(err) }
    }
    render() {
      if (this.state.error) {
        return (
          <elements.InlineAlert>
            This panel crashed: {this.state.error}
          </elements.InlineAlert>
        )
      }
      return this.props.children
    }
  }
}
