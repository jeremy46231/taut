// Warns workspace admins before they type in an announcement-style channel

import { type ModalHandle, TautPlugin } from '$taut'

type RestrictedTo = {
  type?: string[]
  user?: string[]
}

type Channel = {
  id?: string
  name?: string
  created?: number
  creator?: string
  context_team_id?: string
  conversation_host_id?: string
  properties?: { posting_restricted_to?: RestrictedTo }
}

type Member = {
  is_admin?: boolean
  is_owner?: boolean
}

type TypingOptions = {
  channelId?: string
}

export default class RestrictedChannelWarning extends TautPlugin {
  static readonly id = 'RestrictedChannelWarning'
  static readonly pluginName = 'Restricted Channel Warning'
  static readonly description =
    'Warns workspace admins when they start typing in a restricted channel'
  static readonly authors = '<@U09KKMHLS15>'
  static readonly defaultConfig = `
    // Warns admins before posting in announcement-style channels
    "RestrictedChannelWarning": {
      "enabled": true
    }
  `

  private warningOpen = false
  private warningOpenVersion: string | null = null
  private dismissedChannels = new Set<string>()
  private snoozedChannels = new Map<string, number>()
  private readonly channelIdAliases = new Map<string, string>()
  private warnedVersion: string | null = null

  async start(): Promise<void> {
    const [dismissed, snoozed] = await Promise.all([
      this.api.storage.get<string[]>('dismissedChannels', []),
      this.api.storage.get<Record<string, number>>('snoozedChannels', {}),
    ])
    this.dismissedChannels = new Set(dismissed)
    this.snoozedChannels = new Map(Object.entries(snoozed))
    if (this.api.signal.aborted) return

    this.api.rtm.on('channel_id_changed', (event) => {
      const oldId = event.old_channel_id
      const newId = event.new_channel_id
      if (typeof oldId !== 'string' || typeof newId !== 'string') return

      const oldIdentity = this.channelIdentity(oldId)
      this.channelIdAliases.set(newId, oldIdentity)
      if (
        oldIdentity === `id:${oldId}` &&
        this.dismissedChannels.has(oldIdentity)
      ) {
        this.dismissedChannels.add(`id:${newId}`)
        this.saveDismissedChannels()
      }
      const snoozedUntil = this.snoozedChannels.get(oldIdentity)
      if (oldIdentity === `id:${oldId}` && snoozedUntil) {
        this.snoozedChannels.set(`id:${newId}`, snoozedUntil)
        this.saveSnoozedChannels()
      }
    })

    this.api.redux.patchThunk(
      'currentUserStartedTyping',
      (original) =>
        (...args: unknown[]) => {
          const channelId = (args[0] as TypingOptions | undefined)?.channelId
          if (channelId)
            this.warnedVersion = this.warnIfRestricted(
              channelId,
              this.warnedVersion
            )
          return original(...args)
        }
    )
    for (const name of ['navigate', 'navigateToChannel']) {
      this.api.redux.patchThunk(name, (original) => (...args: unknown[]) => {
        this.warnedVersion = null
        return original(...args)
      })
    }

    this.log('Started')
  }

  private channelIdentity(channelId: string): string {
    const alias = this.channelIdAliases.get(channelId)
    if (alias) return alias
    const state = this.api.redux.getRawState()
    const channel: Channel | undefined = state?.channels?.[channelId]
    if (!channel?.created) return `id:${channelId}`
    const host =
      channel.conversation_host_id ??
      channel.context_team_id ??
      state?.bootData?.team_id ??
      'unknown'
    return `created:${host}:${channel.creator ?? 'unknown'}:${channel.created}`
  }

  private restrictionVersion(channelId: string): string | null {
    const channel: Channel | undefined =
      this.api.redux.getRawState()?.channels?.[channelId]
    const restriction = channel?.properties?.posting_restricted_to
    const types = restriction?.type
    if (!restriction || !types?.includes('admin') || types.includes('user'))
      return null
    return JSON.stringify([
      this.channelIdentity(channelId),
      [...types].sort(),
      [...(restriction.user ?? [])].sort(),
    ])
  }

  private saveDismissedChannels(): void {
    void this.api.storage.set('dismissedChannels', [...this.dismissedChannels])
  }

  private saveSnoozedChannels(): void {
    void this.api.storage.set(
      'snoozedChannels',
      Object.fromEntries(this.snoozedChannels)
    )
  }

  private isDismissed(identity: string): boolean {
    if (this.dismissedChannels.has(identity)) return true
    const until = this.snoozedChannels.get(identity)
    if (!until) return false
    if (until > Date.now()) return true
    this.snoozedChannels.delete(identity)
    this.saveSnoozedChannels()
    return false
  }

  private warnIfRestricted(
    channelId: string,
    warnedVersion: string | null
  ): string | null {
    const state = this.api.redux.getRawState()
    const userId = this.api.members.getCurrentMemberId()
    const member: Member | undefined = userId
      ? state?.members?.[userId]
      : undefined
    if (!member?.is_admin && !member?.is_owner) return null

    const channel: Channel | undefined = state?.channels?.[channelId]
    const restriction = channel?.properties?.posting_restricted_to
    const types = restriction?.type
    if (!types?.includes('admin') || types.includes('user')) return null

    const identity = this.channelIdentity(channelId)
    const version = this.restrictionVersion(channelId)
    if (!version) return null
    if (version === warnedVersion || this.isDismissed(identity)) return version
    if (this.warningOpen)
      return this.warningOpenVersion === version ? version : warnedVersion

    const channelName = channel?.name ? `#${channel.name}` : 'this channel'
    const selectedUsers = restriction?.user?.length ?? 0
    const audience = selectedUsers
      ? `workspace admins and ${selectedUsers} selected ${selectedUsers === 1 ? 'person' : 'people'}`
      : 'workspace admins'

    this.warningOpen = true
    this.warningOpenVersion = version
    const Button = this.api.elements.Button
    let handle: ModalHandle | null = null
    let removeFooterStyle: (() => void) | null = this.api.setStyle(
      '.c-sk-modal_footer { display: none; }',
      'restricted-channel-warning-footer'
    )
    const cleanup = () => {
      this.warningOpen = false
      this.warningOpenVersion = null
      removeFooterStyle?.()
      removeFooterStyle = null
    }
    const close = () => {
      handle?.close()
      cleanup()
    }
    const snoozeForWeek = () => {
      this.snoozedChannels.set(identity, Date.now() + 7 * 24 * 60 * 60 * 1000)
      this.saveSnoozedChannels()
      close()
    }
    const dismissForever = () => {
      this.dismissedChannels.add(identity)
      this.snoozedChannels.delete(identity)
      this.saveDismissedChannels()
      this.saveSnoozedChannels()
      close()
    }

    handle = this.api.modal.openModal({
      title: `Before you post in ${channelName}`,
      showSubmitButton: false,
      showCancelButton: false,
      body: (
        <div style={{ paddingBottom: 24 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
            <this.api.elements.SvgIcon name="warning" size={22} />
            <div>
              <strong>This is a restricted posting channel.</strong>
              <p style={{ margin: '8px 0 0' }}>
                Only {audience} can post here. You can type because you’re an
                admin, so please double-check that your message belongs here.
              </p>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              gap: 8,
              marginTop: 24,
            }}
          >
            <Button size="small" type="primary" onClick={close}>
              I understand
            </Button>
            <Button size="small" type="outline" onClick={snoozeForWeek}>
              Remind me in a week
            </Button>
            <Button size="small" type="danger" onClick={dismissForever}>
              Don't remind me here
            </Button>
          </div>
        </div>
      ),
      onClose: cleanup,
    })
    if (!handle) {
      cleanup()
      return warnedVersion
    }
    return version
  }
}
