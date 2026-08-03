// Shows a red squiggle on users who are not IDV verified

import { TautPlugin } from '$taut'

const global = globalThis as any

type IdvStatusType = 'eligible' | 'over_18' | 'unverified' | 'loading'

export default class IdvStatus extends TautPlugin {
  static readonly id = 'IdvStatus'
  static readonly pluginName = 'IDV Status'
  static readonly description =
    'Shows a red squiggle on users who are not IDV eligible'
  static readonly authors = '<@U08PUHSMW4V>'
  static readonly defaultConfig = `
    // Shows a red squiggle on users who are not IDV verified
    // Shows an orange squiggle on users who verified ID but have since become >18
    "IdvStatus": {
      "enabled": false
    }
  `

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
          ? 'taut-idv-not-eligible'
          : idvStatus === 'over_18'
            ? 'taut-idv-over-18'
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

    this.api.setStyle(
      'idv-status',
      `
        .taut-idv-not-eligible, .taut-idv-not-eligible .c-message__sender_button {
          text-decoration: underline wavy #e01e5a !important;
          text-decoration-thickness: 1px !important;
        }

        .taut-idv-over-18, .taut-idv-over-18 .c-message__sender_button {
          text-decoration: underline wavy #d97706 !important;
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
