// Taut Modal API
// Gives access to use Slack's modal system

import { reactPromise } from '../slack/react'
import { getReduxStore } from '../slack/redux'
import { waitForExport } from '../slack/webpack'
import { elementsAPIPromise } from './elements'

type RawModalHandle = { close: () => void; render: (props: unknown) => void }
type OpenModalThunk = (opts: {
  element: React.ReactElement
  name?: string
  isStackable?: boolean
}) => unknown

export interface OpenModalOptions {
  title: React.ReactNode
  body: React.ReactNode
  submitText?: string
  cancelText?: string
  danger?: boolean
  showCancelButton?: boolean
  showSubmitButton?: boolean
  onSubmit?: () => void
  onCancel?: () => void
  onClose?: () => void
}

export interface ModalHandle {
  close: () => void
}

export interface ConfirmOptions {
  title: React.ReactNode
  body?: React.ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean
}

export interface AlertOptions {
  title: React.ReactNode
  body?: React.ReactNode
  closeText?: string
}

/**
 * Build the convenience dialog helpers over a given `openModal`
 */
export function dialogHelpersFor(
  openModal: (options: OpenModalOptions) => ModalHandle | null
) {
  /** Show a confirm/cancel dialog; resolves `true` if confirmed, `false` on cancel or dismissal. */
  function confirm(options: ConfirmOptions): Promise<boolean> {
    return new Promise((resolve) => {
      let settled = false
      const settle = (result: boolean) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      const handle = openModal({
        title: options.title,
        body: options.body ?? null,
        submitText: options.confirmText ?? 'Confirm',
        cancelText: options.cancelText ?? 'Cancel',
        danger: options.danger,
        onSubmit: () => settle(true),
        onCancel: () => settle(false),
        onClose: () => settle(false),
      })
      if (!handle) settle(false)
    })
  }

  /** Show a dialog with a title/body and a single close button; resolves once the user dismisses it. */
  function alert(options: AlertOptions): Promise<void> {
    return new Promise((resolve) => {
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        resolve()
      }
      const handle = openModal({
        title: options.title,
        body: options.body ?? null,
        submitText: options.closeText ?? 'OK',
        showCancelButton: false,
        onSubmit: settle,
        onClose: settle,
      })
      if (!handle) settle()
    })
  }

  return { confirm, alert }
}

export const modalAPIPromise = (async () => {
  await reactPromise
  const elements = await elementsAPIPromise

  let openModalThunk: OpenModalThunk | undefined
  void waitForExport<OpenModalThunk>(
    (e: unknown) =>
      typeof e === 'function' &&
      (e as { meta?: { name?: string } }).meta?.name === 'openModal'
  ).then((found) => {
    openModalThunk = found
  })

  const Confirmation = elements.ConfirmationModal
  const Label = elements.Label
  const TextInput = elements.FormTextInput

  function openModal(options: OpenModalOptions): ModalHandle | null {
    const store = getReduxStore()
    const openModalAction = openModalThunk
    if (!store || !openModalAction) {
      console.error('[Taut] Modal API: Slack modal system unavailable')
      return null
    }

    const closeRef = { current: () => {} }
    const element = (
      <Confirmation
        title={options.title}
        submitButtonText={options.submitText ?? 'Save'}
        cancelButtonText={options.cancelText ?? 'Cancel'}
        submitButtonType={options.danger ? 'danger' : 'primary'}
        showCancelButton={options.showCancelButton ?? true}
        showSubmitButton={options.showSubmitButton ?? true}
        onSubmit={() => {
          options.onSubmit?.()
          closeRef.current()
        }}
        onCancel={() => {
          options.onCancel?.()
          closeRef.current()
        }}
        onClose={() => {
          options.onClose?.()
          closeRef.current()
        }}
      >
        {options.body}
      </Confirmation>
    )

    const name = typeof options.title === 'string' ? options.title : 'modal'
    const handle = store.dispatch(
      openModalAction({ element, name, isStackable: true })
    ) as RawModalHandle | undefined
    closeRef.current = () => handle?.close()

    return { close: () => handle?.close() }
  }

  return { openModal, ...dialogHelpersFor(openModal), Label, TextInput }
})()

export type ModalAPI = Awaited<typeof modalAPIPromise>
