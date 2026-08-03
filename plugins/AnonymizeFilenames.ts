// Randomizes file names before Slack uploads them to prevent metadata leakage

import { TautPlugin } from '$taut'

const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'
const NAME_LENGTH = 7

function randomName(): string {
  const bytes = new Uint32Array(NAME_LENGTH)
  window.crypto.getRandomValues(bytes)
  let name = ''
  for (let i = 0; i < NAME_LENGTH; i++) name += CHARS[bytes[i] % CHARS.length]
  return name
}

function fileExtension(name: string): string {
  const base = name.slice(
    Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1
  )
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

export default class AnonymizeFileNames extends TautPlugin {
  static readonly id = 'AnonymizeFilenames'
  static readonly pluginName = 'Anonymize Filenames'
  static readonly description =
    'Randomizes file names before uploading to prevent metadata leakage'
  static readonly authors = '<@U080A3QP42C>, <@U06UYA5GMB5>'
  static readonly defaultConfig = `
    // Randomizes file names before uploading to prevent metadata leakage
    "AnonymizeFilenames": {
      "enabled": false
    }
  `

  private originalDescriptor: PropertyDescriptor | null = null
  private cache = new WeakMap<File, string>()

  start(): void {
    const descriptor = Object.getOwnPropertyDescriptor(File.prototype, 'name')
    if (
      !descriptor ||
      typeof descriptor.get !== 'function' ||
      !descriptor.configurable
    ) {
      this.log('Warning: File.prototype.name is not patchable')
      return
    }

    this.originalDescriptor = descriptor
    const originalGet = descriptor.get
    const cache = this.cache

    Object.defineProperty(File.prototype, 'name', {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: function (this: File) {
        const real = String(originalGet.call(this))
        let anonymized = cache.get(this)
        if (anonymized !== undefined) return anonymized
        anonymized = randomName() + fileExtension(real)
        cache.set(this, anonymized)
        return anonymized
      },
    })

    this.log('Started')
  }

  stop(): void {
    if (this.originalDescriptor) {
      Object.defineProperty(File.prototype, 'name', this.originalDescriptor)
      this.originalDescriptor = null
    }
    this.cache = new WeakMap()
    this.log('Stopped')
  }
}
