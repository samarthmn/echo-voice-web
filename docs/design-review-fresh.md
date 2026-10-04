# Echo Voice — fresh design review

Reviewed on 4 October 2026 by a separate reviewer given only the product brief, the running URL, and permission to use disposable fixtures. Previous audit reports, screenshots, and recommendations were not used as evidence.

The interface has a coherent visual identity and a useful evidence-first meeting review experience. The largest weaknesses were in navigation and state transitions: optional cloud setup obscured local setup, the closed mobile drawer accepted keyboard focus, and the account setup route discarded settings edits. Five concrete findings were sent to the implementation agent during review. All five received changes; the relevant outcomes were independently rechecked below.

## Scope and method

- Actual application at `http://127.0.0.1:3013`, with disposable data in `/tmp/echo-fresh-design-20261004`.
- Chromium through Playwright, desktop 1440 × 1000 and mobile 390 × 844, reduced motion enabled. The in-app Browser capability was unavailable; the supplied Playwright fallback was used.
- Fresh DOM snapshots before targeted actions, screenshots saved and opened with `view_image` before accepting them as evidence, selected keyboard interactions, measured bounds, and automated axe checks.
- The explicit sample meeting and one newly created transcript fixture were used. Account, model catalog, and usage values were mocked. ChatGPT authentication/model requests and external browser requests were blocked. No real sign-in, model download, transcription, or paid generation occurred.
- Product Design audit, index, browser guidance, and audit framework were read. The referenced shared critical-overrides resource was unavailable through the skill reader. Saved-context setup did not block the authorized review.
- This review targeted usability and accessibility risks, not full WCAG certification. Root changes arrived during the session; baseline and recheck screenshots are deliberately identified separately.

## Prioritized findings and verified outcomes

### 1. P1 — The closed mobile drawer captured invisible keyboard focus

**Evidence:** Step 4, screenshot 08. At 390px, starting after “Skip to content”, Tab visited the logo, Overview, All meetings, Calendar, Local models, privacy, Settings, and Setup & help while the drawer was visually closed. The logo/navigation bounds started at x = −225; their right edge was −21. The closed drawer also remained in the accessibility tree. Screenshot 08 shows the visible page without a corresponding visible focus target; the measured focus sequence establishes the behavior that an image alone cannot prove.

**Impact:** A keyboard user encounters eight apparently dead steps before reaching visible controls. Assistive technology exposes navigation that sighted users cannot see. This conflicts with predictable focus order and visible focus expectations (WCAG 2.4.3/2.4.7).

**Recommendation:** Hide the closed drawer from rendering and accessibility at mobile sizes, restore visibility when opened, and retain the existing focus containment and Escape behavior.

**Recheck — resolved:** Screenshot 25. On a fresh mobile load, Tab now moves from Skip to content directly to Open navigation, with a clear focus ring. The closed sidebar is absent from the fresh accessibility snapshot. Opening the drawer still exposes its navigation, and selecting Settings closes it.

### 2. P2 — “Local models” concealed the optional account area and prioritized it over local setup

**Evidence:** Step 2, screenshots 03–05. The navigation label was “Local models”, while the first and largest panel was “Bring your ChatGPT plan.” In the missing-helper state, the ChatGPT panel occupied y ≈ 231–712 on desktop, and local model cards began near y = 943. Even with the helper installed, the first Download model button was below the initial 1000px viewport. Mobile began with a long ChatGPT panel, leaving speech setup well below the fold.

**Impact:** People seeking cloud account controls have an unlikely navigation label to choose. People following onboarding to install a speech model first encounter optional sign-in. The strongest visual invitation contradicts the local-by-default product promise.

**Recommendation:** Use a neutral Models label and matching title; expose Speech models, Local notes, and ChatGPT as clear section destinations; put speech setup first while retaining direct access to the account section.

**Recheck — resolved:** Screenshots 21–23. The page is now “Models” / “Your models. Your choice.” Section links are visible at the top. Local speech cards precede local notes and ChatGPT. The ChatGPT link reaches the account panel; the connected account, model selector, and allowance remain readable at 390px. Document width measured 390px, with no horizontal overflow. The mobile Models axe scan returned zero violations for the selected tags.

### 3. P2 — The Settings account-setup route silently discarded the user's draft

**Evidence:** Step 6, screenshots 13–14 and the live roundtrip. Choosing ChatGPT revealed “Set up ChatGPT.” Clicking it, then returning to Settings, reset the provider to Ollama. Ordinary navigation similarly lost unsaved edits. The Save changes action was also below a roughly 1900px mobile form.

**Impact:** The interface invites a setup action that erases the choice prompting that action. A user can successfully connect an account and return uncertain why the provider preference changed. The remote Save action makes this easier to miss.

**Recommendation:** Preserve the settings draft through account setup and navigation; make saving explicit. Keep Save and Discard visible while changes are pending.

**Recheck — resolved within the session:** Screenshots 26–27. “Alex review draft” and ChatGPT both survived the Set up ChatGPT → Settings roundtrip. Reading persisted settings still returned Ollama, confirming that navigation did not silently save the cloud preference. The sticky action bar shows both Save changes and Discard changes in the mobile viewport. Discard reset the name and provider to their saved values. Draft survival through a full browser reload is not claimed.

### 4. P2 — First-use setup competed with marketing, zero statistics, and the sample empty state

**Evidence:** Step 1, screenshots 01–02. The overview had a greeting, a large promotional hero, three capture entry points, zero-value statistics, an empty recent-meetings panel, and then setup. On mobile, setup began around y = 1340. “Connect your calendar” appeared as the third numbered setup step without an immediate optional qualifier.

**Impact:** First-time users see several ways to begin but less help distinguishing what is required now. Zero statistics provide little guidance before the first meeting. The visual ordering implies a longer prerequisite sequence than the product actually requires.

**Recommendation:** Remove zero statistics for the empty library, move setup before the sample state, and explicitly say that recording works immediately while transcription and calendar connection can follow.

**Recheck — improved:** Screenshots 28–29. The empty overview hides statistics, presents setup before the sample, and says “Record right away. Set up transcription and connections when you need them.” Calendar is explicitly optional. Mobile setup now follows the capture cards at roughly y = 790. The hero remains spacious; further condensation is a low-priority option, not a blocker.

### 5. P2 — A failed account check was presented as a confirmed disconnection

**Evidence:** Step 9, screenshot 20. With a mocked 503 account-status response, the provider area simultaneously said “ChatGPT is not connected” and “Could not check your ChatGPT connection. Try again.” It offered “Connect in Models”, without a nearby retry control.

**Impact:** A transient status failure appears to require signing in again. The interface conflates unknown state with a known disconnected state and sends the user away from the meeting unnecessarily.

**Recommendation:** Display “Connection status unavailable” and a local Retry action; reserve disconnected language for a successful status response that confirms disconnection.

**Recheck — resolved:** Screenshot 30. The provider area now says “Connection status unavailable” with “Retry connection”. After restoring the mocked successful response, Retry recovered to the account identity `alex@example.test` in place. No model request was made.

## Strengths to preserve

- **A consistent visual language.** Lavender surfaces, thin borders, rounded cards, muted secondary text, and line icons are used consistently across overview, settings, models, calendar, and review. Primary actions remain easy to spot. The design feels appropriate for a quiet personal workspace.
- **A useful recording dialog.** Screenshots 06–07 show a named input with visible focus, separate microphone access testing, explicit participant permission, and a clear disabled Start action until consent. The full dialog fits 390 × 844. The copy explains local capture, post-recording transcription, keeping the tab open, and recording before model setup.
- **Evidence is close to the notes it supports.** Screenshots 09–11 use timestamp chips beside summaries, decisions, and actions. Owners, due dates, section counts, and reviewable AI-draft labeling help turn output into something a user can check.
- **Cloud consent is specific and timely.** Screenshots 18–19 identify the recipient (OpenAI), payload (spoken text and speaker labels), excluded audio, local storage of resulting notes, the connected account, and plan allowance. The primary action names ChatGPT. The native modal focuses Cancel initially; Escape closes it and restores Generate meeting notes focus. The 358 × 542px mobile dialog fits entirely within the tested viewport. An axe scan returned zero violations in this modal state.
- **Account usage avoids implying unlimited access.** Screenshots 21–23 distinguish the model selector, plan, shared Codex allowance, reset windows, and per-note tokens from a remaining balance. The mocked usage was clearly readable on mobile.
- **Import failure gives a concrete next step.** Screenshot 24 reports that the supplied fixture lacks a supported audio header and lists accepted formats. The failed import did not add a meeting. The message is a dismissible status notification.
- **Calendar boundaries are explained.** Screenshot 15 distinguishes read-only calendar connection from the optional local runner, names Google Meet support, and describes host admission. No calendar account or live meeting was used.

## Remaining polish opportunities

These are lower priority than the five corrected findings and do not establish broken functionality.

1. **Make dense secondary copy easier to scan.** Small technical labels and repeated explanatory paragraphs make Settings and the account panel long on mobile (14, 22, 26). Keep the payload/recipient/consent language visible, but consider grouping supplementary helper, account, and storage details under concise expandable explanations. Verify any smaller type and contrast with real users and zoom, rather than reducing size further.
2. **Use more direct destination language in the local-notes empty state.** Screenshot 16 says to configure Ollama in Settings, but the guidance is plain text. A Setup local notes action near Generate would shorten the path for someone without a local service. The current hint is truthful; no successful local generation was tested here.
3. **Keep frequently used work close to the top once the library grows.** The polished hero is large even when a meeting exists (24). A more compact returning-user overview could prioritize recent meetings and ongoing work. This is an opportunity supported by the current layout, not a demonstrated multi-meeting usability failure.
4. **Refine human-readable metadata.** Review uses numeric dates with seconds and raw-looking status labels in library cards (09, 16, 24). Friendly dates/times and consistent sentence-case status labels would improve polish without changing the workflow.

## Numbered flow and health

| Step | Flow reviewed | Health after recheck | Screenshot evidence |
|---|---|---|---|
| 1 | Empty overview and getting started, desktop/mobile | Improved; setup is earlier and optional connections are clearer | 01–02 baseline; 28–29 revised |
| 2 | Model setup, missing helper, sign-in entry | Improved; correct naming and task order | 03–05 baseline; 21–22 revised |
| 3 | New meeting dialog, desktop/mobile | Good in inspected pre-recording state | 06–07 |
| 4 | Closed mobile drawer and keyboard traversal | Corrected; visible focus order restored | 08 baseline; 25 revised |
| 5 | Sample notes and transcript, desktop/mobile | Good reading hierarchy and evidence affordances | 09–11 |
| 6 | General Settings, provider choice, account setup roundtrip | Corrected; draft retained and actions visible | 12–14 baseline; 26–27 revised |
| 7 | Disconnected Calendar | Good explanation of connection and runner requirements | 15 |
| 8 | First notes, local/cloud provider choice, disconnected account | Clear privacy choice; local setup shortcut remains an opportunity | 16–17 |
| 9 | Cloud consent and account check failure/retry | Strong consent; error-state ambiguity corrected | 18–20 baseline; 30 revised |
| 10 | Connected account, model choice, and usage | Good with mocked account data; readable on mobile | 21–23 |
| 11 | Invalid audio import | Good actionable validation message | 24 |

## Accessibility checks and evidence limits

The saved `consent-axe.json`, `models-mobile-axe.json`, and `overview-desktop-axe.json` contain empty violation arrays for WCAG 2 A/AA, WCAG 2.1 AA, WCAG 2.2 AA, and best-practice tags in those captured states. This supports those narrow checks; it is not a full accessibility claim. Keyboard testing found the mobile drawer defect that a screenshot or automated scan alone would not establish.

No screen-reader session, 200–400% zoom test, real mobile OS keyboard, browser microphone-permission prompt, sustained recording, long transcript, successful model inference, authenticated calendar, live runner, offline restart, or actual OpenAI account interaction was exercised. Initial loading was observed through DOM updates but not benchmarked or exhaustively captured. Fixture generation and usage values establish presentation behavior only. The absence of a real model service means transcription quality, latency, and generated-note accuracy remain outside this review.

Screenshots are full-page unless the filename says `viewport` or the captured document fits one viewport. Fixed overlays in full-page captures cover the actual viewport, so unblurred content below that viewport is a screenshot property, not evidence of a modal backdrop defect. Screenshot 09 retains the page's current scroll position for fixed sidebar placement; the content and responsive review layout are the intended evidence.

## Screenshot gallery

Every image below was saved in this review and opened for visual inspection. Baseline images remain unchanged so the findings are reviewable alongside the updated states.

### Baseline: first-use desktop

![Baseline: first-use desktop](../artifacts/design-review-fresh/01-onboarding-desktop.png)

### Baseline: first-use mobile

![Baseline: first-use mobile](../artifacts/design-review-fresh/02-onboarding-mobile.png)

### Baseline: models with helper unavailable fixture

![Baseline: models with helper unavailable fixture](../artifacts/design-review-fresh/03-models-desktop.png)

### Baseline: models with sign-in available fixture

![Baseline: models with sign-in available fixture](../artifacts/design-review-fresh/04-models-signin-desktop.png)

### Baseline: models mobile

![Baseline: models mobile](../artifacts/design-review-fresh/05-models-mobile.png)

### New meeting dialog desktop

![New meeting dialog desktop](../artifacts/design-review-fresh/06-new-meeting-desktop.png)

### New meeting dialog mobile

![New meeting dialog mobile](../artifacts/design-review-fresh/07-new-meeting-mobile.png)

### Baseline: invisible mobile focus; see measured sequence

![Baseline: invisible mobile focus; see measured sequence](../artifacts/design-review-fresh/08-mobile-hidden-navigation-focus.png)

### Sample meeting notes desktop

![Sample meeting notes desktop](../artifacts/design-review-fresh/09-sample-review-desktop.png)

### Sample meeting notes mobile

![Sample meeting notes mobile](../artifacts/design-review-fresh/10-sample-review-mobile.png)

### Sample transcript mobile

![Sample transcript mobile](../artifacts/design-review-fresh/11-transcript-mobile.png)

### General settings desktop

![General settings desktop](../artifacts/design-review-fresh/12-settings-desktop.png)

### Baseline: unsaved ChatGPT preference desktop

![Baseline: unsaved ChatGPT preference desktop](../artifacts/design-review-fresh/13-settings-chatgpt-desktop.png)

### Baseline: unsaved ChatGPT preference mobile

![Baseline: unsaved ChatGPT preference mobile](../artifacts/design-review-fresh/14-settings-mobile.png)

### Disconnected calendar desktop

![Disconnected calendar desktop](../artifacts/design-review-fresh/15-calendar-desktop.png)

### First local notes state

![First local notes state](../artifacts/design-review-fresh/16-notes-empty-desktop.png)

### Disconnected account in meeting review

![Disconnected account in meeting review](../artifacts/design-review-fresh/17-chatgpt-disconnected-desktop.png)

### Cloud consent desktop

![Cloud consent desktop](../artifacts/design-review-fresh/18-cloud-consent-desktop.png)

### Cloud consent mobile

![Cloud consent mobile](../artifacts/design-review-fresh/19-cloud-consent-mobile.png)

### Baseline: failed connection check

![Baseline: failed connection check](../artifacts/design-review-fresh/20-account-error-mobile.png)

### Recheck: model hierarchy and connected account

![Recheck: model hierarchy and connected account](../artifacts/design-review-fresh/21-models-revised-desktop.png)

### Recheck: mobile model hierarchy

![Recheck: mobile model hierarchy](../artifacts/design-review-fresh/22-models-revised-mobile.png)

### Connected account and usage in mobile viewport

![Connected account and usage in mobile viewport](../artifacts/design-review-fresh/23-chatgpt-account-mobile-viewport.png)

### Invalid audio import validation

![Invalid audio import validation](../artifacts/design-review-fresh/24-import-validation-desktop.png)

### Recheck: visible navigation focus

![Recheck: visible navigation focus](../artifacts/design-review-fresh/25-mobile-keyboard-recheck.png)

### Recheck: preserved settings draft

![Recheck: preserved settings draft](../artifacts/design-review-fresh/26-settings-draft-recheck-mobile.png)

### Recheck: visible Save and Discard actions

![Recheck: visible Save and Discard actions](../artifacts/design-review-fresh/27-settings-savebar-viewport.png)

### Recheck: mobile first-use hierarchy

![Recheck: mobile first-use hierarchy](../artifacts/design-review-fresh/28-onboarding-revised-mobile.png)

### Recheck: desktop first-use hierarchy

![Recheck: desktop first-use hierarchy](../artifacts/design-review-fresh/29-onboarding-revised-desktop.png)

### Recheck: unknown connection state and retry

![Recheck: unknown connection state and retry](../artifacts/design-review-fresh/30-account-error-recheck-mobile.png)
