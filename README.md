# Taut

Client mod for Slack :D

## Quickstart

- Desktop:
  - Windows: [x64](https://taut.jer.app/taut-win.exe) / [ARM](https://taut.jer.app/taut-win-arm.exe)
  - MacOS: [Apple Silicon](https://taut.jer.app/taut-mac.dmg) / [Intel](https://taut.jer.app/taut-mac-x64.dmg)
    - Or with Homebrew: `brew install --cask jeremy46231/taut/taut`
  - Linux: [AppImage](https://taut.jer.app/taut-linux.AppImage) / [deb](https://taut.jer.app/taut-linux.deb) / [rpm](https://taut.jer.app/taut-linux.rpm) / [pacman](https://taut.jer.app/taut-linux.pacman)
    - ARM: [AppImage](https://taut.jer.app/taut-linux-arm.AppImage) / [deb](https://taut.jer.app/taut-linux-arm.deb) / [rpm](https://taut.jer.app/taut-linux-arm.rpm) / [pacman](https://taut.jer.app/taut-linux-arm.pacman)
    - Or add the repository:
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
  - Runs separately from your normal Slack desktop app!
- Userscript:
  - Requires [Tampermonkey](https://tampermonkey.net/#download), no Safari
  - Set these settings in the Tampermonkey dashboard > `Settings`
    - `General` / `Config mode`: `Advanced`
    - Chrome / Chromium-based:
      - `Security` / `Content Script API`: `UserScripts API Dynamic`
    - Firefox:
      - `Experimental` / `Inject Mode`: `Instant`
    - Make sure to hit the correct save button!
  - Install the [userscript](https://taut.jer.app/taut.user.js)
- Browser extension:
  - Chrome / Chromium-based
    - Extract the [extension](https://taut.jer.app/taut-chrome.zip) to a permanent location
    - Go to `about:extensions`, enable `Developer mode`, `Load unpacked` the extension folder
    - To update, extract the new zip over that folder and click Taut's reload button in `about:extensions`
  - Firefox
    - Install the [extension](https://taut.jer.app/taut-firefox.xpi)

> Join [#taut](https://hackclub.slack.com/archives/C0A057686SF) on the [Hack Club Slack](https://hackclub.com/slack)!

---

## Usage

Open `Preferences` > `Taut` for Taut settings:

- Enable or disble plugins
- Edit plugin config or user CSS
- Desktop enables DevTools, press `Ctrl`+`Alt`+`I` or `Cmd`+`Option`+`I`

Change how Taut is loaded:

- Loader:
  - Desktop
    - Menu (on Windows/Linux, press Alt to show) > `Taut` > `Change app source...`
  - Userscript
    - Tampermonkey icon while on Slack > `Options`
    - Or, go to [taut.jer.app/options](https://taut.jer.app/options)
  - Extension
    - `Manage Extension` > `Extension options`/`Preferences`
- Options:
  - `Official` - Normal build, always up-to-date
  - `Official (sourcemaps)` - Same as Official, but original `.ts` and `.tsx` files show up in DevTools for better debugging, ~250kb more
  - `Dev server` - Loads from `npm run dev` running locally on `localhost:3000`
  - `Embedded copy` (only on custom embedded builds) - Loads the copy of Taut stored inside the loader

  `user-plugins/` (the `plugins/` directory is overwritten on update)

## Development

Taut consists of a primary [app](app/) (with [plugins](plugins/) bundled inside) and different loaders (including [desktop](desktop/), the [userscript](userscript/), and the [Chrome](extension/chrome/) and [Firefox](extension/firefox/) extensions). An "embedded" loader contains a copy of the app bundle inside of it, otherwise it is loaded from [taut.jer.app](https://taut.jer.app/taut.js) by default.

The build runs on Node 22.18+ with npm (`npm ci`), or on [Bun](https://bun.sh) if you prefer it (`bun install`, and `bun run` in place of `npm run --`). `npm run build` builds the app bundle, extensions and userscript into [`dist/`](dist/). Pass target names to build a subset, `--embedded` (and/or `--standard`) to pick variants, and for the desktop app (much slower than everything else) platform names: `win` `win-arm` `mac` `mac-x64` `linux` or `all`, defaulting to the machine you're on. For example `npm run build -- desktop mac win --embedded`. `npm run build -- --help` lists it all. `npm run dev` serves a live-rebuilding debug bundle for the `Dev server` loader option.

Writing a plugin, or working on Taut itself? Read [`docs/`](docs/) first.

PRs are very welcome! You should join the [#taut](https://hackclub.slack.com/archives/C0A057686SF) channel on the [Hack Club Slack](https://hackclub.com/slack) (13-18yo only). I'm [@Jeremy](https://hackclub.slack.com/team/U06UYA5GMB5), say hi :D

## See also

Other Slack tools from the Hack Club community that may interest you:

- [Slick](https://github.com/3kh0/slick) by [Rowan](https://3kh0.net) - Client mod, desktop app, DOM modifications
- [Rope](https://github.com/anirudhb/rope) by [Ani](https://github.com/anirudhb) ([#rope](https://hackclub.enterprise.slack.com/archives/C0A3GT3RWJG)) - Client mod, userscript, similar Webpack patching
- [Snail](https://github.com/espcaa/snail) by [Alice](https://espcaa.eu) ([#snail](https://hackclub.enterprise.slack.com/archives/C0A0HBS87PX)) - Client mod, patches MacOS app, React monkeypatching

## Credits

- Invisible Forward plugin based on [Cyril](https://github.com/CyrilSLi)'s [userscript](https://greasyfork.org/en/scripts/526439-forward-slack-messages-files-and-later-items-to-channels-and-threads-using-an-invisible-link)
- Shinigami Eyes plugin by [ShyMike](https://github.com/ImShyMike) and [Scooter](https://github.com/scooterthedev)
- IdvStatus plugin by [Sahil](https://github.com/sadeshmukh)
- Oneko plugin based on [adryd](https://github.com/adryd325)'s [oneko.js](https://github.com/adryd325/oneko.js)

## License

GPLv3 or later, see [LICENSE](LICENSE)
