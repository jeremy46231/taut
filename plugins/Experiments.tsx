// Try Slack's unreleased features by overriding its experiments

import { type ExperimentAssignment as Assignment, TautPlugin } from '$taut'

/** experiment name -> group to read as, or null to read as not assigned */
type Overrides = Record<string, string | null>
type Filter = 'all' | 'overridden' | 'assigned' | 'unassigned'
type Row = { name: string; groups: readonly string[] }

const PAGE = 100
const COMMON_GROUPS = ['on', 'off', 'control', 'treatment']
// stable identity so it doesn't break memos
const NO_ASSIGNMENTS: Record<string, Assignment> = {}

export default class Experiments extends TautPlugin<typeof Experiments> {
  static readonly id = 'Experiments'
  static readonly pluginName = 'Experiments'
  static readonly description =
    "Try Slack's unreleased features by overriding its experiments"
  static readonly authors = ['jeremy'] as const
  static readonly category = 'app'
  static readonly defaultConfig = {
    enabled: false,
  }

  private overrides = this.api.storage.store<Overrides>('overrides', {})
  /** the overrides at boot, to show when a reload is needed */
  private booted: Overrides = {}

  /** experiment name -> groups autodetected from slack's code */
  private refs = new Map<string, Set<string>>()
  private scanned = new Set<string>()
  private scans = new this.api.Store(0)
  /** holds Slack's `getAllExperimentAssignments` selector once it loads */
  private allAssignments = new this.api.Store<
    ((state: unknown) => Record<string, Assignment> | undefined) | undefined
  >(undefined)

  async start() {
    // what other plugins force wins over what's picked here
    this.api.experiments.priority = -1
    await this.overrides.ready
    if (this.api.signal.aborted) return
    this.booted = this.overrides.get()
    this.apply()
    this.overrides.subscribe(() => this.apply())
    this.api
      .waitForExport<(state: unknown) => Record<string, Assignment>>(
        this.api.byMeta('getAllExperimentAssignments')
      )
      .then(this.allAssignments.set)
    this.api.setStyle(`
      .taut-experiments__title { margin-bottom: 2px; }
      .taut-experiments__muted {
        margin: 0 0 12px;
        color: var(--dt_color-content-sec);
      }
      .taut-experiments__bar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 12px;
      }
      .taut-experiments__bar .taut-experiments__muted { margin: 0; }
      .taut-experiments .c-input_text { margin: 0; }
      .taut-experiments__filters {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin: 12px 0;
      }
      .taut-experiments__rows {
        margin: 0 0 12px;
        padding: 0;
        list-style: none;
      }
      .taut-experiments__row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: center;
        gap: 8px 12px;
        padding: 6px 0 6px 8px;
        border-top: 1px solid var(--dt_color-otl-ter);
      }
      .taut-experiments__row--overridden {
        box-shadow: inset 3px 0 0 var(--dt_color-content-hig);
      }
      .taut-experiments__row--overridden .taut-experiments__name {
        font-weight: 700;
      }
      .taut-experiments__name {
        overflow-wrap: anywhere;
        font-family: Monaco, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      .taut-experiments__forced {
        grid-column: 1 / -1;
        color: var(--dt_color-content-sec);
        font-size: 12px;
      }
      .taut-experiments__custom {
        grid-column: 1 / -1;
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .taut-experiments__custom > :first-child { flex: 1 1 auto; min-width: 0; }
    `)
    this.api.preferences.addTab({
      label: 'Experiments',
      icon: 'magic-wand',
      render: () => <this.Panel />,
    })
  }

  private apply() {
    const overrides = this.overrides.get()
    const { experiments } = this.api
    for (const name of [...experiments.keys()])
      if (!(name in overrides)) experiments.delete(name)
    for (const [name, group] of Object.entries(overrides))
      experiments.set(name, group)
  }

  private save(change: (overrides: Overrides) => Overrides) {
    this.overrides
      .update(change)
      .catch((err) => this.log('Could not save overrides', err))
  }

  private readonly setOverride = (
    name: string,
    group: string | null | undefined
  ) =>
    this.save((overrides) => {
      const next = { ...overrides }
      if (group === undefined) delete next[name]
      else next[name] = group
      return next
    })

  /** find `(0,x.getGroupForUser)(state, "name")` calls and the groups they're compared to, best effort */
  private async scanCode() {
    const selectors = await this.api.waitForExport<Record<string, any>>(
      (exp: any) =>
        !!exp &&
        typeof exp === 'object' &&
        Object.values(exp).some(
          (value: any) => value?.meta?.name === 'getGroupForUser'
        )
    )
    const id = this.api.findModuleId(selectors)
    if (id === undefined) return
    const keys = Object.keys(selectors).filter((key) =>
      [
        'getGroupForUser',
        'getGroupForUserWithoutExposure',
        'getAssignmentByName',
      ].includes(selectors[key]?.meta?.name)
    )
    const required = /^\d+$/.test(id)
      ? `\\(${id}\\)`
      : `\\("${RegExp.escape(id)}"\\)`
    const importRe = new RegExp(`([\\w$]+)=[\\w$]+${required}`, 'g')
    const needle = /^\d+$/.test(id) ? `(${id})` : `("${id}")`
    const group = String.raw`"([^"\\]{1,80})"`
    let found = false

    for (const [moduleId, source] of this.api.getModuleSources()) {
      if (this.scanned.has(moduleId)) continue
      this.scanned.add(moduleId)
      if (!source.includes(needle)) continue
      const aliases = new Set(
        Array.from(source.matchAll(importRe), (m) => m[1])
      )
      if (!aliases.size) continue
      const call = String.raw`\(0,(?:${[...aliases].map(RegExp.escape).join('|')})\.(?:${keys.map(RegExp.escape).join('|')})\)\([^,()]{1,40},"([\w.-]{1,120})"[^()]{0,20}\)`
      const pattern = new RegExp(
        String.raw`(?:${group}\s*[!=]==?\s*|\[((?:"[^"\\]{1,80}",?){1,8})\]\.includes\()?${call}(?:\s*[!=]==?\s*${group})?`,
        'g'
      )
      for (const [, before, list, name, after] of source.matchAll(pattern)) {
        if (!name) continue
        const groups = this.refs.get(name) ?? new Set()
        this.refs.set(name, groups)
        if (before) groups.add(before)
        if (after) groups.add(after)
        for (const [, item] of list?.matchAll(/"([^"]+)"/g) ?? [])
          groups.add(item)
        found = true
      }
    }
    if (found) this.scans.set(this.scans.get() + 1)
  }

  private readonly Panel = () => {
    const { elements } = this.api
    const overrides = this.overrides.use()
    const scans = this.scans.use()
    const assignments: Record<string, Assignment> =
      this.api.redux.useReduxState(
        () => this.api.redux.getRawState()?.experiments
      ) ?? NO_ASSIGNMENTS
    const allAssignments = this.allAssignments.use()
    const effective: Record<string, Assignment> =
      this.api.redux.useReduxState((state) => allAssignments?.(state)) ??
      assignments
    const [query, setQuery] = React.useState('')
    const [filter, setFilter] = React.useState<Filter>('all')
    const [limit, setLimit] = React.useState(PAGE)

    React.useEffect(() => {
      this.scanCode()
    }, [])

    const rows = React.useMemo(() => {
      const names = new Set([...Object.keys(assignments), ...this.refs.keys()])
      return [...names].sort().map(
        (name): Row => ({
          name,
          groups: [
            ...new Set([
              ...(this.refs.get(name) ?? []),
              ...(assignments[name]?.group ? [assignments[name].group] : []),
              ...COMMON_GROUPS,
            ]),
          ],
        })
      )
    }, [assignments, scans])

    const needle = query
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_')
    const shown = React.useMemo(() => {
      const matching = rows.filter(({ name }) => {
        if (filter === 'overridden' && !(name in overrides)) return false
        if (filter === 'assigned' && !assignments[name]) return false
        if (filter === 'unassigned' && assignments[name]) return false
        return name.includes(needle)
      })
      if (needle)
        matching.sort(
          (a, b) =>
            Number(!a.name.startsWith(needle)) -
            Number(!b.name.startsWith(needle))
        )
      // an experiment in code that hasn't loaded yet can still be set by name
      if (
        filter === 'all' &&
        /^[\w.-]{1,120}$/.test(needle) &&
        !matching.some(({ name }) => name === needle)
      )
        matching.push({ name: needle, groups: COMMON_GROUPS })
      return matching
    }, [rows, filter, needle, overrides, assignments])

    const count = Object.keys(overrides).length
    const booted = Object.entries(this.booted)
    const needsReload =
      booted.length !== count ||
      booted.some(([name, group]) => overrides[name] !== group)

    const resetAll = async () => {
      const ok = await this.api.modal.confirm({
        title: 'Reset all experiments?',
        body: `Removes ${count} override${count === 1 ? '' : 's'}.`,
        confirmText: 'Reset',
      })
      if (ok) this.save(() => ({}))
    }

    return (
      <div className="taut-experiments">
        <h2 className="taut-experiments__title">Experiments</h2>
        <p className="sk_foreground_max">
          Unreleased features can break Slack. Reset all if something goes
          wrong.
        </p>
        <div className="taut-experiments__bar">
          <span className="taut-experiments__muted">
            {count ? `${count} overridden` : 'Nothing overridden'}
          </span>
          {count > 0 && (
            <elements.Button type="outline" size="small" onClick={resetAll}>
              Reset all
            </elements.Button>
          )}
          {needsReload && (
            <elements.Button size="small" onClick={() => location.reload()}>
              Reload to apply
            </elements.Button>
          )}
        </div>
        <elements.FormTextInput
          placeholder={`Search ${rows.length.toLocaleString()} experiments`}
          value={query}
          onChange={(value) => {
            setQuery(value)
            setLimit(PAGE)
          }}
        />
        <div className="taut-experiments__filters">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'overridden', label: 'Overridden' },
              { id: 'assigned', label: 'Assigned' },
              { id: 'unassigned', label: 'Not assigned' },
            ] satisfies { id: Filter; label: string }[]
          ).map((option) => (
            <elements.FilterPill
              key={option.id}
              isActive={filter === option.id}
              aria-pressed={filter === option.id}
              onClick={() => {
                setFilter(option.id)
                setLimit(PAGE)
              }}
            >
              {option.label}
            </elements.FilterPill>
          ))}
        </div>
        {shown.length === 0 && (
          <p className="taut-experiments__muted">No experiments match.</p>
        )}
        <ul className="taut-experiments__rows">
          {shown.slice(0, limit).map((row) => (
            <this.Row
              key={row.name}
              row={row}
              assigned={assignments[row.name]?.group}
              override={overrides[row.name]}
              effective={effective[row.name]?.group ?? null}
            />
          ))}
        </ul>
        {shown.length > limit && (
          <div className="taut-experiments__bar">
            <elements.Button
              type="outline"
              size="small"
              onClick={() => setLimit(limit + PAGE)}
            >
              Show more
            </elements.Button>
            <span className="taut-experiments__muted">
              {limit.toLocaleString()} of {shown.length.toLocaleString()}
            </span>
          </div>
        )}
      </div>
    )
  }

  private readonly Row = React.memo(
    ({
      row,
      assigned,
      override,
      effective,
    }: {
      row: Row
      assigned: string | undefined
      override: string | null | undefined
      /** the group Slack reads, which another plugin may be forcing */
      effective: string | null
    }) => {
      const { elements } = this.api
      const [custom, setCustom] = React.useState<string | null>(null)

      const options = React.useMemo(() => {
        const groups = new Set(row.groups)
        if (typeof override === 'string') groups.add(override)
        // the leading space keeps these values apart from group names
        return [
          { label: `Default (${assigned ?? 'none'})`, value: ' default' },
          ...[...groups].map((group) => ({ label: group, value: group })),
          ...(assigned || override === null
            ? [{ label: 'Not assigned', value: ' none' }]
            : []),
          { label: 'Custom...', value: ' custom' },
        ]
      }, [row.groups, assigned, override])
      const value =
        custom !== null
          ? ' custom'
          : override === undefined
            ? ' default'
            : override === null
              ? ' none'
              : override
      const picked = override === undefined ? (assigned ?? null) : override
      const commit = () => {
        const group = custom?.trim()
        if (group) this.setOverride(row.name, group)
        setCustom(null)
      }

      return (
        <li
          className={`taut-experiments__row${override !== undefined ? ' taut-experiments__row--overridden' : ''}`}
        >
          <span className="taut-experiments__name">{row.name}</span>
          <elements.BasicSelect
            selectId={`taut-experiments__${row.name}`}
            ariaLabel={`Group for ${row.name}`}
            options={options}
            selectedOption={options.find((option) => option.value === value)}
            width={180}
            onSelectionChange={(option) => {
              if (option.value === ' custom') return setCustom(override ?? '')
              setCustom(null)
              this.setOverride(
                row.name,
                option.value === ' default'
                  ? undefined
                  : option.value === ' none'
                    ? null
                    : option.value
              )
            }}
          />
          {effective !== picked && (
            <span className="taut-experiments__forced">
              Forced by a plugin: {effective ?? 'not assigned'}
            </span>
          )}
          {custom !== null && (
            <div className="taut-experiments__custom">
              <elements.FormTextInput
                placeholder="Group"
                value={custom}
                autoFocus
                onChange={setCustom}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commit()
                }}
              />
              <elements.Button
                type="outline"
                size="medium"
                disabled={!custom.trim()}
                onClick={commit}
              >
                Set
              </elements.Button>
            </div>
          )}
        </li>
      )
    }
  )
}
