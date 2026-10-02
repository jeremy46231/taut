// Blurs private information while others may be able to see your screen

import { opt, TautPlugin } from '$taut'

type Shortcut = {
  code: string
  key: string
  mod: boolean
  shift: boolean
  alt: boolean
}

type NotificationArgs = { message?: unknown }
type MessageProps = { msg?: { channel?: string }; className?: string }

const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform)

function parseShortcut(value: unknown): Shortcut | null {
  if (typeof value !== 'string') return null
  const parts = value
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
  const key = parts.pop()
  if (!key) return null
  const mods = new Set(parts)
  const shortcut = {
    code: /^[a-z]$/.test(key)
      ? `Key${key.toUpperCase()}`
      : /^[0-9]$/.test(key)
        ? `Digit${key}`
        : key,
    key,
    mod: mods.has('mod') || mods.has('cmd') || mods.has('ctrl'),
    shift: mods.has('shift'),
    alt: mods.has('alt') || mods.has('option'),
  }
  // without one of these it would fire while someone is typing
  return shortcut.mod || shortcut.alt ? shortcut : null
}

/** the thread a row belongs to, from the key its list item carries */
function threadOf(row: Element): string {
  const key = row.getAttribute('data-item-key') ?? ''
  const [channel, ts] = key.replace(/^(?:heading|root|footer)-/, '').split('-')
  return ts ? `${channel}-${ts}` : ''
}

function matches(event: KeyboardEvent, shortcut: Shortcut): boolean {
  const mod = IS_MAC ? event.metaKey : event.ctrlKey
  return (
    (event.code === shortcut.code ||
      event.key.toLowerCase() === shortcut.key) &&
    mod === shortcut.mod &&
    event.shiftKey === shortcut.shift &&
    event.altKey === shortcut.alt
  )
}

export default class StreamerMode extends TautPlugin<typeof StreamerMode> {
  static readonly id = 'StreamerMode'
  static readonly pluginName = 'Streamer Mode'
  static readonly description =
    'Blurs private information while others may be able to see your screen'
  static readonly authors = ['jeremy', 'rowan', 'miggy'] as const
  static readonly category = 'privacy'
  static readonly defaultConfig = {
    enabled: false,
    blur: opt.number(
      4,
      "In pixels: 4 shows the shape but isn't easily readable",
      {
        min: 1,
        max: 10,
      }
    ),
    shortcut: opt(
      'mod+shift+p',
      'Leave empty for none. "mod" is Ctrl (Cmd on Mac), and a modifier is required'
    ),
    dmPreviewBlur: opt.select(
      [
        { value: 'all', label: 'Who it is with, and what it says' },
        { value: 'content', label: 'Only what it says' },
      ],
      'all',
      'What to blur in DM previews',
      { label: 'DM preview blur' }
    ),
    privateChannelNames: opt(true, 'Blur the names of private channels'),
    channelListReveal: opt.select(
      [
        { value: 'list', label: 'The whole list' },
        { value: 'section', label: 'Its section' },
        { value: 'channel', label: 'Only that channel' },
      ],
      'list',
      'What hovering over a blurred channel in the sidebar unblurs'
    ),
    hideVip: opt(true, 'Hide VIP badges and icons', {
      label: 'Hide VIP',
    }),
    silenceNotifications: true,
    autoOnScreenShare: true,
  }

  private active = new this.api.SharedStore<boolean>(
    'active',
    localStorage.getItem('taut_streamer_mode_active') === 'true'
  )
  /** a screen share turned it on, so the share ending turns it off */
  private autoActivated = false
  private originalGetDisplayMedia: MediaDevices['getDisplayMedia'] | null = null

  start() {
    this.apply(this.active.get())
    this.api.setStyle(this.css(), 'streamer')
    this.injectButton()

    if (this.config.silenceNotifications) {
      this.api.redux.patchThunk(
        'showNotification',
        (original) => (args: NotificationArgs) =>
          original(this.active.get() ? { ...args, message: undefined } : args)
      )
    }

    const shortcut = parseShortcut(this.config.shortcut)
    if (shortcut) {
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.repeat || !matches(event, shortcut)) return
        event.preventDefault()
        event.stopPropagation()
        this.toggle()
      }
      window.addEventListener('keydown', onKeyDown, true)
      this.api.signal.addEventListener('abort', () =>
        window.removeEventListener('keydown', onKeyDown, true)
      )
    } else if (this.config.shortcut) {
      this.log(
        `Ignoring "${this.config.shortcut}", a shortcut needs Ctrl, Cmd or Alt`
      )
    }

    this.markPrivateThreads()
    this.followThreadHover()
    if (this.config.autoOnScreenShare) this.watchScreenShares()
    this.log('Started')
  }

  stop() {
    document.documentElement.classList.remove('taut-streamer-mode')
    if (this.originalGetDisplayMedia) {
      navigator.mediaDevices.getDisplayMedia = this.originalGetDisplayMedia
      this.originalGetDisplayMedia = null
    }
  }

  private toggle = () => {
    this.autoActivated = false
    this.apply(!this.active.get())
    localStorage.setItem('taut_streamer_mode_active', String(this.active.get()))
  }

  private apply(active: boolean) {
    this.active.set(active)
    document.documentElement.classList.toggle('taut-streamer-mode', active)
  }

  private watchScreenShares() {
    const media = navigator.mediaDevices
    if (typeof media?.getDisplayMedia !== 'function') return
    const original = media.getDisplayMedia.bind(media)
    this.originalGetDisplayMedia = media.getDisplayMedia
    const shares = new Set<MediaStream>()
    const ended = (stream: MediaStream) => {
      shares.delete(stream)
      if (shares.size || !this.autoActivated) return
      this.autoActivated = false
      this.apply(false)
    }
    media.getDisplayMedia = async (...args) => {
      const stream = await original(...args)
      if (this.api.signal.aborted) return stream
      shares.add(stream)
      if (!this.active.get()) {
        this.autoActivated = true
        this.apply(true)
      }
      for (const track of stream.getTracks())
        track.addEventListener('ended', () => ended(stream), { once: true })
      stream.addEventListener('inactive', () => ended(stream), { once: true })
      return stream
    }
  }

  private markPrivateThreads() {
    this.api.patchComponent<MessageProps>(
      'MessageBackground',
      (Original) => (props) => {
        const id = props.msg?.channel
        const channel = id ? this.api.channels.getCachedChannel(id) : undefined
        if (!channel?.is_private && !channel?.is_mpim)
          return <Original {...props} />
        return (
          <Original
            {...props}
            className={`${props.className ?? ''} taut-streamer-mode__private-thread`}
          />
        )
      }
    )
  }

  private revealed = ''

  // a thread's heading, root, replies and footer are flat siblings, so css can't hover them as one
  private followThreadHover() {
    const follow = (event: Event) => {
      const view = document.querySelector('.p-threads_view')
      if (!view) return
      const target = event.target
      const row =
        target instanceof Element
          ? target.closest('.c-virtual_list__item')
          : undefined
      const thread = row && view.contains(row) ? threadOf(row) : ''
      if (thread === this.revealed) return
      this.revealed = thread
      for (const item of Array.from(
        view.querySelectorAll('.c-virtual_list__item')
      ))
        item.classList.toggle(
          'taut-streamer-mode__revealed',
          !!thread && threadOf(item) === thread
        )
    }
    for (const type of ['pointerover', 'focusin'] as const)
      window.addEventListener(type, follow, true)
    this.api.signal.addEventListener('abort', () => {
      for (const type of ['pointerover', 'focusin'] as const)
        window.removeEventListener(type, follow, true)
    })
  }

  private injectButton() {
    const { Tooltip, SvgIcon } = this.api.elements
    const KeyboardKeysTooltip = this.api.lazyComponent<{
      title: string
      mainKey: string
      modifiers?: string[]
    }>('KeyboardKeysTooltip')
    const shortcut = parseShortcut(this.config.shortcut)
    const modifiers = shortcut && [
      ...(shortcut.mod ? [IS_MAC ? '⌘' : 'Ctrl'] : []),
      ...(shortcut.alt ? [IS_MAC ? 'Option' : 'Alt'] : []),
      ...(shortcut.shift ? ['Shift'] : []),
    ]
    const label = (active: boolean) =>
      active ? 'Turn off streamer mode' : 'Turn on streamer mode'
    const tip = (active: boolean) =>
      shortcut ? (
        <KeyboardKeysTooltip
          title={label(active)}
          modifiers={modifiers ?? undefined}
          mainKey={shortcut.key.toUpperCase()}
        />
      ) : (
        label(active)
      )

    this.api.patchComponent<Record<string, unknown>>(
      'HelpButton',
      (Original) => (props) => {
        const active = this.active.use()
        return (
          <>
            <div className="p-top_nav__windows_controls_container taut-streamer-mode__container">
              <Tooltip tip={tip(active)} position="bottom" delay={500}>
                <button
                  type="button"
                  className="c-button-unstyled p-top_nav__button p-top_nav__help taut-streamer-mode__button"
                  aria-label={label(active)}
                  aria-pressed={active}
                  onClick={this.toggle}
                >
                  <SvgIcon
                    name={active ? 'eye-closed' : 'eye-open'}
                    size={20}
                  />
                </button>
              </Tooltip>
            </div>
            <Original {...props} />
          </>
        )
      }
    )
  }

  private css(): string {
    const root = `html.taut-streamer-mode`
    const { hideVip, dmPreviewBlur, privateChannelNames, channelListReveal } =
      this.config
    const blur = Math.max(0, this.config.blur)
    const lock = '[data-inline-channel-type-icon^="lock"]'
    const sidebarRowOf = (types: string) =>
      `.p-channel_sidebar__channel:is(${types}):not([data-qa-channel-sidebar-channel-is-selected="true"])`
    const privateType = '[data-qa-channel-sidebar-channel-type="private"]'
    const groupType = '[data-qa-channel-sidebar-channel-type="mpim"]'
    const sidebarRow = sidebarRowOf(`${privateType}, ${groupType}`)
    const sidebarName = `${sidebarRow} .p-channel_sidebar__name`
    const hot = ':is(:hover, :focus-visible)'
    const item = '.p-channel_sidebar__static_list__item'
    const hotItem = `${item}${hot}`
    const heading = `${item}[data-item-key^="sectionHeading-"]`
    const sidebarRevealed = {
      list: [
        `.p-channel_sidebar:is(:hover, :has(:focus-visible)) ${sidebarName}`,
      ],
      // a section's rows are flat siblings from its heading up to the next heading
      section: [
        `${hotItem} ${sidebarName}`,
        `${hotItem} ~ ${item}:not(${hotItem} ~ ${heading} ~ *) ${sidebarName}`,
        `${item}:has(~ ${hotItem}):not(:has(~ ${heading}${hot}, ~ ${heading} ~ ${hotItem})) ${sidebarName}`,
      ],
      channel: [`${hotItem} ${sidebarName}`],
    }[channelListReveal]
    const activityRow = '[data-qa="activity-item-container"]'
    const preview = '[data-qa="activity-item-message"]'

    const destination = '.p-activity_row_content__destination_tag'

    const privateDestination = `${destination}:has(${lock})`
    const groupDestination = `${destination}:not(:has(.c-inline_channel_entity))`

    const dmsRow =
      '[data-qa="dms_channel"]:not(:has(.p-activity_ia4_page__item--selected))'
    const groupName = `${dmsRow}:has(.c-base_icon_image_stacked) [data-qa="dms-channel-sender-name"]`

    const threadBody = `.taut-streamer-mode__private-thread :is(.c-message_kit__gutter__left, .c-message_kit__gutter__right)`
    const suggestionOf = (types: string) =>
      `.c-search_autocomplete__suggestion_item:is(${types})`
    const privateSuggestion = ':has(.c-channel_icon svg[data-qa^="lock"])'
    const groupSuggestion = '[data-type="mpim"]'
    const suggestion = suggestionOf(`${privateSuggestion}, ${groupSuggestion}`)
    const suggestionText = '.c-search_autocomplete__suggestion_item_left'

    const mention = `.c-inline_channel_entity:has(${lock}):not(${activityRow} *) .c-channel_entity__name`

    const inRow = `:is(${preview}, ${destination}, [data-qa="dms-channel-sender-name"])`
    const blurred = [
      ...(privateChannelNames
        ? [
            `${root} ${sidebarRowOf(privateType)} .p-channel_sidebar__name`,
            `${root} ${mention}`,
            `${root} ${activityRow} ${privateDestination}`,
            `${root} ${suggestionOf(privateSuggestion)} ${suggestionText}`,
          ]
        : []),
      ...(dmPreviewBlur === 'all'
        ? [
            `${root} ${sidebarRowOf(groupType)} .p-channel_sidebar__name`,
            `${root} ${activityRow} ${groupDestination}`,
            `${root} ${groupName}`,
            `${root} ${suggestionOf(groupSuggestion)} ${suggestionText}`,
          ]
        : []),
      `${root} ${activityRow}:has(${lock}) ${preview}`,
      `${root} ${activityRow}:has([data-qa="direct-messages"]) ${preview}`,
      `${root} ${dmsRow} ${preview}`,
      `${root} .p-threads_view ${threadBody}`,
    ]
    return `
      ${blurred.join(',\n      ')} {
        filter: blur(${blur}px);
        transition: filter 0.15s;
      }
      ${sidebarRevealed.map((selector) => `${root} ${selector}`).join(',\n      ')},
      ${root} .c-inline_channel_entity:hover .c-channel_entity__name,
      ${root} ${activityRow}:hover ${inRow},
      ${root} ${dmsRow}:hover ${inRow},
      ${root} .taut-streamer-mode__revealed ${threadBody},
      ${root} .taut-streamer-mode__revealed ${mention},
      ${root} ${suggestion}:hover ${suggestionText} {
        filter: none;
      }
      ${
        hideVip
          ? `${root} [data-qa="priority_vip_badge"],
      ${root} svg[data-qa="vip"],
      ${root} svg[data-qa="vip-filled"] {
        display: none;
      }`
          : ''
      }
      .taut-streamer-mode__container {
        margin-right: 8px;
      }
      .taut-streamer-mode__button[aria-pressed="true"] {
        color: rgba(var(--sk_raspberry_red, 224, 30, 90), 1);
      }
    `
  }
}
