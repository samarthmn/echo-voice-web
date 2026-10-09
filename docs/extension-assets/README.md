# Draft extension store images

These assets are prepared locally for review. They have not been uploaded or published, and do not establish browser or meeting-service qualification. Follow the [store listing](../extension-store.md) and [qualification matrix](../extension-qualification.md) before submission.

| Asset | Contents |
| --- | --- |
| [promo-440x280.png](promo-440x280.png) | 440×280 promotional tile using Echo's existing icon, shared tokens and bundled Inter font. The copy states that transcripts and notes need the desktop app. |
| [setup-protection-1280x800.png](setup-protection-1280x800.png) | Actual extension setup showing recording protection and the unpaired connection choices. |
| [setup-choices-1280x800.png](setup-choices-1280x800.png) | The same setup page scrolled to service and microphone choices. No service is enabled and no microphone permission is granted. |

All three images are 24-bit RGB PNGs without transparency. The setup screenshots are direct 1280×800 viewport captures of the unmodified built extension; no padding, labels, simulated controls, seeded storage or edited product states were added. The profile contains no recordings or connection, and no recovery phrase was generated. Displayed services are available setup choices, not a claim that every service has passed live qualification.

The [capture provenance](capture-provenance.json) records the browser version, extension version, asset dimensions and SHA-256 values, and hashes of every extension bundle file. Its bundle hashes identify this dirty-workspace candidate more precisely than an unchanged Git commit would. Rerun the capture against the final release candidate before submission.

## Reproduce

Install the repository's locked npm dependencies, then run from the project root:

```sh
node scripts/capture-extension-assets.mjs
```

The script uses Brave on macOS or `/usr/bin/chromium` on Linux. Set `CHROMIUM_PATH` to another installed extension-capable Chromium executable when needed. It uses the same Playwright and `buildExtension` path as the existing extension runtime tests. A sandbox that disallows launching a local browser needs permission for this command.

The script creates a unique profile and extension build below project `tmp/`, blocks HTTP(S) through a local deny proxy including loopback destinations, and opens only the built extension and the local [promotional source](promo.html). It never connects to a running Echo library, opens an account, grants permissions or creates audio. It cleans its profile, build and browser temporary files when done. Generated images and provenance overwrite only the named draft outputs in this directory.

The promotional source reads `public/favicon.svg`, `public/design-tokens.css` and the bundled Inter fonts directly. It is a deterministic code-based branding layout, not a product screenshot or an AI-generated interface.

## Still pending

- A real approved connection to a synthetic Echo library, with identifiers and recovery words outside the captured viewport.
- Recording, source indicators and pause from an actual qualified synthetic call.
- Genuine saved/pending-history and recovery states after that call; never show recovery words.
- A final transcript/notes review screenshot from the qualified candidate.

Older images elsewhere in this directory retain their original evidence status. They were not refreshed by this script and are not presented as current candidate screenshots.

## Current workspace previews

[Desktop Overview](echo-overview.png) and [mobile Overview](echo-overview-mobile.png) were refreshed on October 9 with the current first-transcript guide and 24px separation from the recording actions. They are direct light-theme Brave viewport captures at 1440×1050 and 390×844, respectively, from a fresh isolated empty library and browser profile. No account, recording, microphone permission, downloaded model or fabricated interface state was used. The [workspace provenance](workspace-capture-provenance.json) records exact image and source hashes.

These are documentation previews, not store-sized screenshots or evidence of live call qualification. The extension capture script above does not overwrite them. Recheck the final candidate before submitting store images.
