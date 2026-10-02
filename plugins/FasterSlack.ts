// Optimizations that make Slack faster and smoother

import { opt, TautPlugin } from '$taut'

const QUIET_MS = 150

export default class FasterSlack extends TautPlugin<typeof FasterSlack> {
  static readonly id = 'FasterSlack'
  static readonly pluginName = 'Faster Slack'
  static readonly description =
    'Optimizations that make Slack faster and smoother'
  static readonly authors = ['jeremy'] as const
  static readonly category = 'app'
  static readonly defaultConfig = {
    enabled: true,
    optimizeResize: opt(
      true,
      "Pause Slack's layout work while the window is being resized"
    ),
  }

  /** [window width, the basis slack settled on], most recent last */
  private samples: [number, number][] = []

  start() {
    if (this.config.optimizeResize) {
      // slack's js sets the left basis linearly in window width, so css extrapolates it from two samples while paused
      this.api.setStyle(
        `
          .taut-resizing .p-ia4_top_nav__left_container {
            flex-basis: var(--taut-top-nav-left-basis) !important;
          }
        `,
        'top-nav'
      )
      this.sampleLeftBasis()
      this.api.deferResizeWork({
        quietMs: QUIET_MS,
        onHoldChange: (holding) => this.onHoldChange(holding),
      })
    }
    this.log('Started')
  }

  stop() {
    document.documentElement.classList.remove('taut-resizing')
    document.documentElement.style.removeProperty('--taut-top-nav-left-basis')
    this.log('Stopped')
  }

  private onHoldChange(holding: boolean) {
    const { classList, style } = document.documentElement
    if (holding) {
      if (style.getPropertyValue('--taut-top-nav-left-basis'))
        classList.add('taut-resizing')
      return
    }
    classList.remove('taut-resizing')
    // slack writes its own basis as it re-renders, so read it after that
    requestAnimationFrame(() => this.sampleLeftBasis())
  }

  private sampleLeftBasis() {
    const container = document.querySelector<HTMLElement>(
      '.p-ia4_top_nav__left_container'
    )
    const basis = Number.parseFloat(container?.style.flexBasis ?? '')
    const width = window.innerWidth
    if (!Number.isFinite(basis) || !width) return

    const previous = this.samples.at(-1)
    if (previous && Math.abs(previous[0] - width) < 1) return
    const next: [number, number] = [width, basis]
    this.samples = [...this.samples, next].slice(-2)

    const [first, last] = this.samples
    let value = `calc(100vw * ${first[1] / first[0]})`
    if (last) {
      const slope = (last[1] - first[1]) / (last[0] - first[0])
      if (!(slope > 0)) return
      value = `calc(${last[1]}px + ${slope} * (100vw - ${last[0]}px))`
    }
    document.documentElement.style.setProperty(
      '--taut-top-nav-left-basis',
      value
    )
  }
}
