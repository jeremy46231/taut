// saved for the next page load since Slack reads many experiments before any plugin starts

import { patchThunk, refreshState } from './redux'
import { byMeta, patchFunctionExport } from './webpack'

/** a group to read as, or null to read as not assigned */
export type ExperimentGroup = string | null

/** one entry of Slack's `experiments` slice */
export type ExperimentAssignment = {
  experiment_id?: string
  type?: string
  group?: string
  trigger?: string
  log_exposures?: boolean
  exposure_id?: string | number
  schedule_ts?: number
}

const sets = new Set<ForcedExperiments>()
/** what the last page load forced in the end, used until plugins have started */
let bootForced: Map<string, ExperimentGroup> | undefined
let saving = false
let lastSaved: string | null = null
let forced: ReadonlyMap<string, ExperimentGroup> = new Map()
let forcedText = '[]'
let scheduled = false

/** no exposure logging and no `schedule_ts`, so it isn't reported as an exposure or sent in perf trace tags */
function forcedAssignment(
  assignment: ExperimentAssignment | undefined,
  group: string
): ExperimentAssignment {
  const { schedule_ts: _, ...base } = assignment ?? {
    // what Slack's overrideExperimentAssignments fills in
    type: 'user',
    experiment_id: 'from-override',
    exposure_id: 0,
    trigger: 'force_request',
  }
  return { ...base, group, log_exposures: false }
}

type Assignments = Record<string, ExperimentAssignment>

/** forced assignments by name, kept while the stored one and the group stay the same so selectors return the same object */
const assignmentMemo = new Map<
  string,
  {
    stored: ExperimentAssignment | undefined
    group: string
    out: ExperimentAssignment
  }
>()
let allMemo:
  | { stored: Assignments; forced: typeof forced; out: Assignments }
  | undefined

function assignmentFor(
  name: string,
  stored: ExperimentAssignment | undefined,
  group: ExperimentGroup
): ExperimentAssignment | undefined {
  if (group === null) return undefined
  const hit = assignmentMemo.get(name)
  if (hit && hit.stored === stored && hit.group === group) return hit.out
  const out = forcedAssignment(stored, group)
  assignmentMemo.set(name, { stored, group, out })
  return out
}

/** every assignment with the forced ones in */
function allAssignments(
  stored: Assignments | undefined
): Assignments | undefined {
  if (!forced.size || !stored) return stored
  if (allMemo?.stored === stored && allMemo.forced === forced)
    return allMemo.out
  const out = { ...stored }
  for (const [name, group] of forced) {
    const assignment = assignmentFor(name, stored[name], group)
    if (assignment) out[name] = assignment
    else delete out[name]
  }
  allMemo = { stored, forced, out }
  return out
}

// every read of state.experiments goes through these selectors, so nothing forced is ever in the store
for (const selector of ['getGroupForUser', 'getGroupForUserWithoutExposure'])
  patchFunctionExport(
    byMeta(selector),
    (original) =>
      (state, name, ...rest) => {
        const group = forced.get(name)
        return group === undefined ? original(state, name, ...rest) : group
      }
  )
patchFunctionExport(
  byMeta('getAssignmentByName'),
  (original) => (state, name) => {
    const group = forced.get(name)
    const stored = original(state, name)
    return group === undefined ? stored : assignmentFor(name, stored, group)
  }
)
patchFunctionExport(
  byMeta('getAllExperimentAssignments'),
  (original) => (state) => allAssignments(original(state))
)
patchFunctionExport(
  byMeta('getAllAssignmentsMatchingQuery'),
  (original) => (state, query) => {
    if (!forced.size) return original(state, query)
    const all = allAssignments(state?.experiments) ?? {}
    return Object.fromEntries(
      Object.entries(all).filter(([name]) => name.includes(query))
    )
  }
)

// logs an exposure for whatever the assignment says, log_exposures or not
patchThunk(
  'logExperimentExposure',
  (original) => (params?: { name?: unknown }) => {
    const thunk = original(params)
    return typeof params?.name === 'string' && forced.has(params.name)
      ? Object.assign(() => undefined, thunk)
      : thunk
  }
)

/** every set combined: higher priority wins, then the set made later */
function combined(): Map<string, ExperimentGroup> {
  const out = new Map<string, ExperimentGroup>()
  const ordered = [...sets].sort((a, b) => a.priority - b.priority)
  for (const set of ordered)
    for (const [name, group] of set) out.set(name, group)
  return out
}

function save(live: Map<string, ExperimentGroup>): void {
  const text = live.size ? JSON.stringify(Object.fromEntries(live)) : null
  if (text === lastSaved) return
  lastSaved = text
  try {
    if (text === null) localStorage.removeItem('taut_experiments')
    else localStorage.setItem('taut_experiments', text)
  } catch {}
}

function update(): void {
  scheduled = false
  const live = combined()
  if (saving) save(live)
  const next = bootForced ?? live
  const text = JSON.stringify([...next].sort())
  if (text === forcedText) return
  forced = next
  forcedText = text
  refreshState()
}

function scheduleUpdate(): void {
  if (scheduled) return
  scheduled = true
  queueMicrotask(update)
}

/** force what the last page load forced until plugins start, call before bootstrap awaits anything */
export function applySavedExperiments(): void {
  let saved: unknown
  try {
    lastSaved = localStorage.getItem('taut_experiments')
    saved = JSON.parse(lastSaved ?? 'null')
  } catch {}
  if (!saved || typeof saved !== 'object') return
  bootForced = new Map(
    Object.entries(saved).filter(
      (entry): entry is [string, ExperimentGroup] =>
        entry[1] === null || typeof entry[1] === 'string'
    )
  )
  update()
}

/** force what plugins' sets say from now on, saving it for the next page load */
export function switchToLiveExperiments(): void {
  bootForced = undefined
  saving = true
  update()
}

/** experiment name -> group, forced while the set exists (while the plugin runs, for `this.api.experiments`) */
export class ForcedExperiments {
  private readonly groups = new Map<string, ExperimentGroup>()
  private order = 0
  private disposed = false

  constructor() {
    sets.add(this)
  }

  /** the higher one wins when two sets force one experiment, starts at 0 */
  get priority(): number {
    return this.order
  }
  set priority(priority: number) {
    if (priority === this.order) return
    this.order = priority
    scheduleUpdate()
  }

  get size(): number {
    return this.groups.size
  }

  get(name: string): ExperimentGroup | undefined {
    return this.groups.get(name)
  }

  has(name: string): boolean {
    return this.groups.has(name)
  }

  /** read `name` as `group`, or as not assigned for null */
  set(name: string, group: ExperimentGroup): this {
    if (group !== null && typeof group !== 'string')
      throw new TypeError(`Experiment group must be a string or null`)
    if (this.disposed || this.groups.get(name) === group) return this
    this.groups.set(name, group)
    scheduleUpdate()
    return this
  }

  delete(name: string): boolean {
    const had = this.groups.delete(name)
    if (had) scheduleUpdate()
    return had
  }

  clear(): void {
    if (!this.groups.size) return
    this.groups.clear()
    scheduleUpdate()
  }

  keys(): IterableIterator<string> {
    return this.groups.keys()
  }

  entries(): IterableIterator<[string, ExperimentGroup]> {
    return this.groups.entries()
  }

  [Symbol.iterator](): IterableIterator<[string, ExperimentGroup]> {
    return this.groups.entries()
  }

  /** stop forcing any of them, for good */
  dispose = (): void => {
    this.disposed = true
    this.groups.clear()
    sets.delete(this)
    scheduleUpdate()
  }
}
