/**
 * Fixture-only optional ChatGPT notes UI verification, using an isolated server.
 * Build current WASM/assets first, then:
 * ECHO_TEST_URL=http://127.0.0.1:3013 node tests/review-chatgpt.e2e.mjs
 * ChatGPT status, settings preferences, and ALL model-generation routes are
 * intercepted. Only this test's meeting/transcript/note fixtures reach real REST.
 * No ChatGPT sign-in, model inference, or external network request is permitted.
 */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const base = (process.env.ECHO_TEST_URL || 'http://127.0.0.1:3013').replace(/\/$/, '');
const origin = new URL(base).origin;
const artifacts = process.env.ECHO_CHATGPT_TEST_ARTIFACTS || '/tmp/echo-review-chatgpt-e2e';
const request = async (path, method = 'GET', body) => {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  assert.equal(response.ok, true, `${method} ${path}: ${JSON.stringify(data)}`);
  return data;
};
const usage = { inputTokens: 1240, outputTokens: 380, cachedInputTokens: 240 };
const selectedModel = 'gpt-5.4-mini';
const accountFixture = (connected = true, busy = false) => ({
  connected, busy, available: true,
  account: connected ? { email: 'review-fixture@example.test', planType: 'plus' } : null,
  models: [{ id: selectedModel, displayName: 'Fixture notes model' }],
});
const notesFixture = (meeting, provider, generation = false) => ({
  model: provider === 'chatgpt' ? selectedModel : 'local-fixture',
  provider,
  ...(provider === 'chatgpt' ? { usage } : {}),
  transcriptVersionId: meeting.activeTranscriptId,
  summary: [{ id: 'chatgpt-summary', text: generation ? 'Fixture-generated notes keep the launch review on track.' : 'The team reviewed the launch plan.', passageIds: ['chatgpt-p1'] }],
  decisions: [{ id: 'chatgpt-decision', text: 'Keep the launch review on Friday.', passageIds: ['chatgpt-p1'] }],
  actions: [{ id: 'chatgpt-action', text: 'Prepare the release checklist.', owner: 'Riley', dueDate: '2026-10-09', done: false, passageIds: ['chatgpt-p2'] }],
});

await mkdir(artifacts, { recursive: true });
const fixtures = [];
const generationRequests = [];
const editRequests = [];
const forbiddenRequests = [];
const routeErrors = [];
const pageErrors = [];
const consoleErrors = [];
let browser;
let page;
let preferredProvider = 'ollama';
let account = accountFixture();
let statusRequests = 0;
let statusFailureServed = false;
let deferredStatus;

try {
  const actualSettings = await request('/settings');
  const createMeeting = async (suffix, seedNotes) => {
    let value = await request('/meetings', 'POST', { title: `ChatGPT review fixture ${Date.now()} ${suffix}`, mode: 'import', consent: true });
    fixtures.push(value);
    value = await request(`/meetings/${value.id}/transcripts`, 'POST', {
      model: 'transcript-fixture', label: 'Original fixture transcript', vocabulary: [],
      passages: [
        { id: 'chatgpt-p1', start: 0, end: 4, speaker: 'Alex', text: 'Keep the launch review on Friday.' },
        { id: 'chatgpt-p2', start: 4, end: 8, speaker: 'Riley', text: 'I will prepare the release checklist.' },
      ],
    });
    if (seedNotes) value = await request(`/meetings/${value.id}/notes`, 'POST', notesFixture(value, 'ollama'));
    return value;
  };
  const meeting = await createMeeting('existing notes', true);
  const emptyMeeting = await createMeeting('first notes', false);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.__reviewModelsRequests = 0;
    window.addEventListener('echo-open-models', () => { window.__reviewModelsRequests++; });
  });
  await context.route('**/*', async route => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const path = url.pathname;
    const fulfill = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    try {
      if (url.origin !== origin) {
        forbiddenRequests.push(`${incoming.method()} ${url.origin}${path}`);
        return route.abort('blockedbyclient');
      }
      if (path === '/api/settings' && incoming.method() === 'GET') {
        return fulfill({ ...actualSettings, onboardingComplete: true, notesProvider: preferredProvider, chatgptModel: ` ${selectedModel} ` });
      }
      if (path === '/api/chatgpt' && incoming.method() === 'GET') {
        statusRequests++;
        if (deferredStatus) {
          const gate = deferredStatus;
          deferredStatus = undefined;
          await gate.promise;
          statusFailureServed = true;
          return fulfill({ error: 'Fixture connection check failed. Check your ChatGPT connection and try again.' }, 503);
        }
        return fulfill(account);
      }
      if (path === '/api/notes' && incoming.method() === 'GET') {
        return fulfill({ available: false, models: [], error: 'Fixture-only test: no local model service.' });
      }
      if (path === '/api/notes' && incoming.method() === 'POST') {
        const body = incoming.postDataJSON();
        generationRequests.push(body);
        assert.ok(fixtures.some(value => value.id === body.meetingId), 'Generation belongs to this test fixture');
        assert.ok(['ollama', 'chatgpt'].includes(body.provider));
        assert.equal(body.cloudConsent, body.provider === 'chatgpt', 'Cloud generation requires explicit consent; local generation does not send it');
        if (body.provider === 'chatgpt') assert.equal(body.model, selectedModel, 'The configured ChatGPT model is sent without surrounding whitespace');
        else assert.equal(Object.hasOwn(body, 'model'), false, 'The ChatGPT model must not leak into local generation');
        const saved = await request(`/meetings/${body.meetingId}`);
        const result = await request(`/meetings/${body.meetingId}/notes`, 'POST', notesFixture(saved, body.provider, true));
        return fulfill(result);
      }
      // These prefixes include auth, downloads, and inference. Never pass them through.
      if (path.startsWith('/api/chatgpt') || path.startsWith('/api/notes')) {
        forbiddenRequests.push(`${incoming.method()} ${path}`);
        return fulfill({ error: 'Fixture-only test forbids authentication and model requests.' }, 403);
      }
      if (incoming.method() === 'POST' && fixtures.some(value => path === `/api/meetings/${value.id}/notes`)) editRequests.push(incoming.postDataJSON());
      return route.continue();
    } catch (error) {
      routeErrors.push(error.stack || error.message);
      return fulfill({ error: `Fixture route failed: ${error.message}` }, 500);
    }
  });
  page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (statusFailureServed && message.location().url === `${base}/api/chatgpt` && /503/.test(message.text())) return;
    consoleErrors.push(message.text());
  });
  const openMeeting = async value => {
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: new RegExp(value.title) }).first().click();
    await expect(page.getByRole('heading', { name: value.title, exact: true })).toBeVisible();
    await page.locator('.review-tab').filter({ hasText: 'Notes' }).click();
    await expect(page.getByRole('combobox', { name: 'Create notes with' })).toHaveValue(preferredProvider);
  };
  const provider = page.getByRole('combobox', { name: 'Create notes with' });
  const regenerate = page.getByRole('button', { name: 'Generate a new notes version', exact: true });
  const dialog = page.getByRole('dialog', { name: 'Create notes with ChatGPT?', exact: true });
  const confirm = dialog.getByRole('button', { name: 'Generate with ChatGPT', exact: true });
  const cancel = dialog.getByRole('button', { name: 'Cancel', exact: true });
  const assertNoGeneration = count => assert.equal(generationRequests.length, count, 'No generation occurs before explicit confirmation');

  // First notes remain local by default, even when a ChatGPT model is configured.
  await openMeeting(emptyMeeting);
  await expect(page.getByRole('heading', { name: 'Your conversation, distilled.' })).toBeVisible();
  await expect(page.locator('.review-notes-provider-info')).toContainText('On your computer');
  await page.getByRole('button', { name: 'Generate meeting notes', exact: true }).click();
  await expect(page.locator('.review-draft-label')).toContainText('Local · Ollama');
  assert.deepEqual(generationRequests, [{ meetingId: emptyMeeting.id, provider: 'ollama', cloudConsent: false }]);
  await expect(dialog).not.toBeVisible();

  // Selection checks the connection but never sends a transcript or creates notes.
  await openMeeting(meeting);
  await expect(provider).toHaveValue('ollama');
  const beforeSelection = statusRequests;
  await provider.selectOption('chatgpt');
  await expect.poll(() => statusRequests).toBeGreaterThan(beforeSelection);
  await expect(page.locator('.review-provider-account')).toContainText('review-fixture@example.test');
  assertNoGeneration(1);
  await regenerate.click();
  await expect(dialog).toBeVisible();
  assert.ok(await dialog.evaluate(element => element instanceof HTMLDialogElement && element.matches(':modal')), 'Consent uses a native modal dialog');
  await expect(cancel).toBeFocused();
  await expect(dialog).toContainText('this meeting’s transcript, including speaker labels and spoken text');
  await expect(dialog).toContainText('to OpenAI through your connected ChatGPT account');
  await expect(dialog).toContainText('Your original audio is not sent.');
  await expect(dialog).toContainText('notes are saved in your local library');
  await expect(dialog).toContainText('Codex usage included with your ChatGPT plan');
  await expect(dialog).toContainText('subject to your plan’s limits');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  assertNoGeneration(1);

  // The complete disclosure and both choices fit the desktop and mobile viewport.
  await regenerate.click();
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: `${artifacts}/chatgpt-consent-desktop.png`, fullPage: true });
  const auditDialog = async viewport => {
    const audit = await new AxeBuilder({ page }).include('#review-chatgpt-dialog').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
    assert.deepEqual(audit.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target) })), [], `${viewport} consent dialog accessibility`);
  };
  await auditDialog('Desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cancel).toBeFocused();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile review does not overflow horizontally');
  const mobile = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return {
      fits: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      noHorizontalOverflow: element.scrollWidth <= element.clientWidth + 1,
      readable: [...element.querySelectorAll('p')].every(item => parseFloat(getComputedStyle(item).fontSize) >= 12),
      buttons: [...element.querySelectorAll('button')].every(item => item.getBoundingClientRect().height >= 44),
    };
  });
  assert.deepEqual(mobile, { fits: true, noHorizontalOverflow: true, readable: true, buttons: true });
  await page.screenshot({ path: `${artifacts}/chatgpt-consent-mobile.png`, fullPage: true });
  await auditDialog('Mobile');
  await cancel.click();
  await expect(dialog).not.toBeVisible();
  assertNoGeneration(1);
  await page.setViewportSize({ width: 1440, height: 1000 });

  // A confirmed cloud request returns fixture notes through real local persistence.
  await regenerate.click();
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.review-draft-label')).toContainText('ChatGPT · OpenAI');
  await expect(page.locator('.review-draft-label')).toContainText(selectedModel);
  await expect(page.locator('.review-notes-usage')).toHaveText('Reported token usage: 1240 input · 380 output · 240 cached input');
  await expect(page.locator('.review-notes-footer')).toContainText('Generated with ChatGPT. Saved locally');
  assert.deepEqual(generationRequests[1], { meetingId: meeting.id, provider: 'chatgpt', cloudConsent: true, model: selectedModel });
  let saved = await request(`/meetings/${meeting.id}`);
  assert.equal(saved.notes.length, 2);
  assert.equal(saved.notes[0].provider, 'ollama');
  assert.equal(saved.notes.at(-1).provider, 'chatgpt');
  assert.deepEqual(saved.notes.at(-1).usage, usage);

  // User edits and action completion preserve provider/usage under strict REST validation.
  await page.getByRole('button', { name: 'Edit notes', exact: true }).click();
  await page.locator('.review-note-summary textarea').fill('Reviewed fixture notes retain their source and token usage.');
  await page.getByRole('button', { name: 'Save version', exact: true }).click();
  await expect.poll(async () => (await request(`/meetings/${meeting.id}`)).notes.length).toBe(3);
  await page.getByRole('button', { name: 'Toggle action completion', exact: true }).click();
  await expect.poll(async () => (await request(`/meetings/${meeting.id}`)).notes.length).toBe(4);
  saved = await request(`/meetings/${meeting.id}`);
  assert.equal(saved.notes.at(-1).summary[0].text, 'Reviewed fixture notes retain their source and token usage.');
  assert.equal(saved.notes.at(-1).actions[0].done, true);
  assert.equal(editRequests.length, 2);
  for (const version of [...editRequests, ...saved.notes.slice(2)]) {
    assert.equal(version.provider, 'chatgpt');
    assert.equal(version.model, selectedModel);
    assert.deepEqual(version.usage, usage);
    assert.equal(version.edited, true);
  }
  for (const body of editRequests) {
    assert.equal(Object.hasOwn(body, 'id'), false, 'New versions must omit generated IDs');
    assert.equal(Object.hasOwn(body, 'createdAt'), false, 'New versions must omit generated timestamps');
  }
  await page.locator('.review-tab').filter({ hasText: 'Details' }).click();
  const history = page.locator('.review-detail-card').filter({ has: page.getByRole('heading', { name: /Notes history/ }) });
  await expect(history).toContainText('ChatGPT · OpenAI');
  await expect(history).toContainText('Reported token usage: 1240 input · 380 output · 240 cached input');
  await page.locator('.review-tab').filter({ hasText: 'Notes' }).click();

  // A stale successful connection cannot authorize a request while refresh is pending or fails.
  let releaseStatus;
  deferredStatus = { promise: new Promise(resolve => { releaseStatus = resolve; }) };
  await regenerate.click();
  await expect(dialog).toContainText('Checking your ChatGPT connection');
  await expect(confirm).toBeDisabled();
  assertNoGeneration(2);
  releaseStatus();
  await expect(dialog).toContainText('Fixture connection check failed.');
  await expect(confirm).toHaveCount(0);
  await expect(dialog).toContainText('Connection status unavailable.');
  await expect(page.locator('.review-provider-account')).not.toContainText('ChatGPT is not connected.');
  await dialog.getByRole('button', { name: 'Retry connection', exact: true }).click();
  await expect(confirm).toBeEnabled();
  assertNoGeneration(2);
  await cancel.click();

  // Busy and signed-out accounts remain blocked, with an actionable Models shortcut.
  account = accountFixture(true, true);
  await provider.selectOption('ollama');
  await provider.selectOption('chatgpt');
  await expect(page.locator('.review-provider-account')).toContainText('Another ChatGPT request is running.');
  await regenerate.click();
  await expect(dialog).toContainText('Wait for it to finish');
  await expect(confirm).toBeDisabled();
  await cancel.click();
  account = accountFixture(false);
  await provider.selectOption('ollama');
  await provider.selectOption('chatgpt');
  await expect(page.locator('.review-provider-account')).toContainText('ChatGPT is not connected.');
  await regenerate.click();
  await expect(dialog).toContainText('Connect your ChatGPT account in Models to continue.');
  await expect(confirm).toHaveCount(0);
  assertNoGeneration(2);
  const modelsRequests = await page.evaluate(() => window.__reviewModelsRequests);
  await dialog.getByRole('button', { name: 'Connect in Models', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__reviewModelsRequests)).toBe(modelsRequests + 1);
  await expect(dialog).not.toBeVisible();
  assertNoGeneration(2);

  // A saved ChatGPT preference is hydrated without bypassing per-request consent.
  preferredProvider = 'chatgpt';
  account = accountFixture();
  await openMeeting(meeting);
  await expect(provider).toHaveValue('chatgpt');
  await expect(page.locator('.review-provider-account')).toContainText('review-fixture@example.test');
  assertNoGeneration(2);
  await regenerate.click();
  await expect(dialog).toBeVisible();
  await expect(confirm).toBeEnabled();
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  assertNoGeneration(2);
  assert.deepEqual(routeErrors, [], `Fixture route errors: ${routeErrors.join('\n')}`);
  assert.deepEqual(forbiddenRequests, [], 'No external, sign-in, download, or unmocked model request was attempted');
  assert.deepEqual(pageErrors, [], `Browser runtime errors: ${pageErrors.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `Unexpected browser console errors: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({ ok: true, checked: ['local default and first-time generation', 'selection without generation', 'native consent disclosure/focus/Escape/cancel', 'desktop and mobile dialog layout and axe accessibility', 'explicit cloud consent and configured model', 'provider/usage provenance and real REST edits', 'history provenance', 'pending/failed connection blocks stale status', 'busy/disconnected state and Models dispatch', 'persisted provider still requires consent', 'no real model/auth/external requests', 'zero unexpected runtime/console errors'], statusRequests, generationRequests: generationRequests.length, artifacts }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }).catch(() => {});
    console.error('Runtime errors:', pageErrors, 'Console errors:', consoleErrors, 'Route errors:', routeErrors);
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-8000));
  }
  throw error;
} finally {
  if (deferredStatus) deferredStatus = undefined;
  if (browser) await browser.close();
  for (const fixture of fixtures) await request(`/meetings/${fixture.id}`, 'DELETE');
}
