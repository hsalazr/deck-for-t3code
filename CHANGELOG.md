# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

## [1.0.0] - Unreleased

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

[1.0.0]: https://github.com/hsalazr/deck-for-t3code/releases/tag/v1.0.0
