# Changelog

What's new in Taut, newest first. Shows in "What's new" in Slack after an update.

Each release is a `## x.y.z` heading, and each change is one bullet:

- `- **Plugin Name** (new plugin): What it does` for a new plugin
- `- **Plugin Name**: What changed` for a plugin update
- `- **Plugin Name**: Fixed what was broken` for a plugin fix
- `- What changed` for a change to Taut itself

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
- **Faster Slack**: Smoother resizing, and an option to skip animations
- **Slim Message Box**: Can move "Also send to channel" to a toolbar button
- **Private Channel**: Mention any private channel by typing its ID, and fixed channel IDs being saved as channel names
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

- Fixed Taut not loading after Slack's update on September 29

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
