// Taut Settings: a plugin's options as form controls

import type { DefaultConfig, JsonValue } from '../../shared/Plugin'
import type { ConfigStore } from '../configStore'
import { deepEqual } from '../helpers'
import { checkOption, type DefaultEntry, defaultEntries } from '../pluginConfig'
import type { PluginInfo, PluginManager } from '../pluginManager'
import {
  baseAPI,
  ConfigCheckbox,
  ErrorBoundary,
  elements,
  useConfigValue,
} from './common'

export const CONFIG_FORM_CSS = `
  .taut-settings__list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .taut-settings__top {
    align-items: flex-start;
  }
  .taut-settings__list-foot {
    justify-content: space-between;
  }
  /* a square button drawn like Slack's text inputs, to sit beside one */
  .taut-settings__box-button {
    flex: none;
    box-sizing: border-box;
    width: 36px;
    height: 36px;
    border: 1px solid var(--dt_color-otl-pry);
    border-radius: var(--sk_input_styles-radius, 8px);
    background: var(--dt_color-base-pry);
    cursor: pointer;
  }
  .taut-settings__box-button:focus-visible {
    box-shadow:
      0 0 0 1px var(--sk_focused-shadow-color, var(--dt_color-otl-hgl-1)),
      0 0 0 5px
        color-mix(
          in srgb,
          var(--sk_focused-shadow-color, var(--dt_color-otl-hgl-1)) 30%,
          transparent
        );
    border-color: transparent;
    outline: none;
  }
  .taut-settings__swatch {
    padding: 5px;
  }
  .taut-settings__icon-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--dt_color-content-pry);
  }
  .taut-settings__icon-button:hover:not(:disabled) {
    background: var(--dt_color-base-sec);
  }
  /* as Slack draws a disabled button */
  .taut-settings__icon-button:disabled {
    background: var(--dt_color-base-ter);
    border-color: transparent;
    color: var(--dt_color-content-ter);
    cursor: default;
  }
  .taut-settings__swatch > span {
    display: block;
    height: 100%;
    border-radius: 4px;
    box-shadow: inset 0 0 0 1px var(--dt_color-otl-ter);
  }
  .taut-settings__picker {
    border: 1px solid var(--dt_color-otl-ter);
    border-radius: 8px;
    background: rgba(var(--sk_primary_background, 255, 255, 255), 1);
    box-shadow:
      0 4px 6px -4px rgba(0, 0, 0, 0.1),
      0 10px 15px -3px rgba(0, 0, 0, 0.1);
  }
  .taut-settings__picker-head {
    padding: 12px;
    border-bottom: 1px solid var(--dt_color-otl-ter);
    font-weight: 700;
  }
  .taut-settings__picker-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
  }
  .taut-settings__json {
    font-family: Monaco, Menlo, Consolas, 'Courier New', monospace;
    font-size: 12px;
  }
`

export function formEntries(defaults: DefaultConfig): DefaultEntry[] {
  return defaultEntries(defaults).filter((entry) => entry.key !== 'enabled')
}

export function ConfigForm({
  plugin,
  defaults,
  configStore,
  pluginManager,
}: {
  plugin: PluginInfo[number]
  defaults: DefaultConfig
  configStore: ConfigStore
  pluginManager: PluginManager
}) {
  return (
    <>
      {formEntries(defaults).map((entry) =>
        entry.kind.type === 'secret' ? (
          <SecretField
            key={entry.key}
            pluginId={plugin.id}
            entry={entry}
            pluginManager={pluginManager}
          />
        ) : (
          <OptionField
            key={entry.key}
            pluginId={plugin.id}
            entry={entry}
            value={plugin.config[entry.key] as JsonValue}
            problem={plugin.problems[entry.key]}
            configStore={configStore}
          />
        )
      )}
    </>
  )
}

/** an `opt.secret`, saved to Taut's secret storage instead of config.json */
function SecretField({
  pluginId,
  entry,
  pluginManager,
}: {
  pluginId: string
  entry: DefaultEntry
  pluginManager: PluginManager
}) {
  const [saved, setSaved] = React.useState<string | null>(null)
  const [draft, setDraft] = React.useState('')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inputId = `taut-settings__option-${pluginId}-${entry.key}`

  React.useEffect(() => {
    let live = true
    pluginManager.readPluginSecret(pluginId, entry.key).then((value) => {
      if (!live) return
      setSaved(value)
      setDraft(value)
    })
    return () => {
      live = false
    }
  }, [pluginManager, pluginId, entry.key])

  const commit = async (value: string) => {
    const next = value.trim()
    if (saved === null || next === saved) return
    setSaving(true)
    setError(null)
    const ok = await pluginManager.setPluginSecret(pluginId, entry.key, next)
    setSaving(false)
    if (ok) setSaved(next)
    else setError("Couldn't save it to Taut's secret storage")
  }

  return (
    <div className="taut-settings__field">
      <elements.Label text={entry.label} subtext={entry.comment || undefined} />
      <WithReset
        label={entry.label}
        disabled={!saved || saving}
        onReset={() => {
          setDraft('')
          commit('')
        }}
      >
        <elements.FormTextInput
          id={inputId}
          type="password"
          value={draft}
          onChange={setDraft}
          onBlur={() => commit(draft)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit(draft)
          }}
          isDisabled={saving || saved === null}
          autoComplete="off"
          hintText="Kept in Taut's secret storage on this device, not in config.json"
        />
      </WithReset>
      {error && <elements.InlineAlert>{error}</elements.InlineAlert>}
    </div>
  )
}

type ControlProps<T> = {
  id: string
  value: T
  commit: (value: T) => void
}

function OptionField({
  pluginId,
  entry,
  value: resolved,
  problem,
  configStore,
}: {
  pluginId: string
  entry: DefaultEntry
  value: JsonValue
  problem?: string
  configStore: ConfigStore
}) {
  const path = ['plugins', pluginId, entry.key]
  const saved = useConfigValue(configStore, path, entry.value, (next) =>
    checkOption(entry, next)
  )
  const { error, set } = saved
  // what's being saved, until the plugin's config has it
  const value = saved.saving ? saved.value : resolved
  const { kind, label, editor: Editor } = entry
  const inputId = `taut-settings__option-${pluginId}-${entry.key}`
  const commit = (next: JsonValue) => {
    if (problem || !deepEqual(next, value)) set(next)
  }
  const problemAlert = problem && (
    <elements.InlineAlert>
      config.json: {problem}. Using the default.
    </elements.InlineAlert>
  )
  // any value config.json has can be reset to unset, even one equal to the default or one it can't use
  const resetProps = {
    label,
    disabled: !saved.isSet,
    onReset: () => saved.reset(),
  }

  if (kind.type === 'boolean' && !Editor) {
    return (
      <div className="taut-settings__field">
        <WithReset {...resetProps} center>
          <ConfigCheckbox
            configStore={configStore}
            path={path}
            defaultValue={entry.value === true}
            label={label}
            subtext={entry.comment || undefined}
          />
        </WithReset>
        {problemAlert}
      </div>
    )
  }

  const controlProps = { id: inputId, commit }
  let control: React.ReactNode
  if (Editor) {
    control = (
      <ErrorBoundary>
        <Editor value={value} onChange={commit} label={label} api={baseAPI} />
      </ErrorBoundary>
    )
  } else if (kind.type === 'select') {
    control = (
      <elements.BasicSelect
        selectId={inputId}
        options={kind.options}
        selectedOption={kind.options.find((o) => o.value === value)}
        onSelectionChange={(option) => commit(option.value)}
        ariaLabel={label}
        width="100%"
      />
    )
  } else if (kind.type === 'number') {
    control = (
      <NumberControl
        {...controlProps}
        value={value as number}
        min={kind.min}
        max={kind.max}
      />
    )
  } else if (kind.type === 'string') {
    control = <TextControl {...controlProps} value={value as string} />
  } else if (kind.type === 'color') {
    control = <ColorControl {...controlProps} value={value as string} />
  } else if (kind.type === 'list') {
    control = (
      <ListControl
        {...controlProps}
        value={value as string[]}
        label={label}
        reset={<ResetButton {...resetProps} />}
      />
    )
  } else {
    control = <JsonControl {...controlProps} value={value} />
  }

  return (
    <div className="taut-settings__field">
      <elements.Label text={label} subtext={entry.comment || undefined} />
      {Editor || kind.type === 'list' ? (
        control
      ) : (
        <WithReset {...resetProps}>{control}</WithReset>
      )}
      {problemAlert}
      {error && <elements.InlineAlert>{error}</elements.InlineAlert>}
    </div>
  )
}

type ResetProps = { label: string; disabled: boolean; onReset: () => void }

function ResetButton({ label, disabled, onReset }: ResetProps) {
  return (
    <elements.Tooltip tip="Reset to default">
      <button
        type="button"
        className="c-button-unstyled taut-settings__box-button taut-settings__icon-button"
        aria-label={`Reset ${label} to default`}
        disabled={disabled}
        onClick={onReset}
      >
        <elements.SvgIcon name="undo" size={16} inline />
      </button>
    </elements.Tooltip>
  )
}

/** a control with its reset button to the right, level with its top */
function WithReset({
  children,
  center,
  ...reset
}: ResetProps & { children: React.ReactNode; center?: boolean }) {
  return (
    <div
      className={`taut-settings__inline${center ? '' : ' taut-settings__top'}`}
    >
      <div className="taut-settings__grow">{children}</div>
      <ResetButton {...reset} />
    </div>
  )
}

function useDraft<T>(value: T, format: (value: T) => string) {
  const [draft, setDraft] = React.useState(() => format(value))
  const formatted = format(value)
  React.useEffect(() => setDraft(formatted), [formatted])
  return [draft, setDraft] as const
}

function TextControl({ id, value, commit }: ControlProps<string>) {
  const [draft, setDraft] = useDraft(value, String)
  return (
    <elements.FormTextInput
      id={id}
      value={draft}
      onChange={setDraft}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(draft)
      }}
    />
  )
}

function NumberControl({
  id,
  value,
  commit,
  min,
  max,
}: ControlProps<number> & { min?: number; max?: number }) {
  const [draft, setDraft] = useDraft(value, String)
  const parsed = draft.trim() === '' ? Number.NaN : Number(draft)
  const range =
    min !== undefined && max !== undefined
      ? `${min} to ${max}`
      : min !== undefined
        ? `${min} or more`
        : max !== undefined
          ? `${max} or less`
          : null
  const outside = (n: number) =>
    (min !== undefined && n < min) || (max !== undefined && n > max)
  const invalid = !Number.isFinite(parsed)
  const save = () => {
    if (invalid) return
    if (parsed === value) return
    const clamped = Math.min(max ?? parsed, Math.max(min ?? parsed, parsed))
    setDraft(String(clamped))
    commit(clamped)
  }
  const hint = !range
    ? null
    : outside(value) && parsed === value
      ? `Set to ${value} in config.json, outside the ${range} offered here`
      : range
  return (
    <elements.FormTextInput
      id={id}
      value={draft}
      onChange={setDraft}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') save()
      }}
      isInvalid={invalid}
      errorText={invalid ? `Enter a number${range ? `, ${range}` : ''}` : null}
      hintText={invalid ? null : hint}
    />
  )
}

/** convert any css color to #rrggbb */
function toHex(color: string): string {
  const ctx = document.createElement('canvas').getContext('2d')
  if (!ctx) return '#000000'
  ctx.fillStyle = '#000000'
  ctx.fillStyle = color
  const out = ctx.fillStyle
  return /^#[0-9a-f]{6}$/i.test(out) ? out : '#000000'
}

const isColor = (text: string) => CSS.supports('color', text)

/** a swatch that opens Slack's color picker */
function ColorControl({ id, value, commit }: ControlProps<string>) {
  const [draft, setDraft] = useDraft(value, String)
  const [rejected, setRejected] = React.useState(false)
  const [anchor, setAnchor] = React.useState<DOMRect | null>(null)
  const [windowRef] = React.useState(() => new WeakRef(window))
  const next = draft.trim()
  const shown = isColor(next) ? next : value
  const save = () => {
    if (isColor(next)) commit(next)
    else setRejected(true)
  }

  return (
    <div className="taut-settings__inline taut-settings__top">
      <button
        type="button"
        className="c-button-unstyled taut-settings__box-button taut-settings__swatch"
        aria-label="Pick a color"
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}
      >
        <span style={{ background: shown }} />
      </button>
      {anchor && (
        <elements.Popover
          isOpen
          targetBounds={anchor}
          windowRef={windowRef}
          position="bottom-left"
          offsetY={4}
          onClose={() => {
            setAnchor(null)
            save()
          }}
          ariaRole="dialog"
          ariaLabel="Pick a color"
        >
          <div className="taut-settings__picker">
            <div className="taut-settings__picker-head">Pick a color</div>
            <elements.HSVPicker
              className="taut-settings__picker-body"
              value={toHex(shown).slice(1)}
              onChange={(hex) => {
                setRejected(false)
                setDraft(`#${hex.toLowerCase()}`)
              }}
            />
          </div>
        </elements.Popover>
      )}
      <div className="taut-settings__grow">
        <elements.FormTextInput
          id={id}
          value={draft}
          onChange={(text) => {
            setRejected(false)
            setDraft(text)
          }}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
          }}
          isInvalid={rejected}
          errorText={rejected ? 'Enter a CSS color' : null}
        />
      </div>
    </div>
  )
}

function ListControl({
  id,
  value,
  commit,
  label,
  reset,
}: ControlProps<string[]> & { label: string; reset: React.ReactNode }) {
  const [items, setItems] = React.useState(value)
  const key = JSON.stringify(value)
  React.useEffect(() => setItems(JSON.parse(key)), [key])
  const save = (next: string[]) => commit(next.filter((item) => item.trim()))

  return (
    <div className="taut-settings__list">
      {items.map((item, i) => (
        <div className="taut-settings__inline" key={i}>
          <div className="taut-settings__grow">
            <elements.FormTextInput
              id={i === 0 ? id : undefined}
              value={item}
              onChange={(next) =>
                setItems(items.map((old, j) => (j === i ? next : old)))
              }
              onBlur={() => save(items)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save(items)
              }}
            />
          </div>
          <elements.Tooltip tip="Remove">
            <button
              type="button"
              className="c-button-unstyled taut-settings__box-button taut-settings__icon-button"
              aria-label={`Remove ${item || 'item'} from ${label}`}
              onClick={() => {
                const next = items.filter((_, j) => j !== i)
                setItems(next)
                save(next)
              }}
            >
              <elements.SvgIcon name="close" size={16} inline />
            </button>
          </elements.Tooltip>
        </div>
      ))}
      <div className="taut-settings__inline taut-settings__list-foot">
        <elements.Button
          size="small"
          type="outline"
          disabled={items.some((item) => !item.trim())}
          onClick={() => setItems([...items, ''])}
        >
          Add
        </elements.Button>
        {reset}
      </div>
    </div>
  )
}

function JsonControl({ id, value, commit }: ControlProps<JsonValue>) {
  const [draft, setDraft] = useDraft(value, (v) => JSON.stringify(v, null, 2))
  const [error, setError] = React.useState<string | null>(null)
  const save = () => {
    try {
      const parsed = JSON.parse(draft) as JsonValue
      setError(null)
      commit(parsed)
    } catch {
      setError("That isn't valid JSON")
    }
  }
  return (
    <>
      <textarea
        id={id}
        className="c-input_textarea taut-settings__json"
        value={draft}
        rows={Math.min(10, draft.split('\n').length + 1)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        spellCheck={false}
      />
      {error && <elements.InlineAlert>{error}</elements.InlineAlert>}
    </>
  )
}
