---
title: Releasing
description: How Echo versions are cut, and how the website at echo-web.samarthmn.com is built and deployed on Vercel.
---

## The website

The website (landing page and these docs) is an Astro + Starlight project in `site/`. It reads the docs straight from the repository's `docs/` folder, so a docs change on `main` updates the site.

```bash
pnpm install
pnpm --filter echo-site dev     # http://localhost:4321
pnpm --filter echo-site build   # astro check + static build into site/dist
```

The build fails on broken internal links (`starlight-links-validator`). Repository-relative links in the docs, such as `install.md#updating` or `../scripts/setup.sh`, are rewritten to site routes or GitHub links by `site/src/plugins/remark-repo-links.ts`.

### Vercel setup

The site is a static Astro build deployed by Vercel's Git integration. Its settings are in `site/vercel.json`: build commands, trailing slashes, and the security headers (CSP, HSTS and others). No Vercel secrets live in GitHub.

1. In Vercel, choose **Add New → Project** and import `samarthmn/echo-voice-web`.
2. Set the **Root Directory** to `site`, and keep **Include files outside the root directory in the Build Step** enabled: the site reads `docs/`, `brand/`, `public/fonts/` and `scripts/` from the repository root.
3. Leave the framework, install and build settings to `site/vercel.json` (Astro; output `dist`). It runs the repository's pinned pnpm (12.11.2) through `npx` for install and build, because Vercel's bundled pnpm cannot switch itself to pnpm 12. Keep that version in step with `packageManager` in `package.json`.
4. Under **Settings → General**, choose Node.js 22 or newer.
5. Under **Settings → Domains**, add `echo-web.samarthmn.com` and create the DNS record Vercel shows.
6. Under **Analytics**, enable Web Analytics. Builds on Vercel then include its cookieless script, served from the site's own `/_vercel/insights` path. Analytics only ever run on the website, never in the app.

Pushes to `main` deploy to production; other branches and pull requests get preview URLs.

## Releasing a version

Echo has one version number, `[workspace.package] version` in `Cargo.toml`. `scripts/version.ts` copies it into `package.json`, `extension/manifest.json` and `Cargo.lock`, and `check.sh --lint` fails if they drift.

1. Move the `Unreleased` notes in `CHANGELOG.md` under a new `## [X.Y.Z] - YYYY-MM-DD` heading, and update the links at the bottom.
2. Set the version everywhere:

   ```bash
   node scripts/version.ts X.Y.Z
   ```

3. Re-check the competitor facts on the landing page (`site/src/data/site.ts`, with the "checked" date) and update them if they have changed.
4. Run `./scripts/check.sh --all`, commit, and merge to `main`.
5. Tag the merge commit and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The `Release` workflow (`.github/workflows/release.yml`) checks that the tag matches the version, runs the Rust and app checks on macOS, builds the unpacked extension zip and the Chrome Web Store zip, writes `SHA256SUMS.txt`, and publishes a GitHub release whose notes are that version's CHANGELOG section.

For the Chrome Web Store, upload the store zip from the release as described in the [store listing](store-listing.md).
