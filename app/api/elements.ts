// Taut Elements Registry
// Central place to find Slack's React components

import { findComponentPromise, reactPromise } from '../slack/react'

export type SvgIconProps = {
  name: string
  size?: number
  inline?: boolean
}

export type MrkdwnElementProps = {
  text: string
}

export type ButtonProps = {
  type?: 'primary' | 'ghost' | 'outline' | 'danger'
  size?: 'small' | 'medium' | 'large'
  icon?: string
  href?: string
  htmlType?: 'button' | 'submit' | 'reset'
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'size'>

export type TooltipProps = {
  tip: string
  position?: string
  offsetY?: number
  delay?: number
  zIndex?: string
  children?: React.ReactNode
}

export type IconButtonBaseProps = {
  size?: string
  className?: string
  'aria-pressed'?: string
  'aria-label'?: string
  'data-qa'?: string
  onClick?: () => void
  tabIndex?: number
  children?: React.ReactNode
}

export type ConfirmationModalProps = {
  title?: React.ReactNode
  children?: React.ReactNode
  onSubmit?: () => void
  onCancel?: () => void
  onClose?: () => void
  submitButtonText?: string
  cancelButtonText?: string
  submitButtonType?: 'primary' | 'danger'
  showCancelButton?: boolean
  showSubmitButton?: boolean
  disableSubmitButton?: boolean
}

export type LabelProps = {
  text: React.ReactNode
  htmlFor?: string
  subtext?: React.ReactNode
  optional?: boolean
  type?: 'block' | 'inline'
  isDisabled?: boolean
  className?: string
  id?: string
}

export type FormTextInputProps = {
  id?: string
  name?: string
  value: string
  onChange: (value: string) => void
  onBlur?: React.FocusEventHandler<HTMLInputElement>
  onFocus?: React.FocusEventHandler<HTMLInputElement>
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
  placeholder?: string
  hintText?: string | null
  errorText?: string | null
  isDisabled?: boolean
  isInvalid?: boolean
  isRequired?: boolean
  size?: 'small' | 'medium' | 'large'
  autoFocus?: boolean
  autoComplete?: string
  maxCharacterLimit?: number | null
  className?: string
}

// A component that renders nothing and logs once, for when a lookup fails
function missingElement<P extends {}>(name: string): React.ComponentType<P> {
  let warned = false
  return function TautMissingElement() {
    if (!warned) {
      warned = true
      console.error(`[Taut] Elements: "${name}" is unavailable`)
    }
    return null
  }
}

export const elementsAPIPromise = (async () => {
  await reactPromise
  const findComponent = await findComponentPromise

  function resolve<P extends {}>(name: string): React.ComponentType<P> {
    try {
      return findComponent<P>(name)
    } catch (err) {
      console.error(`[Taut] Elements: could not resolve "${name}"`, err)
      return missingElement<P>(name)
    }
  }

  return {
    SvgIcon: resolve<SvgIconProps>('SvgIcon'),
    MrkdwnElement: resolve<MrkdwnElementProps>('MrkdwnElement'),
    Button: resolve<ButtonProps>('Button'),
    Tooltip: resolve<TooltipProps>('Tooltip'),
    IconButtonBase: resolve<IconButtonBaseProps>('IconButtonBase'),
    ConfirmationModal: resolve<ConfirmationModalProps>('ConfirmationModal'),
    Label: resolve<LabelProps>('Label'),
    FormTextInput: resolve<FormTextInputProps>('FormTextInput'),
  }
})()

export type ElementsAPI = Awaited<typeof elementsAPIPromise>
