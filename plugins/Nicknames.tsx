// Locally rename other members from their profile "..." menu - only you see
// it, everyone else still sees their real name

import { TautPlugin } from '$taut'

type NicknameMap = Record<string, string>

type MenuTemplateItem = {
  key?: string
  label?: React.ReactNode
  type?: 'separator' | string
  click?: (e?: unknown) => void
  [extra: string]: unknown
}
type MenuFromTemplateProps = { template?: MenuTemplateItem[] }
type OverflowMenuProps = { memberId?: string }
type MemberLike = {
  real_name?: string
  profile?: { display_name?: string; real_name?: string; image_48?: string }
}

const NICKNAME_ITEM_KEY = 'taut-set-nickname'

export default class Nicknames extends TautPlugin {
  static readonly id = 'Nicknames'
  static readonly pluginName = 'Nicknames'
  static readonly description = 'Locally nickname other members across Slack'
  static readonly authors = '<@U06UYA5GMB5>'
  static readonly defaultConfig = `
    // Locally nickname other members
    "Nicknames": {
      "enabled": true
    }
  `

  private readonly MemberIdContext = React.createContext<string | null>(null)

  private nicknames: NicknameMap = {}

  async start() {
    const keys = await this.api.storage.keys()
    if (this.api.signal.aborted) return
    if (keys.includes('nicknames')) {
      this.nicknames = await this.api.storage.get<NicknameMap>('nicknames', {})
    } else {
      // One-time migration from the storage used before plugin-scoped storage.
      try {
        const legacy = JSON.parse(
          localStorage.getItem('taut_nicknames') || '{}'
        ) as unknown
        if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
          this.nicknames = legacy as NicknameMap
          await this.api.storage.set('nicknames', this.nicknames)
        }
      } catch {}
    }
    if (this.api.signal.aborted) return

    this.api.redux.patchSlice('members', (id, member) => {
      const nickname = this.nicknames[id]
      if (!nickname || !member?.profile) return member
      return this.api.members.modifyMemberObject(member, { name: nickname })
    })

    this.api.patchComponent<OverflowMenuProps>(
      'RimetoMemberProfileOverflowMenu',
      (Original) => (props) => (
        <this.MemberIdContext.Provider value={props.memberId ?? null}>
          <Original {...props} />
        </this.MemberIdContext.Provider>
      )
    )

    this.api.patchComponent<MenuFromTemplateProps>(
      'MenuFromTemplate',
      (Original) => (props) => {
        const memberId = React.useContext(this.MemberIdContext)
        const template = props.template
        if (memberId && Array.isArray(template)) {
          const idx = template.findIndex(
            (it) =>
              typeof it?.label === 'string' &&
              it.label.startsWith('Copy display name')
          )
          const already = template.some((it) => it?.key === NICKNAME_ITEM_KEY)
          if (idx !== -1 && !already) {
            const next = [
              ...template.slice(0, idx + 1),
              {
                key: NICKNAME_ITEM_KEY,
                label: 'Set nickname…',
                click: () => this.openNicknameModal(memberId),
              },
              ...template.slice(idx + 1),
            ]
            return <Original {...props} template={next} />
          }
        }
        return <Original {...props} />
      }
    )

    this.log('Started')
  }

  private setNickname(userId: string, nickname: string) {
    const trimmed = nickname.trim()
    const next = { ...this.nicknames }
    if (trimmed) next[userId] = trimmed
    else delete next[userId]
    this.nicknames = next
    void this.api.storage.set('nicknames', next)
    this.api.redux.refresh()
  }

  private openNicknameModal(userId: string) {
    const member: MemberLike | undefined = this.api.redux.getStore()?.getState()
      ?.members?.[userId]
    const realName =
      member?.profile?.display_name ||
      member?.profile?.real_name ||
      member?.real_name ||
      userId

    const { Label, TextInput } = this.api.modal
    const valueRef = { current: this.nicknames[userId] ?? '' }

    const NicknameField = () => {
      const [value, setValue] = React.useState(valueRef.current)
      return (
        <>
          <Label text="Nickname" htmlFor="taut-nickname-input" optional />
          <TextInput
            id="taut-nickname-input"
            value={value}
            onChange={(next) => {
              setValue(next)
              valueRef.current = next
            }}
            placeholder={realName}
            hintText="Leave blank to show their real name again"
            autoFocus
          />
        </>
      )
    }

    this.api.modal.openModal({
      title: `Set nickname for ${realName}`,
      submitText: 'Save',
      cancelText: 'Cancel',
      body: <NicknameField />,
      onSubmit: () => this.setNickname(userId, valueRef.current),
    })
  }
}
