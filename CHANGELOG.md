# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.3] - 2026-11-17

Fixes threads that only wait on background work blinking as "needs you" with T3 Code 0.1.10. Also new since 1.2.2: the **Dictate** key, a microphone on your deck that starts T3 Code's voice input (opt-in); the **Scheduled** key; pull request and goal marks on Thread keys; and reset tickets and hub accounts on the Usage key.

### Added

- **Pull request and goal marks** on Thread keys (Detailed look), read from the live stream the plugin already holds, with no new token or scope. A small disc shows the thread's open pull request, with `#42` when there is room: a red cross for failing checks, an amber `!` for a conflict, requested changes or checks awaiting approval, blue dots while checks run, a ring with a dot when review is required, a green tick when approved or passing, a plain ring when open and nothing else is known, a dashed ring for a draft. Merged and closed pull requests get no mark. Forges that send no check or review state get the plain ring; the plugin never guesses a check result. With several open ones, the one that most needs you shows. A rounded square shows the thread's `/goal`: a target, with the share of its token budget used when T3 Code reports one, or `paused`, `blocked`, `limit`, `budget` or `done`. Both are static: they never make a key flash or change its state, the Overview's counts or any animation. A thread waiting only on a pull request's CI isn't marked twice, and the Glance look, a key paused by a usage limit and linked machines' threads show no marks.
- **Hold Open to open the thread's pull request.** On the Thread Actions page the Open key shows `PR #42` and its status when the thread has a pull request, and holding it for 0.8 s opens the pull request in your default browser (with none open, the most recently updated one, labelled `Last: merged`). It works with "Enable thread actions" off. Only `https` or `http` links with no user name or password and at most 2,048 characters are opened.
- Usage key: banked reset tickets. When a provider or hub account has reset credits, the key shows a small ticket mark with the count in both the Bar and the Ring style, and the Bar style adds `exp 2d` when the next ticket lapses within 3 days and there is room. The plugin only shows them; redeeming one needs a permission it doesn't use. T3 Code doesn't read Claude's own tickets on macOS (as of 0.1.9), so a Claude account signed in on this Mac shows none; Codex accounts and hub accounts do.
- Usage key: accounts served through a CLIProxyAPI hub are in the limit picker, under the hub's name, the driver, the account's email (or name) and plan. On the key itself they read as the driver and plan (`CODEX PLUS WEEKLY`) or the hub's name, never an email. They come from T3 Code's config stream, which the plugin opens for a moment on each refresh and closes; there is still no connection between refreshes. The saved choice holds the hub's id and a hash of the account's id.
- Usage key: a key set to a limit that its provider doesn't report now says why (`No plan limits`, `Couldn't read limits`, `No limits reported`, `Limit not reported`, `Hub unavailable`) instead of "No usage data".
- `scripts/usage.ts` also prints reset tickets, hub accounts and why a provider has no windows.
- **Scheduled key:** one of T3 Code's scheduled tasks, with when it runs next as a large countdown, how its last run went, and a hold to run it now. The *Detailed* look has the title, the countdown, the schedule in a few words (`every 2h`, `daily 09:00`, `once`, `webhook`) and the last result; a failed last run is a red band with a cross that stays until the next run succeeds. The *Glance* look is the countdown in large type with a glyph for the state. It draws counting down, running (the thread tiles' spinner), failed, never run, disabled, blocked by policy, webhook (no next run), no tasks at all, a deleted task, and T3 Code unreachable. The settings are **Task** (default: whichever runs next) and **Look**. A tap opens the task's thread in T3 Code when it has one and the plugin knows it, otherwise brings T3 Code forward; holding for 0.8 s runs the task now. Running changes T3 Code, so it works only while **Enable thread actions** is on and uses the actions token (`orchestration:operate`, `scheduledTasks.runNow`); with it off the key says *Enable in settings*. The plugin reads task titles, schedules, run times and results over the read-only live-status token (one `scheduledTasks.subscribe` stream, open only while a Scheduled key is on a deck, nothing polled), and never a task's prompt.
- **Dictate** key (opt-in, off by default): a microphone on the deck that starts T3 Code's voice input. T3 Code can only start dictation from its microphone button or its keyboard shortcut, so the key brings T3 Code forward and presses that shortcut (`composer.dictation`, read from T3 Code, ⇧⌘D by default) there, through a fixed `osascript` script that only posts while T3 Code is the frontmost app, and posts to T3 Code's own process. The shortcut is looked up on every press, and for a letter the script finds the key that types it on your keyboard layout (Dvorak, AZERTY…) or refuses. Tap for a quick press; hold for longer than 0.2 s and the shortcut stays down until you let go (at least 0.35 s, so T3 Code always reads it as a hold), so T3 Code's own *Dictation shortcut* setting (Auto, Hold to talk, Toggle) decides what happens, as with a keyboard. As with a keyboard, what the chord does depends on what has focus in T3 Code: with its terminal focused, the default ⇧⌘D splits the terminal. A **Thread** setting can open the most urgent thread first. Needs voice input set up in T3 Code and Stream Deck allowed under System Settings → Privacy & Security → Accessibility; the key says so when that permission is missing. Turn it on with **Enable the Dictate key** in the key's settings. SECURITY.md says exactly what it does and checks.

- A thread on a linked machine that has a question open for you blinks amber. Before, it kept showing as working, because T3 Code leaves the run "running" while it asks and the thread list doesn't say. Every round (3 seconds while something runs there) the plugin asks T3 Code about each running top-level thread on that machine (`t3_pending_request` with action `list`, through this Mac's server, over the read-only Threads token). The answer holds the questions' ids and nothing of their text. T3 Code doesn't list approvals, secrets or link requests that way, so a linked machine's thread waiting on one of those still shows as working. At most 12 threads are asked per round, the ones asked longest ago first, and a machine that refuses is left alone for a minute.
- A linked machine's thread that waits on background work says what it waits on (`PR #42 CI`, `2 agents`, a command's name), when both machines run T3 Code 0.1.10 or later. Before, the chip always said `background`.

### Changed

- "Needs you" comes only from a request that is open for you, by T3 Code's own rule. A subagent's ordinary question no longer makes its main thread blink, because the agent that started the subagent answers it; a subagent's approval, secret or link request still does. A sign-in refresh never blinks.
- Usage key: every provider T3 Code reports gets a name: its own, else the known name for its driver (Grok, Kiro, Muse Code, Pi, Antigravity, fx, ACP Registry…), else the driver's id tidied up. Two instances with the same name are told apart by their instance id.
- Usage key: with no limit picked, the key still shows Claude's weekly window, but for other providers it now finds a weekly limit by its kind rather than by Claude's window id, preferring one that covers all models.

### Fixed

- Threads that only wait on background work no longer blink amber as "needs you". Since T3 Code 0.1.10 the thread list reports a thread as `waiting` when its turn has ended and background work still holds it: subagents, delegated tasks, or commands, monitors and pull request checks its agent said it waits for. The plugin read `waiting` as "waiting on you", so those threads blinked amber and the Overview counted them under "need you". They now show the white spinner and a chip saying what they wait on, on this Mac (also while the live stream is down) and on linked machines, and turn green when T3 Code lists them as completed. A subagent held the same way counts as a working subagent.
- The nightly pre-release is published again. It had failed since 2026-11-11: releases in this repo are immutable now, and GitHub never lets a tag name be used again once a release has used it, so the rolling `nightly` tag stopped working. Each nightly now has its own tag (`nightly-1.2.2.N`) and replaces the one before it. Find it under [pre-releases](https://github.com/hsalazr/deck-for-t3code/releases?q=prerelease%3Atrue).

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

[Unreleased]: https://github.com/hsalazr/deck-for-t3code/compare/v1.2.3...HEAD
[1.2.3]: https://github.com/hsalazr/deck-for-t3code/compare/v1.2.2...v1.2.3
[1.2.2]: https://github.com/hsalazr/deck-for-t3code/compare/v1.2.1...v1.2.2
[1.2.1]: https://github.com/hsalazr/deck-for-t3code/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/hsalazr/deck-for-t3code/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/hsalazr/deck-for-t3code/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/hsalazr/deck-for-t3code/releases/tag/v1.0.0
