import { reactPromise } from '../slack/react'
import { elementsAPIPromise, type MenuTemplateItem } from './elements'

export type { MenuTemplateItem }

export interface MenuProps {
  template: MenuTemplateItem[]
  position?: 'top' | 'bottom' | 'left' | 'right'
  /** the element that opens the menu */
  children?: React.ReactNode
}

export const menuAPIPromise = (async () => {
  await reactPromise
  const { MenuTrigger, MenuFromTemplate } = await elementsAPIPromise

  /** wraps a trigger element to open a Slack menu built from `template` */
  function Menu({ template, position, children }: MenuProps) {
    return (
      <MenuTrigger
        position={position}
        renderMenu={(menuProps) => (
          <MenuFromTemplate {...menuProps} template={template} />
        )}
      >
        {children}
      </MenuTrigger>
    )
  }

  return { Menu }
})()

export type MenuAPI = Awaited<typeof menuAPIPromise>
