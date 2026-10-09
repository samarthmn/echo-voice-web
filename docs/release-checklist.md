# Release candidate checklist

Use this for one immutable commit and its exact artifacts. A successful build is not a release approval. Current evidence and unresolved work live in the [readiness record](production-readiness-status.md).

## Candidate identity

Record the commit, app/extension versions, web asset and extension archive SHA-256 hashes, supported platform/provider cells, store identity and review links. Do not record credentials, recovery phrases, private meeting links or account screens.

- [ ] All implementation changes committed and independent findings resolved.
- [ ] Formatting, Rust/JavaScript/extension tests and affected browser scenarios pass on this commit.
- [ ] Source dependency findings are assessed; server/extension package contents and native Large V3 inference smoke pass.
- [ ] Release server rejects fixture keys; production archives contain no user libraries, recordings, logs, account tokens or recovery phrases. Private configuration and Google web-client credentials are excluded.
- [ ] Fresh CodeRabbit review and CI results refer to this candidate; unavailable checks remain pending.

## Application and extension qualification

- [ ] The documented source build and local-server start work on every advertised OS. Record required tools, actual OS keyring behavior and any setup assistance honestly.
- [ ] Browser reload, local port conflict, duplicate server/library lock, shutdown, restart and stopped-library migration preserve data. Deleting a checkout must be documented as deleting the default library unless backed up elsewhere.
- [ ] [Browser/service matrix](extension-qualification.md) has current evidence for every advertised combination. Keep untested cells pending.
- [ ] Pairing, permission denial, both audio sources, mute/exclusion, no camera, offline capture, crash recovery, transfer retries and export pass.
- [ ] Live text and final processing preserve transcripts, notes, versions, audio timeline and pending recordings.
- [ ] Encryption/recovery pass with real OS credential storage; wrong keys and tampering preserve saved data.
- [ ] Update, migration failure and downgrade checks preserve recoverable originals and reject incompatible libraries.
- [ ] Actual store-installed extension identity, installation and update pass in Brave and Chrome.
- [ ] Four of five consenting first-time participants complete the [unassisted journey](first-use-qualification.md).

## Publisher and delivery

- [ ] [Publisher facts](../release/publisher.json), contact address, privacy disclosures and account ownership are confirmed.
- [ ] Hosted download/privacy/support pages match the tested candidate and contain working approved links.
- [ ] Google branding, read-only scope verification and intended audience are configured; the current test audience is not public readiness.
- [ ] Source update instructions, encrypted backups and schema-version rejection are verified against the candidate. No automatic updater or snapshot is advertised.
- [ ] Store ZIP, 128px icon, 440×280 promotional image, current genuine screenshots and reviewer instructions are ready; follow the [publishing guide](extension-publishing.md).
- [ ] Account-holder login/verification, fees and binding agreements are complete with the required approvals.
- [ ] Private testing and the release summary are reviewed; the owner approves the exact distribution/publication action.
- [ ] Published source/extension links and actual store-installed extension builds are verified. Record rollout, known issues and recovery instructions.

Codex owns preparing and executing these checks wherever access permits. Human participation is limited to the [listed unavoidable dependencies](superpowers/plans/2026-10-09-human-tasks.md).
