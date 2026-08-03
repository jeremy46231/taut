// Shared message-send Delta transform hook
// Patches the three Slack components that handle outgoing messages once,
// then lets plugins register/unregister transform functions at any time.

import type { Delta } from '../../shared/Plugin'
import type { componentReplacer } from '../slack/react'

type PatchComponent = <TProps>(
  name: string,
  replacer: componentReplacer<TProps>
) => () => void

type SendProps = {
  prepareAndSendMessage: (opts: { delta: Delta }) => Promise<unknown>
}
type EditProps = {
  prepareAndSaveEditMessage: (opts: { delta: Delta }) => Promise<unknown>
}

export function setupMessageSendDelta(patchComponent: PatchComponent) {
  const transforms = new Set<(delta: Delta) => Delta>()

  function applyTransforms(delta: Delta): Delta {
    let result = delta
    for (const t of transforms) result = t(result)
    return result
  }

  for (const name of ['MessagePaneInput', 'InputContainer'] as const) {
    patchComponent<SendProps>(name, (Original) => (props) => {
      const send = React.useCallback(
        (opts: { delta: Delta }) =>
          props.prepareAndSendMessage({
            ...opts,
            delta: applyTransforms(opts.delta),
          }),
        [props.prepareAndSendMessage]
      )
      return <Original {...props} prepareAndSendMessage={send} />
    })
  }

  patchComponent<EditProps>('BaseEditMessage', (Original) => (props) => {
    const save = React.useCallback(
      (opts: { delta: Delta }) =>
        props.prepareAndSaveEditMessage({
          ...opts,
          delta: applyTransforms(opts.delta),
        }),
      [props.prepareAndSaveEditMessage]
    )
    return <Original {...props} prepareAndSaveEditMessage={save} />
  })

  return function onMessageSendDelta(
    transform: (delta: Delta) => Delta
  ): () => void {
    transforms.add(transform)
    return () => transforms.delete(transform)
  }
}
