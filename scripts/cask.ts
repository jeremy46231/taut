#!/usr/bin/env node

// Prints the Homebrew cask for the newest desktop release taut.jer.app has both mac installers of, usage: node scripts/cask.ts

import { desktopReleases } from './lib/releases.ts'

const release = (await desktopReleases()).find(
  (r) => r.assets['taut-mac.dmg'] && r.assets['taut-mac-x64.dmg']
)
if (!release) {
  console.error('[cask] no published release has both mac installers')
  process.exit(1)
}
const sha256 = (name: string) => release.assets[name].sha256

process.stdout.write(`cask "taut" do
  arch intel: "-x64"

  version "${release.version}"
  sha256 arm:   "${sha256('taut-mac.dmg')}",
         intel: "${sha256('taut-mac-x64.dmg')}"

  url "https://github.com/jeremy46231/taut/releases/download/desktop-v#{version}/taut-mac#{arch}.dmg"
  name "Taut"
  desc "Client mod for Slack"
  homepage "https://taut.jer.app/"

  livecheck do
    url :url
    regex(/^desktop[._-]v?(\\d+(?:\\.\\d+)+)$/i)
    strategy :github_releases
  end

  depends_on macos: :monterey

  app "Taut.app"

  zap trash: [
    "~/Library/Application Support/Taut",
    "~/Library/Preferences/app.jer.taut.plist",
    "~/Library/Saved Application State/app.jer.taut.savedState",
  ]
end
`)
