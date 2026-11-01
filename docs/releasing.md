---
title: Releasing
description: How Echo versions are cut, and how the website at echo-web.samarthmn.com is built and deployed on Cloudflare.
---

## The website

The website (landing page and these docs) is an Astro + Starlight project in `site/`. It reads the docs straight from the repository's `docs/` folder, so a docs change on `main` updates the site.

```bash
pnpm install
pnpm --filter echo-site dev     # http://localhost:4321
pnpm --filter echo-site build   # astro check + static build into site/dist
```

The build fails on broken internal links (`starlight-links-validator`). Repository-relative links in the docs, such as `install.md#updating` or `../scripts/setup.sh`, are rewritten to site routes or GitHub links by `site/src/plugins/remark-repo-links.ts`.

### Cloudflare setup

The site is served by Cloudflare Workers static assets, configured in `site/wrangler.jsonc`, and deployed by Cloudflare's Git integration. No Cloudflare secrets live in GitHub.

1. In the Cloudflare dashboard, open **Workers & Pages → Create → Import a repository** and pick `samarthmn/echo-voice-web`.
2. Set the **root directory** to `site`.
3. Build command: `pnpm install --frozen-lockfile --filter echo-site && pnpm build`. Deploy command: `npx wrangler deploy`.
4. Set the environment variable `NODE_VERSION` to `22` (or newer).
5. Under **Settings → Domains & Routes**, add the custom domain `echo-web.samarthmn.com`.
6. Under **Web Analytics**, enable analytics for the site, then add its beacon token as the build variable `CLOUDFLARE_ANALYTICS_TOKEN`. Analytics only ever run on the website, never in the app.

Pushes to `main` deploy to production; other branches get preview URLs.

Security headers (CSP, HSTS and others) are in `site/public/_headers`.
