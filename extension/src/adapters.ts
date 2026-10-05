import {Provider} from './core';
export type MeetingState = 'unmuted' | 'muted' | 'prejoin' | 'ended' | 'unknown';
const labels: Record<Provider,{on: RegExp; off: RegExp}> = {
  meet: {on:/^turn off microphone(?:\s*\([^)]+\))?$/i,off:/^turn on microphone(?:\s*\([^)]+\))?$/i},
  zoom: {on:/^(?:mute(?: my audio)?|mute audio)(?:\s*\([^)]+\))?$/i,off:/^(?:unmute(?: my audio)?|unmute audio)(?:\s*\([^)]+\))?$/i},
  teams: {on:/^(?:mute|mute mic|mute microphone)(?:\s*\([^)]+\))?$/i,off:/^(?:unmute|unmute mic|unmute microphone)(?:\s*\([^)]+\))?$/i},
};
export function stateFromLabels(provider: Provider, controls: string[], texts: string[], visible = true): MeetingState {
  if(!visible || !labels[provider]) return 'unknown';
  if(texts.some(text => /^(?:you left the meeting|you have left the meeting|the meeting has ended|this meeting has ended|you have been removed from the meeting|you've been removed from the meeting|you have been disconnected)$/i.test(text.trim()))) return 'ended';
  if(texts.some(text => /^(?:join now|ask to join|join meeting|join audio|join computer audio|join with computer audio)$/i.test(text.trim()))) return 'prejoin';
  const states = controls.map(label => labels[provider].on.test(label.trim()) ? 'unmuted' : labels[provider].off.test(label.trim()) ? 'muted' : null).filter(Boolean);
  // Multiple or conflicting controls are ambiguous. Never infer from a page's default state.
  return states.length === 1 ? states[0] as MeetingState : 'unknown';
}
export function observeDocument(provider: Provider, doc: Document): MeetingState {
  const visible = (element: Element) => { const box = element.getBoundingClientRect(); const style = getComputedStyle(element); return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'; };
  const controls: string[] = []; const texts: string[] = [];
  for(const element of doc.querySelectorAll('button,[role="button"]')) {
    if(!visible(element)) continue;
    texts.push((element.textContent ?? '').trim());
    // aria-label wins over title; duplicate labels on one button must not manufacture two controls.
    controls.push(element.getAttribute('aria-label') || element.getAttribute('title') || (element.textContent ?? '').trim());
  }
  for(const element of doc.querySelectorAll('[role="alert"],h1,h2')) if(visible(element)) texts.push((element.textContent ?? '').trim());
  return stateFromLabels(provider,controls,texts,true);
}
