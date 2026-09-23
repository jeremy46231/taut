// Warns before sending a haiku that Orpheus will copy into the thread

import { type Delta, TautPlugin } from '$taut'
import { blocksToSlackText, dictionaryLookup, findHaiku } from './lib/haiku'

type SendOptions = { delta: Delta }
type ComposerProps = {
  channelId?: string
  conversationId?: string
  channel?: { id?: string }
  prepareAndSendMessage?: (options: SendOptions) => unknown
}

const EXCLUDED_CHANNEL = 'C09MATKQM8C'
const DICTIONARY_KEY = 'orpheus-syllables-aece7f5'
const DICTIONARY_URL =
  'https://raw.githubusercontent.com/hackclub/orpheus-bot/aece7f5fcc873b8e71ecccfa5216849fafd959e1/app/lib/haiku_check/syllable_counts.txt'

export default class HaikuWarning extends TautPlugin {
  static readonly id = 'HaikuWarning'
  static readonly pluginName = 'Haiku Warning'
  static readonly description =
    'Warns before sending a haiku that Orpheus may copy into the thread'
  static readonly authors = '<@U09KKMHLS15>'
  static readonly defaultConfig = `
    // Warn before Orpheus copies an accidental haiku into the thread
    "HaikuWarning": {
      "enabled": false
    }
  `

  private dictionary: Promise<string | null> | undefined
  private readonly approved = new WeakSet<Delta>()
  private readonly pending = new WeakMap<Delta, Promise<boolean>>()

  start(): void {
    this.dictionary = this.loadDictionary()

    for (const name of ['MessagePaneInput', 'InputContainer'] as const) {
      this.api.patchComponent<ComposerProps>(name, (Original) => (props) => {
        const originalSend = props.prepareAndSendMessage
        const channelId =
          props.channelId ?? props.conversationId ?? props.channel?.id
        const send = React.useCallback(
          (options: SendOptions) =>
            this.reviewAndSend(options, channelId, originalSend),
          [channelId, originalSend]
        )

        if (!originalSend) return <Original {...props} />
        return <Original {...props} prepareAndSendMessage={send} />
      })
    }

    this.log('Started')
  }

  private async reviewAndSend(
    options: SendOptions,
    channelId: string | undefined,
    send: ComposerProps['prepareAndSendMessage']
  ): Promise<unknown> {
    if (!send) return

    const delta = options.delta
    if (this.approved.delete(delta) || channelId === EXCLUDED_CHANNEL) {
      return send(options)
    }

    const existing = this.pending.get(delta)
    if (existing) {
      // One click owns the eventual send; repeated shortcuts while its modal is
      // open should not queue duplicate messages.
      await existing
      return
    }

    const confirmation = this.review(delta)
    this.pending.set(delta, confirmation)
    let approved: boolean
    try {
      approved = await confirmation
    } finally {
      this.pending.delete(delta)
    }
    if (!approved || this.api.signal.aborted) return

    // MessagePaneInput and InputContainer can both participate in one send.
    // Let the next wrapper recognize the already-approved Delta.
    this.approved.add(delta)
    return send(options)
  }

  private async review(delta: Delta): Promise<boolean> {
    try {
      const [dictionary, blocks] = await Promise.all([
        this.dictionary,
        this.api.blocks.fromDelta(delta),
      ])
      if (!dictionary || this.api.signal.aborted) return true

      const text = blocksToSlackText(blocks)
      // This is the same precondition as Orpheus's message checklist. Ruby's
      // String#length counts Unicode code points rather than UTF-16 units.
      if ([...text].length >= 300) return true

      const haiku = findHaiku(text, (word) =>
        dictionaryLookup(dictionary, word)
      )
      if (!haiku) return true

      return this.api.modal.confirm({
        title: (
          <this.api.elements.MrkdwnElement text=":orpheus-woah: found a haiku in your messsage!" />
        ),
        confirmText: 'Send anyway',
        cancelText: 'Keep editing',
        body: (
          <div>
            <p style={{ marginTop: 0 }}>
              If Orpheus is in this channel, then she will repeat your message,
              preserving it so it can&apos;t be deleted. Ensure you&apos;re okay
              with this message:
            </p>
            <blockquote style={{ whiteSpace: 'pre-line', marginBottom: 0 }}>
              {haiku.join('\n')}
            </blockquote>
          </div>
        ),
      })
    } catch (error) {
      this.log('Could not check message', error)
      return true
    }
  }

  private async loadDictionary(): Promise<string | null> {
    const cached = await this.api.storage.get<string | null>(
      DICTIONARY_KEY,
      null
    )
    if (cached) return cached

    try {
      const response = await this.api.fetch(DICTIONARY_URL, {
        signal: this.api.signal,
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const dictionary = await response.text()
      if (dictionary.length < 1_000_000)
        throw new Error('Incomplete dictionary')
      if (!this.api.signal.aborted) {
        await this.api.storage.set(DICTIONARY_KEY, dictionary)
      }
      return dictionary
    } catch (error) {
      if (!this.api.signal.aborted) this.log('Could not load dictionary', error)
      return null
    }
  }
}
