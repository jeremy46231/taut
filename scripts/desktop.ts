#!/usr/bin/env node

// Launches the desktop app in an isolated instance, run with --help

import { launchInstance, realConfigDir, URL_SPECS } from './lib/instance.ts'

const USAGE = `usage: npm run desktop:dev -- [name] [options]
       (or bun run desktop:dev ...)

Runs the desktop app with its own config dir and Chromium profile under
~/.taut-dev, so it sits beside a normal install instead of fighting it for the
single-instance lock. Logs go to <instance>/logs/, and the Chromium and main
process debuggers are open.

name            instance name (default: dev)
--seed          copy the real install's config and profile in first, so it
                starts signed in (your keychain is never read, so saved cookies
                and secrets don't come along)
--reset         delete the instance first
--url <spec>    which bundle to load: ${URL_SPECS.join(' | ')} | <url>
                none serves an empty script, local and debug serve dist/
--cdp <port>    devtools port (default: the first free one from 9222)
--system-install
                register slack:// and the desktop entry, as a real install
                does. Off by default, so the instance leaves your system alone
--background    keep it out of your way: no dock icon, never takes focus, and
                transparent and click-through (it still renders, so measurements
                are unaffected) (may be buggy, only tested on macOS)

To script it, import launchInstance from scripts/lib/instance.ts.
`

function fail(message: string): never {
  console.error(`[desktop] ${message}\n\n${USAGE}`)
  process.exit(1)
}

const argv = process.argv.slice(2)
const options: Parameters<typeof launchInstance>[0] = {}

const next = (flag: string) => {
  const value = argv.shift()
  if (value === undefined) fail(`${flag} needs a value`)
  return value
}

while (argv.length) {
  const arg = argv.shift() as string
  if (arg === '-h' || arg === '--help') {
    console.log(USAGE)
    process.exit(0)
  } else if (arg === '--seed') options.seed = true
  else if (arg === '--reset') options.reset = true
  else if (arg === '--url') options.url = next(arg)
  else if (arg === '--background') options.background = true
  else if (arg === '--system-install') options.systemInstall = true
  else if (arg === '--cdp') options.cdpPort = Number(next(arg))
  else if (arg.startsWith('-')) fail(`Unknown option "${arg}"`)
  else options.name = arg
}

if (options.seed) console.log(`[desktop] Seeding from ${realConfigDir()}`)
const taut = await launchInstance(options)
console.log(`[desktop] ${taut.root}`)
console.log(`[desktop] log ${taut.logPath}`)
console.log(`[desktop] devtools http://127.0.0.1:${taut.cdpPort}/json/list`)
console.log(`[desktop] main process inspector on ${taut.inspectPort}`)

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => taut.stop())
}
process.exit(await taut.exited)
