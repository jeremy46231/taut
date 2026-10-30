// Lets you reply and react anonymously as the author of your owl confessions

import { opt, TautPlugin } from '$taut'

const OWL_APPS: Readonly<Record<string, string>> = {
  A0C5L27PB9P: '',
  A0CDBA8FXDL: 'demo',
}
/** how long to wait for owl's shortcuts to load and for its modal to open */
const OWL_TIMEOUT = 10_000

type Block = Record<string, any>
type Owned = { key: string | null }
type Owl = 'owl' | 'demo'
type Thread = { channelId: string; threadTs: string }
type Confirmation = { id: string; replyKey: string | null }
type SendArgs = {
  channelId?: string
  replyToTs?: string
  delta?: { ops?: unknown[] }
  shouldBroadcast?: boolean
  dateScheduled?: unknown
  fileIds?: unknown[]
  pendingFileIds?: unknown[]
  slashCommandAppId?: string
  [key: string]: unknown
}

const FENCE = '```'
const SLASH_COMMAND_RE = /^[/\uFF0F][^/\uFF0F\s]/
const DRAFT_ID_RE = /^([A-Z0-9]+)-(\d+\.\d+)$/
const REACTION_KEY_RE = /^message-(\d+\.\d+)-([A-Z0-9]+)$/

function savedId(app: string, id: string): string {
  return OWL_APPS[app] ? `${OWL_APPS[app]}-${id}` : id
}
function parseSaved(saved: string) {
  const [, name = '', id = saved] = /^(?:([a-z]+)-)?(\d+)$/.exec(saved) ?? []
  const app = Object.keys(OWL_APPS).find((app) => OWL_APPS[app] === name)
  return { app, demo: !!name, label: `${name ? `${name} ` : ''}#${id}` }
}
/** which owl a saved id belongs to */
function owlOf(saved: string): Owl {
  return parseSaved(saved).demo ? 'demo' : 'owl'
}
/** the class that colors an element for `owl`, red for the demo */
function themeClass(owl: Owl): string {
  return owl === 'demo' ? ' taut-owl-demo' : ''
}

export default class OwlMode extends TautPlugin<typeof OwlMode> {
  static readonly id = 'OwlMode'
  static readonly pluginName = 'Owl Mode'
  static readonly description =
    'Lets you reply and react anonymously as the author of your owl confessions'
  static readonly authors = ['jeremy'] as const
  static readonly category = 'messages'
  static readonly hackClubOnly = true
  static readonly defaultConfig = {
    enabled: true,
    autoSave: opt(
      false,
      'Save confession keys in Taut whenever owl shows them, without asking'
    ),
  }

  /** the mention warning has been shown */
  private readonly mentionsWarned = this.api.storage.store(
    'mentionsWarned',
    false
  )
  /** member id -> confession id -> its reply key | null for an account hash */
  private readonly confessions = this.api.secrets.store(
    'confessions',
    {} as Record<string, Record<string, Owned>>
  )
  /** "channel-threadTs" -> owl mode turned on or off there */
  private readonly modes = new this.api.Store<ReadonlyMap<string, boolean>>(
    new Map()
  )
  /** client_token -> waiting for the modal a shortcut run with it opens */
  private readonly views = new Map<string, (viewId: string) => void>()
  /** the timestamp in the last client_token */
  private lastToken = 0
  /** Slack's thunk creators for running a shortcut and submitting its modal */
  private readonly thunks = {
    executeAppAction: this.api.redux.waitForThunkCreator('executeAppAction'),
    submitView: this.api.redux.waitForThunkCreator('submitView'),
  }
  /** "channel-threadTs" of each open composer in owl mode */
  private readonly composers = new this.api.SharedStore<readonly string[]>(
    'composers',
    []
  )
  /** which owl a thread in owl mode goes through, down to the popovers it opens */
  private readonly InOwlThread = React.createContext<Owl | null>(null)

  async start() {
    await Promise.all([this.confessions.ready, this.mentionsWarned.ready])
    if (this.api.signal.aborted) return

    this.api.setStyle(`
      body {
        --taut-owl: 26, 73, 214;
      }
      body.sk-client-theme--dark {
        --taut-owl: 120, 150, 255;
      }
      .taut-owl-demo {
        --taut-owl: 214, 48, 49;
      }
      body.sk-client-theme--dark .taut-owl-demo {
        --taut-owl: 255, 107, 107;
      }
      .c-wysiwyg_container.taut-owl-composer {
        --TextyTheme-wysiwyg-border-color: rgba(var(--taut-owl), 0.6);
        --TextyTheme-send-bg: rgba(var(--taut-owl), 1);
        --TextyTheme-send-bg-hover: rgba(var(--taut-owl), 0.85);
      }
      .c-wysiwyg_container.taut-owl-composer:focus-within {
        border-color: rgba(var(--taut-owl), 1);
      }
      .p-context_bar_v2.taut-owl-context-bar {
        background: rgba(var(--taut-owl), 0.1);
      }
      .taut-owl-context-bar .p-context_bar_v2__icon {
        color: rgba(var(--taut-owl), 1);
      }
      .taut-owl-context-bar__details {
        margin: -4px -4px -4px 8px;
      }
      .c-reaction_bar.taut-owl-reactions .c-reaction,
      .c-reaction_bar.taut-owl-reactions [data-qa="add_reaction_button"] {
        box-shadow: 0 0 0 1px rgba(var(--taut-owl), 1);
      }
      .c-reaction_bar.taut-owl-reactions .c-reaction:hover,
      .c-reaction_bar.taut-owl-reactions [data-qa="add_reaction_button"]:hover {
        background-color: rgba(var(--taut-owl), 0.08);
      }
      .c-reaction_bar.taut-owl-reactions .c-reaction--reacted,
      .c-reaction_bar.taut-owl-reactions .c-reaction--reacted:hover {
        background-color: rgba(var(--taut-owl), 0.15);
        color: var(--dt_color-content-pry);
      }
      .taut-owl-action,
      .taut-owl-picker {
        display: contents;
      }
      .taut-owl-action .c-message_actions__button,
      .taut-owl-action .c-message_actions__button:hover {
        color: rgba(var(--taut-owl), 1);
      }
      .taut-owl-action .c-message_actions__button:hover {
        background: rgba(var(--taut-owl), 0.1);
      }
      .taut-owl-picker .p-emoji_picker {
        box-shadow:
          0 0 0 1px rgba(var(--taut-owl), 1),
          0 4px 12px 0 #0000001f;
      }
      .taut-owl-save__button {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .taut-owl-save__button.c-button--outline {
        border-color: rgba(var(--taut-owl), 1);
        color: rgba(var(--taut-owl), 1);
      }
      .taut-owl-save__button.c-button--disabled {
        border-color: rgba(var(--taut-owl), 0.4);
        color: rgba(var(--taut-owl), 0.7);
      }
    `)

    this.api.rtm.on('view_opened', (event) => {
      const token = event.client_token
      const viewId = event.view_id
      if (typeof token !== 'string' || typeof viewId !== 'string') return
      this.views.get(token)?.(viewId)
    })

    this.api.composer.addButton({
      id: 'taut-owl-mode',
      placement: 'end',
      kinds: ['thread'],
      render: ({ channelId, threadTs }) => {
        const thread = this.useThread(channelId, threadTs)
        if (!thread) return null
        return {
          icon: thread.on ? 'glasses-filled' : 'glasses',
          label: thread.on
            ? 'Reply as yourself'
            : parseSaved(thread.id).demo
              ? 'Reply via (demo) Owl'
              : 'Reply anonymously via Owl',
          pressed: thread.on,
          onClick: () =>
            thread.owned
              ? this.setMode({ channelId, threadTs }, !thread.on)
              : this.claim({ channelId, threadTs }, thread.id),
        }
      },
    })

    this.api.patchComponent<{
      channelId?: string
      threadTs?: string
      dontShowBroadcastControls?: boolean
    }>('InputContainer', (Original) => (props) => {
      const on = !!this.useThread(props.channelId, props.threadTs)?.on
      const key = `${props.channelId}-${props.threadTs}`
      React.useEffect(() => {
        if (!on) return
        this.composers.update((keys) => [...keys, key])
        return () =>
          this.composers.update((keys) => {
            const at = keys.indexOf(key)
            return at < 0 ? keys : keys.filter((_, i) => i !== at)
          })
      }, [on, key])
      return on ? (
        <Original {...props} dontShowBroadcastControls />
      ) : (
        <Original {...props} />
      )
    })

    this.api.patchComponent<{
      channelId?: string
      threadTs?: string
      [enable: `enable${string}`]: boolean | undefined
    }>('MessageInput', (Original) => (props) => {
      const thread = this.useThread(props.channelId, props.threadTs)
      if (!thread?.on) return <Original {...props} />
      return (
        <this.InOwlThread.Provider value={owlOf(thread.id)}>
          <Original
            {...props}
            enableFileButton={false}
            enableStoryButton={false}
            enableAudioButton={false}
            enableGifPicker={false}
            enableScheduleSendButton={false}
            enableSlashCommandsButton={false}
            enableMentionButton={false}
          />
        </this.InOwlThread.Provider>
      )
    })

    // the message box itself, which edit boxes outside the owl composer also use
    this.api.patchComponent<{ className?: string }>(
      'WysiwygContainer',
      (Original) => (props) => {
        const owl = React.useContext(this.InOwlThread)
        return owl ? (
          <Original
            {...props}
            className={`${props.className ?? ''} taut-owl-composer${themeClass(owl)}`}
          />
        ) : (
          <Original {...props} />
        )
      }
    )

    this.api.patchComponent<{
      channelId?: string
      threadTs?: string
      ariaId?: string
      onIsContextBarShowing?: (showing: boolean) => void
    }>('BaseContextBarV2', (Original) => (props) => {
      const thread = this.useThread(props.channelId, props.threadTs)
      const on = !!thread?.on
      const { onIsContextBarShowing } = props
      React.useEffect(() => {
        if (on) onIsContextBarShowing?.(true)
      }, [on, onIsContextBarShowing])
      if (!thread || !on) return <Original {...props} />
      return (
        <div
          className={`p-context_bar_v2 taut-owl-context-bar${themeClass(owlOf(thread.id))}`}
          data-qa="context_bar"
          data-context-bar
        >
          <div className="p-context_bar_v2__icon">
            <this.api.elements.SvgIcon name="glasses-filled" />
          </div>
          <div className="p-context_bar_v2__content">
            <span id={props.ariaId}>
              {parseSaved(thread.id).demo
                ? 'Replying via (demo) Owl'
                : 'Replying anonymously via Owl'}
            </span>
          </div>
          <this.api.elements.Tooltip tip="Details" position="top" delay={500}>
            <this.api.elements.IconButtonBase
              className="taut-owl-context-bar__details"
              size="small"
              aria-label="Details"
              onClick={() => this.showDetails(thread.id)}
            >
              <this.api.elements.SvgIcon name="info" />
            </this.api.elements.IconButtonBase>
          </this.api.elements.Tooltip>
          <div className="p-context_bar_v2__filler" />
        </div>
      )
    })

    this.api.patchComponent<{ channelId?: string; threadTs?: string }>(
      'ShortcutsMenuTriggerButton',
      (Original) => (props) => {
        const thread = this.useThread(props.channelId, props.threadTs)
        return thread?.on ? null : <Original {...props} />
      }
    )

    this.api.redux.patchThunk(
      'prepareAndSendMessage',
      (original) =>
        (args: SendArgs, ...rest: unknown[]) => {
          const { channelId, replyToTs } = args ?? {}
          if (!channelId || !replyToTs) return original(args, ...rest)
          if (!this.isOn({ channelId, threadTs: replyToTs }))
            return original(args, ...rest)
          // rejecting puts the message back in the composer
          return () =>
            this.sendAsOwl({ channelId, threadTs: replyToTs }, args).catch(
              (err) => {
                this.failed("Owl didn't send your reply", err)
                throw err
              }
            )
        }
    )

    this.api.redux.patchThunk(
      'currentUserStartedTyping',
      (original) =>
        (args: { channelId?: string; threadTs?: string }, ...rest: unknown[]) =>
          args?.channelId &&
          args.threadTs &&
          this.isOn({ channelId: args.channelId, threadTs: args.threadTs })
            ? () => {}
            : original(args, ...rest)
    )

    // don't save messages as synced drafts, to mitigate accidentally sending them on other devices not via the plugin
    for (const name of ['syncDraftCreate', 'syncDraftUpdates']) {
      this.api.redux.patchThunk(
        name,
        (original) =>
          (args: { draftId?: string }, ...rest: unknown[]) => {
            const [, channelId, threadTs] =
              DRAFT_ID_RE.exec(args?.draftId ?? '') ?? []
            return channelId && this.isOn({ channelId, threadTs })
              ? () => Promise.resolve()
              : original(args, ...rest)
          }
      )
    }

    this.api.redux.patchThunk(
      'changeReactionFromUserAction',
      (original) =>
        (args: { key?: string; name?: string }, ...rest: unknown[]) => {
          const target = this.reactionTarget(args?.key)
          if (!target || !args.name) return original(args, ...rest)
          const name = args.name
          return () =>
            this.reactAsOwl(target, name).catch((err) =>
              this.failed("Owl didn't react", err)
            )
        }
    )
    // every other way of reacting ends here
    this.api.redux.patchThunk(
      'submitAddOrRemoveReaction',
      (original) =>
        (args: { reactionKey?: string }, ...rest: unknown[]) =>
          this.reactionTarget(args?.reactionKey)
            ? () =>
                Promise.reject(
                  new Error('[Taut] Owl mode held back a reaction as you')
                )
            : original(args, ...rest)
    )

    this.api.patchComponent<{
      reactionKey?: string
      className?: string
      currentUser?: string
    }>('ReactionBar', (Original) => (props) => {
      const owl = this.useReactionOwl(props.reactionKey)
      if (!owl) return <Original {...props} />
      return (
        <this.InOwlThread.Provider value={owl.owl}>
          <Original
            {...props}
            className={`${props.className ?? ''} taut-owl-reactions${themeClass(owl.owl)}`}
            // pills show as pressed where owl reacted
            currentUser={owl.user}
          />
        </this.InOwlThread.Provider>
      )
    })

    // the hover toolbar, the other component by this name wraps the whole message (edit box included)
    this.api.patchComponent<{ ts?: string; channelId?: string }>(
      'MessageActions',
      (Original) => (props) => {
        const owl = this.useReactionOwl(
          `message-${props.ts}-${props.channelId}`
        )
        if (!owl) return <Original {...props} />
        return (
          <this.InOwlThread.Provider value={owl.owl}>
            <Original {...props} />
          </this.InOwlThread.Provider>
        )
      }
    )
    this.api.patchComponent(
      'MessageActionButtonReaction',
      (Original) => (props) => {
        const owl = React.useContext(this.InOwlThread)
        return owl ? (
          <span className={`taut-owl-action${themeClass(owl)}`}>
            <Original {...props} />
          </span>
        ) : (
          <Original {...props} />
        )
      }
    )

    this.api.patchComponent<{
      ts?: string
      threadTs?: string
      channelId?: string
    }>('EmojiPickerPopover', (Original) => (props) => {
      const thread = this.useThread(props.channelId, props.threadTs ?? props.ts)
      if (!thread?.on) return <Original {...props} />
      return (
        <this.InOwlThread.Provider value={owlOf(thread.id)}>
          <Original {...props} />
        </this.InOwlThread.Provider>
      )
    })
    this.api.patchComponent('EmojiPicker', (Original) => (props) => {
      const owl = React.useContext(this.InOwlThread)
      return owl ? (
        <div className={`taut-owl-picker${themeClass(owl)}`}>
          <Original {...props} />
        </div>
      ) : (
        <Original {...props} />
      )
    })

    this.api.composer.addSendCheck(async (blocks, { channelId, threadTs }) => {
      if (!threadTs || !this.isOn({ channelId, threadTs })) return true
      let mentions = false
      this.api.blocks.mapRichTextElements(blocks, (element) => {
        if (['user', 'usergroup', 'broadcast'].includes(element.type))
          mentions = true
        return element
      })
      if (!mentions || this.mentionsWarned.get()) return true
      this.mentionsWarned
        .set(true)
        .catch((err) => this.log('Could not save the mention warning', err))
      return this.api.modal.confirm({
        title: 'Owl will show mentions as plain IDs',
        body: "People you mention won't be notified.",
        confirmText: 'Send anyway',
        cancelText: 'Keep editing',
      })
    })

    this.api.patchComponent<{ view?: { appId?: string; blocks?: unknown } }>(
      'ViewBlocks',
      (Original) => (props) => {
        const app = props.view?.appId
        const shown =
          app && Object.hasOwn(OWL_APPS, app)
            ? parseConfirmation(props.view?.blocks, app)
            : undefined
        if (!shown) return <Original {...props} />
        return (
          <>
            <Original {...props} />
            <this.SaveButton {...shown} />
          </>
        )
      }
    )
    this.api.patchComponent<{ msg?: Record<string, any> }>(
      'MessageBlocks',
      (Original) => (props) => {
        const { msg } = props
        const app = msg?.channel?.startsWith('D')
          ? this.owlAppOf(msg)
          : undefined
        const shown = app ? parseConfirmation(msg?.blocks, app) : undefined
        if (!shown) return <Original {...props} />
        return (
          <>
            <Original {...props} />
            <this.SaveButton {...shown} />
          </>
        )
      }
    )
  }

  private readonly SaveButton = ({ id, replyKey }: Confirmation) => {
    const saved = !!this.confessions.use()[this.me()]?.[id]
    const { autoSave } = this.config
    React.useEffect(() => {
      if (autoSave && !saved) this.save(id, replyKey)
    }, [autoSave, saved, id, replyKey])
    const { Button, SvgIcon } = this.api.elements
    // like a Block Kit actions block
    return (
      <div className="p-actions_block" data-stringify-ignore>
        <div className="p-actions_block_elements">
          <div className="p-actions_block__action">
            <Button
              type="outline"
              size="small"
              className={`p-block_kit_button_element taut-owl-save__button${themeClass(owlOf(id))}`}
              disabled={saved}
              onClick={() => this.save(id, replyKey)}
            >
              <SvgIcon name="glasses" size={16} />
              {saved ? 'Saved in Taut' : 'Save in Taut'}
            </Button>
          </div>
          {saved && (
            <div className="p-actions_block__action">
              <Button
                type="outline"
                size="small"
                className="p-block_kit_button_element"
                onClick={() => this.forget(id)}
              >
                Forget
              </Button>
            </div>
          )}
        </div>
      </div>
    )
  }

  private me(): string {
    return this.api.members.getCurrentMemberId() ?? ''
  }

  private owlAppOf(msg: Record<string, any> | undefined): string | undefined {
    if (!msg?.bot_id) return
    return [
      msg.bot_profile?.app_id,
      this.api.redux.getRawState()?.bots?.[msg.bot_id]?.app_id,
    ].find((app) => typeof app === 'string' && Object.hasOwn(OWL_APPS, app))
  }

  /** the saved id of an owl post */
  private confessionOf({ channelId, threadTs }: Thread): string | undefined {
    const root = this.api.messages.getRawMessage(channelId, threadTs)
    const app = this.owlAppOf(root)
    const id = app && /^(\d+): /.exec(String(root?.text ?? ''))?.[1]
    return id ? savedId(app, id) : undefined
  }

  private ownedRecord(id: string): Owned | undefined {
    return this.confessions.get()[this.me()]?.[id]
  }

  /** whether sends, typing and reactions in this thread go through owl */
  private isOn(thread: Thread): boolean {
    const id = this.confessionOf(thread)
    if (!id || !this.ownedRecord(id)) return false
    return (
      this.modes.get().get(`${thread.channelId}-${thread.threadTs}`) !== false
    )
  }

  /** `isOn` as a hook */
  private useThread(channelId?: string, threadTs?: string) {
    const id = this.api.redux.useReduxState(() =>
      channelId && threadTs
        ? this.confessionOf({ channelId, threadTs })
        : undefined
    )
    const owned = !!(id && this.confessions.use()[this.me()]?.[id])
    const explicit = this.modes.use().get(`${channelId}-${threadTs}`)
    if (!id) return null
    return { id, owned, on: owned && explicit !== false }
  }

  /** the message a reaction key points to, if its thread is in owl mode */
  private reactionTarget(
    reactionKey: string | undefined
  ): (Thread & { ts: string }) | undefined {
    // most people have no confessions saved
    const mine = this.confessions.get()[this.me()]
    if (!mine || !Object.keys(mine).length) return
    const [, ts, channelId] = REACTION_KEY_RE.exec(reactionKey ?? '') ?? []
    if (!ts || !channelId) return
    const msg = this.api.messages.getRawMessage(channelId, ts)
    const threadTs = String(msg?.thread_ts ?? ts)
    return this.isOn({ channelId, threadTs })
      ? { channelId, threadTs, ts }
      : undefined
  }

  /** owl's member id where a reaction bar is in owl mode, and which owl it is */
  private useReactionOwl(
    reactionKey: string | undefined
  ): { user: string; owl: Owl } | undefined {
    // rerenders when owl mode turns on or off
    this.confessions.use()
    this.modes.use()
    const root = () => {
      const target = this.reactionTarget(reactionKey)
      return (
        target &&
        this.api.messages.getRawMessage(target.channelId, target.threadTs)
      )
    }
    // separate selectors, an object would never compare equal
    const user = this.api.redux.useReduxState(() => {
      const owl = root()?.user
      return typeof owl === 'string' ? owl : undefined
    })
    const demo = this.api.redux.useReduxState(
      () => !!OWL_APPS[this.owlAppOf(root()) ?? '']
    )
    return user ? { user, owl: demo ? 'demo' : 'owl' } : undefined
  }

  private setMode({ channelId, threadTs }: Thread, on: boolean) {
    this.modes.update((modes) =>
      new Map(modes).set(`${channelId}-${threadTs}`, on)
    )
  }

  /** resolves whether it saved */
  private async save(id: string, key: string | null): Promise<boolean> {
    const me = this.me()
    if (!me) return false
    try {
      await this.confessions.update((all) => ({
        ...all,
        [me]: { ...all[me], [id]: { key } },
      }))
      return true
    } catch (err) {
      this.failed("Couldn't save in Taut", err)
      return false
    }
  }

  /** show what Taut has saved for a confession, with a button to forget it */
  private showDetails(id: string) {
    const replyKey = this.ownedRecord(id)?.key
    const { Label } = this.api.modal
    const { MrkdwnElement } = this.api.elements
    this.api.modal.openModal({
      title: `Owl ${parseSaved(id).label}`,
      body: replyKey ? (
        <>
          <Label text="Private reply key" />
          <MrkdwnElement text={`${FENCE}${replyKey}${FENCE}`} />
        </>
      ) : (
        'Saved in Taut, linked to your account hash'
      ),
      submitText: 'Forget',
      danger: true,
      cancelText: 'Close',
      onSubmit: () => this.confirmForget(id),
    })
  }

  private async confirmForget(id: string) {
    const forget = await this.api.modal.confirm({
      title: `Forget ${parseSaved(id).label}?`,
      body: this.ownedRecord(id)?.key
        ? "Copy the reply key first if it isn't saved anywhere else. Owl can't show it again."
        : 'You can save it again from the owl button.',
      confirmText: 'Forget',
      danger: true,
    })
    if (forget) await this.forget(id)
  }

  private async forget(id: string) {
    const me = this.me()
    if (!me) return
    try {
      await this.confessions.update((all) => {
        const { [id]: _, ...rest } = all[me] ?? {}
        return { ...all, [me]: rest }
      })
    } catch (err) {
      this.failed("Couldn't forget it", err)
    }
  }

  /** ask for the key of a confession Taut doesn't know, then turn owl mode on */
  private claim(
    thread: Thread,
    id: string,
    /** a key that wasn't one, shown again with an error */
    rejected?: string
  ) {
    const { Label, TextInput } = this.api.modal
    const keyRef = { current: rejected ?? '' }
    const KeyField = () => {
      const [value, setValue] = React.useState(keyRef.current)
      return (
        <>
          <Label text="Private reply key" htmlFor="taut-owl__key" optional />
          <TextInput
            id="taut-owl__key"
            type="password"
            value={value}
            onChange={(next) => {
              setValue(next)
              keyRef.current = next
            }}
            hintText="Leave blank if you chose the Slack account hash"
            errorText={
              rejected === undefined
                ? null
                : 'Owl reply keys are 64 hexadecimal characters'
            }
            autoFocus
          />
        </>
      )
    }
    this.api.modal.openModal({
      title: `Reply as the author of ${parseSaved(id).label}`,
      submitText: 'Save in Taut',
      body: <KeyField />,
      onSubmit: async () => {
        const key = keyRef.current.trim()
        if (key && !/^[0-9a-f]{64}$/.test(key))
          return this.claim(thread, id, key)
        if (await this.save(id, key || null)) this.setMode(thread, true)
      },
    })
  }

  private async sendAsOwl(thread: Thread, args: SendArgs) {
    const id = this.confessionOf(thread)
    const record = id && this.ownedRecord(id)
    if (!record) throw new Error('[Taut] Not your confession')
    const first = args.delta?.ops?.[0] as { insert?: unknown } | undefined
    if (
      args.shouldBroadcast ||
      args.dateScheduled ||
      args.fileIds?.length ||
      args.pendingFileIds?.length ||
      args.slashCommandAppId ||
      SLASH_COMMAND_RE.test(String(first?.insert ?? ''))
    )
      throw new Error('Owl can only send text')
    const blocks = await this.api.blocks.fromDraft(args.delta?.ops ?? [])
    const richText = blocks.find((block) => block.type === 'rich_text')
    if (!richText) throw new Error('Nothing to send')
    await this.runOwl(
      id,
      'Reply anonymously',
      thread.channelId,
      thread.threadTs,
      {
        key: { key: { type: 'plain_text_input', value: record.key ?? '' } },
        text: { text: { type: 'rich_text_input', rich_text_value: richText } },
      }
    )
  }

  private async reactAsOwl(target: Thread & { ts: string }, name: string) {
    const id = this.confessionOf(target)
    const record = id && this.ownedRecord(id)
    if (!record) throw new Error('[Taut] Not your confession')
    // owl takes the base emoji name
    const emoji = name.split('::')[0]
    await this.runOwl(id, 'React anonymously', target.channelId, target.ts, {
      key: { key: { type: 'plain_text_input', value: record.key ?? '' } },
      emoji: {
        emoji: {
          type: 'external_select',
          selected_option: {
            text: { type: 'plain_text', text: `:${emoji}:` },
            value: emoji,
          },
        },
      },
    })
  }

  /** the id of `app`'s message shortcut named `name` */
  private async owlShortcut(app: string, name: string): Promise<string> {
    // slack loads the shortcuts list shortly after boot
    const id = await this.api.within(
      (signal) =>
        this.api.redux.waitForState(
          () =>
            Object.values<{ appId?: string; id?: string; name?: string }>(
              this.api.redux.getRawState()?.appActions?.actions ?? {}
            ).find(
              (action) => action.appId === app && action.name?.endsWith(name)
            )?.id,
          signal
        ),
      OWL_TIMEOUT,
      `owl's "${name}" shortcut`
    )
    if (!id) throw new Error(`Owl's "${name}" shortcut isn't available`)
    return id
  }

  /** run the shortcut of the owl that posted confession `id` on a message and submit its modal */
  private async runOwl(
    id: string,
    shortcut: string,
    channelId: string,
    messageTs: string,
    values: Record<string, unknown>
  ) {
    const { app } = parseSaved(id)
    if (!app) throw new Error("Taut doesn't know that Owl app")
    const actionId = await this.owlShortcut(app, shortcut)
    // slack's format, it parses the timestamp
    this.lastToken = Math.max(Date.now(), this.lastToken + 1)
    const clientToken = `web-${this.lastToken}`

    let timer: ReturnType<typeof setTimeout> | undefined
    const opened = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => {
        this.views.delete(clientToken)
        reject(new Error("Owl didn't answer"))
      }, OWL_TIMEOUT)
      this.views.set(clientToken, (viewId) => {
        clearTimeout(timer)
        this.views.delete(clientToken)
        resolve(viewId)
      })
    })

    this.log('running owl shortcut', actionId, 'on', messageTs)
    try {
      await this.dispatch('executeAppAction', {
        appId: app,
        actionId,
        channelId,
        messageTs,
        clientToken,
      })
    } catch (err) {
      clearTimeout(timer)
      this.views.delete(clientToken)
      throw err
    }
    const viewId = await opened

    try {
      await this.dispatch('submitView', {
        viewId,
        viewState: { values },
      })
    } catch (err: any) {
      // owl's field errors, like a wrong key
      const errors: Record<string, unknown> | undefined = err?.data?.errors
      const first = errors && Object.values(errors)[0]
      throw typeof first === 'string' ? new Error(first) : err
    }
  }

  /** dispatches one of `thunks`, failing if Slack doesn't have it in time */
  private async dispatch(name: keyof OwlMode['thunks'], args: object) {
    const create = await this.api.within(
      this.thunks[name],
      OWL_TIMEOUT,
      `Slack's ${name} action`
    )
    // a user action, so the store exists by now
    const store = this.api.redux.getStore()
    if (!create || !store)
      throw new Error(`Slack's ${name} action isn't available`)
    return store.dispatch(create(args))
  }

  private failed(title: string, err: unknown) {
    if (this.api.signal.aborted) return
    // slack's errors can carry the submitted view, reply key included, so don't log
    const message = err instanceof Error ? err.message : String(err)
    this.log(title, message)
    this.api.modal.alert({ title, body: message })
  }
}

/** owl's confirmation, in its modal or its DM, as shown when you submit */
function parseConfirmation(
  blocks: unknown,
  app: string
): Confirmation | undefined {
  if (!Array.isArray(blocks)) return
  const text = blocks
    .map((block: Block) => block?.text?.text)
    .filter((t) => typeof t === 'string')
    .join('\n')
  const number = /(?:Post|Confession) #(\d+)/.exec(text)?.[1]
  if (!number) return
  const id = savedId(app, number)
  const key = /Your private reply key:\n([0-9a-f]{64})/.exec(text)?.[1]
  if (key) return { id, replyKey: key }
  if (text.includes('recognized through its salted hash')) {
    return { id, replyKey: null }
  }
}
