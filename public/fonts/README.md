# Fonts

Echo self-hosts its typeface. Nothing is fetched from a font CDN.

| Family | Use | Source | License |
| --- | --- | --- | --- |
| Mulish variable 200–1000, normal and italic | Headings (800) and body text | `@fontsource-variable/mulish@5.3.0` (npm tarball sha256 `92e3fddbf9366437b20a9dcffb137e6f68b0face1f5428d31d552c802e5923b0`) | [SIL OFL 1.1](OFL-Mulish.txt) |

Only the `latin` and `latin-ext` woff2 subsets are included. The `@font-face` rules live in `scripts/build-tokens.ts`, which writes them into the generated `tokens.css`.

To update the font, `npm pack` the new Fontsource version into `tmp/`, copy the same files over these ones, and update this table.
