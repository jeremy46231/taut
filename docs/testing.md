# Running and debugging Taut

## A browser with Taut in it

Any browser and any loader works, including a browser you already run Taut in. An agent should ask its user which browser to use or set one up itself, and save the answer (browser, profile path, how to launch it) so it doesn't ask again.

To set one up from scratch:

1. `npm run build -- extension`, then `npm run dev`. The dev server serves `http://localhost:3000/taut.js` and rebuilds on every change, and `PORT` sets the port.
2. Launch a Chromium-based browser with its own profile directory (`--user-data-dir`) and the unpacked extension (`--load-extension` pointing at `dist/extension/chrome`), with first-run prompts skipped (`--no-first-run --no-default-browser-check`) and remote debugging on (`--remote-debugging-port`). Put the profile somewhere durable, not `/tmp` or a scratch directory, since those get cleared and the sign-in is lost. Branded Google Chrome ignores `--load-extension`. Chromium and most forks accept it, some only with `--disable-features=DisableLoadExtensionCommandLineSwitch`.
3. In the extension's options, set the app bundle URL to the dev server.
4. Open `https://hackclub.slack.com`, which goes to the login page and never hands off to the desktop app. A new profile needs one sign-in, which an agent should ask its user to do.
5. An agent can then drive it over CDP with whatever tool it has (a DevTools MCP, Claude in Chrome, ...).

The account signed in is a real person, and anything the browser does, they did. Send test messages only somewhere private (a test channel, or a DM to yourself), mark them as tests, and delete them afterwards.

## The dev loop

- Edits under `app/`, `plugins/` or `shared/` rebuild the bundle. Reload the Slack tab to pick them up.
- If a build fails, the dev server serves a stub that logs the build error to the browser console and loads no Taut. The server's output shows it too.
- A change to a loader (`extension/`, `userscript/`, `desktop/`) needs that loader rebuilt and reloaded, not just the page.
- Run `npm run check` and `npm run build` before you finish.

## Globals

Taut puts these on `window` for the console. Search `app/` for `global.` to find their definitions.

- `TautAPI`: the plugin API, including the webpack lookups. Per-plugin storage lives on each plugin's own `this.api` instead.
- `__tautPluginManager`: the loaded plugins and their instances. `configStore` holds Taut's config.
- React helpers: `getComponent`, `waitForComponent`, `patchComponent`, `getFiberFromNode`, `getComponentSource`, and `getRenderedComponent`, which finds components seen on screen, including ones Slack doesn't export.
- `__webpackModuleRegistry` and `__webpackModuleFactories`, both `Map`s.

## When something's broken

Things to figure out:

- what happens, and the steps to make it happen
- their Taut version, which loader (desktop, extension, userscript) and its version, browser and OS
- any error Taut settings shows for a plugin
- console output from around the problem

Then narrow it down:

- Safe mode (in Taut settings, or `?taut_safe_mode` on the URL) boots with no plugins and no custom CSS. If the problem goes away there, it's a plugin or custom CSS, so turn plugins off one at a time to find it. Turning a plugin off clears its cache, so capture anything you need first. If it's still broken in safe mode, it could be Taut itself, the loader, or something outside Taut.
- If it's still broken with Taut removed entirely, look at Slack or the environment (other extensions, the network, the browser).

If the desktop app won't start, run its executable from a terminal to see its output (on macOS, `Taut.app/Contents/MacOS/Taut`) (warning: long). Once it's running, DevTools opens with `Cmd`+`Option`+`I` or `Ctrl`+`Alt`+`I`.
