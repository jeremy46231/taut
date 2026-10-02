// Adds buttons to open a member in Hack Club tools

import {
  type MenuTemplateItem,
  type OptEditorProps,
  opt,
  TautPlugin,
} from '$taut'

type MenuFromTemplateProps = { template?: MenuTemplateItem[] }
type OverflowMenuProps = { memberId?: string }

const TOOLS = [
  {
    value: 'identity',
    label: 'Identity',
    url: 'https://auth.hackclub.com/backend/identities?search={id}',
  },
  {
    value: 'telescreen',
    label: 'Telescreen',
    url: 'https://telescreen.hackclub.com/subjects/{id}',
  },
  {
    value: 'joe',
    label: 'Joe',
    url: 'https://joe.fraud.hackclub.com/profile/{id}',
  },
  {
    value: 'fireEngine',
    label: 'Fire Engine',
    url: 'https://nemo.hackclub.com/fd/members/{id}',
  },
  {
    value: 'slackAdmin',
    label: 'Slack Admin',
    url: 'https://app.slack.com/manage/E09V59WQY1E/people/{id}',
  },
] as const

type Preset = (typeof TOOLS)[number]['value']
type CustomTool = { name: string; url: string }
type Tool = Preset | CustomTool

const preset = (item: unknown) => TOOLS.find((tool) => tool.value === item)

const toolUrl = (template: string, memberId: string) =>
  template.replaceAll('{id}', encodeURIComponent(memberId))

function checkUrl(template: string): string | null {
  if (!template.includes('{id}')) return 'Put {id} where the member ID goes'
  try {
    const url = new URL(toolUrl(template, 'U0'))
    if (url.protocol === 'https:' || url.protocol === 'http:') return null
  } catch {}
  return 'Enter a full http(s) URL'
}

function customProblems(tool: Partial<Record<keyof CustomTool, unknown>>) {
  const problems: Partial<Record<keyof CustomTool, string>> = {}
  if (typeof tool.name !== 'string' || !tool.name.trim())
    problems.name = 'Name is required'
  const url = typeof tool.url === 'string' ? tool.url.trim() : ''
  const urlProblem = url ? checkUrl(url) : 'URL is required'
  if (urlProblem) problems.url = urlProblem
  return problems
}

// unknown names (like a removed preset) pass here and start() skips them
function checkTools(tools: Tool[]): string | null {
  const seen = new Set<unknown>()
  for (const tool of tools) {
    if (typeof tool === 'string') {
      if (preset(tool) && seen.has(tool)) return `"${tool}" is listed twice`
      seen.add(tool)
      continue
    }
    const problems =
      tool && typeof tool === 'object'
        ? Object.values(customProblems(tool))
        : ['expected a preset name or { name, url }']
    if (problems.length)
      return `${JSON.stringify(tool)}: ${problems.join(', ')}`
  }
  return null
}

export default class AdminBackend extends TautPlugin<typeof AdminBackend> {
  static readonly id = 'AdminBackend'
  static readonly pluginName = 'Admin Backend'
  static readonly description =
    'Adds buttons to open a member in Hack Club tools'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'people'
  static readonly hackClubOnly = true
  static readonly defaultConfig = {
    enabled: false,
    tools: opt(
      ['identity', 'telescreen', 'slackAdmin'] as Tool[],
      'Tools in the profile menu, in order',
      { editor: ToolsEditor, check: checkTools }
    ),
  }

  private readonly MemberIdContext = React.createContext<string | null>(null)

  start(): void {
    const tools = this.config.tools.flatMap((item) =>
      typeof item === 'string'
        ? TOOLS.filter((tool) => tool.value === item)
        : [{ label: item.name, url: item.url }]
    )
    if (!tools.length) return

    this.api.patchComponent<OverflowMenuProps>(
      'RimetoMemberProfileOverflowMenu',
      (Original) => (props) => (
        <this.MemberIdContext.Provider value={props.memberId ?? null}>
          <Original {...props} />
        </this.MemberIdContext.Provider>
      )
    )

    this.api.patchComponent<MenuFromTemplateProps>(
      'MenuFromTemplate',
      (Original) => (props) => {
        const memberId = React.useContext(this.MemberIdContext)
        const template = props.template
        if (!memberId || !Array.isArray(template))
          return <Original {...props} />
        if (
          template.some((item) => item?.key?.startsWith('taut-admin-backend__'))
        )
          return <Original {...props} />

        const next = [
          ...template,
          { key: 'taut-admin-backend__separator', type: 'separator' as const },
          ...tools.map((tool, i) => ({
            key: `taut-admin-backend__tool-${i}`,
            label: `Open in ${tool.label}`,
            click: () =>
              window.open(
                toolUrl(tool.url, memberId),
                '_blank',
                'noopener,noreferrer'
              ),
          })),
        ]
        return <Original {...props} template={next} />
      }
    )

    this.log('Started')
  }
}

const move = (list: Tool[], from: number, to: number) => {
  const next = [...list]
  next.splice(to, 0, ...next.splice(from, 1))
  return next
}

function ToolsEditor({ value, onChange, label, api }: OptEditorProps<Tool[]>) {
  const { elements } = api
  React.useEffect(
    // returns a disposer, so it only has the css when needed
    () =>
      api.setStyle(`
        .taut-tool-list {
          margin: 0;
          padding: 0;
          list-style: none;
          border: 1px solid var(--dt_color-otl-sec);
          border-radius: 8px;
          overflow: hidden;
        }
        .taut-tool-list:empty {
          display: none;
        }
        .taut-tool-list + .taut-tool-list {
          margin-top: 12px;
        }
        .taut-tool-list__row {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 6px 8px;
          background: var(--dt_color-base-pry);
        }
        .taut-tool-list__row + .taut-tool-list__row {
          border-top: 1px solid var(--dt_color-otl-sec);
        }
        .taut-tool-list__row--dragging {
          position: relative;
          z-index: 1;
          background: var(--dt_color-surf-sec, var(--dt_color-base-pry));
        }
        .taut-tool-list__text {
          flex: 1 1 auto;
          min-width: 0;
          display: flex;
          flex-direction: column;
        }
        .taut-tool-list__name,
        .taut-tool-list__url {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .taut-tool-list__url {
          font-size: 13px;
          color: var(--dt_color-content-sec);
        }
        .taut-tool-list__handle {
          flex: none;
          display: inline-flex;
          padding: 6px;
          border-radius: 4px;
          color: var(--dt_color-content-ter);
          cursor: grab;
          touch-action: none;
        }
        .taut-tool-list__row--dragging .taut-tool-list__handle {
          cursor: grabbing;
        }
        .taut-tool-list__form {
          flex: 1 1 auto;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 4px 0;
        }
        .taut-tool-list__form .c-input_text {
          margin-bottom: 0;
        }
        .taut-tool-list__buttons {
          display: flex;
          gap: 8px;
        }
      `),
    [api]
  )
  const known = value.filter((item) => typeof item !== 'string' || preset(item))
  const [items, setItems] = React.useState(known)
  const key = JSON.stringify(known)
  React.useEffect(() => setItems(JSON.parse(key)), [key])
  const [dragging, setDragging] = React.useState<number | null>(null)
  const [editing, setEditing] = React.useState<number | 'new' | null>(null)
  const [announcement, setAnnouncement] = React.useState('')
  const listRef = React.useRef<HTMLUListElement | null>(null)
  const itemsRef = React.useRef(items)
  itemsRef.current = items

  const nameOf = (item: Tool) =>
    typeof item === 'string' ? (preset(item)?.label ?? item) : item.name
  const save = (next: Tool[]) => {
    setItems(next)
    onChange(next)
  }

  const startDrag = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0) return
    e.preventDefault()
    const start = itemsRef.current
    let at = index
    setDragging(at)
    const onMove = (ev: PointerEvent) => {
      const rows = Array.from(listRef.current?.children ?? [])
      let to = rows.findIndex((row) => {
        const rect = row.getBoundingClientRect()
        return ev.clientY < rect.top + rect.height / 2
      })
      if (to === -1) to = rows.length - 1
      else if (to > at) to -= 1
      if (to === at) return
      setItems((list) => move(list, at, to))
      at = to
      setDragging(at)
    }
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      setDragging(null)
      if (at !== index) onChange(move(start, index, at))
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  const onHandleKey = (e: React.KeyboardEvent, index: number) => {
    const to =
      e.key === 'ArrowUp' ? index - 1 : e.key === 'ArrowDown' ? index + 1 : -1
    if (to < 0 || to >= items.length) return
    e.preventDefault()
    save(move(items, index, to))
    setAnnouncement(
      `${nameOf(items[index])}, position ${to + 1} of ${items.length}`
    )
    // the handle moved with its row, keep focus on it
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelectorAll<HTMLElement>('.taut-tool-list__handle')
        [to]?.focus()
    )
  }

  const occurrences = new Map<string, number>()
  const rowKey = (item: Tool) => {
    const k = JSON.stringify(item)
    const n = occurrences.get(k) ?? 0
    occurrences.set(k, n + 1)
    return `${k}#${n}`
  }
  const unused = TOOLS.filter((tool) => !items.includes(tool.value))

  const iconButton = (icon: string, tip: string, onClick: () => void) => (
    <elements.Tooltip tip={tip}>
      <elements.Button
        type="outline"
        size="small"
        className="c-button--icon"
        aria-label={tip}
        onClick={onClick}
      >
        <elements.SvgIcon name={icon} size={16} inline />
      </elements.Button>
    </elements.Tooltip>
  )

  return (
    <div>
      <ul className="taut-tool-list" ref={listRef} aria-label={label}>
        {items.map((item, i) =>
          editing === i && typeof item !== 'string' ? (
            <li key={rowKey(item)} className="taut-tool-list__row">
              <CustomToolForm
                api={api}
                initial={item}
                onCancel={() => setEditing(null)}
                onSave={(next) => {
                  setEditing(null)
                  save(items.map((old, j) => (j === i ? next : old)))
                }}
              />
            </li>
          ) : (
            <li
              key={rowKey(item)}
              className={`taut-tool-list__row${dragging === i ? ' taut-tool-list__row--dragging' : ''}`}
            >
              {iconButton('minus', `Remove ${nameOf(item)}`, () =>
                save(items.filter((_, j) => j !== i))
              )}
              <div className="taut-tool-list__text">
                <span className="taut-tool-list__name">{nameOf(item)}</span>
                {typeof item !== 'string' && (
                  <span className="taut-tool-list__url">{item.url}</span>
                )}
              </div>
              {typeof item !== 'string' &&
                iconButton('edit', `Edit ${nameOf(item)}`, () => setEditing(i))}
              <elements.Tooltip tip="Drag, or use the arrow keys">
                <button
                  type="button"
                  className="c-button-unstyled taut-tool-list__handle"
                  aria-label={`Move ${nameOf(item)}`}
                  onPointerDown={(e) => startDrag(e, i)}
                  onKeyDown={(e) => onHandleKey(e, i)}
                >
                  <elements.SvgIcon name="reorder" size={16} inline />
                </button>
              </elements.Tooltip>
            </li>
          )
        )}
      </ul>
      <ul className="taut-tool-list">
        {unused.map((tool) => (
          <li key={tool.value} className="taut-tool-list__row">
            {iconButton('plus', `Add ${tool.label}`, () =>
              save([...items, tool.value])
            )}
            <div className="taut-tool-list__text">
              <span className="taut-tool-list__name">{tool.label}</span>
            </div>
          </li>
        ))}
        {editing === 'new' ? (
          <li className="taut-tool-list__row">
            <CustomToolForm
              api={api}
              onCancel={() => setEditing(null)}
              onSave={(next) => {
                setEditing(null)
                save([...items, next])
              }}
            />
          </li>
        ) : (
          <li className="taut-tool-list__row">
            {iconButton('plus', 'Add custom', () => setEditing('new'))}
            <div className="taut-tool-list__text">
              <span className="taut-tool-list__name">Custom</span>
            </div>
          </li>
        )}
      </ul>
      <div className="offscreen" aria-live="polite">
        {announcement}
      </div>
    </div>
  )
}

function CustomToolForm({
  api,
  initial,
  onSave,
  onCancel,
}: {
  api: OptEditorProps<Tool[]>['api']
  initial?: CustomTool
  onSave: (tool: CustomTool) => void
  onCancel: () => void
}) {
  const { elements } = api
  const [draft, setDraft] = React.useState<CustomTool>(
    initial ?? { name: '', url: '' }
  )
  const [problems, setProblems] = React.useState<
    ReturnType<typeof customProblems>
  >({})
  const id = `taut-tool-list__field-${React.useId()}`
  const field = (
    key: keyof CustomTool,
    label: string,
    placeholder: string,
    hint?: string
  ) => (
    <div>
      <elements.Label text={label} htmlFor={`${id}-${key}`} />
      <elements.FormTextInput
        id={`${id}-${key}`}
        size="small"
        autoFocus={key === 'name'}
        value={draft[key]}
        placeholder={placeholder}
        onChange={(next) => setDraft({ ...draft, [key]: next })}
        isInvalid={!!problems[key]}
        errorText={problems[key] ?? null}
        hintText={problems[key] ? null : (hint ?? null)}
      />
    </div>
  )
  return (
    <form
      className="taut-tool-list__form"
      onSubmit={(e) => {
        e.preventDefault()
        const tool = { name: draft.name.trim(), url: draft.url.trim() }
        const found = customProblems(tool)
        setProblems(found)
        if (!Object.keys(found).length) onSave(tool)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onCancel()
        }
      }}
    >
      {field('name', 'Name', 'HCB')}
      {field(
        'url',
        'URL',
        'https://example.com/users/{id}',
        '{id} is replaced with the Slack user ID'
      )}
      <div className="taut-tool-list__buttons">
        <elements.Button size="small" type="outline" htmlType="submit">
          {initial ? 'Save' : 'Add'}
        </elements.Button>
        <elements.Button size="small" type="outline" onClick={onCancel}>
          Cancel
        </elements.Button>
      </div>
    </form>
  )
}
