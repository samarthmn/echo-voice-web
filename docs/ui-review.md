# UI review — 4 October 2026

Reviewed the actual Dioxus release build in Linux Chromium at 1440px desktop and 390px mobile widths, with reduced motion enabled. Every visual finding below is based on screenshots captured and inspected during this review. Keyboard behavior was exercised in the browser; axe checks supplement the visual review. The sample meeting is illustrative and read-only.

| Step | Flow | Findings and changes | Final health |
| --- | --- | --- | --- |
| 1 | Overview, library, and navigation | Supporting text was faint and some mobile controls were small. Raised contrast and type sizes, enlarged key mobile actions, exposed active navigation/filter state, and made the mobile drawer contain focus, close with Escape, and return focus. Brand/help navigation also closes the drawer. | Passed visual, keyboard, contrast, and overflow checks. |
| 2 | Recording setup and capture | Locked setup controls while microphone permission is pending; the new-meeting shortcut cannot open a second recording. Custom dialogs contain focus and restore it on close, with a main-content fallback when their trigger disappears. | Passed real browser capture, permission-denial recovery, startup, pause/mute, and save tests. |
| 3 | Audio import | The existing chunk uploader emitted progress without showing it. Added a persistent file/progress indicator that follows navigation and clears on completion or interruption. | Passed 17 MB import with injected failure, duplicate-free retry, visible progress, and exact saved byte count. |
| 4 | Local models and Calendar | Clarified supporting copy through larger type and stronger contrast; corrected heading order. Calendar setup now has focus containment, Escape dismissal, and focus restoration. | Passed desktop/mobile UI and keyboard checks. Real model downloads and connected Google services remain unqualified here. |
| 5 | Meeting review | Evidence timestamps and Copy actions were hard to see; mobile tabs clipped Details. Improved text/targets, kept all four tabs visible, assigned a stable avatar color to each speaker, and hid unavailable Follow playback. | Passed notes/transcript/history/moments/export/delete browser flows and desktop/mobile review. |
| 6 | Settings, vocabulary, storage, and help | Improved small/light labels and controls. Opening the vocabulary editor now focuses the preferred spelling; save/cancel return focus to Add word. | Passed preference persistence, vocabulary, archive, microphone permission, and responsive-tab checks. |

## Evidence

- [Overview before](../artifacts/ui-review/01-overview-desktop-before.png) → [after](../artifacts/ui-review/overview-desktop.png); [mobile after](../artifacts/ui-review/overview-mobile.png).
- [Models desktop](../artifacts/ui-review/models-desktop.png) and [mobile](../artifacts/ui-review/models-mobile.png).
- [Calendar setup before](../artifacts/ui-review/04-calendar-dialog-before.png) → [after](../artifacts/ui-review/calendar-dialog-desktop.png); [mobile dialog](../artifacts/ui-review/calendar-dialog-mobile.png).
- [Recording setup](../artifacts/ui-review/new-meeting-desktop.png), [mobile setup](../artifacts/ui-review/new-meeting-mobile.png), and [mobile navigation](../artifacts/ui-review/navigation-mobile.png).
- [Review mobile before](../artifacts/ui-review/review-notes-mobile-before.png) → [after](../artifacts/ui-review/review-notes-mobile-after.png); [transcript after](../artifacts/ui-review/review-transcript-desktop-after.png).
- [Storage mobile before](../artifacts/ui-review/settings-storage-mobile-before.png) → [after](../artifacts/ui-review/settings-storage-mobile-after.png); [settings after](../artifacts/ui-review/settings-general-desktop-after.png).

`tests/accessibility.e2e.mjs` verifies 12 core page/dialog states with zero automated WCAG A/AA and best-practice findings in this run. It also asserts focus containment, Escape, focus restoration, skip navigation, shortcut isolation, and absence of horizontal overflow. A separate review/settings audit checked all eight tabs at both widths: 16 further states with zero automated findings, browser errors, or overflow ([recorded evidence](../artifacts/ui-review/review-settings-after-metrics.json)). These are tested outcomes, not a claim of complete accessibility certification or screen-reader/browser parity.

No live Google account, admitted meeting, or downloaded model was used in this UI review. [Verification limits](verification.md#not-externally-qualified) and [feature coverage](feature-coverage.md) still apply.

## Fresh-context follow-up after ChatGPT integration

A second reviewer received only the product brief and running app, without this conversation or the earlier review. Its [detailed report and fresh screenshots](design-review-fresh.md) cover onboarding, Models/account setup, recording setup, review, Settings, Calendar, cloud consent, and failure recovery. Five findings were fixed and rechecked: hidden mobile navigation focus, Models information order, unsaved settings lost during setup navigation, first-use priorities, and failed connection checks presented as signed out. The ChatGPT usage-limit alert also received stronger text contrast. Final combined browser verification passed; [verification details](verification.md#chatgpt-extension-and-fresh-context-design-review).
