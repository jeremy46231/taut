// minimal reactive store for state read inside a React render

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

  subscribe = (onChange: () => void) => {
    this.target.addEventListener('change', onChange)
    return () => this.target.removeEventListener('change', onChange)
  }

  /** a hook, rerenders the component when the value changes */
  use = (): T => {
    return React.useSyncExternalStore(this.subscribe, this.get)
  }
}
