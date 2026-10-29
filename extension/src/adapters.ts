import { Provider } from './core';
export type MeetingState = 'unmuted' | 'muted' | 'prejoin' | 'ended' | 'unknown';
type MicState = 'unmuted' | 'muted';
/** One candidate microphone control: its label and any language-independent state attribute. */
export type MicControl = { label: string; toggle?: MicState | null };
// English labels: the fallback when a provider exposes no language-independent state.
const labels: Record<Provider, { on: RegExp; off: RegExp }> = {
  meet: {
    on: /^turn off microphone(?:\s*\([^)]+\))?$/i,
    off: /^turn on microphone(?:\s*\([^)]+\))?$/i,
  },
  zoom: {
    on: /^(?:mute(?: my audio)?|mute audio)(?:\s*\([^)]+\))?$/i,
    off: /^(?:unmute(?: my audio)?|unmute audio)(?:\s*\([^)]+\))?$/i,
  },
  teams: {
    on: /^(?:mute|mute mic|mute microphone)(?:\s*\([^)]+\))?$/i,
    off: /^(?:unmute|unmute mic|unmute microphone)(?:\s*\([^)]+\))?$/i,
  },
};
const ENDED =
  /^(?:you left the meeting|you have left the meeting|the meeting has ended|this meeting has ended|you have been removed from the meeting|you've been removed from the meeting|you have been disconnected)$/i;
const PREJOIN =
  /^(?:join now|ask to join|join meeting|join audio|join computer audio|join with computer audio)$/i;
// Meet marks its microphone and camera toggles with data-is-muted. Only the microphone's
// label ends with its keyboard shortcut, "(⌘ + d)" or "(Ctrl + D)", in every interface language.
const MEET_MIC_SHORTCUT = /\+\s*d\s*\)\s*$/i;
function meetToggle(element: Element): MicState | null {
  const muted = element.getAttribute('data-is-muted');
  const label = element.getAttribute('aria-label') || element.getAttribute('data-tooltip') || '';
  if (!MEET_MIC_SHORTCUT.test(label)) return null;
  return muted === 'true' ? 'muted' : muted === 'false' ? 'unmuted' : null;
}
// Teams names its microphone button by id or data-tid and its state by data-state.
function teamsToggle(element: Element): MicState | null {
  const named = [element.id, element.getAttribute('data-tid')].includes('microphone-button');
  const state = named ? element.getAttribute('data-state') : null;
  return state === 'mic-off' ? 'muted' : state === 'mic' || state === 'mic-on' ? 'unmuted' : null;
}
// aria-pressed is not read: whether "pressed" means muted or live differs between toolbars,
// and a wrong guess would record a muted participant. Zoom exposes only its English labels.
const toggles: Record<Provider, (element: Element) => MicState | null> = {
  meet: meetToggle,
  zoom: () => null,
  teams: teamsToggle,
};
// Call toolbars, where a provider has one. The whole document is scanned otherwise.
const TOOLBARS: Record<Provider, string> = {
  meet: '[role="toolbar"],footer',
  zoom: '#wc-footer,[role="toolbar"],footer',
  teams: '[data-tid="call-controls"],#calling-controls,[role="toolbar"]',
};
function labelState(provider: Provider, label: string): MicState | null {
  const text = label.trim();
  return labels[provider].on.test(text)
    ? 'unmuted'
    : labels[provider].off.test(text)
      ? 'muted'
      : null;
}
/** A control's microphone state. A language-independent attribute that contradicts its label is ambiguous. */
function controlState(provider: Provider, control: MicControl): MicState | 'conflict' | null {
  const fromLabel = labelState(provider, control.label);
  if (control.toggle && fromLabel && control.toggle !== fromLabel) return 'conflict';
  return control.toggle ?? fromLabel;
}
export function stateFromControls(
  provider: Provider,
  controls: MicControl[],
  texts: string[],
): MeetingState {
  if (!labels[provider]) return 'unknown';
  if (texts.some((text) => ENDED.test(text.trim()))) return 'ended';
  if (texts.some((text) => PREJOIN.test(text.trim()))) return 'prejoin';
  const states = controls
    .map((control) => controlState(provider, control))
    .filter((state) => state !== null);
  // Multiple or conflicting controls are ambiguous. Never infer from a page's default state.
  return states.length === 1 && states[0] !== 'conflict' ? states[0] : 'unknown';
}
export function stateFromLabels(
  provider: Provider,
  controls: string[],
  texts: string[],
  visible = true,
): MeetingState {
  if (!visible) return 'unknown';
  return stateFromControls(
    provider,
    controls.map((label) => ({ label })),
    texts,
  );
}
// Layout reads are the expensive part of a scan. Only candidate controls are measured, and a
// measurement is reused for a short while: a stale entry can only add an ambiguous control.
const LAYOUT_TTL_MS = 1000;
const layout = new WeakMap<Element, { at: number; visible: boolean }>();
function visible(element: Element, now: number): boolean {
  const cached = layout.get(element);
  if (cached && now - cached.at < LAYOUT_TTL_MS) return cached.visible;
  const box = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const shown =
    box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  layout.set(element, { at: now, visible: shown });
  return shown;
}
function micControls(provider: Provider, doc: Document, now: number): MicControl[] {
  const toolbars = [...doc.querySelectorAll(TOOLBARS[provider])];
  const roots: ParentNode[] = toolbars.length ? toolbars : [doc];
  const seen = new Set<Element>();
  const controls: MicControl[] = [];
  for (const root of roots)
    for (const element of root.querySelectorAll('button,[role="button"]')) {
      if (seen.has(element)) continue;
      seen.add(element);
      // aria-label wins over title; duplicate labels on one button must not manufacture two controls.
      const control = {
        label:
          element.getAttribute('aria-label') ||
          element.getAttribute('title') ||
          (element.textContent ?? '').trim(),
        toggle: toggles[provider](element),
      };
      if (controlState(provider, control) !== null && visible(element, now)) controls.push(control);
    }
  return controls;
}
function statusTexts(doc: Document, now: number): string[] {
  const texts: string[] = [];
  for (const element of doc.querySelectorAll('[role="alert"],h1,h2,button,[role="button"]')) {
    const text = (element.textContent ?? '').trim();
    if ((ENDED.test(text) || PREJOIN.test(text)) && visible(element, now)) texts.push(text);
  }
  return texts;
}
export function observeDocument(provider: Provider, doc: Document, now = Date.now()): MeetingState {
  return stateFromControls(provider, micControls(provider, doc, now), statusTexts(doc, now));
}
