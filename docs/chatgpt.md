# Optional ChatGPT notes

Echo Voice can use a connected ChatGPT account to draft meeting notes through the official Codex helper. Ollama remains the default notes provider. Recording, saved audio, and speech recognition remain local whether or not you connect an account.

This connection uses an eligible plan’s **Codex allowance**. It does not use OpenAI API credits, expose a general ChatGPT token pool, or make every ChatGPT model available to Echo. Account eligibility, model access, and usage limits are determined by OpenAI. Echo does not ask you to paste an API key or a ChatGPT session token.

## Connect your account

1. Open **Models → ChatGPT** in Echo Voice.
2. Check the helper status. If the helper is missing, use the setup instructions below.
3. Choose **Sign in** and complete the official OpenAI sign-in flow in your browser. Echo does not sign in automatically or reuse another app’s saved login.
4. Return to Echo and check that your account is connected. Choose an available model, or keep the account default.
5. Choose **ChatGPT · Optional cloud** under **Settings → General → Default notes provider**, then save.
6. Open a meeting and request notes. Review the disclosure and confirm that this meeting’s transcript can be sent to OpenAI.

Connecting an account, selecting a model, and saving your provider preference do not send a meeting transcript or start generation. You can continue recording and transcribing without finishing any of these steps.

## What is sent and stored

When you request ChatGPT notes, Echo sends the meeting’s active transcript, including speaker labels and spoken text, together with the instructions needed to produce notes. This is the active transcript, not only highlighted passages. Audio is not uploaded for notes or cloud transcription. Review the meeting before sending it.

The returned notes are saved in the local meeting record with their provider and model information. Earlier notes and transcript versions remain available if a later request fails. Generated notes are drafts; verify decisions and action items against the transcript and audio.

The helper manages its own sign-in state in `<ECHO_DATA_DIR>/chatgpt/`, normally `.echo-data/chatgpt/`. Echo gives it a separate working directory and does not read an existing login from another Codex installation. Treat this folder as private account data. Supported library exports exclude sign-in credentials; copying the entire data directory is a different operation and can include them.

Moving a supported library archive to another computer does not connect that computer to your account. Sign in there separately. Existing notes remain readable without a connected account.

## Local helper setup

The integration targets **Codex CLI 0.160.0**, supplied by the official `@openai/codex@0.160.0` package. The helper’s app-server protocol is version sensitive, including experimental surfaces; Echo rejects an incompatible helper version instead of guessing how to communicate with it.

Source builds include this package as an optional dependency. Whether a native helper is present depends on the installed platform package and package-manager options. Check **Models → ChatGPT** for the actual status. A release archive must explicitly include a compatible platform helper to work without a separate install; do not assume every release or platform does.

Echo looks for the executable in this order:

1. `codexBinary` in `echo.config.json` (or the developer `ECHO_CODEX_BIN` shell override).
2. The application’s `tools/codex/codex` helper.
3. The native executable in an installed official Codex platform package.
4. A `codex` executable on `PATH`.

To install the pinned official package separately:

```sh
npm install --global @openai/codex@0.160.0
codex --version
```

The expected version is `codex-cli 0.160.0`. A native executable is recommended. An executable package wrapper is also version checked. If Echo cannot locate your installation, set `codexBinary` in `echo.config.json` to its absolute executable path, then restart Echo. This public setting does not belong in `.env`.

Use Echo’s **Sign in** action after starting the server. Running a separate `codex login` with its ordinary home directory does not populate Echo’s private sign-in directory.

## Defaults and recovery

`notesProvider` is `ollama` by default; `chatgpt` is the explicit optional choice. Older settings and library archives that omit this preference retain local notes behavior. `chatgptModel` defaults to an empty string, meaning the account default from the helper’s available model catalog. Ollama’s `notesModel` and loopback connection remain separate and are preserved when changing providers.

If the helper cannot confirm included usage, generation stops before sending the transcript; Echo does not infer allowance from percentages or reset times. If sign-in expires, reconnect in **Models → ChatGPT**. If your account is ineligible, a model is unavailable, or your plan allowance is exhausted, use the explanation shown by Echo and check your account’s Codex access. Choosing ChatGPT does not authorize an automatic switch to a different provider. You can select Ollama yourself and retry locally; existing notes remain available.

The connection is optional. A missing helper, failed sign-in, or unavailable cloud service does not prevent local audio recording, local transcription, replay, editing, or exports.

## Verification boundary and official references

Automated checks can validate provider selection, the local helper protocol, failure handling, privacy boundaries, and UI behavior without a real account. Those checks are not live qualification of account eligibility, OAuth completion, cloud model access, plan usage, or successful cloud generation. Complete those steps with your own account before relying on the optional integration.

The implementation uses the official CLI app-server bridge from Rust. It does not claim to provide a general ChatGPT API. The official TypeScript SDK is another documented way to embed the same Codex CLI; Echo does not require that SDK at runtime.

- [Official Codex README and ChatGPT-plan sign-in](https://github.com/openai/codex/blob/main/README.md#using-codex-with-your-chatgpt-plan)
- [Codex in ChatGPT plans](https://help.openai.com/en/articles/11369540-codex-in-chatgpt)
- [Official Codex TypeScript SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md)
- [Official Codex app-server documentation](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

Upstream documentation describes the current upstream release. Echo’s compatibility target remains the pinned helper version listed above until its protocol is deliberately updated and verified.
