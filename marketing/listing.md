# Marketplace listing: Deck for T3 Code

Copy and paste into the Elgato Marketplace submission form.

## Name

Deck for T3 Code

## Short description (under 100 characters)

See which T3 Code agents are working, stuck or done, right on your Stream Deck keys.

<!-- 84 characters -->

## Long description (English, under 1500 characters)

Deck for T3 Code puts every T3 Code thread on a Stream Deck key, so you can see what your agents are doing without switching windows.

macOS only. T3 Code must be installed and running on the same Mac.

• Colour, a glyph and motion tell you the state: amber blink when an agent needs you (approvals and questions too), red blink when a run failed, solid green when it's done, a blue spinner while it works, a white one while it waits on a subagent, command or PR's CI.
• Subagents fold into their main thread, with a badge and a flash if one is waiting.
• Overview key: counts of threads that need you, are working, or are done. Tap for a full page of threads.
• Hold a thread key, then let go, for quick messages, Compact, Snooze, Settle and Stop. Compact, Settle, Stop and messages need a hold. Pages for Stream Deck XL, Stream Deck, Neo and Mini.
• Usage keys: any usage limit T3 Code reports, as a bar or a ring with an even-pace tick.
• Context bar on every thread key.

Private by design: the plugin talks only to the T3 Code app on your Mac. No account, no cloud, no telemetry. Two read-only tokens come from your local T3 CLI. An optional 24-hour actions token exists only while you enable thread actions. Sign out any time.

Free and open source (GPL-3.0-or-later).

Not affiliated with or endorsed by T3 Tools Inc. T3 Code is a trademark of its respective owner.

<!-- 1372 characters -->

## Tags / keywords

t3 code, ai agents, coding agents, developer tools, status, monitor, notifications, productivity, usage, open source

## Category

Development (or Productivity, whichever the form offers)

## Compatibility

- Platform: macOS 13 or later (macOS only at launch)
- Stream Deck app 7.1 or later
- Requires T3 Code installed and running locally
- Bundled T3 Threads and Thread Actions pages for Stream Deck XL, Stream Deck (15 keys, including MK.2), Stream Deck Neo and Stream Deck Mini. Not Stream Deck +: it gets the Thread, Overview and Usage keys only (Overview jumps to the most urgent thread).
- Thread, Overview and Usage keys work on any key-based Stream Deck.

## Release notes: 1.0.0

First public release.

- Thread keys with live state: needs you, failed, done, working, waiting on CI or background work, paused by a usage limit, idle
- Subagents folded into their main thread
- Overview key and a full-deck T3 Threads page (XL, Stream Deck, Neo, Mini)
- Thread Actions page: quick messages, Compact, Snooze, Settle, Stop (hold to confirm)
- Usage keys as a bar or a ring, with a pace marker
- Context-window bar on each key
- Two read-only tokens (30 days); opt-in 24-hour actions token, revoked when you turn actions off

## Support and links

- Website: https://hsalazr.github.io/deck-for-t3code/
- Source code: https://github.com/hsalazr/deck-for-t3code
- Support / bug reports: https://github.com/hsalazr/deck-for-t3code/issues
- Security reports: https://github.com/hsalazr/deck-for-t3code/security/advisories/new
- Privacy policy: https://github.com/hsalazr/deck-for-t3code#privacy--security
- License: GPL-3.0-or-later, https://github.com/hsalazr/deck-for-t3code/blob/main/LICENSE

Donation links (GitHub Sponsors, Liberapay) go in the README and site only, never in the plugin's Property Inspector or the listing's plugin UI.

## Privacy note

No data leaves your Mac. Deck for T3 Code talks only to the T3 Code app running on the same machine. It has no server, no account, and no analytics or telemetry. It reads thread titles, project names, run status, background-task names, context size and usage limits from T3 Code to draw the keys, holds them in memory only, and keeps up to three scoped tokens in its own folder on your Mac (files readable only by you). It only sends them to a local (127.0.0.1, localhost or ::1) T3 Code server. You can revoke the tokens any time with the plugin's Sign out button or `t3 auth session revoke <id>`; uninstalling alone doesn't revoke them.

## Images

| Purpose | File |
|---|---|
| Thumbnail (1920×960) | `thumbnail.png` |
| Gallery 1: key states | `gallery-1-states.png` |
| Gallery 2: Thread Actions page (XL) | `gallery-2-thread-actions.png` |
| Gallery 3: Usage tiles | `gallery-3-usage.png` |
| Gallery 4: how it works (tokens, local only) | `gallery-4-how-it-works.png` |
| Plugin icon | `icon/plugin-256.png`, `icon/plugin-512.png` |
| Category icon (white, 28/56) | `icon/category.png`, `icon/category@2x.png` |
| Action list icons (white, 20/40) | `icon/thread*.png`, `icon/overview*.png`, `icon/usage*.png`, `icon/back*.png` |

All images are generated from the plugin's own renderers with invented data by `render-assets.ts`. They contain no T3 artwork. Re-run the script after UI changes land.
