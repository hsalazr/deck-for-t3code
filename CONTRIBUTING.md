# Contributing to Deck for T3 Code

Thanks for wanting to help. This is a small, independent project: it isn't affiliated with or endorsed by T3 Tools Inc., and T3 Code is a trademark of its respective owner.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md). By contributing code you agree it's released under [GPL-3.0-or-later](LICENSE), the project's licence.

## Before you start

- **Bug?** Open an issue with the bug template. Say which plugin, Stream Deck, macOS and T3 Code versions you use.
- **Idea?** Open an issue first for anything bigger than a small fix, so we can agree on it before you write code.
- **Security problem?** Don't open a public issue. See [SECURITY.md](SECURITY.md).

## Set up

You need macOS, Node 24 and the Stream Deck app (7.1 or later).

```sh
git clone https://github.com/hsalazr/deck-for-t3code.git
cd deck-for-t3code
npm ci
npm test
npm run build
npx streamdeck link *.sdPlugin   # once
npm run watch                    # rebuild and restart on change
```

Useful scripts:

- `node --experimental-strip-types scripts/preview.ts out.html` writes a contact sheet of every key state, no Stream Deck needed.
- `node --experimental-strip-types scripts/snapshot.ts` prints what the deck would show right now.
- `node --experimental-strip-types scripts/usage.ts` prints the usage limits T3 Code reports.
- `npm run profile` rebuilds the bundled T3 Threads and Thread Actions profiles (one per deck type) from `scripts/build-profile.mjs`. Re-run it after changing a page layout.
- `node --experimental-strip-types marketing/render-assets.ts` regenerates the site and Marketplace images from the plugin's own renderers and the profile layouts. Re-run it after UI changes and commit the new PNGs.

## Making a change

1. Fork the repo and branch from `main`.
2. Keep the change focused. One idea per pull request.
3. Add or update tests. The model, the renderers and the usage maths are pure functions and easy to test (`test/`).
4. Run everything CI runs:
   ```sh
   npm test
   npx tsc --noEmit -p .
   npm run build
   ```
5. For anything visible on a key, include a screenshot or a photo in the pull request.
6. Update the README, the site (`docs/index.html`), `marketing/listing.md` and `CHANGELOG.md` if behaviour changes, and `SECURITY.md` if tokens, scopes or checks change. Docs must match the code: check each claim against it.

## Keep examples invented

Tests, docs, screenshots and issues must not contain real project names, thread titles, tokens, paths or hostnames. Use made-up examples such as projects `acme-api`, `acme-web`, `acme-infra` and threads like "Add retry to checkout flow".

## Ground rules for the plugin

- **Local only.** The plugin talks to T3 Code on the same machine and nothing else. No analytics, no telemetry, no third-party services.
- **Least privilege.** Read-only tokens by default. Anything that changes T3 Code state goes through the opt-in actions token (only minted while "Enable thread actions" is on), and Compact, Settle, Stop and quick messages need a 0.8 s hold to confirm.
- **Credentials stay on loopback.** Tokens are only sent to a `127.0.0.1`, `localhost` or `::1` origin, the `t3` CLI is vetted before it runs, and log lines are redacted. Keep it that way.
- **No T3 artwork.** Don't add T3's logo, screenshots or other branding. Draw your own.
- **No donation links in the plugin's Property Inspector** (Elgato's Marketplace rules). Sponsor links belong in the README and the site.

## Releasing (maintainer)

1. Update `CHANGELOG.md` and the version in the manifest (`Version`, four parts, e.g. `1.0.0.0`), `package.json` and `package-lock.json` (`1.0.0`), and `PLUGIN_VERSION` in `src/version.ts` (sent to T3 Code as the client version; a test checks all four agree). The tag `v1.0.0` matches the manifest.
2. Run `npm run notices` after `npm ci` and commit `THIRD_PARTY_NOTICES.md` (repo root and plugin folder) if it changed. It lists the packages bundled into `bin/plugin.js` with their license texts; a test fails when the files are stale.
3. Tag `vX.Y.Z` and push the tag. The release workflow builds, checks that the tag matches the manifest, packs the plugin and attaches the `.streamDeckPlugin` file to a GitHub release, using the matching `CHANGELOG.md` section as the notes.

Nightlies need nothing: `.github/workflows/nightly.yml` builds `main` daily at 08:23 UTC when it has changed (or on demand: **Actions → Nightly → Run workflow**), stamps the manifest's fourth version part with the run number, and replaces the `nightly` pre-release with the change log's `[Unreleased]` section as notes.
