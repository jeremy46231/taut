# Changelog

What's new in Taut, newest first. Shows in "What's new" in Slack after an update.

Each release is a `## x.y.z` heading, and each change is one bullet:

- `- **Plugin Name** (new plugin): What it does` for a new plugin
- `- **Plugin Name**: What changed` for a plugin update
- `- **Plugin Name**: Fixed what was broken` for a plugin fix
- `- What changed` for a change to Taut itself

## 3.7.0

- **Admin Backend**: Adds Attend as an option
- **Owl Mode**: Supports (demo) Owl in #owlery-demo, which is not anonymous

## 3.6.0

- **Streamer Mode**: Blurs DM previews in Activity again, turns on when you share your screen in the desktop app, stays in sync across tabs, and can stay on all the time
- **Show Real User**: Greatly reduces the number of requests sent
- **Slack Fixes**: Fixes Slack's thread admin tools not showing on threads started by bots

## 3.5.0

- **No Slackbot Menubar** (new plugin): Hides or quiets the Slackbot Mini icon in the Mac menu bar
- Plugins can hide Slack's menu bar icon or take over its clicks
- **Better Typing Indicator** (new plugin): Shows as many typing people as possible and lets you view their profiles

## 3.4.0

- **Private Channel**: Right-click a hidden channel's mention to give it a local name
- **Last Seen**: Better remembers when people were last seen, follows Slack's limit even with several tabs open
- **Account Switcher**: Checks an account is still signed in before switching to it, and shows why switching or adding failed
- **Office Hours**: Fixed its state carrying over between accounts
- **Censorship**: Fixed &, < and >, emoji in link text, and word changes show without a reload
- **Show Real User**: Add new supported bots
- **Show Sending Bot**: Fixed the badge in Activity
- Fixed plugins, like Censorship and Private Channel, doing nothing after a Slack update
- Desktop settings in Advanced

## 3.3.0

- **Slack Fixes** (new plugin): Fixes small bugs in Slack's UI, starting with the misaligned Halloween sidebar row

## 3.2.0

- **Quick Join** (new plugin): Join a channel from its right-click menu
- **Experiments**: Powerful filters for experiments and more data about them, to help find interesting ones
- **Slim Message Box**: Allow disabling the broadcast button, fixed /gif with the emoji button hidden
- **IDV Status**: People who just verified show as verified sooner
- **Haiku Warning**: Stores a much smaller dictionary
- Fixed settings changes being lost with multiple Slack tabs open

## 3.1.4

- **Haiku Warning**: Choose a banner, a pop-up, or both, the icon is the Orpheus emoji, and the banner no longer flashes while typing
- **Custom Name Recording**: Now converts non-MP3 files to MP3 for Slack
- **Copy Reacted**: Fixed copying more than 50 people
- **Anonymize Filenames**: Fixed in pop-out windows
- **Show Sending Bot**: Fixed the app badge missing on specific messages in search

## 3.1.2

- **Nicknames**: Set a nickname from the right-click menu on someone's name or avatar
- **Haiku Warning**: Shows a banner when your message is a haiku, detection is more accurate, and more channels are skipped

## 3.1.0

- **Huddle Activity** (new plugin): Shows who muted you or anyone else in a huddle, and logs renames, theme and language changes, invites, knocks, and transcription
- **Owl Mode** (new plugin): Reply and react as Owl under your own confessions, right from the reply box
- **Thread Jump** (new plugin): Jump to the top, bottom, a date, or 100 replies at a time in long threads
- **Show Sending Bot**: Fixed badges in Activity after Slack's October 20th update, and on grouped messages
- Fixed the color picker in plugin settings after Slack's October 20th update

## 3.0.4

- **User Pronouns**: Fixed after Slack's October 20th update
- **Bring Back Slackbot**: Fixed after Slack's October 20th update
- **Experiments**: Fixed after Slack's October 20th update

## 3.0.3

- Fixed the "View message activity" window crashing

## 3.0.1

- Fixed Slack never loading for some people after Slack's second update on October 1st

## 3.0.0

- **Real Markdown** (new plugin): Write messages in standard Markdown
- **Shut Up Slackbot** (new plugin): Silences workspace admin Slackbot spam
- **Click to Load** (new plugin): Music and other embeds wait until you click them
- **Haiku Warning** (new plugin): Warns before you send a haiku that Orpheus would detect
- **Restricted Channel Warning** (new plugin): Stops admins from accidentally messaging in restricted channels
- **Human Count** (new plugin): Channel member counts exclude bots (and optionally guests)
- **Office Hours** (new plugin): Weekly schedules for going out of office or appearing away
- **Experiments** (new plugin): Try Slack's unreleased features by overriding its experiments
- **Native At Channel** (new plugin): Send @channel and @here through at-channel like normal pings, then edit or delete them like your own messages
- **Censorship**: Also masks search, Activity and notifications, and can keep a word's first or last letter
- **Streamer Mode**: Options to blur only what DM previews say, to leave private channel names alone, and to pick whether hovering the channel list reveals all of them, the channel group, or just that channel
- **Admin Backend**: Pick, reorder and add your own tools, adds Fire Engine
- **Copy Reacted**: Can copy @handles
- **IDV Status**: Pick your own colors
- **Nicknames**: Edit all your nicknames in one list, and fix when you have multiple Slack tabs open
- **Clear URLs**: Cleans links as you paste them, so the message box shows what you'll send, and update replacement logic
- **Invisible Forward**: Now works in plain text and Markdown mode
- **Slim Message Box**: Can move "Also send to channel" to a toolbar button
- **Private Channel**: Mention any private channel by typing its ID, and fixed channel IDs being saved as channel names
- Fixed Slack crashing on load after Slack's update on October 1st
- config.jsonc is now config.json and simplified
- New settings page, with search, categories and a page for each plugin
- Safe mode, in Taut settings > Advanced
- A setting to turn off usage statistics
- Hack Club-only plugins are hidden in other workspaces
- Taut loads faster from taut.jer.app
- Plugins apply faster, without re-rendering all of Slack
- Taut dialogs open on top of other dialogs instead of replacing them
- Plugins' saved data stays in sync between open Slack tabs
- What's new (hello!)

## 2.14.3

- Fixed Taut not loading after Slack's update on September 29th

## 2.14.2

- **Show Real User**: Supports Heidi the Helper (Nephthys)

## 2.14.1

- **Streamer Mode**: Fixed the Threads tab blurring every thread, not just private ones

## 2.14.0

- New plugin options are added to config.jsonc
- **Streamer Mode**: Also blurs group DM names and Activity destinations

## 2.13.0

- **Streamer Mode** (new plugin): Blurs private information while you share your screen

## 2.12.1

- Plugins look people up in batches, and retry when that fails

## 2.12.0

- **Censorship** (new plugin): Masks words you'd rather not read, on your screen only

## 2.11.0

- **Admin Backend**: Adds Open in Slack Admin
- Daily usage ping, to count installs

## 2.10.1

- Plugins start sooner, and work even when parts of Slack load late

## 2.10.0

- **Faster Slack** (new plugin): Smoother window resizing
