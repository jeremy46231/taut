// Adds a "Switch account" submenu to the profile menu (above "Sign out") for
// jumping between saved same-workspace accounts without re-logging in

import { type ComponentType, type StoredAccount, TautPlugin } from '$taut'

type MenuTemplateItem = {
  key: string
  label?: React.ReactNode
  type?: 'submenu' | 'separator' | 'header' | 'custom'
  template?: MenuTemplateItem[]
  click?: (e?: unknown) => void
  disabled?: boolean
}

type MenuFromTemplateProps = { template?: MenuTemplateItem[] }
type AccountRowProps = {
  userId: string
  isCurrent: boolean
  onRemove: (userId: string) => void
}

const SIGN_OUT_KEYS = ['sign-out', 'signout-submenu']
const SWITCHER_KEY = 'taut-account-switcher'

function orgKey(account: StoredAccount): string {
  const enterpriseId = account.team?.enterprise_id
  return typeof enterpriseId === 'string' ? enterpriseId : account.teamId
}

export default class AccountSwitcher extends TautPlugin {
  static readonly id = 'AccountSwitcher'
  static readonly pluginName = 'Account Switcher'
  static readonly description =
    'Switch between saved accounts from the profile menu'
  static readonly defaultConfig = `
    // Switch between saved accounts from the profile menu
    "AccountSwitcher": {
      "enabled": true
    }
  `
  static readonly authors = '<@U06UYA5GMB5>'

  private accountsStore = new this.api.Store<StoredAccount[]>([])
  private currentUserId: string | null = null
  private currentOrgKey: string | null = null

  private SvgIcon = this.api.elements.SvgIcon
  private AccountRow: React.FC<AccountRowProps> = () => null
  async start() {
    if (!this.api.accounts.supported) {
      this.log('Account switching is not supported by this loader; idle')
      return
    }

    this.AccountRow = this.makeAccountRow()

    this.api.patchComponent<MenuFromTemplateProps>(
      'MenuFromTemplate',
      (Original: ComponentType<MenuFromTemplateProps>) =>
        (props: MenuFromTemplateProps) => {
          const accounts = this.accountsStore.use()
          const template = props.template
          if (Array.isArray(template)) {
            const idx = template.findIndex(
              (it) => it && SIGN_OUT_KEYS.includes(it.key)
            )
            const already = template.some((it) => it && it.key === SWITCHER_KEY)
            if (idx !== -1 && !already) {
              const next = [
                ...template.slice(0, idx),
                this.buildSwitcherItem(accounts),
                ...template.slice(idx),
              ]
              return <Original {...props} template={next} />
            }
          }
          return <Original {...props} />
        }
    )

    void this.captureAndRefresh()

    this.log('Started')
  }

  private async captureAndRefresh() {
    // The active team/token isn't always populated the moment we start, so
    // retry the capture a few times before giving up.
    for (let attempt = 0; attempt < 10; attempt++) {
      if (this.api.signal.aborted) return
      try {
        const current = await this.api.accounts.captureCurrent()
        if (current) {
          this.currentUserId = current.userId
          this.currentOrgKey = orgKey(current)
          break
        }
      } catch (err) {
        this.log('Account capture failed', err)
      }
      await new Promise<void>((resolve) => {
        const onAbort = () => {
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(() => {
          this.api.signal.removeEventListener('abort', onAbort)
          resolve()
        }, 1000)
        this.api.signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    if (this.api.signal.aborted) return
    await this.refresh()
  }

  private async refresh() {
    try {
      const all = await this.api.accounts.list()
      // Profiles come from the current workspace's store, so scope to it
      const scoped = this.currentOrgKey
        ? all.filter((a) => orgKey(a) === this.currentOrgKey)
        : all
      // Most-recently-saved first, with the current account pinned to the top
      const sorted = scoped.sort((a, b) => {
        if (a.userId === this.currentUserId) return -1
        if (b.userId === this.currentUserId) return 1
        return b.updatedAt - a.updatedAt
      })
      this.accountsStore.set(sorted)
    } catch (err) {
      this.log('Failed to refresh accounts', err)
    }
  }

  private async removeAccount(userId: string) {
    try {
      await this.api.accounts.forget(userId)
    } catch (err) {
      this.log('Failed to remove account', err)
    }
    await this.refresh()
  }

  private makeAccountRow(): React.FC<AccountRowProps> {
    const { members } = this.api
    const SvgIcon = this.SvgIcon

    return function AccountRow({ userId, isCurrent, onRemove }) {
      const [removed, setRemoved] = React.useState(false)
      const [removeHovered, setRemoveHovered] = React.useState(false)
      const member = members.useMember(userId)
      const profile = member?.profile
      const name =
        profile?.display_name || profile?.real_name || member?.real_name
      const avatar = profile?.image_48 // 2x for the 20px row

      if (removed) return null

      return (
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            flex: '1 1 auto',
            minWidth: 0,
            position: 'relative',
            top: '1px',
          }}
        >
          <span
            style={{
              width: '20px',
              height: '20px',
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {isCurrent && <SvgIcon name="check-filled" size={16} inline />}
          </span>
          {avatar ? (
            <img
              src={avatar}
              alt=""
              width={20}
              height={20}
              style={{ borderRadius: '4px', flex: '0 0 auto' }}
            />
          ) : (
            <span
              style={{
                width: '20px',
                height: '20px',
                borderRadius: '4px',
                flex: '0 0 auto',
                background:
                  'rgba(var(--sk_foreground_low_solid, 221, 221, 221), 0.1)',
              }}
            />
          )}
          {name ? (
            <span
              style={{
                flex: '1 1 auto',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </span>
          ) : (
            <span
              style={{
                flex: '0 1 90px',
                height: '12px',
                borderRadius: '4px',
                background:
                  'rgba(var(--sk_foreground_low_solid, 221, 221, 221), 0.1)',
              }}
            />
          )}
          {!isCurrent && (
            <button
              type="button"
              aria-label="Remove account"
              title="Remove account"
              onClick={(e) => {
                e.preventDefault()
                e.stopPropagation()
                setRemoved(true)
                onRemove(userId)
              }}
              onMouseEnter={() => setRemoveHovered(true)}
              onMouseLeave={() => setRemoveHovered(false)}
              style={{
                width: '20px',
                height: '20px',
                flex: '0 0 auto',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                borderRadius: '4px',
                border: 0,
                padding: 0,
                color: removeHovered ? '#fff' : 'var(--sk_error, #e01e5a)',
                opacity: removeHovered ? 1 : 0.6,
                background: removeHovered
                  ? 'var(--sk_error, #e01e5a)'
                  : 'transparent',
                transition:
                  'background-color 0.1s ease, opacity 0.1s ease, color 0.1s ease',
              }}
            >
              <SvgIcon name="trash-filled" size={16} inline />
            </button>
          )}
        </span>
      )
    }
  }

  private buildSwitcherItem(accounts: StoredAccount[]): MenuTemplateItem {
    const AccountRow = this.AccountRow
    const template: MenuTemplateItem[] = []

    for (const account of accounts) {
      const isCurrent = account.userId === this.currentUserId
      template.push({
        key: `taut-acct-${account.userId}`,
        label: (
          <AccountRow
            userId={account.userId}
            isCurrent={isCurrent}
            onRemove={(userId) => this.removeAccount(userId)}
          />
        ),
        click: isCurrent
          ? undefined
          : () => {
              this.api.accounts
                .switchTo(account.userId)
                .catch((err) => this.log('Switch failed', err))
            },
      })
    }

    if (template.length) {
      template.push({ key: 'taut-acct-separator', type: 'separator' })
    }
    template.push({
      key: 'taut-acct-add',
      label: 'Add another account',
      click: () => {
        this.api.accounts
          .addAccount()
          .catch((err) => this.log('Add account failed', err))
      },
    })

    return {
      key: SWITCHER_KEY,
      label: 'Switch account',
      type: 'submenu',
      template,
    }
  }
}
