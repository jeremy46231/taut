// Shows admins the "Only certain people can post" box where only admins can post

import { TautPlugin } from '$taut'

type RestrictedTo = { type?: string[]; user?: string[] }
type Channel = {
  properties?: {
    posting_restricted_to?: RestrictedTo
    threads_restricted_to?: RestrictedTo
  }
}
type RoadblockProps = {
  channelId?: string
  roadblockMessage?: React.ReactNode
  allowWrap?: boolean
}

/** the channel's posting rules as a cache key, so ignores expire when the rules change */
const restrictionKey = (channel: Channel | undefined) =>
  JSON.stringify([
    channel?.properties?.posting_restricted_to,
    channel?.properties?.threads_restricted_to,
  ])

export default class RestrictedChannelWarning extends TautPlugin<
  typeof RestrictedChannelWarning
> {
  static readonly id = 'RestrictedChannelWarning'
  static readonly pluginName = 'Restricted Channel Warning'
  static readonly description =
    'Shows admins the "Only certain people can post" box where only admins can post'
  static readonly authors = ['izie', 'jeremy'] as const
  static readonly category = 'messageBox'
  static readonly defaultConfig = {
    enabled: true,
  }

  /** channel id -> the `restrictionKey` it was ignored at */
  private ignored = this.api.storage.store<Record<string, string>>(
    'ignoredChannels',
    {}
  )

  async start(): Promise<void> {
    await this.ignored.ready
    if (this.api.signal.aborted) return
    this.ignored.subscribe(() => this.api.redux.refresh())

    // these two slices decide whether Slack lets you post
    // use what non-admins see (unless restrictions are ignored)
    this.api.redux.patchSlice('readOnlyChannels', (id, entry) => {
      const access = this.access(id)
      return access ? { ...entry, isReadOnly: access.readOnly } : entry
    })
    this.api.redux.patchSlice('threadOnlyChannels', (id, entry) => {
      const access = this.access(id)
      return access ? { ...entry, isThreadOnly: access.threadOnly } : entry
    })

    // add our ignore button
    this.api.patchComponent<RoadblockProps>(
      'MessageInputRoadblock',
      (Original) => (props) => {
        const { channelId } = props
        if (!channelId || !this.access(channelId)) {
          return <Original {...props} />
        }
        return (
          <Original
            {...props}
            allowWrap
            roadblockMessage={
              <>
                {props.roadblockMessage}
                <this.api.elements.Button
                  className="taut-restricted-channel__post"
                  size="small"
                  type="outline"
                  onClick={() => this.ignore(channelId)}
                >
                  Post anyway
                </this.api.elements.Button>
              </>
            }
          />
        )
      }
    )
    this.api.setStyle(
      '.taut-restricted-channel__post { margin-left: 8px; vertical-align: middle; }'
    )
  }

  /** where you could post if you weren't an admin (only if that differs) (unless ignored) */
  private access(channelId: string) {
    const state = this.api.redux.getRawState()
    const channel: Channel | undefined = state?.channels?.[channelId]
    const userId = this.api.members.getCurrentMemberId()
    if (!channel?.properties || !userId) return null
    if (this.ignored.get()[channelId] === restrictionKey(channel)) return null

    // Slack's decision, accounts for admin
    const wasReadOnly = !!state.readOnlyChannels?.[channelId]?.isReadOnly
    const wasThreadOnly = !!state.threadOnlyChannels?.[channelId]?.isThreadOnly

    // lets us post only because we're admin, we're not explicitly listed
    const adminOnly = (restriction: RestrictedTo | undefined) =>
      ['admin', 'org_admin'].includes(restriction?.type?.[0] ?? '') &&
      !restriction?.user?.includes(userId)
    const { posting_restricted_to, threads_restricted_to } = channel.properties
    const post =
      !wasReadOnly && !wasThreadOnly && !adminOnly(posting_restricted_to)
    const thread = !wasReadOnly && !adminOnly(threads_restricted_to)

    const readOnly = !post && !thread
    const threadOnly = !post && thread
    if (readOnly === wasReadOnly && threadOnly === wasThreadOnly) return null
    return { readOnly, threadOnly }
  }

  private ignore(channelId: string): void {
    const channel = this.api.redux.getRawState()?.channels?.[channelId]
    const key = restrictionKey(channel)
    this.ignored
      .update((saved) => ({ ...saved, [channelId]: key }))
      .catch((err) => this.log('Could not save', err))
  }
}
