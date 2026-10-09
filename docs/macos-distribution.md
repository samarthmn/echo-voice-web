# macOS signing and notarization

This is the release operator's procedure for the Apple Silicon macOS 14+ candidate. It does not establish clean-machine compatibility or approve public distribution. A debug app passed a local native GUI check, and an unsigned release app passed packaging/native-runtime checks. Rebuild after later source changes before signing. No Developer ID signing or notarization has been performed as part of preparing this procedure.

## Build and inspect

Complete the [release checks](production-readiness-status.md), build the browser assets, then package the current release server and desktop resources using the [developer instructions](development.md#make-a-downloadable-package). Build the Tauri app in release mode:

```bash
mkdir -p tmp
export TMPDIR="$PWD/tmp"
npm run package:desktop
cd desktop
npm_config_cache="$PWD/../tmp/desktop-cli-cache" npm exec --yes --package @tauri-apps/cli@2.12.1 -- tauri build --bundles app --no-sign --config ../artifacts/desktop-runtime/tauri-aarch64-apple-darwin.json
cd ..
node scripts/sign-macos.mjs --app 'target/release/bundle/macos/Echo Voice.app'
```

The last command is a **read-only signing plan**. It discovers Mach-O executables and libraries, rejects unexpected code locations and symlinks, and checks every packaged runtime file against its manifest. A missing module or changed resource requires rebuilding rather than editing a packaged file. It may inspect a debug app but explicitly reports the production key policy as unchecked. No keychain identity is used in this mode.

Publisher builds supply the approved local Google OAuth descriptor through `ECHO_GOOGLE_OAUTH_CONFIG` as described in the developer guide. Do not commit that private build input. Cargo keeps release build-time helper symbols to avoid the macOS linker alignment issue; shipped runtime binaries retain release stripping. The `--no-sign` build makes identity selection explicit in the following steps.

The bundle contains native code under `Contents/Resources/runtime`: Node, Echo's server, the optional Codex executable, ONNX and sharp libraries. They must each be signed explicitly before the outer app. `codesign --deep` is used only for verification because it can miss resource-directory code or apply the wrong entitlements when signing. The manifest hashes must be refreshed **after** native signatures change those files and **before** signing the outer bundle. The signing script performs that ordering. [Apple signing guidance](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac)

## Select the signing identity

```bash
security find-identity -p codesigning -v
```

Confirm the exact **Developer ID Application** identity and its team belong to the authorized publisher. The public listing's publisher name alone does not determine the signing team. Keep the private key in the system keychain; do not export it or put certificates, passwords, API keys or signing credentials in this repository. Keychain access prompts may require the account holder.

Set these two shell variables to the selected public identity label and team ID. They are not private keys:

```bash
ECHO_SIGN_IDENTITY='Developer ID Application: AUTHORIZED NAME (TEAMIDHERE)'
ECHO_SIGN_TEAM='TEAMIDHERE'
```

The checked-in script does not choose an identity and refuses ad-hoc signing. Signing uses Apple's secure timestamp service, so this step needs network access. Publication remains a separate approval.

## Sign and verify a new copy

```bash
node scripts/sign-macos.mjs \
  --app 'target/release/bundle/macos/Echo Voice.app' \
  --output 'artifacts/desktop-runtime/signed/Echo Voice.app' \
  --identity "$ECHO_SIGN_IDENTITY" --team "$ECHO_SIGN_TEAM" --sign

node scripts/sign-macos.mjs \
  --app 'artifacts/desktop-runtime/signed/Echo Voice.app' \
  --team "$ECHO_SIGN_TEAM" --verify
```

The output must not already exist. The source app is never changed. Before using the signing identity, the script runs the staged server's `--check-library` against an isolated library under the project's `tmp/`, with installed resource paths and an explicit synthetic fixture key. It requires a safe unlock rejection without a database being created. Debug servers accept this development-only key and therefore cannot pass the signing gate. The check has a 15-second timeout, bounded output and no real-library or OS-keyring access.

Signing failures remove only the newly created output and signing scratch. The final verifier checks each native object, the outer seal, matching team, secure timestamp, hardened runtime, exact entitlements and current runtime hashes. A successful result says **notarization not submitted**, not “production ready.”

The script's entitlement profiles are deliberately specific:

| Process | Entitlements | Basis and remaining verification |
| --- | --- | --- |
| Echo launcher and server | None | These are not sandboxed Mac App Store apps. Calendar uses the browser; camera and microphone belong to the browser extension. No hardware permission is added here. |
| Node 22.23.3 | `com.apple.security.cs.allow-jit` | This entitlement was present in the pinned upstream signature. A reduced profile must pass the script's signed JIT, WebAssembly, CPU ONNX inference and sharp smoke, then a full native Large V3 transcription before release. |
| Codex 0.160.0 | `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory` | These are the two entitlements inspected in the pinned official executable. Optional ChatGPT sign-in and notes must still be qualified after re-signing. |
| ONNX/sharp native libraries | None | Libraries run with their owning process's entitlements and are signed with the same team as Node. |

The upstream Node signature also carried debugging and broad runtime exceptions. Echo does not copy `get-task-allow`, disable library validation, permit DYLD injection or disable executable page protection. If the reduced profile fails, diagnose the failing operation before changing it; do not blanket-preserve upstream exceptions. The smoke is synthetic and does not download models, access an account or read recordings. Entitlement sufficiency for full Large V3 remains an explicit qualification gate. [Apple entitlement placement](https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac)

## Notarize and staple the app

Only after the signing identity and submission are authorized, configure an Apple notarytool keychain profile through its secure interactive flow. The example profile name below is `echo-notary`; credentials must not appear in command-line arguments, logs or repository files.

```bash
xcrun notarytool store-credentials echo-notary
```

Create a ZIP preserving the bundle, submit it, and require an **Accepted** result. If rejected, retrieve the submission log and fix the reported component; do not bypass Gatekeeper.

```bash
mkdir -p tmp/macos-notary
ditto -c -k --keepParent 'artifacts/desktop-runtime/signed/Echo Voice.app' tmp/macos-notary/echo-app.zip
xcrun notarytool submit tmp/macos-notary/echo-app.zip --keychain-profile echo-notary --wait
xcrun stapler staple 'artifacts/desktop-runtime/signed/Echo Voice.app'
xcrun stapler validate 'artifacts/desktop-runtime/signed/Echo Voice.app'
node scripts/sign-macos.mjs --app 'artifacts/desktop-runtime/signed/Echo Voice.app' --team "$ECHO_SIGN_TEAM" --verify
spctl --assess --type execute --verbose=4 'artifacts/desktop-runtime/signed/Echo Voice.app'
```

Stapling adds Apple's ticket to the app. It must not change the signed runtime files. Re-run signature and manifest verification afterward. The ZIP was created before stapling and is only a submission intermediate; distribute a fresh archive or disk image containing the stapled app. [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)

## Build the installable disk image

Use a fresh session-owned staging folder. The final disk image contains only the stapled app and an Applications shortcut:

```bash
mkdir -p tmp/macos-notary/dmg-root
ditto 'artifacts/desktop-runtime/signed/Echo Voice.app' 'tmp/macos-notary/dmg-root/Echo Voice.app'
ln -s /Applications tmp/macos-notary/dmg-root/Applications
hdiutil create -volname 'Echo Voice' -srcfolder tmp/macos-notary/dmg-root -format UDZO 'artifacts/desktop-runtime/Echo-Voice-macOS-arm64.dmg'
codesign --sign "$ECHO_SIGN_IDENTITY" --timestamp --identifier app.echovoice.desktop.disk-image 'artifacts/desktop-runtime/Echo-Voice-macOS-arm64.dmg'
xcrun notarytool submit 'artifacts/desktop-runtime/Echo-Voice-macOS-arm64.dmg' --keychain-profile echo-notary --wait
xcrun stapler staple 'artifacts/desktop-runtime/Echo-Voice-macOS-arm64.dmg'
xcrun stapler validate 'artifacts/desktop-runtime/Echo-Voice-macOS-arm64.dmg'
codesign --verify --strict --verbose=2 'artifacts/desktop-runtime/Echo-Voice-macOS-arm64.dmg'
spctl --assess --type open --context context:primary-signature --verbose=4 'artifacts/desktop-runtime/Echo-Voice-macOS-arm64.dmg'
shasum -a 256 'artifacts/desktop-runtime/Echo-Voice-macOS-arm64.dmg'
```

Record the commit, app/extension versions, OS version, signing team, submission IDs, final SHA-256 and qualification results. Keep secrets out of evidence. Remove only this session's `tmp/macos-notary` files after retaining the sanitized results. A DMG signature uses the Developer ID **Application** identity, not an Installer identity. [Apple packaging guidance](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)

Before release, test the downloaded/quarantined DMG on a clean supported Mac, GUI install/launch, OS keyring access and recovery, existing-browser pairing, recording, Turbo and Large V3, optional account flows, restart, busy quit, update and uninstall/data retention. Test on macOS 14 separately; a successful run on the development Mac's newer OS does not establish the minimum target. Public hosting and update-feed activation require the agreed release approval. Tauri updater signatures are separate from Developer ID signatures and must cover the final artifact bytes.
