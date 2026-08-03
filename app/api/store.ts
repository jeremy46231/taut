// Minimal reactive store for plugin-owned state read inside patched components

export class Store<T> {
  private value: T
  private target = new EventTarget()

  constructor(initial: T) {
    this.value = initial
  }

  get = (): T => this.value

  set = (next: T): void => {
    this.value = next
    this.notify()
  }

  update = (updater: (value: T) => T): void => {
    this.value = updater(this.value)
    this.notify()
  }

  private notify() {
    this.target.dispatchEvent(new Event('change'))
  }

  private subscribe = (onChange: () => void) => {
    this.target.addEventListener('change', onChange)
    return () => this.target.removeEventListener('change', onChange)
  }

  /** Reactively read the current value inside a component */
  use = (): T => {
    return React.useSyncExternalStore(this.subscribe, this.get)
  }
}
