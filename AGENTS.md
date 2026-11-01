# Instructions for coding agents

These rules apply to every coding agent working in this repository (Claude Code, Codex, Cursor, Copilot and any other), and to humans too.

## Lint and type checks run before every commit. Never bypass them

The git pre-commit hook (`.githooks/pre-commit`) runs `./scripts/check.sh --pre-commit` before every commit. It runs every linter and type checker: rustfmt and `dx fmt`, Clippy (native and wasm), Prettier, ESLint, stylelint, markdownlint, ShellCheck, actionlint, both TypeScript compilers, `astro check`, knip, and the icon and version freshness checks. A commit is only allowed when all of them pass.

**No coding agent may bypass, skip, disable or weaken these checks in order to commit.** In particular, never:

- commit with `git commit --no-verify` or `-n`, including with `--amend`;
- change, unset or override the hooks path (`git config core.hooksPath`, `git -c core.hooksPath=...`, `GIT_CONFIG_*` environment tricks);
- edit, delete, rename or `chmod` `.githooks/pre-commit` or `scripts/check.sh` to make a failing check pass or skip;
- create commits through plumbing (`git commit-tree`, `git update-ref`, `git replace`) or any other route that avoids the hook;
- silence a finding instead of fixing it: no new `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `as any`, `#[allow(...)]`, `stylelint-disable`, `shellcheck disable` or `markdownlint-disable` unless the rule is genuinely wrong for that line, with a comment giving the specific reason;
- loosen a configuration (`eslint.config.ts`, `tsconfig*.json`, `[workspace.lints]` in `Cargo.toml`, `clippy.toml`, `.stylelintrc.json`, `.markdownlint-cli2.jsonc`, `knip.json`, `deny.toml`) just to get a change through.

If the checks fail, fix the code. If you cannot fix it, **stop and tell the human what fails and why. Do not commit.** If a check itself is broken or flaky, fix the check in its own commit, which must also pass, or ask the human first.

Run the checks yourself before committing so you see failures early:

```bash
./scripts/check.sh --pre-commit   # what the hook runs: lint and type checks
./scripts/check.sh --all          # everything CI runs, including tests and builds
```

The hook checks the whole working tree, not only the staged files, so commit with a clean tree or make sure unstaged changes also pass. If the hook is not active in a checkout (`./scripts/doctor.sh` reports it), enable it with `git config core.hooksPath .githooks`; `setup.sh` does this. CI runs the same checks on every pull request, so a bypassed commit will still fail there.

## Working in this repository

- Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/development.md](docs/development.md) before changing code.
- Package manager: pnpm. Rust toolchain: pinned in `rust-toolchain.toml`. Node.js 22.18 or newer.
- Scratch files go in `./tmp` (git-ignored), never the system temp directory. Clean up what you create.
- The docs in `docs/` are also the website. Update them when behaviour or setup changes, and add a line to `CHANGELOG.md` under `Unreleased` for anything users will notice.
- Never commit meeting data, recordings, recovery phrases, OAuth secrets or `.env` files.
