# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Report it privately through GitHub Security Advisories: go to the repository's **Security** tab and choose **Report a vulnerability**, or use https://github.com/hsalazr/deck-for-t3code/security/advisories/new.

Include what you found, how to reproduce it, and the plugin and macOS versions. I'll acknowledge your report within a few days, keep you updated, and credit you in the fix if you'd like. This is a spare-time project, so please be patient.

## Supported versions

Only the latest release gets security fixes.

## How the plugin handles access to T3 Code

Deck for T3 Code is a local plugin (macOS only). It talks only to the T3 Code server on the same Mac, has no server of its own, and sends no analytics, crash reports or telemetry. The one thing it can do on your Mac beyond that, pressing T3 Code's dictation shortcut, is off unless you turn it on (see [The Dictate key](#the-dictate-key)).

To do that it uses **up to three tokens**, minted with your local `t3` CLI and stored on your Mac in `~/Library/Application Support/io.github.hsalazr.deck-for-t3code/` (folder mode 0700, files mode 0600: `credential.json`, `credential-rpc.json`, `credential-operate.json`, and `pending-revoke.json` for sessions still to revoke):

| Token | Label in `t3 auth session list` | Scope | Used for | Lifetime |
|---|---|---|---|---|
| Threads | `Stream Deck (Deck for T3 Code)` | `orchestration:read` (session subject `mcp-client`) | Thread list | 30 days; renewed once less than half is left |
| Live and usage | `Stream Deck (Deck for T3 Code usage)` | `orchestration:read` | Live status stream, context size, usage limits | 30 days; renewed once less than half is left |
| Actions | `Stream Deck (Deck for T3 Code actions)` | `orchestration:read`, `orchestration:operate` | Thread Actions keys: send, snooze, settle, stop | 24 hours; minted only while "Enable thread actions" is on (the first time an action runs); revoked when it is turned off |

- The first two are read-only. The actions token is opt-in (off by default) and short-lived.
- Replaced tokens are revoked. A revoke that fails (for example, T3 Code is closed) is recorded in `pending-revoke.json` and retried each time the plugin starts and whenever T3 Code comes back after being unreachable. Revokes always go through the current T3 home's CLI. If T3 home changes (you edit it; at a later start the plugin finds `~/.t3` in use instead of a custom build's folder; or `~/.t3` comes into use before the found folder's server has answered), tokens minted for the old home can't be revoked there; they stop working when they expire (24 hours for the actions token, 30 days for the others). Use `t3 auth session revoke` in the old home to end them sooner.
- If T3 Code rejects a token, the plugin mints a new one and revokes the old one. If a renewal fails, the current token keeps working until it expires.
- Revoke tokens yourself with **Sign out / revoke tokens** in the plugin's settings (it revokes all of them and deletes the files, and says how many revokes are still pending if T3 Code was unreachable; nothing is minted again until you press **Sign in again** or restart the plugin), or with `t3 auth session list` and `t3 auth session revoke <id>`.
- **Uninstalling the plugin does not revoke its tokens.** Sign out first, or they stay valid until they expire.
- Anyone who can read the plugin's token files as your user can act with those scopes, so keep your Mac account secure. Revoke the tokens if you think a file leaked.

### What the plugin checks

- **Loopback only.** Credentials are only sent to the origin in T3 Code's `server-runtime.json`, and only if it is `http` or `https` on `127.0.0.1`, `localhost` or `::1` without a user name or password. Anything else is refused before a token is minted or sent.
- **T3 home must be an absolute path** (a leading `~/` is expanded).
- **A found T3 home gets the same checks.** With no T3 home set and no `userdata` folder, the plugin may use a folder next to `~/.t3` named `~/.t3-<custom>`, but only if there is exactly one such folder that is a real folder (not a symlink) you own and nobody else can write to, with a `userdata` folder that passes the same check. With several, it uses none, so it never has to guess between two builds. Once the found folder's server has answered, it keeps that folder until T3 home changes or the plugin restarts; before that, if `~/.t3/userdata` appears, it goes back to `~/.t3`. To decide, it checks whether `~/.t3/userdata` exists, lists your home folder, and runs `lstat` on each candidate and its `userdata`. The found home's server origin and CLI then go through the same loopback and CLI checks as any other home.
- **The T3 CLI is vetted before it runs.** `<T3 home>/bin/t3` must be a regular, executable file owned by you or root that no other user can write to. Session ids are also checked before they are passed to the CLI as an argument.
- **No redirects.** Every request that carries a token is sent with redirects refused, so a loopback server can't bounce a token elsewhere.
- **Log redaction.** Every log line passes through a filter that replaces any run of 32 or more token-like characters with `[redacted]`.
- **Hold to confirm.** Compact, Settle, Stop and quick messages only fire after a 0.8 s hold, never on a tap.

## The Dictate key

The Dictate key starts T3 Code's voice input by pressing T3 Code's own dictation shortcut, because T3 Code offers no other way to start it. Sending keystrokes is a different kind of access from talking to the T3 Code server, so it is narrow and opt-in.

**Off by default.** It works only while **Enable the Dictate key** (global setting `dictationEnabled`) is on. Off, a Dictate key says "Enable in settings" and a press runs nothing. Turning it off mid-press lets go of a shortcut that is held down at that moment and sends nothing new.

**What it does when enabled, and only on a Dictate key press:**

1. Asks T3 Code for the chord bound to `composer.dictation` (`server.getConfig`, read-only token) and, at the same time, brings T3 Code forward with `open -b <bundle id>` (with a `t3code://` thread link when the key is set to the most urgent thread), as other keys already do. The chord is looked up on every press and never cached; no answer within 3 seconds, and nothing is sent.
2. Runs `/usr/bin/osascript -l JavaScript -e <script> -- <tap|down|up> --bundle-id <id> --key-code <n> --flags <n> [--char <letter>] --post pid --wait-ms 1500` with a 5-second timeout. A tap is one run (key-down, 40 ms, key-up); a held key is one run on the way down and one on the way up, at least 0.35 s later.
3. The script posts one or two keyboard events (CoreGraphics `CGEventCreateKeyboardEvent`, `CGEventSetFlags`, then `CGEventPostToPid` to T3 Code's process): the dictation key with its modifier flags on the way down, the same key with no flags on the way up. It posts no modifier key events (it refuses modifier key codes), so no modifier can be left held down, and it never types text. A key-down that failed in a way that doesn't prove nothing was posted (a timeout, a crash) still gets its key-up when you let go; a lone key-up does nothing.

**What T3 Code does with the chord is up to T3 Code.** The plugin sends the chord bound to `composer.dictation`, as your keyboard would; T3 Code decides what it means from what has focus inside T3 Code, which the plugin can't see. With the default bindings, ⇧⌘D with T3 Code's terminal focused splits the terminal pane instead of starting dictation. Click into the composer first, or bind dictation to a chord nothing else uses (a function key, say) in T3 Code's keybindings; the key uses it from the next press.

**What it checks:**

- **One shortcut.** Only the chord T3 Code has bound to `composer.dictation` right now, picked the way T3 Code itself picks the one it shows. Its key must be in a fixed table of US-layout key codes (letters, digits, F1–F20, Space, punctuation) and its modifiers are limited to Command, Shift, Control and Option; anything else is refused and logged, never guessed.
- **The keyboard layout, for letters.** Key codes are positions, and T3 Code (like macOS) matches a letter by the character the layout types, so on another layout the US position of a letter could be another shortcut (on AZERTY, US *A* is *Q*, and ⇧⌘Q is Log Out). For a letter the script reads what the current layout types on that key (an unmodified event, through `NSEvent`) and, if it isn't the letter, uses the character key that types it. If no key does: on a layout with no Latin letter on that key (Cyrillic, Greek…) it keeps the position, which is how T3 Code matches the letter there; otherwise it refuses and posts nothing. Digits, punctuation, Space and function keys are posted at their US position, because T3 Code matches those by physical key on every layout.
- **One app.** The script posts only while the frontmost app's bundle id (`NSWorkspace.frontmostApplication`) equals T3 Code's, waiting up to 1.5 s for it to come forward, and checks the app and its process id again (after letting the run loop run) before the key-up of a tap. It posts to that app's process id, not to the system-wide event stream, so a panel that has the keyboard while T3 Code is frontmost (Spotlight, a launcher) or a global hotkey on the same chord doesn't receive it. The bundle id is the **T3 app bundle id** setting or the one of the app running the T3 server; it must pass the same bundle-id check as `open -b`. With only the `t3code://` fallback there is no bundle id to check against, so the key refuses.
- **A fixed script.** The script is a constant in the plugin. Every value (mode, bundle id, key code, flags, letter, post target, wait) is passed as a separate argument through `execFile`, never put into the script text or a shell, and the script checks each again (whole numbers in range, no modifier key codes, a reverse-DNS bundle id, known flag bits only, one letter a–z on a character key) before it builds anything. The script can also post at the HID event tap (`--post hid`, like a real keyboard); the plugin doesn't use that.
- **Permission.** macOS requires the Accessibility permission to post events, granted to the Stream Deck app (the plugin runs inside it). Without it the script posts nothing, asks macOS once to show the request, and the key says "Allow Stream Deck in Accessibility". The plugin never changes privacy settings itself.
- **Logs.** Failures are logged through the same redacting logger as everything else.

**What it means for you.** With Accessibility granted, macOS lets the Stream Deck app, and so every plugin you run in it, post keyboard events. That permission belongs to Stream Deck, not to this plugin; this plugin uses it only as above. To stop the Dictate key, turn **Enable the Dictate key** off. To withdraw the permission from Stream Deck as a whole, turn it off in System Settings → Privacy & Security → Accessibility.

## In scope

Anything that could let another person or process read or use these tokens, send commands to T3 Code without the user's action, make the plugin contact a host other than the local T3 Code server, or run code through crafted thread titles, messages or settings. Also anything that makes the Dictate key post a key other than T3 Code's dictation shortcut, post to an app other than T3 Code, post while it is turned off, or post without a key press.

## Out of scope

Vulnerabilities in T3 Code, the Stream Deck app or macOS themselves. Please report those to their respective vendors.

Not affiliated with or endorsed by T3 Tools Inc. T3 Code is a trademark of its respective owner.
