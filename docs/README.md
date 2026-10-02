# Working on Taut

Taut modifies Slack's web client from inside the page. It runs next to Slack's code and changes Slack by reaching into its webpack modules, React components and Redux store.

- Writing a plugin: [plugins.md](plugins.md)
- Running Taut in a browser, and debugging it: [testing.md](testing.md)

## How the pieces connect

```
loader --bridge--> app bundle (taut.js) --this.api--> plugins
```

- The loaders (`desktop/`, `extension/`, `userscript/`) get `taut.js` onto the page before Slack boots. Each environment differs, and each loader is released on its own.
- Each loader provides the bridge: storage, secrets, privileged fetch and files.
- The app (`app/`) is `taut.js`. It intercepts Slack's modules as they load, patches React and Redux, builds the plugin API, runs the plugins and draws Taut's settings. Its knowledge of Slack's internals lives in `app/slack/`.
- Plugins (`plugins/`) are bundled into `taut.js` and only use `this.api`.

A change to `app/` or `plugins/` reaches everyone once `taut.js` is published. A change to a loader or the bridge only reaches people as they update that loader, which is slow. So the app has to keep working with older loaders, and a fix at that boundary can need both.

## `app/` versus plugins

Slack knowledge that can be stated generally belongs in `app/slack/`, exposed on `this.api`. That covers how to find a module, what a store slice holds, how Slack derives a field and how patching works. A plugin states intent: which data or component, and what to change about it. It shouldn't carry Slack mechanics that the next plugin would have to rediscover.

Most plugins need no new API. Add to `app/` only when a plugin needs something the API actually can't do. The addition is the generic mechanism, kept small, and the plugin's own policy stays in the plugin.

## How Taut changes Slack

- Pick the hook that reaches every reader and never changes what Slack stores. Usually that's a read-time patch on the data where Slack keeps it, so rendering, search, sorting and every other reader agree. Patching each place where an old value shows up always misses some of them. When everything reads a value through a few functions or selectors, wrapping those reaches every reader too, and is simpler.
- Nothing patched reaches Slack's store. Don't change what Slack shows by mutating its stored state or patching its reducers. Slack persists its state, so the change would outlive the plugin, and turning the plugin off could leave Slack broken. Real actions (sending, marking read, setting a status) go through Slack's thunks or API, like any other client.
- When a decision isn't driven by data, patch where it's made: the React component (`patchComponent`) or the thunk (`patchThunk`).
- Taut is a React codebase, and the DOM is a discouraged escape hatch. Inspecting it while you investigate is fine, but what a plugin does shouldn't be driven by the DOM. Don't query Slack's DOM to find things, and don't insert, rewrite or restyle its nodes by reaching in. UI you add is React, rendered from a component patch. Reaching for the DOM is the path of least resistance, and it's fragile and slow. Listening for input or measuring an element is occasionally needed, so keep it rare and contained.
- Never observe Slack's DOM with a `MutationObserver` using `subtree: true`. It's easy to write, and it makes Slack laggy.
- Slack's code keeps loading all session, so reach Slack's internals through the waiting and lazy forms (`waitFor*`, `lazy*`) and patches, which apply whenever their target shows up. They remove a whole class of timing bugs that otherwise take very careful code. The instant `get*` lookups are for the console, and using one in code needs a good reason. A lookup that finds nothing may just mean the code hasn't loaded yet, and if waiting could hold something up, like a send, bound the wait with a timeout instead. Slack also renames things, so a target that never turns up may be gone.
- Stopping a plugin undoes its patches. Everything registered through `this.api` (patches, styles, listeners) is torn down, and Slack goes back to behaving as if the plugin never ran. Turning a plugin off and on mid-session should work without a reload. This doesn't undo actions already taken, or clear the plugin's own saved data.
- Look like Slack. Reuse Slack's components, classes and design tokens instead of hand-built markup, and keep UI text short and minimal.
- Prefer simple, correct code over clever code. Don't add compatibility code for formats that never shipped, and keep test files out of the repo (test from scratch space). A `this.api` member that has shipped keeps working when that isn't hard to support, as a thin wrapper over its replacement marked `@deprecated`. Drop one only carefully, when that much simplifies or improves things.
