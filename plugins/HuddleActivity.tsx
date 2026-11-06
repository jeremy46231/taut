// Logs who did what in a huddle, including mutes and settings changes

import { opt, type PeerMessageEvent, TautPlugin } from '$taut'

/** a log line: text and user ids, each id drawn as that person's name */
type Note = Array<string | { userId: string }>
type LogEntry = {
  type: 'JOIN'
  memberId: string | undefined
  timestampMs: number
  tautNote: Note
}
type LogEvent = { type?: string; timestampMs?: number; tautNote?: Note }
type HuddleEvents = {
  enabled?: boolean
  isLoading?: boolean
  events?: LogEvent[]
  isSideBySideEnabled?: boolean
  isClosedCaptionsEnabled?: boolean
}
type InviteStatus = 'pending' | 'declined'
type KnockStatus = 'pending' | 'accepted' | 'expired'
type Room = {
  id?: string
  name?: string
  locale?: string
  background_id?: string
  last_invite_status_by_user?: Record<string, InviteStatus>
  knocks?: Record<string, KnockStatus>
}
type Theme = { id?: string; name?: string; category?: { name?: string } }
type RoomEvent = { type?: string; user?: unknown; room?: Room }
type TranscriptionStatus = {
  type?: string
  eventTimeMs?: number
  transcriptionConfiguration?: string
}
type Thunk = (...args: any[]) => any

// how long before a language change's room update its transcription stop can arrive
const STATUS_WAIT_MS = 3_000
// how long after a language change its transcription restart and Slack's toast can arrive
const LANGUAGE_CHANGE_MS = 10_000

// timeout for Slack's huddle actions, which load with its huddle code
const ACTION_WAIT_MS = 10_000

const languageName = (locale: string): string => {
  try {
    return (
      new Intl.DisplayNames([navigator.language], { type: 'language' }).of(
        locale
      ) ?? locale
    )
  } catch {
    return locale
  }
}

export default class HuddleActivity extends TautPlugin<typeof HuddleActivity> {
  static readonly id = 'HuddleActivity'
  static readonly pluginName = 'Huddle Activity'
  static readonly description =
    'Logs who did what in a huddle, including mutes and settings changes'
  static readonly authors = ['izie', 'jeremy'] as const
  static readonly category = 'people'
  static readonly defaultConfig = {
    enabled: true,
    toasts: opt.select(
      [
        { value: 'all', label: 'Everything' },
        { value: 'mutes', label: 'Only mutes' },
        { value: 'none', label: 'None' },
      ],
      'all',
      'Which toasts to show'
    ),
  }

  /** the current huddle's added log lines, merged into Slack's `huddleEvents` at read time */
  private entries: LogEntry[] = []
  private callId: string | undefined
  /** each huddle's room as the websocket last sent it */
  private rooms = new Map<string, Room>()
  /** whether the plugin is responsible for the log being open */
  private ownLog = false
  private leaving = false
  private localeChange: { at: number; userId?: string } | undefined
  private enableLog = this.api.waitForExport<() => object>(
    this.api.byMeta('enableEventLog')
  )
  private disableLog = this.api.waitForExport<() => object>(
    this.api.byMeta('disableEventLog')
  )
  /** `enableEventLog` is waiting to be dispatched, so store changes meanwhile don't start another */
  private opening = false
  private unsubscribe: (() => void) | undefined

  async start() {
    this.api.redux.patchState(this.withEntries)
    this.patchLog()
    this.patchMuteBanner()
    this.patchTranscription()
    this.patchCaptionsMenu()
    this.patchLanguageToast()
    this.api.huddles.onPeerMessage((event) => this.onPeerMessage(event))
    for (const type of ['sh_room_join', 'sh_room_leave', 'sh_room_update'])
      this.api.rtm.on(type, (event) => this.onRoomEvent(event as RoomEvent))

    await this.api.redux.waitForStore()
    if (this.api.signal.aborted) return
    this.api.huddles.onActiveHuddle((huddle) => {
      if (huddle?.callId === this.callId) return
      this.callId = huddle?.callId
      this.entries = []
      this.ownLog = false
      this.api.redux.refresh()
      this.keepLogOpen()
    })
    // follows the workspace, so switching doesn't leave the old store subscribed
    this.unsubscribe = this.api.redux.subscribe(this.keepLogOpen)
  }

  stop() {
    this.unsubscribe?.()
    // only turn off the log that we're responsible for that would otherwise be off
    if (this.callId && this.ownLog && !this.captionsOn())
      this.dispatch(this.disableLog)
  }

  private rawLog(): HuddleEvents | undefined {
    return this.api.redux.getRawState()?.huddleEvents
  }

  /** whether you turned captions on, which Slack stores as these view flags */
  private captionsOn(): boolean {
    const log = this.rawLog()
    return !!(log?.isSideBySideEnabled || log?.isClosedCaptionsEnabled)
  }

  private async dispatch(action: Promise<() => object>) {
    const create = await this.api.within(
      action,
      ACTION_WAIT_MS,
      "Slack's event log action"
    )
    if (!create) return
    this.api.redux.getStore()?.dispatch(create())
  }

  /** Slack only logs while its captions are on, so turn the log on locally in every huddle */
  private keepLogOpen = () => {
    if (!this.callId) return
    const log = this.rawLog()
    if (!log || log.isLoading || log.enabled || this.opening) return
    this.ownLog = true
    this.opening = true
    this.dispatch(this.enableLog).finally(() => {
      this.opening = false
    })
  }

  // the Captions tab only exists while side-by-side captions are on
  private withEntries = (state: any) => {
    const log: HuddleEvents | undefined = state?.huddleEvents
    if (!log?.enabled || !this.callId) return state
    const events = this.entries.length
      ? [...(log.events ?? []), ...this.entries].sort(
          (a, b) => (a.timestampMs ?? 0) - (b.timestampMs ?? 0)
        )
      : log.events
    return {
      ...state,
      huddleEvents: { ...log, isSideBySideEnabled: true, events },
    }
  }

  /** the state with your real side-by-side setting, for the captions menu */
  private realCaptions = (state: any) => {
    const log = this.rawLog()
    if (!state?.huddleEvents || !log) return state
    return {
      ...state,
      huddleEvents: {
        ...state.huddleEvents,
        isSideBySideEnabled: log.isSideBySideEnabled,
      },
    }
  }

  private patchCaptionsMenu() {
    const StateView = this.api.redux.StateView
    for (const name of ['CaptionsSubmenu', 'CaptionsItemsMenu'])
      this.api.patchComponent(name, (Original) => (props) => (
        <StateView patch={this.realCaptions}>
          <Original {...props} />
        </StateView>
      ))
  }

  private addEntry(
    memberId: string | undefined,
    tautNote: Note,
    timestampMs = Date.now()
  ) {
    if (!this.callId) return
    this.entries = [
      ...this.entries,
      { type: 'JOIN', memberId, timestampMs, tautNote },
    ]
    this.api.redux.refresh()
  }

  private Name = ({ userId }: { userId?: string }) => {
    const member = this.api.members.useMember(userId ?? '')
    const profile = member?.profile
    return (
      <>
        {profile?.display_name ||
          profile?.real_name ||
          member?.real_name ||
          userId ||
          'Someone'}
      </>
    )
  }

  private renderNote(note: Note) {
    const Name = this.Name
    return note.map((part, i) =>
      typeof part === 'string' ? part : <Name key={i} userId={part.userId} />
    )
  }

  private toast(
    content: React.ReactNode,
    icon: string,
    about: 'mute' | 'other'
  ) {
    const { toasts } = this.config
    if (toasts === 'none' || (toasts === 'mutes' && about !== 'mute')) return
    this.api.redux
      .dispatchThunk('enqueueHuddleToast', {
        content,
        svgIconProps: { name: icon },
        duration: 5000,
      })
      .catch((err) => this.log('Could not show a toast', err))
  }

  private patchLog() {
    this.api.patchComponent<{ event?: LogEvent; tautNote?: Note }>(
      'HuddleMetaEvent',
      (Original) => (props) =>
        props.event?.tautNote ? (
          <Original {...props} tautNote={props.event.tautNote} />
        ) : (
          <Original {...props} />
        )
    )
    this.api.patchComponent<{ tautNote?: Note; children?: React.ReactNode }>(
      'HuddleBaseEvent',
      (Original) => (props) => {
        const { tautNote, ...rest } = props
        if (!tautNote) return <Original {...props} />
        return (
          <Original {...rest}>
            <span className="p-huddle_event_log__meta_text">
              {this.renderNote(tautNote)}
            </span>
          </Original>
        )
      }
    )
  }

  private patchMuteBanner() {
    const Name = this.Name
    this.api.patchComponent<{ bannerName?: string }>(
      'HuddlesAlertBannerBase',
      (Original) => (props) => {
        const muter = this.api.redux.useReduxState<string | undefined>(
          (state) =>
            state.alert?.alerts?.find(
              (alert: { type?: string }) => alert.type === 'peerMuteRequest'
            )?.id
        )
        const userId = muter && this.api.huddles.getAttendeeUserId(muter)
        if (props.bannerName !== 'informational_user_was_muted' || !userId)
          return <Original {...props} />
        return (
          <Original {...props}>
            <b>
              <Name userId={userId} /> muted you.
            </b>
          </Original>
        )
      }
    )
  }

  private onPeerMessage({
    message,
    kind,
    senderAttendeeId,
    selfAttendeeId,
  }: PeerMessageEvent) {
    const actor = this.api.huddles.getAttendeeUserId(senderAttendeeId)
    if (!actor) return
    const Name = this.Name
    const target = kind === 'muteRequest' && message.muteRequest?.peerId
    // requests at you are handled once Slack accepts them, it ignores some
    if (target && target !== selfAttendeeId) {
      const muted = this.api.huddles.getAttendeeUserId(target)
      if (!muted) return
      this.addEntry(actor, ['muted ', { userId: muted }, '.'])
      if (actor !== this.api.members.getCurrentMemberId())
        this.toast(
          <>
            <Name userId={actor} /> muted <Name userId={muted} />.
          </>,
          'microphone-off',
          'mute'
        )
    }
    const kicked =
      kind === 'kickNotification' && message.kickNotification?.kickedUserId
    if (kicked)
      this.addEntry(actor, [
        'removed ',
        { userId: kicked },
        ' from the huddle.',
      ])
  }

  private onMutedByPeer(peerId: string) {
    const actor = this.api.huddles.getAttendeeUserId(peerId)
    if (!actor) return
    const Name = this.Name
    this.addEntry(actor, ['muted you.'])
    // with more than one other person, Slack shows no banner for this
    const others = Object.keys(
      this.api.redux.getRawState()?.peers?.byId ?? {}
    ).length
    if (others > 1)
      this.toast(
        <>
          <Name userId={actor} /> muted you.
        </>,
        'microphone-off',
        'mute'
      )
  }

  private onRoomEvent(event: RoomEvent) {
    const room = event.room
    if (!room?.id) return
    const call = this.api.huddles.getCall(room.id)
    // before Slack stores the update, its copy is the previous state
    const before: Room | undefined =
      this.rooms.get(room.id) ??
      (call && {
        name: call.name,
        locale: call.locale,
        background_id: call.backgroundId,
      })
    this.rooms.set(room.id, room)
    // the websocket sends every huddle's updates, only this one and the current huddle are read
    for (const id of this.rooms.keys()) {
      if (id !== room.id && id !== this.callId) this.rooms.delete(id)
    }
    if (event.type !== 'sh_room_update' || !before || room.id !== this.callId)
      return

    const actor = typeof event.user === 'string' ? event.user : undefined
    const self = this.api.members.getCurrentMemberId()
    const Name = this.Name

    // including icon shows a toast
    const log = (text: string, icon?: string, at = Date.now()) => {
      this.addEntry(actor, [actor ? text : `Someone ${text}`], at)
      if (icon && actor && actor !== self)
        this.toast(
          <>
            <Name userId={actor} /> {text}
          </>,
          icon,
          'other'
        )
    }

    if (room.locale && room.locale !== before.locale) {
      this.localeChange = { at: Date.now(), userId: actor }
      // no toast, Slack shows its own
      log(`changed the huddle language to ${languageName(room.locale)}.`)
    }
    if (room.name !== before.name)
      log(
        room.name
          ? `renamed the huddle to "${room.name}".`
          : 'removed the huddle name.',
        'edit'
      )
    if (room.background_id !== before.background_id) {
      const at = Date.now()
      this.themeName(room.id, room.background_id).then((theme) => {
        if (this.api.signal.aborted || this.callId !== room.id) return
        log(
          theme
            ? `changed the huddle theme to ${theme}.`
            : 'changed the huddle theme.',
          'paintbrush',
          at
        )
      })
    }
    this.logStatusChanges(
      before.last_invite_status_by_user,
      room.last_invite_status_by_user,
      {
        pending: { text: 'was invited to the huddle.', icon: 'user-add' },
        // Slack sends toasts for declines itself
        declined: { text: 'declined the invite.' },
      }
    )
    this.logStatusChanges(before.knocks, room.knocks, {
      // Slack shows its own join request ui
      pending: { text: 'asked to join.' },
      accepted: { text: 'was let in.', icon: 'check-circle' },
    })
  }

  private async themeName(huddleId: string, themeId: string | undefined) {
    if (!themeId) return undefined
    await this.api.within(
      this.api.redux
        .dispatchThunk('maybeFetchBackgrounds', { huddleId })
        .catch((err) => this.log('Could not load huddle themes', err)),
      ACTION_WAIT_MS,
      "Slack's huddle themes"
    )
    const themes: Theme[] | undefined = this.api.redux.getStore()?.getState()
      .huddlesCanvas?.backgrounds
    const theme = themes?.find((theme) => theme.id === themeId)
    return theme?.name || theme?.category?.name
  }

  /** a line for each person whose status in `after` changed to one in `lines` */
  private logStatusChanges<Status extends string>(
    before: Record<string, Status> | undefined,
    after: Record<string, Status> | undefined,
    lines: Partial<Record<Status, { text: string; icon?: string }>>
  ) {
    // without an earlier map, every status would look new
    if (!before || !after) return
    const Name = this.Name
    const self = this.api.members.getCurrentMemberId()
    for (const [userId, status] of Object.entries(after)) {
      const line = lines[status]
      if (before[userId] === status || !line) continue
      this.addEntry(userId, [line.text])
      if (line.icon && userId !== self)
        this.toast(
          <>
            <Name userId={userId} /> {line.text}
          </>,
          line.icon,
          'other'
        )
    }
  }

  private patchTranscription() {
    // Slack calls this only for mute requests it accepts, after its rate limit
    this.api.redux.patchThunk(
      'displayAlertMessage',
      (original) => (options) => {
        if (options?.alert === 'peerMuteRequest' && options.peerId)
          this.onMutedByPeer(options.peerId)
        return original(options)
      }
    )

    this.api.redux.patchThunk(
      'processAwsTranscription',
      (original) => (event) => {
        if (event?.type) this.onTranscriptionStatus(event)
        return original(event)
      }
    )

    // Slack skips asking the server to transcribe when its log is already on, which ours always is
    this.api.redux.patchThunk('startEventLog', (original) => (...args) => {
      if (!this.rawLog()?.enabled) return original(...args)
      return () => this.setTranscription(true)
    })

    // Slack stops transcription for everyone whenever its log is on, so only when you had captions on, like stock
    this.api.redux.patchThunk('stopEventLog', (original) => (...args) => {
      if (this.leaving)
        return this.captionsOn() ? original(...args) : () => Promise.resolve()
      // turning captions off, without clearing the log
      return () => this.setTranscription(false)
    })

    this.api.redux.patchThunk('stopHuddle', (original) => (...args) => {
      const thunk = original(...args)
      return async (...thunkArgs: unknown[]) => {
        this.leaving = true
        try {
          return await (thunk as Thunk)(...thunkArgs)
        } finally {
          this.leaving = false
        }
      }
    })
  }

  private async setTranscription(on: boolean): Promise<unknown> {
    const callId = this.callId
    if (!callId) return Promise.resolve()
    try {
      return await this.api.redux.dispatchThunk(
        on ? 'roomsStartTranscriptionFetcher' : 'roomsStopTranscriptionFetcher',
        {
          reason: on ? 'start-event-log' : 'stop-event-log',
          callId,
        }
      )
    } catch (err) {
      return this.log('Could not change transcription', err)
    }
  }

  private onTranscriptionStatus(status: TranscriptionStatus) {
    const type = status.type?.toLowerCase()
    if (type !== 'started' && type !== 'stopped') return
    const receivedAt = Date.now()
    setTimeout(
      () => this.logTranscriptionStatus(type, status, receivedAt),
      STATUS_WAIT_MS
    )
  }

  private logTranscriptionStatus(
    type: 'started' | 'stopped',
    status: TranscriptionStatus,
    receivedAt: number
  ) {
    const change = this.localeChange
    if (this.api.signal.aborted) return
    if (change && receivedAt - change.at < LANGUAGE_CHANGE_MS) return
    let language: string | undefined
    try {
      language = JSON.parse(status.transcriptionConfiguration ?? '{}')
        ?.EngineTranscribeSettings?.LanguageCode
    } catch {}
    const text =
      type === 'started'
        ? `Transcription started${language ? ` in ${languageName(language)}` : ''}.`
        : 'Transcription stopped.'
    this.addEntry(undefined, [text], status.eventTimeMs || Date.now())
    this.toast(text, 'transcript', 'other')
  }

  private patchLanguageToast() {
    const Name = this.Name
    this.api.redux.patchThunk('enqueueHuddleToast', (original) => (options) => {
      const change = this.localeChange
      const locale = this.callId && this.rooms.get(this.callId)?.locale
      if (
        options?.huddleToastType !== 'language_change' ||
        !change?.userId ||
        !locale ||
        Date.now() - change.at > LANGUAGE_CHANGE_MS
      )
        return original(options)
      // Slack's toast is the sentence and an Undo link
      const [, undo] = React.Children.toArray(options.content?.props?.children)
      return original({
        ...options,
        content: (
          <>
            <div>
              <strong>
                <Name userId={change.userId} /> changed the huddle language to{' '}
                {languageName(locale)}.
              </strong>
            </div>
            {undo}
          </>
        ),
      })
    })
  }
}
