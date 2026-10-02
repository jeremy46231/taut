import { elementsAPIPromise } from '../../api/elements'
import { Store } from '../../store'
import { patchComponentPromise } from '../react'
import { reduxPromise } from '../redux'
import { byName, waitForExport } from '../webpack'

/** the "Also send to #channel" checkbox of a thread composer */
export interface ComposerBroadcast {
  active: boolean
  /** Slack's channel type, e.g. `'im'`, `'mpim'` or `'channel'` */
  channelType: string | undefined
  set(active: boolean): void
}

/** which composer a button is being drawn in */
export type ComposerContext =
  /** a conversation's own message box, in a channel, DM or group DM */
  | { kind: 'channel'; channelId: string }
  /** a thread's reply box, in the thread pane, the Threads view, a huddle and so on */
  | {
      kind: 'thread'
      channelId: string
      threadTs: string
      /** only where Slack shows the checkbox */
      broadcast?: ComposerBroadcast
    }
  /** editing a message you sent */
  | { kind: 'edit'; channelId: string; threadTs?: string }
  /** the full page composer for a new or scheduled message, `channelId` once it has a recipient */
  | { kind: 'draft'; channelId?: string }
  /** any other message box, like forwarding, settings, workflow fields or a plugin's own */
  | { kind: 'other' }

export type ComposerKind = ComposerContext['kind']

export interface ComposerButtonDisplay {
  /** an `SvgIcon` name, or your own node */
  icon: string | React.ReactNode
  /** the accessible name, and the tooltip unless `tooltip` is given */
  label: string
  tooltip?: React.ReactNode
  /** makes it a toggle button */
  pressed?: boolean
  onClick(): void
}

type MessageBoxKind = 'channel' | 'thread'

export interface ComposerButton<K extends ComposerKind = MessageBoxKind> {
  /** unique, used as the React key and the order within a placement */
  id: string
  /** `'native'` right after Slack's buttons, `'end'` after everything */
  placement: 'native' | 'end'
  /** the composers it appears in, `['channel', 'thread']` if left out */
  kinds?: readonly K[]
  /** runs as its own component so it may call hooks, null leaves it out of that composer */
  render(
    context: Extract<ComposerContext, { kind: K }>
  ): ComposerButtonDisplay | null
}

const composerButtons = new Store<readonly ComposerButton<ComposerKind>[]>([])

/** add a button to the toolbar of the message boxes, or of the `kinds` it names */
export function addButton<K extends ComposerKind = MessageBoxKind>(
  added: ComposerButton<K>
): () => void {
  // render only ever gets a context of one of its kinds
  const button = added as unknown as ComposerButton<ComposerKind>
  if (composerButtons.get().some((b) => b.id === button.id)) {
    throw new Error(`[Taut] Composer button "${button.id}" already exists`)
  }
  composerButtons.update((buttons) =>
    [...buttons, button].sort((a, b) => a.id.localeCompare(b.id))
  )
  return () =>
    composerButtons.update((buttons) => buttons.filter((b) => b !== button))
}

type SlackViews = {
  /** Slack's `viewContext` names */
  viewContexts: Record<string, string>
  /** the view contexts Slack draws as a thread */
  isThreadViewContext(viewContext: string): boolean
}
const slackViews = new Store<SlackViews | null>(null)
Promise.all([
  waitForExport<Record<string, string>>(
    (exp) =>
      typeof exp?.MESSAGE_PANE === 'string' &&
      typeof exp?.COMPOSER_VIEW === 'string'
  ),
  waitForExport<SlackViews['isThreadViewContext']>(
    byName('isThreadViewContext')
  ),
]).then(([viewContexts, isThreadViewContext]) =>
  slackViews.set({ viewContexts, isThreadViewContext })
)

/** the kind from the props Slack gives the toolbar, `hasChannel` if the conversation really exists */
function composerContext(
  toolbar: ToolbarContext,
  views: SlackViews,
  hasChannel: boolean
): ComposerContext {
  const { viewContext, draftId = '', channelId, threadTs, broadcast } = toolbar
  // only MessageInput and message editing pass one
  if (!viewContext) return { kind: 'other' }
  if (viewContext === views.viewContexts.COMPOSER_VIEW) {
    return hasChannel ? { kind: 'draft', channelId } : { kind: 'draft' }
  }
  // a plugin's own MessageInput has a made-up channel
  if (!channelId || !hasChannel) return { kind: 'other' }
  // how Slack itself tells an edit's draft id apart
  if (draftId.startsWith('edit-')) return { kind: 'edit', channelId, threadTs }
  if (threadTs) {
    return views.isThreadViewContext(viewContext)
      ? { kind: 'thread', channelId, threadTs, broadcast }
      : { kind: 'other' }
  }
  return viewContext === views.viewContexts.MESSAGE_PANE
    ? { kind: 'channel', channelId }
    : { kind: 'other' }
}

type BroadcastControlsProps = {
  broadcast?: boolean
  channelType?: string
  onBroadcastChange?: (event: { target: { checked: boolean } }) => void
}
type MessageInputProps = {
  /** false wherever Slack hides the checkbox */
  broadcastControls?: React.ReactElement<BroadcastControlsProps> | false
}
type TextyButtonsProps = {
  channelId?: string
  threadTs?: string
  draftId?: string
  viewContext?: string
  enableSubmitButton?: boolean
  textyRef?: { current?: { element?: Element } | null }
}
type ToolbarContext = TextyButtonsProps & { broadcast?: ComposerBroadcast }

// registered at module load before any plugin, so these are innermost and see the props Slack gets
patchComponentPromise.then(async (patchComponent) => {
  const { Tooltip, IconButtonBase, SvgIcon } = await elementsAPIPromise
  const { useReduxState } = await reduxPromise
  // the broadcast value and setter exist only on the element InputContainer passes MessageInput
  const BroadcastContext = React.createContext<ComposerBroadcast | null>(null)
  const ToolbarContext = React.createContext<ToolbarContext | null>(null)

  patchComponent<MessageInputProps>('MessageInput', (Original) => (props) => {
    const controls = props.broadcastControls
    const { broadcast, channelType, onBroadcastChange } = controls
      ? controls.props
      : ({} as BroadcastControlsProps)
    const value = React.useMemo(
      () =>
        onBroadcastChange
          ? {
              active: !!broadcast,
              channelType,
              set: (active: boolean) =>
                onBroadcastChange({ target: { checked: active } }),
            }
          : null,
      [broadcast, channelType, onBroadcastChange]
    )
    return (
      <BroadcastContext.Provider value={value}>
        <Original {...props} />
      </BroadcastContext.Provider>
    )
  })

  patchComponent<TextyButtonsProps>('TextyButtons', (Original) => (props) => {
    const broadcast = React.useContext(BroadcastContext) ?? undefined
    return (
      <ToolbarContext.Provider value={{ ...props, broadcast }}>
        <Original {...props} />
      </ToolbarContext.Provider>
    )
  })

  function ComposerButtonView({
    button,
    context,
    textyRef,
  }: {
    button: ComposerButton<ComposerKind>
    context: ComposerContext
    textyRef: TextyButtonsProps['textyRef']
  }) {
    let display: ComposerButtonDisplay | null
    try {
      display = button.render(context)
    } catch (err) {
      console.error(`[Taut] Composer button "${button.id}" failed:`, err)
      return null
    }
    if (!display) return null
    const { icon, label, tooltip, pressed, onClick } = display
    return (
      <Tooltip
        tip={tooltip ?? label}
        position="top"
        offsetY={-7}
        delay={500}
        zIndex="above_fs"
      >
        <IconButtonBase
          className="c-wysiwyg_container__button"
          size="smedium"
          tabIndex={-1}
          aria-label={label}
          aria-pressed={pressed === undefined ? undefined : String(pressed)}
          onClick={onClick}
          // like Slack's toggles, clicking leaves the focus in the message
          onMouseDown={(event) => {
            const active = event.currentTarget.ownerDocument.activeElement
            if (textyRef?.current?.element?.contains(active)) {
              event.preventDefault()
            }
          }}
        >
          {typeof icon === 'string' ? <SvgIcon name={icon} size={18} /> : icon}
        </IconButtonBase>
      </Tooltip>
    )
  }

  patchComponent<{ children?: React.ReactNode }>(
    'TextyButtonOverflow',
    (Original) => (props) => {
      const toolbar = React.useContext(ToolbarContext)
      const buttons = composerButtons.use()
      const views = slackViews.use()
      const channelId = toolbar?.channelId
      // slack stores a placeholder for an id it can't find, marked isNonExistent
      const hasChannel = !!useReduxState((state) => {
        const channel = channelId && state?.channels?.[channelId]
        return !!channel && !channel.isNonExistent
      })
      if (!toolbar || !views || !buttons.length) return <Original {...props} />

      const context = composerContext(toolbar, views, hasChannel)
      const shown = buttons.filter((button) =>
        (button.kinds ?? ['channel', 'thread']).includes(context.kind)
      )
      if (!shown.length) return <Original {...props} />
      const placed = (placement: ComposerButton['placement']) =>
        shown
          .filter((button) => button.placement === placement)
          .map((button) => (
            <ComposerButtonView
              key={button.id}
              button={button}
              context={context}
              textyRef={toolbar.textyRef}
            />
          ))

      const children = React.Children.toArray(props.children)
      // the feedback composer's submit button stays last among slack's buttons
      const submit = toolbar.enableSubmitButton ? children.splice(-1) : []
      return (
        <Original {...props}>
          {[...children, ...placed('native'), ...submit, ...placed('end')]}
        </Original>
      )
    }
  )
})
