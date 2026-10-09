# Echo documentation

Choose the guide for what you want to do. Setup guides describe the current product; plans describe work that may not exist yet. Test reports record particular builds and environments, not universal support.

## Use Echo

| Task | Guide |
|---|---|
| Start the local web app, record, transcribe, create notes, and back up | [Start with the main README](../README.md) |
| Record a meeting in an existing Brave or Chrome tab | [Browser extension setup and recording](browser-extension.md) |
| Protect, back up or move the library | [Storage and recovery](storage-and-recovery.md) |
| Recover after an application update | [Web updates and recovery](update-recovery.md) |
| Recover pending extension audio | [Offline recording and recovery](browser-extension.md#offline-recording-and-recovery) |
| Use the full Large V3 model | [Native speech setup](native-speech.md) |
| Connect ChatGPT for optional notes | [ChatGPT setup and data sent](chatgpt.md) |
| Connect read-only Google Calendar | [Calendar configuration](integrations.md) |
| Update an installation that used the retired meeting runner | [Migration and audio recovery](extension-migration.md) |

Echo runs as a local web server with an optional meeting-recording extension. Initial server setup currently needs a source build; a store listing is not yet published. Guided connection and protected storage are under qualification. Start with [setup](install.md), [backup and recovery](storage-and-recovery.md), and the [readiness record](production-readiness-status.md). Current platform results remain in the [qualification matrix](extension-qualification.md).

## Develop and release

| Task | Guide |
|---|---|
| Build, configure, test, or package the app | [Developer guide](development.md) |
| Understand components and data flow | [Architecture](architecture.md) |
| Test the extension on macOS or Ubuntu, including a Codex handoff | [Qualification checklist](extension-qualification.md) |
| Publish one extension listing for Chrome and Brave | [Publishing guide](extension-publishing.md) |
| Qualify and approve an exact release candidate | [Release checklist](release-checklist.md) |
| Prepare listing copy and assets | [Store materials](extension-store.md) |
| Check feature scope and known gaps | [Feature coverage](feature-coverage.md) |
| Review the planned simpler setup, pairing, and production work | [Production-readiness plan — October 9, 2026](superpowers/plans/2026-10-09-production-readiness.md) |

## Verification and history

- [Extension review](extension-review.md): recording, recovery, mute tests, and remaining qualification.
- [PR review — October 8, 2026](pr-review-2026-10-08.md): code-review findings, fixes, and verification.
- [AMI accuracy report](ami-accuracy-2026-10-05.md): three recorded sample results and provenance limits.
- [Original verification record](verification.md), [Brave local review](brave-local-verification.md), and [design review](design-review-fresh.md): evidence from earlier builds; their dates and stated limits matter.
- [Original product plan](product-plan.md), [implementation plan](implementation-plan.md), and [browser-extension plan](superpowers/plans/2026-10-05-browser-extension.md): design history, not installation instructions or proof that every requirement is complete.

Historical runner and desktop-application plans remain for context. Desktop application distribution was removed from scope on October 9, 2026; it is not a current installation path. Current meeting capture uses the browser extension; use the migration guide above for old data. The native Large V3 speech helper remains part of the current product.
