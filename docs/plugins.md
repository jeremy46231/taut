# Writing a plugin

Read [README.md](README.md) first.

## The frame

A plugin is one file in `plugins/` whose default export is a class extending `TautPlugin`. `shared/Plugin.ts` documents every field. Start by copying a small plugin that uses the same kind of hook you need: `HumanCount` patches a component, and `SilentTyping` wraps a thunk and adds a composer button.

- The filename, class name and `id` are the same string. The `id` is **permanent once shipped**, because config and stored data are keyed by it. `pluginName` is display text and can change.
- `description` is one short sentence, repeated as a comment on the file's first line.
- `defaultConfig` has `enabled` first, then each option in display order, wrapped in `opt()` or an `opt.*` helper so settings gets the right control and help text. Secrets use `opt.secret`, never a plain option. Only options someone set are stored, and the rest follow the defaults, which are filled in before your plugin sees `this.config`, so read it directly without fallbacks.
- Set a `category`, and `hackClubOnly` if the plugin only makes sense in the Hack Club Slack.
- Anything you inject by name (class names, keys, DOM ids, container names) is `taut-<thing>`, in BEM style, spelled out in words.

## Lifecycle

- `start()` runs when the plugin is enabled. Only await fast, local setup. Run network work in the background and stop it with `this.api.signal`.
- Everything registered through `this.api` is undone when the plugin stops. `stop()` is only for things you set up some other way.
- A config change restarts the plugin as a fresh instance.
- An option's `editor` renders in settings whether or not the plugin is running, so the `api` it gets is unscoped: anything it registers, like CSS, it has to dispose itself, from an effect's cleanup.
- Each open Slack tab runs its own instance, and all of them share the plugin's storage. Keep saved state in `this.api.storage.store(key, defaultValue)`, which stays in step with what's saved and with every other tab, instead of holding your own copy. Its `update` applies your change to the latest saved value under a lock, so tabs don't undo each other's changes.

Before calling it done, check:

- turning it off and on mid-session
- enabling it while the affected view is already on screen
- a cold boot with it enabled
- multiple Slack tabs with the plugin enabled
- every place the change should reach (channel, thread, search, activity...)

## Finding the hook

Start at the thing on screen and walk to the React component that draws it. Read that component's source, then follow it back to the store slice or thunk it reads from, and patch there. [testing.md](testing.md#globals) lists the console globals that help.

## Contributing it to Taut

- Add the file to `plugins/`. If it needs something new in `app/`, add the generic mechanism there and keep the plugin's policy in the plugin.
- Ship it with `enabled: false`. The maintainer decides whether it defaults on.
- Credit whoever wrote it: add them to `shared/authors.ts` and use that key in `authors`. An agent should ask its user for their name, Hack Club Slack member id and a link (defaulting the link to the GitHub profile they're signed in as), and save the answer so it doesn't ask again.
- Run `npm run check` (`npm run fix` formats too).
- Leave every version number and `CHANGELOG.md` alone. A push that bumps the version files is what triggers a release, and the maintainer does that, along with the changelog, after merging.

## A personal plugin

A plugin you don't intend to contribute is one self-contained file. It must not depend on changes anywhere else in the repo, and its `authors` lists you directly, like `[{ name: 'Your Name', slackId: 'U0YOURID', url: 'https://github.com/you' }]`. Either build it with `npm run build:user-plugin -- path/to/MyPlugin.tsx` and install the resulting `.js` from Taut's settings, or keep it in `plugins/` while you work and load it through the dev server.
