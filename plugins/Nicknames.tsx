// Locally nickname other members across Slack

import { type MenuTemplateItem, TautPlugin } from '$taut'

type NicknameMap = Record<string, string>

type MenuFromTemplateProps = { template?: MenuTemplateItem[] }
type OverflowMenuProps = { memberId?: string }
type MemberLike = {
  name?: string
  real_name?: string
  profile?: { display_name?: string; real_name?: string; image_48?: string }
}

export default class Nicknames extends TautPlugin<typeof Nicknames> {
  static readonly id = 'Nicknames'
  static readonly pluginName = 'Nicknames'
  static readonly description = 'Locally nickname other members across Slack'
  static readonly authors = ['jeremy'] as const
  static readonly category = 'people'
  static readonly defaultConfig = {
    enabled: true,
  }

  private readonly MemberIdContext = React.createContext<string | null>(null)

  /** null until something is saved */
  private saved = this.api.storage.store<NicknameMap | null>('nicknames', null)

  private get nicknames(): NicknameMap {
    return this.saved.get() ?? {}
  }

  async start() {
    await this.saved.ready
    if (this.api.signal.aborted) return
    if (this.saved.get() === null) {
      // migrate from the localStorage key used before plugin-scoped storage
      // todo: remove this code after everyone is migrated
      try {
        const legacy = JSON.parse(
          localStorage.getItem('taut_nicknames') ?? 'null'
        ) as unknown
        if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
          await this.saved.update((saved) => saved ?? (legacy as NicknameMap))
        }
      } catch {}
    }
    if (this.api.signal.aborted) return
    this.saved.subscribe(() => this.api.redux.refresh())

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
          const already = template.some(
            (it) => it?.key === 'taut-nicknames__set'
          )
          if (idx !== -1 && !already) {
            const next = [
              ...template.slice(0, idx + 1),
              {
                key: 'taut-nicknames__set',
                label: this.nicknames[memberId]
                  ? 'Edit nickname...'
                  : 'Set nickname...',
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

    this.api.setStyle(
      `
        .taut-nicknames__hint {
          margin: 0 0 12px;
          color: var(--dt_color-content-sec);
        }
        .taut-nicknames__list {
          margin: 0 0 16px;
          padding: 0;
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .taut-nicknames__row {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .taut-nicknames__name {
          flex: 1 1 0;
          min-width: 0;
          display: flex;
          flex-direction: column;
        }
        .taut-nicknames__real-name,
        .taut-nicknames__handle {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .taut-nicknames__real-name {
          font-weight: 700;
          line-height: 20px;
          color: var(--dt_color-content-pry);
        }
        .taut-nicknames__handle {
          font-size: 13px;
          line-height: 18px;
          color: var(--dt_color-content-sec);
        }
        .taut-nicknames__field {
          flex: 1 1 0;
          min-width: 0;
        }
        .taut-nicknames__field .c-input_text {
          margin-bottom: 0;
        }
        /* as tall as the field and the avatar */
        .taut-nicknames__remove.c-button--icon {
          width: 36px;
          height: 36px;
        }
      `
    )

    this.log('Started')
  }

  private setNickname(userId: string, nickname: string) {
    const trimmed = nickname.trim()
    this.saved
      .update((nicknames) => {
        const next = { ...nicknames }
        if (trimmed) next[userId] = trimmed
        else delete next[userId]
        return next
      })
      .catch((err) => this.log('Could not save', err))
  }

  /** the raw real member from Slack, no nickname */
  private realMember(userId: string): MemberLike | undefined {
    return this.api.redux.getRawState()?.members?.[userId]
  }

  private realName(userId: string): string {
    const member = this.realMember(userId)
    return (
      member?.profile?.display_name ||
      member?.profile?.real_name ||
      member?.real_name ||
      userId
    )
  }

  private openNicknameModal(userId: string) {
    const realName = this.realName(userId)

    const { Label, TextInput } = this.api.modal
    const valueRef = { current: this.nicknames[userId] ?? '' }

    const NicknameField = () => {
      const [value, setValue] = React.useState(valueRef.current)
      return (
        <>
          <Label text="Nickname" htmlFor="taut-nicknames__input" optional />
          <TextInput
            id="taut-nicknames__input"
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

  private readonly NicknameRow = ({
    userId,
    onRemoved,
  }: {
    userId: string
    onRemoved: () => void
  }) => {
    const { Avatar, FormTextInput, Button, SvgIcon, Tooltip } =
      this.api.elements
    // only to subscribe and load them, the names come from the raw store
    this.api.members.useMember(userId)
    const [value, setValue] = React.useState(this.nicknames[userId] ?? '')
    const realName = this.realName(userId)
    const handle = this.realMember(userId)?.name
    const inputId = `taut-nicknames__input-${userId}`
    const commit = (next: string) => {
      if (!next.trim()) {
        this.setNickname(userId, '')
        onRemoved()
      } else if (next.trim() !== this.nicknames[userId]) {
        this.setNickname(userId, next)
      }
    }
    return (
      <li className="taut-nicknames__row">
        <Avatar userId={userId} size={36} isInteractive={false} />
        <label className="taut-nicknames__name" htmlFor={inputId}>
          <span className="taut-nicknames__real-name">{realName}</span>
          {handle && <span className="taut-nicknames__handle">@{handle}</span>}
        </label>
        <div className="taut-nicknames__field">
          <FormTextInput
            id={inputId}
            value={value}
            onChange={setValue}
            onBlur={() => commit(value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit(value)
            }}
            placeholder={realName}
          />
        </div>
        <Tooltip tip="Remove nickname">
          <Button
            type="outline"
            size="medium"
            className="c-button--icon taut-nicknames__remove"
            aria-label={`Remove nickname for ${realName}`}
            onClick={() => commit('')}
          >
            <SvgIcon name="close" size={16} inline />
          </Button>
        </Tooltip>
      </li>
    )
  }

  dataPanel() {
    return <this.DataPanel />
  }

  private readonly DataPanel = () => {
    const [ids, setIds] = React.useState(() =>
      Object.keys(this.nicknames).sort((a, b) =>
        this.realName(a).localeCompare(this.realName(b))
      )
    )
    if (!ids.length) {
      return (
        <p className="taut-nicknames__hint">
          No nicknames yet. Open someone's profile, click the "..." menu, and
          choose "Set nickname".
        </p>
      )
    }
    return (
      <ul className="taut-nicknames__list">
        {ids.map((id) => (
          <this.NicknameRow
            key={id}
            userId={id}
            onRemoved={() => setIds((prev) => prev.filter((it) => it !== id))}
          />
        ))}
      </ul>
    )
  }
}
