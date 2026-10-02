// Shows a red squiggle on users who are not IDV eligible, and orange when verified ID but >18

import { opt, TautPlugin } from '$taut'

const global = globalThis as any

type IdvStatusType = 'eligible' | 'over_18' | 'unverified' | 'loading'

export default class IdvStatus extends TautPlugin<typeof IdvStatus> {
  static readonly id = 'IdvStatus'
  static readonly pluginName = 'IDV Status'
  static readonly description =
    'Shows a red squiggle on users who are not IDV eligible, and orange when verified ID but >18'
  static readonly authors = ['sahil', 'rowan'] as const
  static readonly category = 'people'
  static readonly hackClubOnly = true
  static readonly defaultConfig = {
    enabled: false,
    unverifiedColor: opt.color(
      '#e01e5a',
      'Squiggle for users who are not verified, any CSS color'
    ),
    over18Color: opt.color(
      '#d97706',
      'Squiggle for users verified as over 18',
      { label: 'Over 18 color' }
    ),
  }

  private cache = new this.api.Cache<IdvStatusType>('idv_status', {
    ttl: 24 * 60 * 60 * 1000,
    maxSize: 5000,
  })

  async start() {
    this.log('Starting')

    await this.cache.load()
    if (this.api.signal.aborted) return

    this.api.patchComponent<{
      botId?: string
      userId?: string
      className?: string
    }>('BaseMessageSender', (OriginalBaseMessageSender) => (props) => {
      const userId = props.userId
      const isBotMessage = !!props.botId

      const [idvStatus, setIdvStatus] = React.useState<IdvStatusType | null>(
        () => {
          if (!userId || isBotMessage) return null
          if (!userId.startsWith('U') && !userId.startsWith('W')) return null
          if (userId === 'USLACKBOT') return null
          return this.cache.get(userId) ?? 'loading'
        }
      )

      React.useEffect(() => {
        if (!userId || isBotMessage || idvStatus === null) return
        if (!userId.startsWith('U') && !userId.startsWith('W')) return
        if (userId === 'USLACKBOT') return

        this.fetchIdvStatus(userId)
          .then(setIdvStatus)
          .catch(() => {})
      }, [userId, isBotMessage])

      const className =
        idvStatus === 'unverified'
          ? 'taut-idv-status--not-eligible'
          : idvStatus === 'over_18'
            ? 'taut-idv-status--over-18'
            : ''

      return (
        <OriginalBaseMessageSender
          {...props}
          className={
            props.className ? `${props.className} ${className}` : className
          }
        />
      )
    })

    const { unverifiedColor: unverified, over18Color: over18 } = this.config
    this.api.setStyle(
      `
        .taut-idv-status--not-eligible, .taut-idv-status--not-eligible .c-message__sender_button {
          text-decoration: underline wavy ${unverified} !important;
          text-decoration-thickness: 1px !important;
        }

        .taut-idv-status--over-18, .taut-idv-status--over-18 .c-message__sender_button {
          text-decoration: underline wavy ${over18} !important;
          text-decoration-thickness: 1px !important;
        }
      `
    )

    global.tautIdvClearCache = () => this.cache.clear()

    this.log('IDV Status loaded')
  }

  stop(): void {
    delete global.tautIdvClearCache

    this.log('Stopped')
  }

  async fetchIdvStatus(userId: string): Promise<IdvStatusType> {
    return this.cache.fetch(userId, async () => {
      const response = await fetch(
        `https://identity.hackclub.com/api/external/check?slack_id=${userId}`,
        { signal: this.api.signal }
      )
      if (!response.ok)
        throw new Error(`HTTP error! status: ${response.status}`)
      const data = await response.json()

      if (data.result === 'verified_eligible') return 'eligible'
      if (data.result === 'verified_but_over_18') return 'over_18'
      return 'unverified'
    })
  }
}
