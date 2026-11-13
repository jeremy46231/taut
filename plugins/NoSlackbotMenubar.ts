// Hides or quiets the Slackbot Mini icon Slack for Mac puts in the menu bar

import { opt, TautPlugin } from '$taut'

const CLICK_ACTIONS = [
  { value: 'default', label: 'What Slack does' },
  { value: 'nothing', label: 'Nothing' },
]

export default class NoSlackbotMenubar extends TautPlugin<
  typeof NoSlackbotMenubar
> {
  static readonly id = 'NoSlackbotMenubar'
  static readonly pluginName = 'No Slackbot Menubar'
  static readonly description =
    'Hides or quiets the Slackbot Mini icon in the menu bar'
  static readonly authors = ['izie'] as const
  static readonly category = 'app'
  static readonly defaultConfig = {
    enabled: true,
    hideIcon: opt(true, 'Remove the icon from the menu bar'),
    leftClick: opt.select(
      CLICK_ACTIONS,
      'nothing',
      'Left click on the icon, opens Slackbot Mini by default'
    ),
    rightClick: opt.select(
      CLICK_ACTIONS,
      'default',
      'Right click on the icon, shows its menu by default'
    ),
    disableSlackbotMini: opt(
      false,
      'Also turn off Slackbot Mini and its keyboard shortcut'
    ),
  }

  start(): void {
    const { hideIcon, leftClick, rightClick, disableSlackbotMini } = this.config
    if (disableSlackbotMini)
      this.api.experiments.set('desktop_command_center', 'off')

    // a hidden icon can't be clicked, so there is nothing to take over
    if (hideIcon) {
      this.api.tray.setHidden(true)
    } else {
      const events: ('click' | 'right-click')[] = []
      if (leftClick === 'nothing') events.push('click')
      if (rightClick === 'nothing') events.push('right-click')
      this.api.tray.intercept(events)
    }
    this.api.tray.state().then(({ present }) => {
      if (!present) this.log('No menu bar icon to change')
    })
    this.log('Started')
  }
}
