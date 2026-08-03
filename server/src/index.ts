interface Env {
  ASSETS: Fetcher
}

const GH = 'https://github.com/jeremy46231/taut/releases/download'

const REDIRECTS: Record<string, string> = {
  '/taut.js': `${GH}/latest/taut.js`,
  '/taut.debug.js': `${GH}/latest/taut.debug.js`,
  '/taut.user.js': `${GH}/latest/taut.user.js`,
  '/taut-chrome.zip': `${GH}/latest/taut-chrome.zip`,
  '/taut-firefox.xpi': `${GH}/latest/taut-firefox.xpi`,
  '/taut-mac.dmg': `${GH}/latest/taut-mac.dmg`,
  '/taut-mac-x64.dmg': `${GH}/latest/taut-mac-x64.dmg`,
  '/taut-win.exe': `${GH}/latest/taut-win.exe`,
  '/taut-win-arm.exe': `${GH}/latest/taut-win-arm.exe`,
  '/taut-linux.AppImage': `${GH}/latest/taut-linux.AppImage`,
  '/taut-linux-arm.AppImage': `${GH}/latest/taut-linux-arm.AppImage`,
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/') {
      return Response.redirect('https://github.com/jeremy46231/taut', 302)
    }

    const redirect = REDIRECTS[url.pathname]
    if (redirect) {
      return Response.redirect(redirect, 302)
    }

    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
