<h1 align="center">
  <img src="assets/logo.png" alt="" width="128" /><br />
  Taut
</h1>

<p align="center">Client mod for Slack :D Plugins and custom CSS, on desktop and in your browser.</p>

<p align="center">
  <a href="#quickstart"><img alt="Taut version" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Ftaut.jer.app%2Ftaut-versions.json&query=%24.app.version&label=taut&color=4A154B" /></a>
  <a href="#quickstart"><img alt="Desktop version" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Ftaut.jer.app%2Ftaut-versions.json&query=%24.loaders.electron.latest&label=desktop&color=4A154B" /></a>
  <a href="https://hackclub.slack.com/archives/C0A057686SF"><img alt="#taut on the Hack Club Slack" src="https://img.shields.io/badge/slack-%23taut-4A154B?logo=hackclub&logoColor=white" /></a>
  <a href="LICENSE"><img alt="License: GPLv3 or later" src="https://img.shields.io/badge/license-GPLv3%2B-4A154B" /></a>
</p>

Taut adds over 30 plugins to Slack. Switch accounts in one click, see who reacted at a glance, give people nicknames, see when someone was last seen, type without showing up as typing, and blur private stuff whenever someone can see your screen. Make @channel pings feel like native messages, see the names of private channels you aren't in (and mention them yourself!), make Slack faster, try features Slack hasn't released yet, and [lots more](#plugins). Style it with your own CSS, or write your own plugins. It runs as its own desktop app, in Chrome and Firefox, or as a userscript, and it keeps itself up to date.

> [!NOTE]
>
> Taut isn't made by or affiliated with Slack.

## Plugins

Turn plugins on and off in `Preferences` > `Taut`, where you can also write your own CSS. Want something that isn't here? [Write your own plugin](docs/plugins.md).

<!-- begin plugins (written by scripts/readme.ts) -->

<details><summary>All 33 plugins</summary>

#### Messages

- **Bring Back Slackbot**: Makes Slackbot custom responses be from Slackbot again
- **Copy Reacted**: Copy the list of people who reacted to a message
- **Show Real User**: Shows the user who sent a message via a bot like at-channel
- **Show Sending Bot**: Shows the bot used to send a user message
- **Shut Up Slackbot**: Marks Slackbot's "an app took over your slash command" DMs as read and silences them
- **User Pronouns**: Shows people's pronouns next to the timestamp on their messages
- **Who Reacted**: Shows the avatars of everyone who reacted next to each reaction

#### Message Box

- **Anonymize Filenames**: Randomizes file names before uploading to prevent metadata leakage
- **Clear URLs**: Strips tracking parameters from links you paste into messages (rules from [ClearURLs](https://github.com/ClearURLs/Rules))
- **Haiku Warning** (Hack Club only): Warns before you send a haiku that Orpheus would repeat in the thread
- **Invisible Forward**: Makes Slack links at the start of your messages invisible, like a forwarded message
- **Native At Channel** (Hack Club only): Sends @channel and @here through at-channel where you can't ping yourself
- **Real Markdown**: Write messages in standard Markdown instead of Slack's markup
- **Restricted Channel Warning**: Shows admins the "Only certain people can post" box where only admins can post
- **Silent Typing**: Adds a button to hide your typing indicator, so others can't see when you're typing
- **Slim Message Box**: Simplifies and cleans up the message box

#### People

- **Admin Backend** (Hack Club only): Adds buttons to open a member in Hack Club tools
- **Custom Name Recording**: Uploads an audio file as your name recording, instead of recording one
- **Human Count**: Leaves apps, and optionally guests, out of the channel header's member count
- **IDV Status** (Hack Club only): Shows a red squiggle on users who are not IDV eligible, and orange when verified ID but >18
- **Last Seen**: Shows when someone was last seen on their profile
- **Nicknames**: Locally nickname other members across Slack
- **Office Hours**: Weekly schedules for going out of office or appearing away

#### Privacy

- **Click to Load**: Holds Spotify, SoundCloud and other music embeds until you click to load them
- **No Tracking**: Blocks Slack's built-in tracking and analytics requests
- **Streamer Mode**: Blurs private information while others may be able to see your screen

#### App

- **Account Switcher**: Switch between saved accounts from the profile menu
- **Browser Pop-outs**: Enables Slack's pop-out windows in the browser
- **Experiments**: Try Slack's unreleased features by overriding its experiments
- **Faster Slack**: Optimizations that make Slack faster and smoother
- **Private Channel** (Hack Club only): Lets you see and mention private channels you aren't in (uses the [flaron](https://flaron.halceon.dev) index)

#### Fun

- **Censorship**: Masks words you choose in messages, only on your screen
- **Oneko**: A cute cat that chases your cursor around the screen, based on [oneko.js](https://github.com/adryd325/oneko.js)

</details>

<!-- end plugins -->

## Quickstart

Most people want the desktop app.

### Desktop

| Platform | Download |
| --- | --- |
| Windows | [x64](https://taut.jer.app/taut-win.exe) / [ARM](https://taut.jer.app/taut-win-arm.exe) |
| macOS | [Apple Silicon](https://taut.jer.app/taut-mac.dmg) / [Intel](https://taut.jer.app/taut-mac-x64.dmg), or `brew install --cask jeremy46231/taut/taut` |
| Linux | [AppImage](https://taut.jer.app/taut-linux.AppImage) / [deb](https://taut.jer.app/taut-linux.deb) / [rpm](https://taut.jer.app/taut-linux.rpm) / [pacman](https://taut.jer.app/taut-linux.pacman) |
| Linux ARM | [AppImage](https://taut.jer.app/taut-linux-arm.AppImage) / [deb](https://taut.jer.app/taut-linux-arm.deb) / [rpm](https://taut.jer.app/taut-linux-arm.rpm) / [pacman](https://taut.jer.app/taut-linux-arm.pacman) |

<details><summary>Linux package repositories (apt, dnf, and Nix)</summary>

- Debian / Ubuntu:
  ```sh
  curl -fsSL https://taut.jer.app/taut.gpg | sudo tee /usr/share/keyrings/taut.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/taut.gpg] https://taut.jer.app/apt stable main" | sudo tee /etc/apt/sources.list.d/taut.list
  sudo apt update && sudo apt install taut
  ```
- Fedora / RHEL:
  ```sh
  sudo dnf config-manager addrepo --from-repofile=https://taut.jer.app/rpm/taut.repo
  sudo dnf install taut
  ```
- Nix: `nix run github:jeremy46231/taut`, or add the flake as an input and use its `taut` package (also in `overlays.default`)

</details>

### Browser extension

- Chrome / Chromium-based:
  - Extract the [extension](https://taut.jer.app/taut-chrome.zip) to a permanent location
  - Go to `about:extensions`, enable `Developer mode`, `Load unpacked` the extension folder
  - To update, extract the new zip over that folder and click Taut's reload button in `about:extensions`
- Firefox: Install the [extension](https://taut.jer.app/taut-firefox.xpi)

### Userscript

Requires [Tampermonkey](https://tampermonkey.net/#download) (no Safari). Change its settings first, then install the [userscript](https://taut.jer.app/taut.user.js).

<details><summary>Tampermonkey settings</summary>

In the Tampermonkey dashboard > `Settings`:

- `General` / `Config mode`: `Advanced`
- Chrome / Chromium-based: `Security` / `Content Script API`: `UserScripts API Dynamic`
- Firefox: `Experimental` / `Inject Mode`: `Instant`

Make sure to hit the correct save button!

</details>

> Join [#taut](https://hackclub.slack.com/archives/C0A057686SF) on the [Hack Club Slack](https://hackclub.com/slack)!

## Compared to other mods

|  | Taut | [Slick](https://github.com/3kh0/slick) | [Rope](https://github.com/anirudhb/rope) |
| --- | --- | --- | --- |
| Plugins | **33** | **35** | 8 |
| Desktop app | **Windows, macOS and Linux, x64 and ARM** | **Windows, macOS and Linux, x64 and ARM** | No |
| Browser | **Chrome, Firefox and a userscript, with every plugin** | Firefox (experimental), only some plugins | Userscript |
| Linux packages | **AppImage, deb, rpm, pacman, apt and dnf repos, Nix, all on ARM too** | **AppImage, deb, rpm, Flatpak, Nix, AUR (Nix and AUR x64 only)** | - |
| macOS | **dmg, Homebrew** | dmg, install script | - |
| Custom plugins | **Install and update them in settings, no reload** | No | No |
| Updates | **Updates when you reload Slack, desktop app updates itself** | Asks to update | Manual |
| Depends on your Slack install | **No** | Yes | **No** |
| Privacy | Blocks Slack's tracking, has opt-out usage statistics | Blocks Slack's tracking | - |
| Last updated | **Active** | **Active** | July 2026 |
| License | GPLv3 or later | GPLv3 | None listed |

Updated October 2026.

## Usage

Open `Preferences` > `Taut` for Taut settings:

- Enable or disable plugins
- Edit plugin config or user CSS
- Desktop enables DevTools, press `Ctrl`+`Alt`+`I` or `Cmd`+`Option`+`I`

## Development

Read [`docs/`](docs/) first (or point your agent at it), it covers how Taut fits together, writing plugins and testing.

- [`app/`](app/) is the app bundle (`taut.js`), with [`plugins/`](plugins/) bundled inside
- [`desktop/`](desktop/), [`extension/`](extension/) and [`userscript/`](userscript/) are the loaders, which get `taut.js` onto the page

### Commands

Install with `npm ci` (Node 22.18+), or `bun install`.

| Command | Does |
| --- | --- |
| `npm run dev` | Serves a live-rebuilding bundle on `localhost:3000` for the `Dev server` source |
| `npm run build` | Builds the app, extensions and userscript into `dist/` |
| `npm run build -- desktop mac win` | Builds the desktop app for those platforms (slow), `--help` for more |
| `npm run check` | Lints and typechecks |
| `npm run readme` | Rewrites the plugin list above from each plugin's `pluginName`, `description` and `category` |

### App source

Pick where a loader gets `taut.js` from:

- Desktop: the app menu (may need to tap Alt) > `Taut` > `Change app source...`
- Userscript: Tampermonkey icon while on Slack > `Options`, or [taut.jer.app/options](https://taut.jer.app/options)
- Extension: `Manage Extension` > `Extension options`/`Preferences`

| Source | Loads |
| --- | --- |
| `Official` | The normal build from [taut.jer.app](https://taut.jer.app/taut.js), always up to date |
| `Official (sourcemaps)` | The same, with the full `.ts` and `.tsx` files in DevTools (~250kb more) |
| `Dev server` | `npm run dev` on `localhost:3000` |
| `Embedded copy` | The copy built into the loader, on `--embedded` builds only |

PRs are very welcome! You should join the [#taut](https://hackclub.slack.com/archives/C0A057686SF) channel on the [Hack Club Slack](https://hackclub.com/slack) (13-18yo only). I'm [@Jeremy](https://hackclub.slack.com/team/U06UYA5GMB5), say hi :D

## License

GPLv3 or later, see [LICENSE](LICENSE)
