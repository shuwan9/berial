import { App, Lifecycles } from './types'
import { importHtml } from './html-loader'
import { lifecycleCheck } from './util'

export enum Status {
  NOT_LOADED = 'NOT_LOADED',
  LOADING = 'LOADING',
  NOT_BOOTSTRAPPED = 'NOT_BOOTSTRAPPED',
  BOOTSTRAPPING = 'BOOTSTRAPPING',
  NOT_MOUNTED = 'NOT_MOUNTED',
  MOUNTING = 'MOUNTING',
  MOUNTED = 'MOUNTED',
  UPDATING = 'UPDATING',
  UPDATED = 'UPDATED',
  UNMOUNTING = 'UNMOUNTING'
}

let started = false
const apps: any = new Set()
const deps: any = new Set()

export function register(name: string, entry: string, match: any) {
  apps.add({
    name,
    entry,
    match,
    status: Status.NOT_LOADED
  } as App)
}

export function start(store: any) {
  started = true
  reroute(store || {})
}

function reroute(store: any) {
  const { loads, mounts, unmounts } = getAppChanges()
  if (started) {
    return perform()
  } else {
    return init()
  }
  async function init() {
    await Promise.all(loads.map(runLoad))
  }
  async function perform() {
    unmounts.map(runUnmount)
    loads.map(async (app) => {
      app = await runLoad(app, store)
      app = await runBootstrap(app)
      return runMount(app)
    })
    mounts.map(async (app) => {
      app = await runBootstrap(app)
      return runMount(app)
    })
  }
}

function getAppChanges() {
  const unmounts: App[] = []
  const loads: App[] = []
  const mounts: App[] = []
  apps.forEach((app: any) => {
    const isActive = app.match(window.location)
    switch (app.status) {
      case Status.NOT_LOADED:
      case Status.LOADING:
        isActive && loads.push(app)
        break
      case Status.NOT_BOOTSTRAPPED:
      case Status.BOOTSTRAPPING:
      case Status.NOT_MOUNTED:
        isActive && mounts.push(app)
        break
      case Status.MOUNTED:
        !isActive && unmounts.push(app)
    }
  })
  return { unmounts, loads, mounts }
}

function compose(fns: ((app: App) => Promise<any>)[]) {
  fns = Array.isArray(fns) ? fns : [fns]
  return (app: App) =>
    fns.reduce((p, fn) => p.then(() => fn(app)), Promise.resolve())
}

async function runLoad(app: App, store: any) {
  if (app.loaded) {
    return app.loaded
  }
  app.loaded = Promise.resolve().then(async () => {
    app.status = Status.LOADING
    let lifecycle: Lifecycles
    let bodyNode: HTMLDivElement
    let styleNodes: HTMLStyleElement[]
    let host = (await loadShadowDOM(app, store)) as any // null shadow dom
    if (typeof app.entry === 'string') {
      const exports = await importHtml(app)
      lifecycleCheck(exports.lifecycle)
      lifecycle = exports.lifecycle
      bodyNode = exports.bodyNode
      styleNodes = exports.styleNodes

      host.shadowRoot?.appendChild(bodyNode)
      for (const k of styleNodes) {
        host.shadowRoot!.insertBefore(k, host.shadowRoot!.firstChild)
      }
    } else {
      lifecycle = (await app.entry(app)) as any
      lifecycleCheck(lifecycle)
    }
    app.status = Status.NOT_BOOTSTRAPPED
    app.bootstrap = compose(lifecycle.bootstrap)
    app.mount = compose(lifecycle.mount)
    app.unmount = compose(lifecycle.unmount)
    app.update = compose(lifecycle.update)
    app.host = host
    delete app.loaded
    return app
  })
  return app.loaded
}

function loadStore(store: any, app: any) {
  return new Proxy(store, {
    get(target, key) {
      const has = app.deps.has(app)
      if (!has) {
        // collect once
        deps.add(app)
      }
      return target[key]
    },
    set(target, key, val) {
      target[key] = val
      deps.forEach((app: App) => app.update(app))
      return true
    }
  })
}

async function loadShadowDOM(
  app: App,
  store: any,
  body?: HTMLElement,
  styles?: HTMLElement[]
) {
  return new Promise<HTMLElement>((resolve) => {
    class Berial extends HTMLElement {
      static get tag() {
        return app.name
      }
      connectedCallback() {
        resolve(this)
      }
      store: any
      constructor() {
        super()
        this.attachShadow({ mode: 'open' })
        this.store = loadStore(store, app)
      }
    }
    const hasDef = window.customElements.get(app.name)
    if (!hasDef) {
      customElements.define(app.name, Berial)
    }
  })
}

async function runUnmount(app: App) {
  if (app.status != Status.MOUNTED) {
    return app
  }
  app.status = Status.UNMOUNTING
  await app.unmount(app)
  app.status = Status.NOT_MOUNTED
  return app
}

async function runBootstrap(app: App) {
  if (app.status !== Status.NOT_BOOTSTRAPPED) {
    return app
  }
  app.status = Status.BOOTSTRAPPING
  await app.bootstrap(app)
  app.status = Status.NOT_MOUNTED
  return app
}

async function runMount(app: App) {
  if (app.status !== Status.NOT_MOUNTED) {
    return app
  }
  app.status = Status.MOUNTING
  await app.mount(app)
  app.status = Status.MOUNTED
  return app
}

const routingEventsListeningTo = ['hashchange', 'popstate']

function urlReroute() {
  reroute({})
}
const capturedEvents = {
  hashchange: [],
  popstate: []
} as any

window.addEventListener('hashchange', urlReroute)
window.addEventListener('popstate', urlReroute)
const originalAddEventListener = window.addEventListener
const originalRemoveEventListener = window.removeEventListener
window.addEventListener = function (name: any, fn: any, ...args: any) {
  if (
    routingEventsListeningTo.indexOf(name) >= 0 &&
    !capturedEvents[name].some((l: any) => l == fn)
  ) {
    capturedEvents[name].push(fn)
    return
  }
  // @ts-ignore
  return originalAddEventListener.apply(this, args)
}
window.removeEventListener = function (name: any, fn: any, ...args: any) {
  if (routingEventsListeningTo.indexOf(name) >= 0) {
    capturedEvents[name] = capturedEvents[name].filter((l: any) => l !== fn)
    return
  }
  //@ts-ignore
  return originalRemoveEventListener.apply(this, args)
}

function patchedUpdateState(updateState: any, ...args: any) {
  return function () {
    const urlBefore = window.location.href
    // @ts-ignore
    updateState.apply(this, args)
    const urlAfter = window.location.href

    if (urlBefore !== urlAfter) {
      // @ts-ignore
      urlReroute(new PopStateEvent('popstate'))
    }
  }
}

window.history.pushState = patchedUpdateState(window.history.pushState)
window.history.replaceState = patchedUpdateState(window.history.replaceState)
