// for some reason this needs to be in its own file

declare module '*.css' {
  const css: string
  export default css
}

// baseline 2025 (chrome 136, firefox 134), not yet in typescript 5.9's lib
interface RegExpConstructor {
  escape(text: string): string
}

// chrome 140, firefox 133, not yet in typescript 5.9's lib
interface Uint8Array {
  toBase64(): string
}
interface Uint8ArrayConstructor {
  fromBase64(base64: string): Uint8Array<ArrayBuffer>
}
