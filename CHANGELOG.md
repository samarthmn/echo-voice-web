# Changelog

All notable changes to Echo are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Echo uses [semantic versioning](https://semver.org/).

## [Unreleased]

- Changed: the speech runtime is now Transformers.js 4.3.2 with ONNX Runtime 1.30 (native) and 1.31 (browser). Word timings and transcripts were checked against the previous runtime on real speech, and models still load only from their pinned versions, including offline.

## [1.0.0] - 2026-11-01

The first public release: Echo as an open-source, self-hosted product.

### Added

- A website at echo-web.samarthmn.com with a landing page and the documentation, built from the repository's `docs/` folder.
- Rewritten documentation: requirements, install from a fresh Mac, first recording, configuration, security model, privacy (every network request), troubleshooting, CLI and HTTP API references.
- The Organic design: a new logo, warm light and dark themes, the self-hosted Mulish typeface and Lucide icons, across the app, the extension and the website.
- `scripts/doctor.sh` checks a Mac and an installation and prints fixes; `scripts/update.sh` updates, rebuilds and restarts Echo.
- `echo-server --version`, a richer `/api/health`, and the version in Settings.
- A Chrome Web Store build of the extension, alongside the unpacked build.
- Strict TypeScript everywhere, typed ESLint, stylelint, markdownlint, ShellCheck, actionlint and strict Clippy lints, all enforced in CI.
- Contribution guide, code of conduct, security policy and issue templates.

### Changed

- Notes are generated only by local Ollama models.
- Accent colours meet WCAG AA in both themes, checked by a test.

### Removed

- The ChatGPT notes provider. Notes made with it remain readable and are labelled "ChatGPT (legacy)".
- The pre-v3 extension storage migration.

[Unreleased]: https://github.com/samarthmn/echo-voice-web/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/samarthmn/echo-voice-web/releases/tag/v1.0.0
