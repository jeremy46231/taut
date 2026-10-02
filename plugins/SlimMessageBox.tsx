// Simplifies and cleans up the message box

import { TautPlugin } from '$taut'

type TextyButtonsProps = Record<string, unknown>
type PrefPayload = { pref?: string; value?: unknown }
type PrefsBoot = { prefsData?: Record<string, unknown> }

const SCOPE = '.p-message_input__input_container_unstyled'

/** slack's account-wide pref for the formatting bar, in `state.userPrefs` */
const FORMATTING_PREF = 'msg_input_sticky_composer'

// a sync copy so boot doesn't flash the wrong state
const readMirror = (): boolean | undefined => {
  const raw = localStorage.getItem('taut_slim_message_box_formatting')
  return raw === null ? undefined : raw === 'true'
}
const writeMirror = (value: boolean) =>
  localStorage.setItem('taut_slim_message_box_formatting', String(value))

/** the message claims this much, and the buttons sit beside it only if they fit */
const MIN_EDITOR_WIDTH = 450

/** an estimate since a container query can't measure the buttons, a wrong one only costs message width */
const SLACK_BUTTON_ROW = 340
const BUTTON_WIDTH = 32
const oneLineWidth = (hidden: number) =>
  `${MIN_EDITOR_WIDTH + SLACK_BUTTON_ROW - hidden * BUTTON_WIDTH}px`

/** the props each option turns off when you set it false */
const BUTTON_PROPS: Record<string, string[]> = {
  showFormattingToggle: ['enableComposerButton'],
  showEmojiPicker: ['enableEmojiButton'],
  showMentionButton: ['enableMentionButton'],
  showVideoButton: ['enableStoryButton'],
  showAudioButton: ['enableAudioButton'],
  showSlashButton: ['enableSlashCommandsButton', 'enableShortcutsButton'],
}

// attachments get slack's stacked layout back, since they need the full width
const ONE_LINE = `${SCOPE}:not(:has(.c-wysiwyg_container__attachments, .p-message_input__attachments, .c-pending_files, .c-message__editor__composer_attachments))`

const BROADCAST = '.p-threads_footer__input_container__broadcast_controls'

const layoutCss = (hiddenButtons: number, broadcastCheckbox: boolean) => `
  ${SCOPE} { container: taut-composer / inline-size; }

  ${ONE_LINE} .c-basic_container__body {
    display: flex !important;
    flex-direction: row !important;
    flex-wrap: wrap;
    align-items: flex-end !important;
    column-gap: 6px;
  }
  /* whatever slack stacks above the editor (alerts, the formatting bar) keeps a full-width row, in its grid-template-areas order */
  ${ONE_LINE} .c-basic_container__body > * { order: 0; flex: 1 0 100%; }
  ${ONE_LINE} .c-basic_container__body > :empty { display: none; }
  ${ONE_LINE} .c-wysiwyg_container__formatting { order: 1; }
  ${ONE_LINE} .c-wysiwyg_container__message_suggestions { order: 2; }
  ${ONE_LINE} .c-texty_input_unstyled__container {
    order: 3;
    flex: 100 1 0% !important;
    min-width: min(${MIN_EDITOR_WIDTH}px, 100%);
  }
  ${ONE_LINE} .c-wysiwyg_container__draft { order: 4; }
  ${ONE_LINE} .p-threads_footer__input_container__broadcast_controls {
    order: 5;
    flex: 1 0 100%;
  }
  /* last and whole so attach, buttons and send wrap together, full width below the query since the contained row measures ~0 there */
  ${ONE_LINE} .c-wysiwyg_container__footer {
    display: flex !important;
    order: 6;
    flex: 1 0 100% !important;
    flex-wrap: wrap;
    min-width: 0;
  }
  ${ONE_LINE} .c-wysiwyg_container__suffix {
    margin-left: auto !important;
    flex: 0 0 auto !important;
  }

  @container taut-composer (min-width: ${oneLineWidth(hiddenButtons)}) {
    ${ONE_LINE} .c-wysiwyg_container__footer { flex: 1 1 auto !important; }
    ${
      broadcastCheckbox
        ? `
          /* no min-width so the toolbar always fits beside the message and the checkbox stays below, a cap strands send on its own row */
          ${ONE_LINE}:has(${BROADCAST}) .c-texty_input_unstyled__container {
            min-width: 0 !important;
          }
          /* slack leaves this no bottom padding, having always had the buttons below it */
          ${ONE_LINE} ${BROADCAST} {
            order: 7;
            padding-bottom: 8px;
          }
        `
        : ''
    }
    /* slack's row is container-type: inline-size so it comes out 0 wide beside the message, and with no box the overflow menu's offsetWidth test sees nothing to do */
    ${ONE_LINE} .c-wysiwyg_container__toolbar_buttons {
      flex: 0 1 auto !important;
      min-width: 0 !important;
    }
    ${ONE_LINE} .c-texty_buttons { display: contents !important; }
  }
`

export default class SlimMessageBox extends TautPlugin<typeof SlimMessageBox> {
  static readonly id = 'SlimMessageBox'
  static readonly pluginName = 'Slim Message Box'
  static readonly description = 'Simplifies and cleans up the message box'
  static readonly authors = ['jeremy', 'rowan'] as const
  static readonly category = 'messageBox'
  static readonly defaultConfig = {
    enabled: false,
    oneLineLayout: true,
    showFormattingToggle: true,
    showEmojiPicker: true,
    showMentionButton: false,
    showVideoButton: false,
    showAudioButton: true,
    showSlashButton: false,
    showBroadcastCheckbox: true,
  }

  /** what the formatting bar was set to before we swapped ours in */
  private slackFormatting = this.api.storage.store<boolean | null>(
    'slackShowFormatting',
    null
  )
  private savedFormatting = this.api.storage.store('showFormatting', false)
  private formatting: boolean | undefined
  /** whether the dispatch in flight is ours, echoing a value we only read */
  private echoing = false

  start(): void {
    // only an explicit false hides one, so a config missing a key keeps its button
    const hidden = Object.keys(BUTTON_PROPS).filter(
      (option) => this.config[option] === false
    )
    const off = Object.fromEntries(
      hidden.flatMap((option) =>
        BUTTON_PROPS[option].map((prop) => [prop, false])
      )
    )

    this.api.setStyle(`
      ${SCOPE} .c-wysiwyg_container__footer_divider { display: none !important; }
    `)

    // slack ships minButtonsForOverflow: 5 against a group of 2, so its menu for narrow composers never opens
    this.api.patchComponent<TextyButtonsProps>(
      'TextyButtons',
      (Original) => (props) => (
        <Original {...props} {...off} minButtonsForOverflow={1} />
      )
    )

    const broadcastCheckbox = this.config.showBroadcastCheckbox
    if (!broadcastCheckbox) {
      // we need slack to still render the checkbox, since its props are the only way to reach the value
      this.api.setStyle(`
        .p-threads_footer__input_container { min-height: 0; }
        ${BROADCAST} { display: none !important; }
      `)
      this.api.composer.addButton({
        id: 'taut-broadcast',
        placement: 'native',
        kinds: ['thread'],
        render: ({ channelId, broadcast }) => {
          const name = this.api.redux.useReduxState(
            (state) => state?.channels?.[channelId]?.name as string | undefined
          )
          if (!broadcast) return null
          const [also, dont] =
            broadcast.channelType === 'im'
              ? ['Also send as direct message', "Don't send as direct message"]
              : broadcast.channelType === 'mpim'
                ? ['Also send to the group', "Don't send to the group"]
                : [
                    `Also send to ${name ? `#${name}` : 'channel'}`,
                    `Don't send to ${name ? `#${name}` : 'channel'}`,
                  ]
          return {
            icon: broadcast.active ? 'megaphone-filled' : 'megaphone',
            label: also,
            tooltip: broadcast.active ? dont : also,
            pressed: broadcast.active,
            onClick: () => broadcast.set(!broadcast.active),
          }
        },
      })
    }

    if (this.config.oneLineLayout)
      this.api.setStyle(layoutCss(hidden.length, broadcastCheckbox))

    this.separateFormattingBar()

    this.log('Started')
  }

  async stop(): Promise<void> {
    localStorage.removeItem('taut_slim_message_box_formatting')
    const slack = this.slackFormatting.get()
    if (slack === null) return
    // the thunk patches are still in place here
    await this.apply(slack)
    await this.api.storage.delete('slackShowFormatting')
  }

  private async separateFormattingBar() {
    const redux = this.api.redux
    const pref = (): boolean | undefined =>
      redux.getStore()?.getState()?.userPrefs?.[FORMATTING_PREF]
    const settle = async (value: boolean | undefined) => {
      if (value !== undefined && value !== !!pref()) await this.apply(value)
    }

    this.formatting = readMirror()

    redux.patchThunk(
      'setUserPrefFetcher',
      (original) => (payload: PrefPayload) =>
        payload?.pref === FORMATTING_PREF
          ? () => Promise.resolve()
          : original(payload)
    )
    redux.patchThunk(
      'setUserPrefByApi',
      (original) => (payload: PrefPayload) => {
        if (payload?.pref === FORMATTING_PREF && !this.echoing) {
          this.formatting = !!payload.value
          writeMirror(this.formatting)
          this.savedFormatting
            .set(this.formatting)
            .catch((err) => this.log('Could not save', err))
        }
        return original(payload)
      }
    )
    redux.patchThunk(
      'initializeUserPrefs',
      (original) => (payload: PrefsBoot) => {
        const prefs = payload?.prefsData
        if (!prefs || !(FORMATTING_PREF in prefs)) return original(payload)
        this.recordSlackFormatting(!!prefs[FORMATTING_PREF])
        return original({
          ...payload,
          prefsData: { ...prefs, [FORMATTING_PREF]: this.formatting ?? false },
        })
      }
    )

    this.recordSlackFormatting(pref())
    await settle(this.formatting)

    await this.savedFormatting.ready
    this.formatting = this.savedFormatting.get()
    writeMirror(this.formatting)
    await this.slackFormatting.ready
    if (this.api.signal.aborted) return
    await settle(this.formatting)
  }

  private async apply(value: boolean) {
    this.echoing = true
    try {
      await this.showFormatting(value)
    } finally {
      this.echoing = false
    }
  }

  /** the account's own value, from whichever run first saw it */
  private async recordSlackFormatting(value: boolean | undefined) {
    // unknown isn't false
    if (value === undefined) return
    await this.slackFormatting.ready
    if (this.slackFormatting.get() !== null) return
    try {
      await this.slackFormatting.update((saved) => saved ?? value)
    } catch (err) {
      this.log('Could not save', err)
    }
  }

  private showFormatting(value: boolean) {
    return this.api.redux.dispatchThunk('setUserPrefByApi', {
      pref: FORMATTING_PREF,
      value,
    })
  }
}
