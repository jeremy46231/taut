// Adds a little cat that chases your cursor around the screen
// Based on oneko.js by @adryd325 (https://github.com/adryd325/oneko.js)

import { type TautAPI, TautPlugin, type TautPluginConfig } from '$taut'

const NEKO_FILE =
  'https://raw.githubusercontent.com/adryd325/oneko.js/46b0684f29694eaf3252835003f4d9d0258556e5/oneko.gif'

type SpriteCoordinates = [number, number]
type SpriteMap = Record<string, SpriteCoordinates[]>

const SPRITE_SETS: SpriteMap = {
  idle: [[-3, -3]],
  alert: [[-7, -3]],
  scratchSelf: [
    [-5, 0],
    [-6, 0],
    [-7, 0],
  ],
  scratchWallN: [
    [0, 0],
    [0, -1],
  ],
  scratchWallS: [
    [-7, -1],
    [-6, -2],
  ],
  scratchWallE: [
    [-2, -2],
    [-2, -3],
  ],
  scratchWallW: [
    [-4, 0],
    [-4, -1],
  ],
  tired: [[-3, -2]],
  sleeping: [
    [-2, 0],
    [-2, -1],
  ],
  N: [
    [-1, -2],
    [-1, -3],
  ],
  NE: [
    [0, -2],
    [0, -3],
  ],
  E: [
    [-3, 0],
    [-3, -1],
  ],
  SE: [
    [-5, -1],
    [-5, -2],
  ],
  S: [
    [-6, -3],
    [-7, -2],
  ],
  SW: [
    [-5, -3],
    [-6, -1],
  ],
  W: [
    [-4, -2],
    [-4, -3],
  ],
  NW: [
    [-1, 0],
    [-1, -1],
  ],
}

type OnekoState = {
  nekoPosX: number
  nekoPosY: number
  mousePosX: number
  mousePosY: number
  frameCount: number
  idleTime: number
  idleAnimation: string | null
  idleAnimationFrame: number
  bgPos: string
}

type OnekoConfig = TautPluginConfig & {
  speed: number
}

export default class Oneko extends TautPlugin {
  static readonly id = 'Oneko'
  static readonly pluginName = 'Oneko'
  static readonly description =
    'A cute cat that chases your cursor around the screen, based on <https://github.com/adryd325/oneko.js|oneko.js>'
  static readonly authors =
    '<https://github.com/adryd325|@adryd325>, <@U06UYA5GMB5>'
  static readonly defaultConfig = `
    // Adds a little cat that chases your cursor around the screen
    "Oneko": {
      "enabled": false,
      "speed": 10
    }
  `

  config: OnekoConfig

  nekoEl: HTMLDivElement | null = null
  animationFrameId: number | null = null
  lastFrameTimestamp: number | null = null

  // State
  nekoPosX = 32
  nekoPosY = 32
  mousePosX = 0
  mousePosY = 0
  frameCount = 0
  idleTime = 0
  idleAnimation: string | null = null
  idleAnimationFrame = 0

  // Event handlers bound to instance
  boundHandleMouseMove: (event: MouseEvent) => void
  boundHandleBeforeUnload: () => void
  boundOnAnimationFrame: (timestamp: number) => void

  constructor(api: TautAPI, config: TautPluginConfig) {
    super(api, config)
    this.config = {
      speed: 10,
      ...config,
    } as OnekoConfig
    this.boundHandleMouseMove = this.handleMouseMove.bind(this)
    this.boundHandleBeforeUnload = this.saveState.bind(this)
    this.boundOnAnimationFrame = this.onAnimationFrame.bind(this)
  }

  start(): void {
    this.log('Started')
    this.createNekoElement()
    this.loadState()
    this.attachListeners()

    // Start loop
    this.animationFrameId = window.requestAnimationFrame(
      this.boundOnAnimationFrame
    )
  }

  stop(): void {
    // Cancel loop
    if (this.animationFrameId !== null) {
      window.cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }

    // Save state one last time before destroying
    this.saveState()

    // Remove listeners
    document.removeEventListener('mousemove', this.boundHandleMouseMove)
    window.removeEventListener('beforeunload', this.boundHandleBeforeUnload)

    // Remove Element
    if (this.nekoEl) {
      this.nekoEl.remove()
      this.nekoEl = null
    }

    this.log('Stopped')
  }

  createNekoElement(): void {
    this.nekoEl = document.createElement('div')
    this.nekoEl.id = 'oneko'
    this.nekoEl.ariaHidden = 'true'
    this.nekoEl.style.width = '32px'
    this.nekoEl.style.height = '32px'
    this.nekoEl.style.position = 'fixed'
    this.nekoEl.style.pointerEvents = 'none'
    this.nekoEl.style.imageRendering = 'pixelated'
    this.nekoEl.style.zIndex = '2147483647'
    this.nekoEl.style.backgroundImage = `url(${NEKO_FILE})`

    document.body.appendChild(this.nekoEl)
  }

  attachListeners(): void {
    document.addEventListener('mousemove', this.boundHandleMouseMove)
    window.addEventListener('beforeunload', this.boundHandleBeforeUnload)
  }

  handleMouseMove(event: MouseEvent): void {
    this.mousePosX = event.clientX
    this.mousePosY = event.clientY
  }

  loadState(): void {
    try {
      const stored = window.localStorage.getItem('oneko')
      if (stored) {
        const state: OnekoState = JSON.parse(stored)
        this.nekoPosX = state.nekoPosX
        this.nekoPosY = state.nekoPosY
        this.mousePosX = state.mousePosX
        this.mousePosY = state.mousePosY
        this.frameCount = state.frameCount
        this.idleTime = state.idleTime
        this.idleAnimation = state.idleAnimation
        this.idleAnimationFrame = state.idleAnimationFrame

        if (this.nekoEl) {
          this.nekoEl.style.backgroundPosition = state.bgPos
          this.nekoEl.style.left = `${this.nekoPosX - 16}px`
          this.nekoEl.style.top = `${this.nekoPosY - 16}px`
        }
      }
    } catch (e) {
      this.log('Failed to load Oneko state', e)
    }
  }

  saveState(): void {
    if (!this.nekoEl) return

    try {
      const state: OnekoState = {
        nekoPosX: this.nekoPosX,
        nekoPosY: this.nekoPosY,
        mousePosX: this.mousePosX,
        mousePosY: this.mousePosY,
        frameCount: this.frameCount,
        idleTime: this.idleTime,
        idleAnimation: this.idleAnimation,
        idleAnimationFrame: this.idleAnimationFrame,
        bgPos: this.nekoEl.style.backgroundPosition,
      }
      window.localStorage.setItem('oneko', JSON.stringify(state))
    } catch (e) {
      this.log('Failed to save Oneko state', e)
    }
  }

  onAnimationFrame(timestamp: number): void {
    if (!this.nekoEl?.isConnected) {
      return
    }

    if (!this.lastFrameTimestamp) {
      this.lastFrameTimestamp = timestamp
    }

    if (timestamp - this.lastFrameTimestamp > 100) {
      if (timestamp - this.lastFrameTimestamp > 500) {
        // If more than 0.5 seconds have passed, reset to avoid large jumps
        this.lastFrameTimestamp = timestamp
      } else {
        this.lastFrameTimestamp += 100
      }
      this.frame()
    }

    this.animationFrameId = window.requestAnimationFrame(
      this.boundOnAnimationFrame
    )
  }

  setSprite(name: string, frame: number): void {
    if (!this.nekoEl) return
    const spriteSet = SPRITE_SETS[name]
    if (!spriteSet) return

    const sprite = spriteSet[frame % spriteSet.length]
    this.nekoEl.style.backgroundPosition = `${sprite[0] * 32}px ${sprite[1] * 32}px`
  }

  resetIdleAnimation(): void {
    this.idleAnimation = null
    this.idleAnimationFrame = 0
  }

  idle(): void {
    this.idleTime += 1

    // every ~ 20 seconds
    if (
      this.idleTime > 10 &&
      Math.floor(Math.random() * 200) === 0 &&
      this.idleAnimation === null
    ) {
      const availableIdleAnimations = ['sleeping', 'scratchSelf']
      if (this.nekoPosX < 32) {
        availableIdleAnimations.push('scratchWallW')
      }
      if (this.nekoPosY < 32) {
        availableIdleAnimations.push('scratchWallN')
      }
      if (this.nekoPosX > window.innerWidth - 32) {
        availableIdleAnimations.push('scratchWallE')
      }
      if (this.nekoPosY > window.innerHeight - 32) {
        availableIdleAnimations.push('scratchWallS')
      }
      this.idleAnimation =
        availableIdleAnimations[
          Math.floor(Math.random() * availableIdleAnimations.length)
        ]
    }

    switch (this.idleAnimation) {
      case 'sleeping':
        if (this.idleAnimationFrame < 8) {
          this.setSprite('tired', 0)
          break
        }
        this.setSprite('sleeping', Math.floor(this.idleAnimationFrame / 4))
        if (this.idleAnimationFrame > 192) {
          this.resetIdleAnimation()
        }
        break
      case 'scratchWallN':
      case 'scratchWallS':
      case 'scratchWallE':
      case 'scratchWallW':
      case 'scratchSelf':
        this.setSprite(this.idleAnimation, this.idleAnimationFrame)
        if (this.idleAnimationFrame > 9) {
          this.resetIdleAnimation()
        }
        break
      default:
        this.setSprite('idle', 0)
        return
    }
    this.idleAnimationFrame += 1
  }

  frame(): void {
    if (!this.nekoEl) return

    this.frameCount += 1
    const diffX = this.nekoPosX - this.mousePosX
    const diffY = this.nekoPosY - this.mousePosY
    const distance = Math.sqrt(diffX ** 2 + diffY ** 2)

    if (distance < this.config.speed || distance < 48) {
      this.idle()
      return
    }

    this.idleAnimation = null
    this.idleAnimationFrame = 0

    if (this.idleTime > 1) {
      this.setSprite('alert', 0)
      // count down after being alerted before moving
      this.idleTime = Math.min(this.idleTime, 7)
      this.idleTime -= 1
      return
    }

    let direction = diffY / distance > 0.5 ? 'N' : ''
    direction += diffY / distance < -0.5 ? 'S' : ''
    direction += diffX / distance > 0.5 ? 'W' : ''
    direction += diffX / distance < -0.5 ? 'E' : ''
    this.setSprite(direction, this.frameCount)

    this.nekoPosX -= (diffX / distance) * this.config.speed
    this.nekoPosY -= (diffY / distance) * this.config.speed

    this.nekoPosX = Math.min(
      Math.max(16, this.nekoPosX),
      window.innerWidth - 16
    )
    this.nekoPosY = Math.min(
      Math.max(16, this.nekoPosY),
      window.innerHeight - 16
    )

    this.nekoEl.style.left = `${this.nekoPosX - 16}px`
    this.nekoEl.style.top = `${this.nekoPosY - 16}px`
  }
}
