# Install and open Echo

**Development preview:** the current branch has a desktop launcher and packaging tools, but no signed, qualified download or store listing has been published. This guide is the candidate user path. Use only a build supplied for testing until the [release record](production-readiness-status.md) identifies a qualified artifact.

## Desktop app

The initial targets are Apple Silicon macOS 14+ and Ubuntu 24.04 x64. Other systems need separate qualification.

For a signed Mac release, open its `.dmg`, copy **Echo Voice** into Applications and open it. For an Ubuntu release, open the supplied `.deb` with the software installer and install it, then launch **Echo Voice** from Applications. Do not disable OS security protections to install an unknown build. Developer test builds and signing instructions belong in the [developer guide](development.md).

In Echo Voice, choose your existing Brave or Chrome browser and select **Open Echo**. Use the browser profile where you will install the extension. The launcher starts and manages the local app; its bundled runtime provides the native Large V3 engine without requiring a separate Node.js installation. Models are downloaded deliberately inside Echo, and Ollama remains optional.

A busy local address, locked library or missing browser produces an action in the launcher. Use **Retry** after resolving it. Run only one app against a library. Closing the workspace tab and quitting the local app are different actions: choose **Quit Echo** in the launcher to stop it. Echo warns about active processing or capture before quitting.

## First use

1. Save the library recovery phrase in **Settings → Storage**.
2. Try the [short in-person recording](../README.md#record-your-first-conversation), then play it back.
3. Follow **First transcript** on Overview. It checks whether the selected speech model is downloaded and links to model setup or your saved recording. Download the model deliberately, then create the transcript.
4. For online calls, [install and set up the extension](browser-extension.md). It records from the existing meeting tab; it needs its own saved recovery phrase.

Google Calendar and notes providers can be connected later. They are not prerequisites for recording.

## Existing library

Keep a backup and stop the old Echo app first. In the launcher expand **Library and recovery**, then choose **Copy existing library…** and select the old data folder. Echo verifies a separate copy before selecting it. Keep the original until meetings, audio and saved versions work. A locked protected copy requires its OS key or recovery phrase; see [recovery](storage-and-recovery.md).

## Updates

Back up first, finish active recordings and synchronize or export pending browser audio. The launcher's **Check for updates** enables installation only when its build has an approved signing key and a qualified update feed. Development builds do not silently accept unsigned updates. The Ubuntu path directs you to a matching verified package; clean-machine update testing remains pending.

Extension updates are delivered separately. Reloading an unpacked extension can interrupt capture. Moving from its development identity to a store identity creates a different browser installation: finish transfers or exports, install and pair the new extension, and verify the destination before removing the old one.

Before a qualified macOS in-app update replaces the application, Echo verifies a separate encrypted library snapshot. A failed snapshot stops the update. See [update recovery](update-recovery.md) for its location and how to restore it deliberately. Ubuntu's manual package update still requires the separate backup described above.

## Remove Echo

Quit Echo and finish/export pending browser recordings first. Removing the desktop application should leave its separately stored library intact; verify data-retention behavior on the qualified installer. Deleting the library itself or its browser profile is a separate irreversible operation. Uninstalling the extension can delete pending audio even if a recovery phrase has been saved.

## No installer available?

Developers can [build from source](development.md#build-and-start). GitHub's **Code → Download ZIP** supplies source, not an application. Nontechnical users should wait for a qualified download rather than installing a toolchain just to record a meeting.
