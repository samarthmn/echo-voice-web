# Echo brand assets

The Echo mark is a soft pebble split by a wave: terracotta above, sage below, with the ground showing through the gap. It stands for a voice and its echo, kept inside one closed shape.

## Files

| File | Use |
| --- | --- |
| `logo.svg` | Master mark, full colour. Also `public/favicon.svg` and the extension's `icons/echo.svg` |
| `logo-mono.svg` | Single colour on `currentColor`, for places where colour isn't available |
| `favicon.ico` | 16, 32 and 48 px PNG-in-ICO favicon (`public/favicon.ico`) |
| `png/apple-touch-icon.png` | 180 px home-screen icon on the Organic ground (`public/apple-touch-icon.png`) |
| `png/logo-512.png` | Transparent raster of the mark |
| `png/favicon-{16,32,48}.png` | The frames inside `favicon.ico` |
| `extension/{16,32,48,128}.png` | Browser extension icons (copied to `extension/icons/`) |
| `store/icon-128.png` | Chrome Web Store icon: 96 px artwork in a 128 px canvas |
| `store/tile-440x280.png` | Chrome Web Store small promo tile |
| `social/og-image.png` | 1200×630 Open Graph and Twitter card image for the website |
| `social/github-social-preview.png` | 1280×640 image for the GitHub repository's social preview |

Chrome Web Store screenshots (1280×800) are made from the running app, not from these templates.

## Colours and type

| Role | Value |
| --- | --- |
| Terracotta (`--color-accent`) | `#c67139` |
| Sage (`--color-accent-2`) | `#7a8a5e` |
| Ground (`--color-bg`) | `#f5ead8` |
| Ink (`--color-text`) | `#201e1d` |
| Wordmark | Caprasimo, set as "Echo" |
| Supporting text | Figtree |

The mark works unchanged on the light and dark Organic grounds. On any other background, use `logo-mono.svg` in a single colour with enough contrast.

## Usage

- Keep clear space around the mark of at least a quarter of its width.
- Don't recolour the two halves, rotate the mark, outline it, or add effects.
- Don't place the full-colour mark on a busy photo; use the mono version on a solid area instead.
- Always pair the wordmark with a qualifier where the name alone is ambiguous, for example "Echo, the local meeting recorder".

## Regenerating

Every raster file comes from `logo.svg` and the self-hosted fonts in `public/fonts/`:

```bash
pnpm build:brand
```

`scripts/build-brand.ts` renders each asset in Chromium, writes them here, and copies the favicon, apple-touch icon and extension icons into `public/` and `extension/icons/`. Commit the results.
