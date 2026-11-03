# Security policy

## Reporting a vulnerability

Please **don't** open a public issue for a security problem.

Report it privately through GitHub Security Advisories: go to the repository's **Security** tab and choose **Report a vulnerability**, or use https://github.com/hsalazr/deck-for-t3code/security/advisories/new.

Include what you found, how to reproduce it, and the plugin and macOS versions. I'll acknowledge your report within a few days, keep you updated, and credit you in the fix if you'd like. This is a spare-time project, so please be patient.

## Supported versions

Only the latest release gets security fixes.

## How the plugin handles access to T3 Code

Deck for T3 Code is a local plugin (macOS only). It talks only to the T3 Code server on the same Mac, has no server of its own, and sends no analytics, crash reports or telemetry.

To do that it uses **up to three tokens**, minted with your local `t3` CLI and stored on your Mac in `~/Library/Application Support/io.github.hsalazr.deck-for-t3code/` (folder mode 0700, files mode 0600: `credential.json`, `credential-rpc.json`, `credential-operate.json`, and `pending-revoke.json` for sessions still to revoke):

| Token | Label in `t3 auth session list` | Scope | Used for | Lifetime |
|---|---|---|---|---|
| Threads | `Stream Deck (Deck for T3 Code)` | `orchestration:read` (session subject `mcp-client`) | Thread list | 30 days; renewed once less than half is left |
| Live and usage | `Stream Deck (Deck for T3 Code usage)` | `orchestration:read` | Live status stream, context size, usage limits | 30 days; renewed once less than half is left |
| Actions | `Stream Deck (Deck for T3 Code actions)` | `orchestration:read`, `orchestration:operate` | Thread Actions keys: send, snooze, settle, stop | 24 hours; minted only while "Enable thread actions" is on (the first time an action runs); revoked when it is turned off |

- The first two are read-only. The actions token is opt-in (off by default) and short-lived.
- Replaced tokens are revoked. A revoke that fails (for example, T3 Code is closed) is recorded in `pending-revoke.json` and retried each time the plugin starts and whenever T3 Code comes back after being unreachable.
- If T3 Code rejects a token, the plugin mints a new one and revokes the old one. If a renewal fails, the current token keeps working until it expires.
- Revoke tokens yourself with **Sign out / revoke tokens** in the plugin's settings (it revokes all of them and deletes the files, and says how many revokes are still pending if T3 Code was unreachable; nothing is minted again until you press **Sign in again** or restart the plugin), or with `t3 auth session list` and `t3 auth session revoke <id>`.
- **Uninstalling the plugin does not revoke its tokens.** Sign out first, or they stay valid until they expire.
- Anyone who can read the plugin's token files as your user can act with those scopes, so keep your Mac account secure. Revoke the tokens if you think a file leaked.

### What the plugin checks

- **Loopback only.** Credentials are only sent to the origin in T3 Code's `server-runtime.json`, and only if it is `http` or `https` on `127.0.0.1`, `localhost` or `::1` without a user name or password. Anything else is refused before a token is minted or sent.
- **T3 home must be an absolute path** (a leading `~/` is expanded).
- **The T3 CLI is vetted before it runs.** `<T3 home>/bin/t3` must be a regular, executable file owned by you or root that no other user can write to. Session ids are also checked before they are passed to the CLI as an argument.
- **No redirects.** Every request that carries a token is sent with redirects refused, so a loopback server can't bounce a token elsewhere.
- **Log redaction.** Every log line passes through a filter that replaces any run of 32 or more token-like characters with `[redacted]`.
- **Hold to confirm.** Compact, Settle, Stop and quick messages only fire after a 0.8 s hold, never on a tap.

## In scope

Anything that could let another person or process read or use these tokens, send commands to T3 Code without the user's action, make the plugin contact a host other than the local T3 Code server, or run code through crafted thread titles, messages or settings.

## Out of scope

Vulnerabilities in T3 Code, the Stream Deck app or macOS themselves. Please report those to their respective vendors.

Not affiliated with or endorsed by T3 Tools Inc. T3 Code is a trademark of its respective owner.
