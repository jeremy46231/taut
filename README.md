# Taut

Client mod for Slack :D

## Quickstart

- Desktop:
  - Windows: [x64](https://taut.jer.app/taut-win.exe) /
    [ARM](https://taut.jer.app/taut-win-arm.exe)
    - You may need to close Slack before installing
  - MacOS: [Apple Silicon](https://taut.jer.app/taut-mac.dmg) /
    [Intel](https://taut.jer.app/taut-mac-x64.dmg)
    - Run before launching:
      `xattr -d com.apple.quarantine /Applications/Taut.app`
  - Linux: [x64](https://taut.jer.app/taut-linux.AppImage) /
    [ARM](https://taut.jer.app/taut-linux-arm.AppImage)
  - Runs separately from your normal Slack desktop app!
  - Cannot run at the same time as normal Slack
- Userscript:
  - Requires [Tampermonkey](https://tampermonkey.net/#download), no Safari
  - Set these settings in the Tampermonkey dashboard > `Settings`
    - `General` / `Config mode`: `Advanced`
    - (Chrome / Chromium-based only) `Security` / `Content Script API`: `UserScripts API Dynamic`
    - (Firefox only) `Experimental` / `Inject Mode`: `Instant`
  - Install the [userscript](https://taut.jer.app/taut.user.js)
- Browser extension:
  - Chrome / Chromium-based
    - Hopefully available in the Chrome Web Store soon
    - Extract the [extension](https://taut.jer.app/taut-chrome.zip) to a
      permanent location
    - Go to `about:extensions`, enable `Developer mode`, `Load unpacked` the
      extension folder
  - Firefox
    - Hopefully available on the Firefox Add-ons site soon
    - Until then, requires
      [Firefox Developer Edition](https://mozilla.org/firefox/developer) (or
      Nightly or another fork that allows unsigned extensions)
    - In `about:config`, set `xpinstall.signatures.required` to `false`
    - Install the [extension](https://taut.jer.app/taut-firefox.xpi)

> Join [#taut](https://hackclub.slack.com/archives/C0A057686SF) on the
> [Hack Club Slack](https://hackclub.com/slack)!

---

## Usage

Open `Preferences` > `Taut` for Taut settings:

- Enable or disble plugins
- Edit plugin config or user CSS
- (Desktop only) You can also edit config or CSS in the config folder:
  - Windows: `%APPDATA%\taut`
  - macOS: `~/Library/Application Support/taut`
  - Linux: `~/.config/taut`
- Desktop enables DevTools, press `Ctrl`+`Alt`+`I` or `Cmd`+`Option`+`I`

Change how Taut is loaded:

- Loader:
  - Desktop
    - Menu (on Windows/Linux, press Alt to show) > `Taut` >
      `Change app source...`
  - Userscript
    - Tampermonkey icon while on Slack > `Options`
    - Or, go to [taut.jer.app/options](https://taut.jer.app/options)
  - Extension
    - `Manage Extension` > `Extension options`/`Preferences`
- Options:
  - `Official` - Normal build, always up-to-date
  - `Official (sourcemaps)` - Same as Official, but original `.ts` and `.tsx`
    files show up in DevTools for better debugging, ~250kb more
  - `Dev server` - Loads from `bun dev` running locally on `localhost:3000`
  - `Embedded copy` (only on custom embedded builds) - Loads the copy of Taut
    stored inside the loader

  `user-plugins/` (the `plugins/` directory is overwritten on update)

## Development

Taut consists of a primary [app](app/) (with [plugins](plugins/) bundled inside)
and different loaders (including [desktop](desktop/), the
[userscript](userscript/), and the [Chrome](extension/chrome/) and
[Firefox](extension/firefox/) extensions). An "embedded" loader contains a copy
of the app bundle inside of it, otherwise it is loaded from
[taut.jer.app](https://taut.jer.app/taut.js) by default.

The project uses [Bun](https://bun.sh) for development (`npm i -g bun` if you
need it). After installing and building everything (`bun run build`), output
files will be in [`dist/`](dist/). Desktop (much slower than everything else) is
built separately with `bun build:desktop [names...]`, where each name is a
platform (`win` `win-arm` `mac` `mac-x64` `linux` `linux-arm`, or `all`) and/or
a variant (`standard` `embedded`), e.g. `bun build:desktop mac win embedded`.

PRs are very welcome! You should join the
[#taut](https://hackclub.slack.com/archives/C0A057686SF) channel on the
[Hack Club Slack](https://hackclub.com/slack) (13-18yo only). I'm
[@Jeremy](https://hackclub.slack.com/team/U06UYA5GMB5), say hi :D

## See also

Other Slack tools from the Hack Club community that may interest you:

- [Rope](https://github.com/anirudhb/rope) by [Ani](https://github.com/anirudhb)
  ([#rope](https://hackclub.enterprise.slack.com/archives/C0A3GT3RWJG)) - Client
  mod, userscript, similar Webpack patching
- [Slick](https://github.com/3kh0/slick) by [Rowan](https://3kh0.net) - Client
  mod, desktop app, DOM modifications
- [Snail](https://github.com/espcaa/snail) by [Alice](https://espcaa.eu)
  ([#snail](https://hackclub.enterprise.slack.com/archives/C0A0HBS87PX)) -
  Client mod, patches MacOS app, React monkeypatching

## Credits

- Invisible Forward plugin based on [Cyril](https://github.com/CyrilSLi)'s
  [userscript](https://greasyfork.org/en/scripts/526439-forward-slack-messages-files-and-later-items-to-channels-and-threads-using-an-invisible-link)
- Shinigami Eyes plugin by [ShyMike](https://github.com/ImShyMike) and
  [Scooter](https://github.com/scooterthedev)
- IdvStatus plugin by [Sahil](https://github.com/sadeshmukh)
- Oneko plugin based on [adryd](https://github.com/adryd325)'s
  [oneko.js](https://github.com/adryd325/oneko.js)

## License

MIT License

---

<sub>AI use disclaimer: I've used plenty of AI in the creation of this project,
but all the code is closely reviewed and high-quality. If not for this
disclaimer, you probably wouldn't be able to tell lol, this is probably the
project I am most proud of ever making.</sub>
