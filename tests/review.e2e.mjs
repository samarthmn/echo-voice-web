/**
 * Real REST + Dioxus review checks, using an isolated running server.
 * ECHO_DATA_DIR=/tmp/echo-review-data ECHO_BIND=127.0.0.1:3013 target/debug/echo-server
 * ECHO_TEST_URL=http://127.0.0.1:3013 node tests/review.e2e.mjs
 * Build current WASM/assets first. This test creates and removes only its own fixture.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

const base = process.env.ECHO_TEST_URL || 'http://127.0.0.1:3013';
const artifacts = process.env.ECHO_TEST_ARTIFACTS || '/tmp/echo-review-e2e';
const request = async (path, method = 'GET', body) => {
  const response = await fetch(`${base}/api${path}`, { method, headers: body instanceof FormData ? undefined : body ? { 'Content-Type': 'application/json' } : undefined, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  assert.equal(response.ok, true, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
};
const wav = seconds => {
  const samples = seconds * 16000;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(Math.sin(index / 16000 * Math.PI * 440) * 1200), 44 + index * 2);
  return bytes;
};

await mkdir(artifacts, { recursive: true });
const meetingTitle = `Review verification ${Date.now()}`;
let meeting;
let browser;
let page;
const pageErrors = [];
const consoleErrors = [];
try {
  meeting = await request('/meetings', 'POST', { title: meetingTitle, mode: 'import', consent: true });
  const form = new FormData();
  form.append('file', new Blob([wav(70)], { type: 'audio/wav' }), 'review-fixture.wav');
  form.append('trackId', 'review-fixture-track'); form.append('sequence', '0'); form.append('mimeType', 'audio/wav'); form.append('label', 'Original test recording');
  await request(`/meetings/${meeting.id}/audio`, 'POST', form);
  await request(`/meetings/${meeting.id}`, 'PATCH', { duration: 70, status: 'saved' });
  const passages = Array.from({ length: 65 }, (_, index) => ({ id: `review-p${index + 1}`, start: index, end: index + 1, speaker: index % 2 ? 'Speaker 2' : 'Speaker 1', text: index === 0 ? 'Project Aurora has old wording to correct.' : index === 64 ? 'The final evidence appears after the initial transcript section.' : `Review passage ${index + 1}: the team discussed the release plan.` }));
  meeting = await request(`/meetings/${meeting.id}/transcripts`, 'POST', { model: 'test-fixture', passages, vocabulary: [], label: 'Original fixture transcript' });
  const originalTranscript = meeting.activeTranscriptId;
  meeting = await request(`/meetings/${meeting.id}/notes`, 'POST', { model: 'test-fixture', transcriptVersionId: originalTranscript, summary: [{ id: 'summary-review', text: 'The release plan is ready for review.', passageIds: ['review-p65'] }], decisions: [{ id: 'decision-review', text: 'Review the release plan together.', passageIds: ['review-p2'] }], actions: [{ id: 'action-review', text: 'Prepare the rollout checklist.', owner: 'Speaker 1', dueDate: '2026-10-09', passageIds: ['review-p3'] }] });

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(base, { waitUntil: 'networkidle' });
  await expect(page.getByRole('heading', { name: 'Good conversations start here.' })).toBeVisible();
  await page.getByRole('button', { name: new RegExp(meetingTitle) }).first().click();
  await expect(page.getByRole('heading', { name: meetingTitle, exact: true })).toBeVisible();
  await expect(page.locator('.review-tab[aria-current="page"]')).toHaveText('Notes');
  await expect(page.getByRole('combobox', { name: 'Playback speed' })).toHaveValue('1');
  await page.screenshot({ path: `${artifacts}/notes-desktop.png`, fullPage: true });
  await page.locator('.review-tab').filter({ hasText: 'Transcript' }).click();
  const speakerColors = await page.locator('.review-passage').evaluateAll(passages => {
    const colors = {};
    for (const passage of passages) {
      const speaker = passage.querySelector('.review-speaker').textContent.trim();
      (colors[speaker] ||= []).push(getComputedStyle(passage.querySelector('.review-speaker-avatar')).backgroundColor);
    }
    return colors;
  });
  for (const [speaker, colors] of Object.entries(speakerColors)) assert.equal(new Set(colors).size, 1, `${speaker} keeps the same visual identity across passages`);
  await page.locator('.review-tab').filter({ hasText: 'Notes' }).click();

  // Evidence must reveal passages outside the first rendered transcript section.
  await page.locator('.review-note-summary .review-evidence-link').click();
  await expect(page.locator('#passage-review-p65')).toBeVisible();
  await expect(page.locator('#passage-review-p65')).toHaveClass(/review-passage-selected/);
  await expect.poll(() => page.locator('#review-audio').evaluate(audio => Math.round(audio.currentTime))).toBe(64);

  // Corrections create versions and preserve the original evidence IDs.
  await page.getByRole('textbox', { name: 'Search transcript' }).fill('old wording');
  await page.locator('.review-passage').getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit passage text' }).fill('Project Aurora now has approved wording.');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await expect.poll(async () => (await request(`/meetings/${meeting.id}`)).transcripts.length).toBe(2);
  let saved = await request(`/meetings/${meeting.id}`);
  assert.equal(saved.transcripts[0].passages[0].text, passages[0].text);
  assert.equal(saved.transcripts.at(-1).passages[0].id, 'review-p1');
  await page.getByRole('textbox', { name: 'Search transcript' }).fill('approved wording');
  await page.locator('.review-passage').getByRole('button', { name: 'Highlight', exact: true }).click();
  await expect.poll(async () => (await request(`/meetings/${meeting.id}`)).moments.length).toBe(1);

  // The speaker dialog supports real original-audio samples, then labels every matching passage.
  await page.locator('.review-passage .review-speaker').click();
  const speakerDialog = page.getByRole('dialog', { name: 'Who was speaking?' });
  await expect(speakerDialog).toBeVisible();
  await expect(speakerDialog.getByLabel('Speaker name')).toBeFocused();
  await speakerDialog.getByRole('button', { name: 'Play speaker sample', exact: true }).click();
  await expect.poll(() => page.locator('#review-speaker-sample').evaluate(audio => !audio.paused)).toBe(true);
  await speakerDialog.getByRole('button', { name: 'Next speaker sample', exact: true }).click();
  await expect(speakerDialog.locator('.review-speaker-sample-heading')).toContainText('2 / 33');
  await speakerDialog.getByLabel('Speaker name').fill('Riley');
  await speakerDialog.getByRole('button', { name: 'Save speaker', exact: true }).click();
  await expect(speakerDialog).not.toBeVisible();
  await expect.poll(() => page.locator('#review-speaker-sample').evaluate(audio => audio.paused)).toBe(true);
  await expect.poll(async () => (await request(`/meetings/${meeting.id}`)).transcripts.length).toBe(3);
  saved = await request(`/meetings/${meeting.id}`);
  assert.equal(saved.transcripts.at(-1).passages.filter(p => p.speaker === 'Riley').length, 33);
  assert.equal(saved.transcripts[0].passages[0].speaker, 'Speaker 1');

  // Moment label editing and arbitrary-time bookmarks use real REST persistence.
  await page.locator('.review-tab').filter({ hasText: 'Saved moments' }).click();
  await page.getByRole('button', { name: 'Edit saved moment label', exact: true }).click();
  await page.getByRole('textbox', { name: 'Saved moment label' }).fill('Approved wording to keep');
  await page.getByRole('button', { name: 'Save moment label', exact: true }).click();
  await expect(page.locator('.review-moment-content')).toContainText('Approved wording to keep');
  await page.locator('#review-audio').evaluate(audio => { audio.currentTime = 7.5; });
  await page.getByRole('button', { name: 'Bookmark current time', exact: true }).click();
  await expect.poll(async () => (await request(`/meetings/${meeting.id}`)).moments.length).toBe(2);
  saved = await request(`/meetings/${meeting.id}`);
  assert.ok(saved.moments.some(moment => moment.kind === 'bookmark' && Math.abs(moment.time - 7.5) < 0.05));
  await page.locator('.review-moment').filter({ hasText: 'Approved wording to keep' }).getByRole('button', { name: 'Remove saved moment', exact: true }).click();
  await expect.poll(async () => (await request(`/meetings/${meeting.id}`)).moments.length).toBe(1);

  // Notes edits/actions retain history and identify outdated transcript evidence.
  await page.locator('.review-tab').filter({ hasText: 'Notes' }).click();
  await expect(page.locator('.review-notes .review-notice-warning')).toContainText('earlier transcript');
  await page.getByRole('button', { name: 'Edit notes', exact: true }).click();
  await page.locator('.review-note-summary textarea').fill('The reviewed rollout plan is ready.');
  await page.locator('.review-action-edit').getByLabel('Owner', { exact: true }).fill('Riley');
  await page.locator('.review-action-edit').getByLabel('Due date', { exact: true }).fill('2026-10-12');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect.poll(async () => (await request(`/meetings/${meeting.id}`)).notes.length).toBe(2);
  await page.getByRole('button', { name: 'Toggle action completion', exact: true }).click();
  await expect.poll(async () => (await request(`/meetings/${meeting.id}`)).notes.length).toBe(3);
  saved = await request(`/meetings/${meeting.id}`);
  assert.equal(saved.notes[0].summary[0].text, 'The release plan is ready for review.');
  assert.equal(saved.notes.at(-1).actions[0].owner, 'Riley');
  assert.equal(saved.notes.at(-1).actions[0].done, true);

  await page.locator('.review-export summary').click();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('.review-dropdown a').filter({ hasText: 'Meeting notes' }).click();
  const download = await downloadPromise;
  assert.ok(download.suggestedFilename().endsWith('.md'));
  await download.saveAs(`${artifacts}/exported-notes.md`);
  await page.locator('.review-export summary').click();

  // Mobile layout and history restoration remain usable.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifacts}/notes-mobile.png`, fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile review must not overflow horizontally');
  assert.ok(await page.locator('.review-tab').evaluateAll(tabs => tabs.every(tab => {
    const rect = tab.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.height >= 44;
  })), 'Every mobile review tab must be fully visible with a comfortable touch target');
  await page.locator('.review-tab').filter({ hasText: 'Details' }).click();
  const transcriptHistory = page.locator('.review-detail-card').filter({ has: page.getByRole('heading', { name: /Transcript history/ }) });
  await transcriptHistory.getByRole('button', { name: 'Restore', exact: true }).last().click();
  await expect.poll(async () => (await request(`/meetings/${meeting.id}`)).activeTranscriptId).toBe(originalTranscript);

  // Escape cancels destructive deletion; confirmation removes the complete managed meeting.
  await page.getByRole('button', { name: 'Delete meeting', exact: true }).click();
  const deleteDialog = page.getByRole('dialog', { name: 'Delete this meeting?' });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog.getByRole('button', { name: 'Keep meeting', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(deleteDialog).not.toBeVisible();
  assert.equal((await request(`/meetings/${meeting.id}`)).id, meeting.id);
  await page.getByRole('button', { name: 'Delete meeting', exact: true }).click();
  await deleteDialog.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Every conversation, remembered.' })).toBeVisible();
  assert.equal((await fetch(`${base}/api/meetings/${meeting.id}`)).status, 404);
  assert.deepEqual(pageErrors, [], `Browser runtime errors: ${pageErrors.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `Browser console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({ ok: true, checked: ['evidence across transcript sections', 'transcript version correction', 'speaker samples and rename', 'highlight/bookmark/label/delete', 'notes edit and action versions', 'outdated notes provenance', 'Markdown export', 'mobile overflow', 'version restore', 'delete focus/escape/confirm', 'zero page/console errors'], artifacts }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }).catch(() => {});
    console.error('Runtime errors:', pageErrors, 'Console errors:', consoleErrors);
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-7000));
  }
  throw error;
} finally {
  if (browser) await browser.close();
  if (meeting) await fetch(`${base}/api/meetings/${meeting.id}`, { method: 'DELETE' }).catch(() => {});
}
