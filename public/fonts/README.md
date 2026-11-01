# Fonts

Echo self-hosts its two typefaces. Nothing is fetched from a font CDN.

| Family | Use | Source | License |
| --- | --- | --- | --- |
| Caprasimo 400 | Headings | `@fontsource/caprasimo@5.3.0` (npm tarball sha256 `ee45db91846a5ce4203d5d051f7b1596d2ef4f95c0f615a21d1f0a2ab9e05244`) | [SIL OFL 1.1](OFL-Caprasimo.txt) |
| Figtree variable 300–900, normal and italic | Body | `@fontsource-variable/figtree@5.3.0` (npm tarball sha256 `745eb850be26774948b5aa9342b7182660ed3a48ac40509c7babcfdcd90c39d7`) | [SIL OFL 1.1](OFL-Figtree.txt) |

Only the `latin` and `latin-ext` woff2 subsets are included. The `@font-face` rules live in `scripts/build-tokens.ts`, which writes them into the generated `tokens.css`.

To update a font, `npm pack` the new Fontsource version into `tmp/`, copy the same files over these ones, and update this table.
