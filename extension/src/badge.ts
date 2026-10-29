// Toolbar badge: REC / II while recording, ! when a saved recording needs attention, and a
// quiet dot on an enabled meeting tab that is ready to record.
import { meetingFor } from './core';
import { allRecordings } from './storage';
import { settings } from './settings';
import type { ActiveStatus } from './offscreen';
type Badge = { text: string; color: string; title: string };
const RECORDING_COLOR = '#6858d9';
const ATTENTION_COLOR = '#af3543';
const READY_COLOR = '#70707b';
// The worker may restart mid-recording; session storage keeps the last capture status.
let capture: Promise<ActiveStatus | null> | undefined;
function captureStatus(): Promise<ActiveStatus | null> {
  capture ??= chrome.storage.session
    .get('captureStatus')
    .then(({ captureStatus }) => (captureStatus as ActiveStatus | undefined) ?? null);
  return capture;
}
export async function captureChanged(active: ActiveStatus | null): Promise<void> {
  capture = Promise.resolve(active);
  await chrome.storage.session.set({ captureStatus: active });
}
async function globalBadge(): Promise<Badge> {
  const active = await captureStatus();
  if (active)
    return active.paused
      ? { text: 'II', color: RECORDING_COLOR, title: 'Echo: recording paused' }
      : { text: 'REC', color: RECORDING_COLOR, title: 'Echo: recording meeting audio' };
  const attention = (await allRecordings()).some(
    (row) =>
      !row.receipt && (row.transferState === 'attention' || row.captureState === 'interrupted'),
  );
  return attention
    ? { text: '!', color: ATTENTION_COLOR, title: 'Echo: saved recording needs attention' }
    : { text: '', color: READY_COLOR, title: 'Echo recorder' };
}
/** A tab URL is visible only with host permission, so a ready tab is an enabled meeting site. */
async function tabBadge(base: Badge, tab: chrome.tabs.Tab): Promise<Badge> {
  if (base.text) return base;
  const meeting = meetingFor(tab.url ?? '');
  if (!meeting || !(await settings()).enabledProviders.includes(meeting.provider)) return base;
  return { text: '●', color: READY_COLOR, title: 'Echo: ready to record this meeting' };
}
async function apply(badge: Badge, tabId?: number): Promise<void> {
  await Promise.all([
    chrome.action.setBadgeText({ text: badge.text, tabId }),
    chrome.action.setBadgeBackgroundColor({ color: badge.color, tabId }),
    chrome.action.setTitle({ title: badge.title, tabId }),
  ]);
}
/**
 * Render the global badge and the given tabs (default: each window's active tab). Tab values
 * override the global badge, so a tab is re-rendered whenever it becomes active.
 */
export async function renderBadge(tabs?: chrome.tabs.Tab[]): Promise<void> {
  const base = await globalBadge();
  await apply(base);
  for (const tab of tabs ?? (await chrome.tabs.query({ active: true })))
    if (tab.id !== undefined) await apply(await tabBadge(base, tab), tab.id);
}
