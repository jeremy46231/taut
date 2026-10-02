import { type Block, blocksPromise } from '../blocks'
import { patchComponentPromise } from '../react'

/** which composer a message is being sent from */
export interface SendCheckContext {
  channelId: string
  threadTs?: string
}

/** return false to keep the message in the composer, may be async (for example, to ask for confirmation) */
export type SendCheck = (
  blocks: Block[],
  context: SendCheckContext
) => boolean | Promise<boolean>

const sendChecks = new Set<SendCheck>()

/** check every message sent from a composer before it goes out */
export function addSendCheck(check: SendCheck): () => void {
  sendChecks.add(check)
  return () => {
    sendChecks.delete(check)
  }
}

async function passesSendChecks(
  delta: unknown,
  context: SendCheckContext
): Promise<boolean> {
  let blocks: Block[]
  try {
    blocks = await (await blocksPromise).fromDelta(delta as never)
  } catch (err) {
    console.error('[Taut] Send checks could not read the message:', err)
    return true
  }
  for (const check of sendChecks) {
    try {
      if ((await check(blocks, context)) === false) return false
    } catch (err) {
      console.error('[Taut] Send check failed:', err)
    }
  }
  return true
}

type SendOptions = { delta?: object; channelId?: string; replyToTs?: string }
type SendProps = {
  channelId?: string
  threadTs?: string
  prepareAndSendMessage?: (options: SendOptions) => Promise<unknown>
}

// one send can pass through both composers' patches, so each delta is decided once
const sendDecisions = new WeakMap<object, Promise<boolean>>()

patchComponentPromise.then((patchComponent) => {
  // channel composers send through MessagePaneInput, thread composers through InputContainer
  for (const name of ['MessagePaneInput', 'InputContainer']) {
    patchComponent<SendProps>(name, (Original) => (props) => {
      const send = props.prepareAndSendMessage
      const checkedSend = React.useCallback(
        async (options: SendOptions) => {
          const { delta } = options
          const channelId = options.channelId || props.channelId
          if (!send || !sendChecks.size || !delta || !channelId) {
            return send?.(options)
          }
          let decision = sendDecisions.get(delta)
          if (!decision) {
            decision = passesSendChecks(delta, {
              channelId,
              threadTs: options.replyToTs ?? props.threadTs,
            })
            sendDecisions.set(delta, decision)
          }
          if (!(await decision)) {
            sendDecisions.delete(delta)
            // a rejected send puts the message back in the composer, as Slack's warnings do
            throw new Error('[Taut] A send check held this message back')
          }
          return send(options)
        },
        [send, props.channelId, props.threadTs]
      )
      if (!send) return <Original {...props} />
      return <Original {...props} prepareAndSendMessage={checkedSend} />
    })
  }
})
