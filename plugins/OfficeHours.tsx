// Weekly schedules for going out of office or appearing away

import {
  type JsonValue,
  type OptEditorProps,
  opt,
  type ScheduleWindow,
  type SlackStatus,
  TautPlugin,
  type Weekday,
} from '$taut'

type Kind = 'outOfOffice' | 'invisible'
type Status = { text: string; emoji: string }
/** rich text blocks, from Slack's out of office reply field */
type Reply = Record<string, JsonValue>[]
/** a status this plugin set and will undo */
type Held = {
  /** when the window it was set for ends */
  until: number
  since: number
  /** the status it replaced, to put back */
  previous?: SlackStatus
  status?: Status
  message?: Reply
  /** whether pausing notifications was asked for */
  pause?: boolean
  /** whether notifications were paused with it */
  snoozed?: boolean
}
type State = {
  held: Partial<Record<Kind, Held>>
  /** changed by hand in a window, so left alone until this time */
  handsOff: Partial<Record<Kind, number>>
}

// Slack's "Out of office" preset
const OOO: Status = { text: 'Out of office', emoji: ':no_entry:' }
const TICK = 30_000
// our own change takes a moment to come back over the socket
const SETTLE = 60_000
// Slack's clock, which expires the status, can be off ours
const SKEW = 5 * 60_000
// what Slack's status and out of office reply fields allow
const STATUS_MAX = 100
const REPLY_MAX = 200

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export default class OfficeHours extends TautPlugin<typeof OfficeHours> {
  static readonly id = 'OfficeHours'
  static readonly pluginName = 'Office Hours'
  static readonly description =
    'Weekly schedules for going out of office or appearing away'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'people'
  static readonly defaultConfig = {
    enabled: false,
    outOfOffice: opt(
      [] as ScheduleWindow[],
      'When to set your status to Out of office, in your Slack time zone',
      { label: 'Out of office', editor: ScheduleEditor, check: checkSchedule }
    ),
    status: opt(OOO, 'Your status while out of office', {
      editor: StatusEditor,
      check: checkStatus,
    }),
    pauseNotifications: opt(
      false,
      'While out of office, until your status is cleared'
    ),
    message: opt([] as Reply, 'Sent to people who message you while out', {
      label: 'Automatic reply',
      editor: ReplyEditor,
      check: checkReply,
    }),
    invisible: opt(
      [] as ScheduleWindow[],
      'When to appear away, in your Slack time zone',
      { label: 'Away', editor: ScheduleEditor, check: checkSchedule }
    ),
  }

  private running?: Promise<unknown>
  private state = this.api.storage.store<State>('state', {
    held: {},
    handsOff: {},
  })
  private timer?: ReturnType<typeof setInterval>

  start() {
    this.timer = setInterval(() => this.schedule(), TICK)
    this.schedule()
  }

  // a config change restarts, leave what's set and let the next start fix it
  async stop() {
    clearInterval(this.timer)
    await this.running
  }

  /** every tab ticks, one at a time */
  private schedule() {
    if (this.running) return
    this.running = navigator.locks
      .request('taut-office-hours__state', { signal: this.api.signal }, () =>
        this.tick()
      )
      .catch((error) => {
        if (!this.api.signal.aborted) this.warn(error)
      })
      .finally(() => {
        this.running = undefined
      })
  }

  /** works out what should be set from the schedule and the saved state */
  private async tick() {
    const now = Date.now()
    const { profile } = this.api
    if (this.api.signal.aborted || !profile.getStatus()) return
    // another tab may have just saved a tick
    const saved = await this.state.refresh()
    const state = { held: { ...saved.held }, handsOff: { ...saved.handsOff } }
    const timeZone = profile.getTimeZone()
    for (const kind of ['outOfOffice', 'invisible'] as const) {
      const until = this.api.scheduleEnd(this.config[kind], timeZone)
      const held = state.held[kind]
      const handsOff = state.handsOff[kind]
      if (handsOff !== undefined && (until === null || now >= handsOff)) {
        delete state.handsOff[kind]
      }

      if (held && until === null) {
        await this.release(kind, held)
        delete state.held[kind]
      } else if (held && now - held.since > SETTLE && !this.isSet(kind)) {
        // Slack may have expired the status a little early by its clock, that's fine
        if (held.until - now < SKEW) await this.release(kind, held)
        else {
          this.log(`${kind} changed by hand, leaving it alone for now`)
          await this.endPause(held)
        }
        delete state.held[kind]
        if (until !== null) state.handsOff[kind] = until
      } else if (
        until !== null &&
        this.differs(kind, until, held) &&
        state.handsOff[kind] === undefined &&
        // already out or away on their own, not ours to undo later
        (held || !this.isSet(kind))
      ) {
        state.held[kind] = await this.apply(kind, until, held)
      } else continue
      await this.state.set({
        held: { ...state.held },
        handsOff: { ...state.handsOff },
      })
    }
  }

  /** whether what's set for `kind` isn't what the config now asks for */
  private differs(kind: Kind, until: number, held?: Held): boolean {
    if (held?.until !== until) return true
    return (
      kind === 'outOfOffice' &&
      (!same(held.status, this.config.status) ||
        !same(held.message, this.config.message) ||
        held.pause !== this.config.pauseNotifications)
    )
  }

  private isSet(kind: Kind): boolean {
    const { profile } = this.api
    return kind === 'invisible'
      ? profile.getPresence() === 'away'
      : profile.getStatus()?.canonical === OOO.text
  }

  private async apply(kind: Kind, until: number, held?: Held): Promise<Held> {
    const { profile } = this.api
    const since = Date.now()
    this.log(`${kind} until ${new Date(until).toLocaleString()}`)
    if (kind === 'invisible') {
      // still away from before, only the end moved
      if (held) return { ...held, until }
      await profile.setPresence('away')
      return { until, since }
    }
    const { status, message, pauseNotifications: pause } = this.config
    const previous = held ? held.previous : profile.getStatus()
    if (
      held?.until !== until ||
      !same(held.status, status) ||
      !same(held.message, message)
    ) {
      // expires with the window, so Slack clears it even if Taut isn't running
      await profile.setStatus({
        ...status,
        // kept when the text is changed, as Slack's dialog does
        canonical: OOO.text,
        expiration: until,
        oooMessage: message,
      })
    }
    const snoozeEnd = profile.getSnooze()
    const snoozed = pause && (held?.snoozed || !snoozeEnd || snoozeEnd < until)
    const paused = snoozeEnd && Math.abs(snoozeEnd - until) < SKEW
    if (snoozed && !paused) await profile.setSnooze(until)
    else if (!snoozed && held?.snoozed) await profile.setSnooze(null)
    return { until, since, previous, status, message, pause, snoozed }
  }

  /** undoes only what's still ours, Slack may already have expired it */
  private async release(kind: Kind, held: Held) {
    const { profile } = this.api
    this.log(`${kind} ended`)
    if (kind === 'invisible') {
      if (profile.getPresence() === 'away') await profile.setPresence('auto')
      return
    }
    const status = profile.getStatus()
    if (
      status?.canonical === OOO.text ||
      (status && !status.text && !status.emoji)
    ) {
      const { previous } = held
      const keep =
        previous &&
        (previous.text || previous.emoji) &&
        (!previous.expiration || previous.expiration > Date.now())
      await profile.setStatus({ ...(keep ? previous : {}), oooMessage: [] })
    }
    await this.endPause(held)
  }

  /** the pause goes with the status, unless it was changed since */
  private async endPause(held: Held) {
    const snoozeEnd = this.api.profile.getSnooze()
    if (held.snoozed && snoozeEnd && Math.abs(snoozeEnd - held.until) < SKEW) {
      await this.api.profile.setSnooze(null)
    }
  }

  private warned = false
  private warn = (error: unknown) => {
    if (this.warned) return
    this.warned = true
    console.warn('[Taut] [Office Hours] Could not update your status:', error)
  }
}

const DAYS: [Weekday, string][] = [
  ['sun', 'Sunday'],
  ['mon', 'Monday'],
  ['tue', 'Tuesday'],
  ['wed', 'Wednesday'],
  ['thu', 'Thursday'],
  ['fri', 'Friday'],
  ['sat', 'Saturday'],
]

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

function checkSchedule(windows: ScheduleWindow[]): string | null {
  for (const window of windows) {
    const found = JSON.stringify(window)
    if (!window || typeof window !== 'object') {
      return `expected a time window, found ${found}`
    }
    const { days, start, end } = window
    if (
      !Array.isArray(days) ||
      !days.every((day) => DAYS.some(([d]) => d === day)) ||
      new Set(days).size !== days.length
    ) {
      return `${found}: days must be ${DAYS.map(([d]) => `"${d}"`).join(', ')}`
    }
    if (![start, end].every((time) => TIME.test(String(time)))) {
      return `${found}: start and end must be 24-hour "HH:MM" times`
    }
  }
  return null
}

function ScheduleEditor({
  value,
  onChange,
  label,
  api,
}: OptEditorProps<ScheduleWindow[]>) {
  const { FilterPill, Button, Tooltip, SvgIcon, TimePicker } = api.elements
  // the look of Slack's start/end box in its status dialog
  React.useEffect(
    () =>
      api.setStyle(`
        .taut-schedule {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin: 0 0 8px;
          padding: 12px;
          list-style: none;
          border-radius: 8px;
          background: var(--dt_color-ctr-sec);
        }
        .taut-schedule__row {
          display: flex;
          flex-wrap: wrap;
          align-items: center;
          gap: 8px;
        }
        .taut-schedule__days {
          display: flex;
          gap: 3px;
        }
        .taut-schedule__day.taut-schedule__day {
          width: 24px;
          height: 28px;
          min-width: 0;
          padding: 0;
        }
        .taut-schedule__day .c-filter-pill__content {
          width: 100%;
          justify-content: center;
        }
        .taut-schedule__times {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .taut-schedule__next-day {
          width: 16px;
          font-size: 12px;
          color: var(--dt_color-content-sec);
          white-space: nowrap;
        }
        .taut-schedule__remove {
          margin-left: auto;
        }
      `),
    [api]
  )
  const update = (index: number, patch: Partial<ScheduleWindow>) =>
    onChange(value.map((w, i) => (i === index ? { ...w, ...patch } : w)))
  const time = (
    window: ScheduleWindow,
    i: number,
    key: 'start' | 'end',
    name: string
  ) => (
    <TimePicker
      value={window[key]}
      onChange={(next) => {
        if (next !== window[key]) update(i, { [key]: next })
      }}
      ariaLabel={`${label}, ${name}`}
      optionsHourIncrement="half"
      size="small"
      width={116}
      showTimeZone={false}
      isRequired
    />
  )
  return (
    <div>
      {value.length > 0 && (
        <ul className="taut-schedule" aria-label={label}>
          {value.map((window, i) => (
            <li key={i} className="taut-schedule__row">
              <span className="taut-schedule__days">
                {DAYS.map(([day, name]) => {
                  const on = window.days.includes(day)
                  return (
                    <FilterPill
                      key={day}
                      className="taut-schedule__day"
                      isActive={on}
                      aria-pressed={on}
                      onClick={() =>
                        update(i, {
                          days: DAYS.map(([d]) => d).filter((d) =>
                            d === day ? !on : window.days.includes(d)
                          ),
                        })
                      }
                    >
                      <span aria-hidden="true">{name[0]}</span>
                      <span className="offscreen">{name}</span>
                    </FilterPill>
                  )
                })}
              </span>
              <span className="taut-schedule__times">
                {time(window, i, 'start', 'from')}
                <span aria-hidden="true">–</span>
                {time(window, i, 'end', 'to')}
                <span className="taut-schedule__next-day">
                  {window.end <= window.start && (
                    <Tooltip tip="Ends the next day">
                      <span>
                        <span aria-hidden="true">+1</span>
                        <span className="offscreen">Ends the next day</span>
                      </span>
                    </Tooltip>
                  )}
                </span>
              </span>
              <Tooltip tip="Remove">
                <Button
                  type="ghost"
                  size="small"
                  className="c-button--icon taut-schedule__remove"
                  aria-label={`Remove from ${label}`}
                  onClick={() => onChange(value.filter((_, j) => j !== i))}
                >
                  <SvgIcon name="close" size={16} inline />
                </Button>
              </Tooltip>
            </li>
          ))}
        </ul>
      )}
      <Button
        size="small"
        type="outline"
        onClick={() =>
          onChange([
            ...value,
            {
              days: ['mon', 'tue', 'wed', 'thu', 'fri'],
              start: '17:00',
              end: '09:00',
            },
          ])
        }
      >
        Add times
      </Button>
    </div>
  )
}

const EMOJI = /^(:[^\s:]+(::[^\s:]+)?:)?$/

function checkStatus(status: Status): string | null {
  const { text, emoji } = status
  if (typeof text !== 'string' || typeof emoji !== 'string') {
    return `expected text and emoji, found ${JSON.stringify(status)}`
  }
  if (text.length > STATUS_MAX) {
    return `the text can be ${STATUS_MAX} characters at most`
  }
  if (!EMOJI.test(emoji)) {
    return `the emoji must look like ":no_entry:", found "${emoji}"`
  }
  if (!text.trim() && !emoji) return 'a status needs text or an emoji'
  return null
}

function StatusEditor({ value, onChange, label, api }: OptEditorProps<Status>) {
  const { EmojiMenuTrigger, MrkdwnElement, SvgIcon } = api.elements
  React.useEffect(
    () =>
      api.setStyle(`
        .taut-status__text {
          flex: 1;
          min-width: 0;
          height: 38px;
          padding: 0 12px 0 0;
          border: 0;
          outline: 0;
          background: none;
          color: inherit;
          font: inherit;
        }
        .taut-status__text::placeholder {
          color: var(--dt_color-content-ter);
        }
        /* the emoji's name tooltip would cover the picker's */
        .taut-status__emoji > * {
          pointer-events: none;
        }
      `),
    [api]
  )
  const [text, setText] = React.useState(value.text)
  React.useEffect(() => setText(value.text), [value.text])
  const save = (change: Partial<Status>) => {
    const next = { ...value, ...change }
    if (!same(next, value)) onChange(next)
  }
  return (
    <div className="c-basic_container c-basic_container--bordered c-basic_container--prefixed p-custom_status_modal__input">
      <div className="c-basic_container__body">
        <EmojiMenuTrigger
          position="bottom"
          offsetY={5}
          onEmojiSelected={(_, name) => save({ emoji: `:${name}:` })}
        >
          <button
            type="button"
            className="c-button-unstyled p-custom_status_modal__input_action taut-status__emoji"
            aria-label={`Status emoji: ${value.emoji || 'none'}`}
          >
            {value.emoji ? (
              <MrkdwnElement text={value.emoji} />
            ) : (
              <SvgIcon name="emoji" size={20} />
            )}
          </button>
        </EmojiMenuTrigger>
        <input
          className="taut-status__text"
          value={text}
          maxLength={STATUS_MAX}
          aria-label={label}
          placeholder="What’s your status?"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => save({ text: text.trim() })}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save({ text: text.trim() })
          }}
        />
      </div>
    </div>
  )
}

function checkReply(blocks: Reply): string | null {
  for (const block of blocks) {
    if (block?.type !== 'rich_text' || !Array.isArray(block.elements)) {
      return `expected rich_text blocks, found ${JSON.stringify(block)}`
    }
  }
  const length = replyLength(blocks)
  if (length > REPLY_MAX) {
    return `the reply can be ${REPLY_MAX} characters at most, found ${length}`
  }
  return null
}

type Element = Record<string, JsonValue>
const str = (value: JsonValue | undefined) =>
  typeof value === 'string' ? value : ''
const list = (value: JsonValue | undefined) =>
  (Array.isArray(value) ? value : []) as Element[]

/** counts like Slack's convertContentsToStringForDisplay */
function replyLength(blocks: Reply): number {
  let text = ''
  const line = (elements: Element[]) => {
    const part = elements.map(inlineText).join('')
    if (part) text += part.endsWith('\n') ? part : `${part}\n`
  }
  for (const block of blocks) {
    for (const element of list(block.elements)) {
      if (element.type === 'rich_text_list') {
        for (const item of list(element.elements)) line(list(item.elements))
      } else line(list(element.elements))
    }
  }
  return text.replace(/\n$/, '').length
}

function inlineText(element: Element): string {
  switch (element.type) {
    case 'text':
      return str(element.text)
    case 'emoji': {
      const tone = element.skin_tone
      return `:${str(element.name)}:${tone ? `:skin-tone-${tone}:` : ''}`
    }
    case 'link':
      return str(element.text) || str(element.url)
    case 'broadcast':
      return `@${str(element.range)}`
    case 'date':
      return str(element.fallback)
    case 'color':
      return str(element.value)
    case 'user':
    case 'usergroup':
    case 'channel':
      return '@a'
    default:
      return ''
  }
}

function ReplyEditor({ value, onChange, label, api }: OptEditorProps<Reply>) {
  const edited = React.useRef({ blocks: value, length: 0 })
  // a new value from elsewhere resets
  const [version, setVersion] = React.useState(0)
  React.useEffect(() => {
    if (same(value, edited.current.blocks)) return
    edited.current = { blocks: value, length: 0 }
    setVersion((v) => v + 1)
  }, [value])
  const { RichTextInput } = api.elements
  return (
    <RichTextInput
      key={version}
      value={value}
      onChange={(blocks, length) => {
        edited.current = { blocks: blocks as Reply, length }
      }}
      onBlur={() => {
        const { blocks, length } = edited.current
        if (length <= REPLY_MAX && !same(blocks, value)) onChange(blocks)
      }}
      ariaLabel={label}
      placeholder="I’m out of office right now."
      maxLength={REPLY_MAX}
    />
  )
}
