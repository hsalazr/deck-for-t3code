# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.2] - 2026-11-11

### Added

- A thread on a linked machine whose turn ended while background work still runs (subagents, delegated tasks, or commands and monitors its agent said it waits for) shows the white spinner and a `background` chip (in the Glance look, the white stroke round the border), and turns green when that work ends. Before, it turned green as soon as the turn ended. The plugin asks T3 Code about each thread once when it finishes a run, and again every 3 seconds while it is held (`t3_thread_wait` with `untilDelegatedWorkSettled` and a 1 ms timeout, through this Mac's server). The key doesn't say what the thread waits on, and a command the agent just left running or a pull request watch doesn't count; this Mac's threads show both.

### Changed

- Threads on linked machines update faster. A machine with something running is asked every 3 seconds instead of every 10; an idle or unreachable one stays at 10. The wait counts from when its last answer came back, so a slow link is never asked faster than it answers. A run that finishes there turns its key green at that next poll. Before, the key could keep showing it as working, or drop off the deck, for up to 30 seconds.

## [1.2.1] - 2026-11-11

### Added

- **Tap** setting on the Overview key: *Open the T3 Threads page* (default, as before) or *Open the most urgent thread*. With the second, a tap opens the thread that needs you first (then failed, done, working) in T3 Code and clears its highlight, and holding the key for 0.5 s, then letting go, opens the T3 Threads page. That key has no "Hold to clear all", except on decks without a bundled page.
- Releases and the nightly come with a `SHA256SUMS.txt` and a GitHub build provenance attestation, so you can check a download was built by this repo's release workflow (`gh attestation verify <file> --repo hsalazr/deck-for-t3code`).

## [1.2.0] - 2026-11-07

### Added

- **Machine** key for this Mac's CPU, memory pressure and free disk space: all three on one key (Summary), or one per key with more detail. CPU is busy time over the last 30 seconds, with performance and efficiency cores apart (found from the hardware, so any M-series chip lays out right); the colour follows the performance cores. Memory follows macOS's own pressure level. Pick a disk by folder. Tap for Activity Monitor (a Disk space key opens its folder in Finder). Read from macOS every 5 seconds while a Machine key is shown, so it works with T3 Code closed. The README and the site explain where each number comes from and why the thresholds sit where they do.
- **Glance** look for Thread and Overview keys (a shared setting, *Thread keys*). Thread keys: just the title in large type; colour, blinking and a stroke running round the border (blue working, white waiting) carry the state. Overview: the count in the most urgent state, big, then `/` all threads, smaller and fainter (`1/2`); no spinner. Same colours and blinking as the detailed look, which stays the default.
- **Glance** style for Machine and Updates keys, to read from across your desk: a ring the size of the Usage key's with the number in the middle (three tall columns for the Machine summary; a check or count in a disc for Updates). The detailed look stays the default.
- The site has a "Two looks" section with a Glance/Detailed switch over the Thread and Overview keys, a Machine and Updates section with its own switch and an explainer of how each number is measured, and a section on why memory is shown as pressure rather than "used". In the demo animation a tap on a finished thread opens it in T3 Code on the Mac, the zoomed-in keys show both looks side by side, act 4 opens on the Overview key, and a fifth act, "Your Mac, at a glance", steps through the Machine and Updates keys.
- **Updates** key: whether T3 Code (against the newest stable or nightly release, matching what you run) or a provider CLI such as Claude or Codex has an update waiting. Checked every 30 minutes while the key is shown; tap to open T3 Code.

### Changed

- Green, red and blue are more saturated on the keys, because a Stream Deck's screen washes colours out. The site and the demo animation keep the softer shades, which look more like light from a real key.
- The nightly pre-release is rebuilt when new plugin code lands on `main`, not on a daily schedule. Docs, site and change log pushes don't rebuild it.

## [1.1.0] - 2026-11-05

### Fixed

- Custom and rebranded T3 Code builds (another app name or bundle id, such as `T3 Acme.app` with `com.t3tools.t3code.custom`) are found. Keys now say `Open T3 Code` instead of `Install T3 Code` when such a build isn't running. Tapping a key brings up the app that runs the T3 server, or, when none is running, the app that owns `t3code://` links, instead of always asking for `com.t3tools.t3code`.
- Tapping a Thread key opens that thread when T3 Code lists it with a `/threads/<environment>/<thread>` link, as some custom builds do. The plugin read `threads` as the environment and sent `t3code://threads/threads/...`, so the app came forward without opening the thread.
- Custom builds that keep their data next to `~/.t3` (such as `~/.t3-custom`) are found without setting T3 home. The Stream Deck app doesn't pass on `T3CODE_HOME`, so before, the plugin looked only in `~/.t3` and said T3 Code had never run. The plugin only looks when no T3 home is set and `~/.t3` has no `userdata` folder, so stock installs behave normally, and it only uses a `~/.t3-<name>` folder when there is exactly one. Once that folder's server has answered, the plugin keeps it until T3 home changes or the plugin restarts. Before that, a `~/.t3/` that comes into use wins. With several such folders, set T3 home.
- Tapping a thread hands its link to the app that runs the T3 server (`open -b`), not to whichever T3 Code build has the default for `t3code://` links. If that app can't be opened, the link opens on its own as before.

### Changed

- Nightly pre-releases are titled `Nightly v<major>.<minor>.<patch>+nightly.<run>`. The Stream Deck app still shows the manifest's four-part version (`1.0.0.2`) as required.

### Added

- Threads on linked machines: with T3 Code's **Settings → Labs → Linked environments** turned on, the deck also lists each reachable linked machine's threads, through this Mac's T3 Code server (`t3_environment_links`, then `t3_thread_list` / `t3_project_list` with `environmentId`). They are polled every 10 s (recent ones every 30 s), have no live-stream extras or context bar, and their Thread Actions keys say "On another machine". A machine that fails for 2 minutes loses its keys; with the setting off, nothing changes.
- **T3 app bundle id** setting, next to T3 home, for builds that detection misses. When it's set, the plugin opens that app and skips detection.

## [1.0.0] - 2026-11-04

First public release (manifest version 1.0.0.0). Repeated identical log lines from one source are collapsed for 10 minutes, and a busy tile's first title line keeps clear of the spinner.

### Added

- **Thread** keys that show T3 Code threads as they change, each state with a colour, a glyph and motion: needs you (amber blink, `!`, including open questions and approvals), failed (red blink, `✕`), done (solid green, `✓`), working (blue spinner), waiting on background work (white spinner with a chip such as "PR #42 CI"), paused by a usage limit ("USAGE LIMIT / back in 2h 10m"), and idle.
- "Seen in T3": done and failed highlights clear when you open the thread, from the key or in T3 Code itself.
- Subagents fold into their main thread: a badge counts them and a waiting subagent makes the main key flash.
- A thin context-window bar on each thread key (grey, amber from 70%, red from 85%), read only for threads that are on a key.
- **Overview** key with counts of threads that need you, are working or are done, and a `+N` overflow count. Tap opens the T3 Threads page; hold 0.8 s clears every done and failed highlight.
- **T3 Threads** page, bundled for Stream Deck XL, Stream Deck (15 keys), Neo and Mini: a full deck of Thread keys with a Back key that returns to your previous profile and shows `+N more`. On other decks (for example Stream Deck +), Overview jumps to the most urgent thread.
- **Thread Actions** page, opened by holding a Thread key for 0.5 s and releasing: quick messages (up to 21 on XL, 7 on Stream Deck, 2 on Neo; `Label | full text` supported), Compact, Snooze (1 hour or until tomorrow 9:00), Settle and Stop. Compact, Settle, Stop and messages need a 0.8 s hold; a tap shows a hint.
- **Usage** key for any usage limit T3 Code reports, as a bar or a segmented ring, with a tick at even pace and an ahead/under pace readout. Tap to refresh.
- Settings for enabling thread actions, quick messages, idle visibility, highlights, status labels, animation, snoozed threads, refresh rate and T3 home, plus a Sign out / Sign in again button.
- A `Signed out` state: after **Sign out / revoke tokens** the first Thread key and the Overview say `Signed out` in grey (not a red sign-in failure), and the settings say `Signed out — use Sign in below`. A sign-out where some revokes could not reach T3 Code reads `Signed out — N token(s) will be revoked later`.
- The Thread Actions page's header shows the thread's context bar, and switching between pages or profiles no longer refetches context for every thread (values are kept for 10 minutes after a thread leaves the keys).
- `THIRD_PARTY_NOTICES.md`, listing the bundled packages and their licenses (`npm run notices`).
- A live connection to T3 Code's shell stream drives updates, with a full reconcile every 30 seconds. Usage limits are fetched every 5 minutes with backoff, and only while a Usage key is on a deck.
- macOS 13+ support, Stream Deck 7.1+.

### Security

- Up to three scoped tokens minted with the local `t3` CLI: two read-only ones (30 days, renewed once less than half is left) and an opt-in actions token (24 hours, minted only while "Enable thread actions" is on and revoked when it is turned off).
- Token-carrying requests refuse redirects; a stale `server-runtime.json` whose pid belongs to another user counts as "T3 Code is not running"; revokes that failed while T3 Code was away are retried when it is back.
- Tokens are stored in `~/Library/Application Support/io.github.hsalazr.deck-for-t3code/` (files 0600). Replaced tokens are revoked, and revokes that fail are retried when the plugin starts.
- Credentials only go to a loopback origin; the T3 home must be an absolute path; the T3 CLI must be a regular file owned by you (or root) and not writable by others before it runs.
- Log lines are redacted of anything that looks like a token. No telemetry.

[Unreleased]: https://github.com/hsalazr/deck-for-t3code/compare/v1.2.2...HEAD
[1.2.2]: https://github.com/hsalazr/deck-for-t3code/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/hsalazr/deck-for-t3code/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/hsalazr/deck-for-t3code/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/hsalazr/deck-for-t3code/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/hsalazr/deck-for-t3code/releases/tag/v1.0.0
