// Adds a button to hide your typing indicator, so others can't see when you're typing

import { TautPlugin } from '$taut'

type TypingArgs = { channelId?: string } | undefined

export default class SilentTyping extends TautPlugin<typeof SilentTyping> {
  static readonly id = 'SilentTyping'
  static readonly pluginName = 'Silent Typing'
  static readonly description =
    "Adds a button to hide your typing indicator, so others can't see when you're typing"
  static readonly authors = ['jeremy', 'rowan', 'ani'] as const
  static readonly category = 'messageBox'
  static readonly defaultConfig = {
    enabled: false,
  }

  /** channel ids with typing hidden */
  private readonly silenced = new this.api.Store<ReadonlySet<string>>(new Set())

  private toggle(channelId: string) {
    this.silenced.update((silenced) => {
      const next = new Set(silenced)
      if (!next.delete(channelId)) next.add(channelId)
      return next
    })
  }

  start(): void {
    try {
      // the global toggle an older version stored
      localStorage.removeItem('taut_silent_typing_suppressed')
    } catch {}

    // every composer reports typing through this thunk
    this.api.redux.patchThunk(
      'currentUserStartedTyping',
      (original) =>
        (args: TypingArgs, ...rest: unknown[]) =>
          args?.channelId && this.silenced.get().has(args.channelId)
            ? () => {}
            : original(args, ...rest)
    )

    this.api.composer.addButton({
      id: 'taut-silent-typing',
      placement: 'end',
      render: ({ channelId }) => {
        const silenced = this.silenced.use().has(channelId)
        return {
          icon: silenced ? 'notifications-off' : 'notifications',
          label: silenced
            ? 'Show typing in this chat'
            : 'Hide typing in this chat',
          tooltip: silenced
            ? 'Show typing in this chat (hidden until you reload)'
            : 'Hide typing in this chat until you reload',
          pressed: silenced,
          onClick: () => this.toggle(channelId),
        }
      },
    })

    this.log('Started')
  }
}
