# Contributing to Echo

Thanks for helping. Echo is a local, single-user meeting recorder for Apple Silicon Macs, so contributions that keep it private, reliable and simple to self-host are the most welcome.

## Before you start

- **Bugs:** open an issue with the bug form and include the output of `./scripts/doctor.sh`.
- **Features:** open an issue with the feature form first, so we can agree on the approach before you write code. Features that send data off the Mac, add accounts, or need a server we run are out of scope.
- **Security problems:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Set up

Follow [docs/install.md](docs/install.md), then use the development server, which keeps its own data in `.echo-dev-data`:

```bash
./scripts/setup.sh
./scripts/dev.sh
```

[docs/development.md](docs/development.md) explains the layout, the dev loop and every check.

## Checks

A git pre-commit hook runs every lint and type check (`./scripts/check.sh --pre-commit`) before each commit; `setup.sh` enables it. Don't bypass it with `--no-verify`. The rules in [AGENTS.md](AGENTS.md) apply to people as well as coding agents.

Run the full suite before you open a pull request:

```bash
./scripts/check.sh --all
```

It covers formatting, Rust and TypeScript linting, type checks, unit, integration and browser tests, and the website build. CI runs the same checks. Smaller loops:

```bash
./scripts/check.sh --rust   # Rust format, clippy, tests
./scripts/check.sh --lint   # every linter and type check, plus the site build
pnpm test                   # Node unit tests
```

## Pull requests

- Keep each pull request to one change, and explain why it is needed.
- Add or update tests for behaviour changes, and update the docs in `docs/` (they are also the website).
- Write commit messages in the imperative mood, with a short subject line (for example "Add a doctor check for disk space") and a body that explains why.
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- New dependencies need a reason; prefer the standard library and existing packages.

## Code of conduct

Everyone taking part is expected to follow the [code of conduct](CODE_OF_CONDUCT.md).

## Licence

By contributing you agree that your contributions are licensed under the [MIT licence](LICENSE).
