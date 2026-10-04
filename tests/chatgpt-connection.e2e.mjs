/**
 * Optional ChatGPT connection UI, with real settings persistence on an isolated server.
 * Build current WASM/assets first, then run with ECHO_TEST_URL pointing at a server
 * whose ECHO_DATA_DIR is a temporary directory (or use npm run test:e2e).
 * Only /api/chatgpt responses are fixtures. No helper, real sign-in, inference,
 * model download, or external browser request is permitted by this suite.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

assert.ok(process.env.ECHO_TEST_URL, 'Set ECHO_TEST_URL to an isolated temporary-data test server.');
const base = process.env.ECHO_TEST_URL.replace(/\/$/, '');
const origin = new URL(base).origin;
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Connection tests require a loopback server.');
const artifacts = process.env.ECHO_CONNECTION_TEST_ARTIFACTS || path.resolve('artifacts/chatgpt-connection');
const request = async (endpoint, method = 'GET', body) => {
  const response = await fetch(`${base}/api${endpoint}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const data = await response.json();
  assert.equal(response.ok, true, `${method} ${endpoint}: ${JSON.stringify(data)}`);
  return data;
};
const disconnected = () => ({ installed: true, connected: false, busy: false, account: null, login: { pending: false }, rateLimits: null });
const connected = () => ({
  ...disconnected(), connected: true,
  account: { email: 'connection-fixture@example.test', planType: 'plus' },
  rateLimits: {
    ordinaryUsageAllowed: true,
    primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 1791093600 },
    secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1791698400 },
  },
});
const catalog = { models: [
  { id: 'fixture-notes-fast', displayName: 'Fixture fast notes' },
  { id: 'fixture-notes-detailed', displayName: 'Fixture detailed notes' },
] };
const loginResult = { pending: true, loginId: 'fixture-login', authUrl: `${base}/api/chatgpt/fixture-sign-in` };
const calls = [];
const settingsWrites = [];
const forbiddenRequests = [];
const routeErrors = [];
const runtimeErrors = [];
const consoleErrors = [];
const audits = [];
const expectedHttpErrors = new Set();
let state = disconnected();
let nextFailure;
let initialSettings;
let browser;
let page;

await mkdir(artifacts, { recursive: true });
try {
  const storage = await request('/storage');
  const dataPath = path.resolve(storage.path);
  assert.ok(dataPath.startsWith(`${path.resolve(tmpdir())}${path.sep}`) && !dataPath.split(path.sep).includes('.echo-data'), 'Refusing to change settings outside an isolated temporary data directory.');
  initialSettings = await request('/settings');
  await request('/settings', 'PATCH', { onboardingComplete: true, notesProvider: 'ollama', chatgptModel: '' });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', async route => {
    const incoming = route.request();
    const url = new URL(incoming.url());
    const endpoint = url.pathname;
    const method = incoming.method();
    const key = `${method} ${endpoint}`;
    const fulfill = (json, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    try {
      if (url.origin !== origin) {
        forbiddenRequests.push(key);
        return route.abort('blockedbyclient');
      }
      if (endpoint.startsWith('/api/chatgpt')) {
        calls.push(key);
        if (nextFailure?.key === key) {
          const failure = nextFailure;
          nextFailure = undefined;
          expectedHttpErrors.add(`${origin}${endpoint}`);
          return fulfill({ error: failure.message }, 503);
        }
        if (key === 'GET /api/chatgpt') return fulfill(state);
        if (key === 'GET /api/chatgpt/models') return fulfill(catalog);
        if (key === 'POST /api/chatgpt/login') {
          assert.deepEqual(incoming.postDataJSON(), {}, 'Sign-in sends no meeting content.');
          state = { ...disconnected(), login: loginResult };
          return fulfill(loginResult);
        }
        if (key === 'DELETE /api/chatgpt/login') {
          state = disconnected();
          return fulfill({ ok: true });
        }
        if (key === 'POST /api/chatgpt/logout') {
          assert.deepEqual(incoming.postDataJSON(), {}, 'Disconnect sends no meeting content.');
          state = disconnected();
          return fulfill({ ok: true });
        }
        if (key === 'GET /api/chatgpt/fixture-sign-in') {
          return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html lang="en"><title>Fixture sign-in</title><h1>Fixture sign-in page</h1></html>' });
        }
        forbiddenRequests.push(key);
        return fulfill({ error: 'Unexpected ChatGPT request: real authentication is forbidden.' }, 403);
      }
      if (endpoint === '/api/settings' && method === 'PATCH') settingsWrites.push(incoming.postDataJSON());
      else if (!['GET', 'HEAD'].includes(method)) {
        forbiddenRequests.push(key);
        return route.abort('blockedbyclient');
      }
      return route.continue();
    } catch (error) {
      routeErrors.push(error.stack || error.message);
      return fulfill({ error: `Fixture failed: ${error.message}` }, 500);
    }
  });
  page = await context.newPage();
  page.on('pageerror', error => runtimeErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') return;
    if (expectedHttpErrors.has(message.location().url) && /503/.test(message.text())) return;
    consoleErrors.push(message.text());
  });
  const panel = page.getByRole('region', { name: 'ChatGPT connection', exact: true });
  const signIn = panel.getByRole('button', { name: 'Sign in with ChatGPT', exact: true });
  const refresh = panel.getByRole('button', { name: 'Refresh ChatGPT connection', exact: true });
  const cancel = panel.getByRole('button', { name: 'Cancel sign-in', exact: true });
  const loginLink = panel.getByRole('link', { name: 'Open ChatGPT sign-in', exact: true });
  const model = panel.getByRole('combobox', { name: 'Notes model', exact: true });
  const disconnect = panel.getByRole('button', { name: 'Disconnect ChatGPT', exact: true });
  const count = key => calls.filter(value => value === key).length;
  const openModels = async () => {
    await page.goto(base);
    const menu = page.getByRole('button', { name: 'Open navigation', exact: true });
    if (await menu.isVisible()) await menu.click();
    await page.locator('.sidebar').getByRole('button', { name: 'Models', exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(refresh).toBeEnabled();
  };
  const refreshConnection = async () => {
    const statusResponse = page.waitForResponse(response => response.url() === `${base}/api/chatgpt` && response.request().method() === 'GET');
    const modelsResponse = state.connected && nextFailure?.key !== 'GET /api/chatgpt'
      ? page.waitForResponse(response => response.url() === `${base}/api/chatgpt/models` && response.request().method() === 'GET')
      : undefined;
    await refresh.click();
    await statusResponse;
    if (modelsResponse) await modelsResponse;
  };
  const refreshState = async value => {
    state = value;
    await refreshConnection();
  };
  const audit = async name => {
    await panel.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${artifacts}/${name}.png`, fullPage: true });
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']).analyze();
    const violations = result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })) }));
    audits.push({ name, violations });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${name}: no horizontal overflow`);
    assert.deepEqual(violations, [], `${name}: no axe accessibility violations`);
  };

  await openModels();
  await expect(signIn).toBeEnabled();
  await expect(panel).toContainText('transcript text and speaker labels go to OpenAI');
  await expect(panel).toContainText('Recording and speech transcription stay on this device.');
  await expect(panel).toContainText('No API key is required.');
  assert.equal(count('POST /api/chatgpt/login'), 0, 'Opening Models must not start sign-in.');
  assert.deepEqual(settingsWrites, [], 'Opening Models must not change saved preferences.');
  await audit('disconnected-desktop');

  nextFailure = { key: 'POST /api/chatgpt/login', message: 'Fixture sign-in preparation failed. Try again.' };
  await signIn.click();
  await expect(panel.getByRole('alert')).toContainText('Fixture sign-in preparation failed. Try again.');
  await expect(signIn).toBeEnabled();
  await signIn.click();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(loginLink).toHaveAttribute('href', loginResult.authUrl);
  await expect(loginLink).toHaveAttribute('target', '_blank');
  await expect(loginLink).toHaveAttribute('rel', /noopener/);
  await expect(loginLink).toHaveAttribute('rel', /noreferrer/);
  await expect(signIn).toHaveCount(0);
  assert.equal(count('GET /api/chatgpt/fixture-sign-in'), 0, 'Preparing login does not automatically open the sign-in page.');
  const popupPromise = page.waitForEvent('popup');
  await loginLink.click();
  const popup = await popupPromise;
  await expect(popup.getByRole('heading', { name: 'Fixture sign-in page', exact: true })).toBeVisible();
  assert.equal(await popup.evaluate(() => window.opener === null), true, 'The sign-in tab cannot access its opener.');
  await popup.close();
  await audit('sign-in-pending-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await audit('sign-in-pending-mobile');
  await cancel.click();
  await expect(loginLink).toHaveCount(0);
  await expect(signIn).toBeEnabled();
  assert.equal(count('DELETE /api/chatgpt/login'), 1);

  // A pending login survives navigation; its completion is picked up by polling.
  await signIn.click();
  await expect(loginLink).toBeVisible();
  await openModels();
  await expect(loginLink).toBeVisible();
  const beforeCompletion = count('GET /api/chatgpt');
  state = connected();
  await expect(model).toBeVisible({ timeout: 10000 });
  await expect(model.getByRole('option', { name: 'Fixture detailed notes', exact: true })).toHaveCount(1);
  assert.ok(count('GET /api/chatgpt') > beforeCompletion, 'Sign-in completion is discovered without a manual refresh.');
  await expect(loginLink).toHaveCount(0);
  await expect(panel).toContainText('connection-fixture@example.test');
  await expect(panel).toContainText('plus plan');
  await expect(panel).toContainText('23% used');
  await expect(panel).toContainText('61% used');
  await expect(panel.getByRole('progressbar', { name: '5 hour window used' })).toHaveAttribute('value', '23');
  await expect(panel.getByRole('progressbar', { name: '7 day window used' })).toHaveAttribute('value', '61');
  await expect(panel).toContainText('Resets');
  await expect(panel).toContainText('token counts on a note are not a remaining balance');
  await audit('connected-mobile');
  await page.setViewportSize({ width: 1440, height: 1050 });
  await audit('connected-desktop');

  await model.selectOption('fixture-notes-detailed');
  await expect.poll(async () => (await request('/settings')).chatgptModel).toBe('fixture-notes-detailed');
  assert.equal((await request('/settings')).notesProvider, 'ollama', 'Choosing a model leaves the local notes preference intact.');
  await panel.getByRole('button', { name: 'Use ChatGPT for notes', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Default notes provider', exact: true })).toBeDisabled();
  await expect.poll(async () => (await request('/settings')).notesProvider).toBe('chatgpt');
  await openModels();
  await expect(model).toHaveValue('fixture-notes-detailed');
  await expect(panel.getByRole('button', { name: 'Default notes provider', exact: true })).toBeDisabled();
  assert.deepEqual(settingsWrites, [{ chatgptModel: 'fixture-notes-detailed' }, { notesProvider: 'chatgpt' }], 'Connection choices persist through the real settings API.');
  assert.equal((await request('/settings')).notesModel, initialSettings.notesModel, 'The saved local model remains available.');

  await refreshState({ ...connected(), rateLimits: null });
  await expect(panel).toContainText('Usage information isn’t available right now.');
  await expect(panel.getByRole('progressbar')).toHaveCount(0);
  await refreshState({ ...connected(), rateLimits: { ordinaryUsageAllowed: false, primary: { usedPercent: 100, windowDurationMins: 300 }, secondary: { windowDurationMins: 10080 } } });
  await expect(panel.getByRole('alert')).toContainText('Included usage is currently unavailable.');
  await expect(panel.getByRole('alert')).toContainText('Echo won’t switch to API billing.');
  await expect(panel).toContainText('Usage unavailable');
  await expect(panel.getByRole('progressbar', { name: '5 hour window used' })).toHaveAttribute('value', '100');
  await page.setViewportSize({ width: 390, height: 844 });
  await audit('allowance-unavailable-mobile');
  await refreshState(connected());
  await expect(panel.getByRole('alert')).toHaveCount(0);

  nextFailure = { key: 'GET /api/chatgpt/models', message: 'Fixture account model list is temporarily unavailable.' };
  await refreshConnection();
  await expect(panel.getByRole('alert')).toContainText('Fixture account model list is temporarily unavailable.');
  await refreshConnection();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(model).toHaveValue('fixture-notes-detailed');
  nextFailure = { key: 'GET /api/chatgpt', message: 'Fixture connection check failed. Refresh to recover.' };
  await refreshConnection();
  await expect(panel.getByRole('alert')).toContainText('Fixture connection check failed. Refresh to recover.');
  await expect(panel).toContainText('Connection status is unavailable. Refresh to check again.');
  await expect(disconnect).toHaveCount(0);
  await expect(model).toHaveCount(0);
  await expect(panel.getByText('Set up the local sign-in helper', { exact: true })).toHaveCount(0);
  await expect(refresh).toBeEnabled();
  await refreshConnection();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(disconnect).toBeEnabled();

  nextFailure = { key: 'POST /api/chatgpt/logout', message: 'Fixture disconnect failed. Try again.' };
  await disconnect.click();
  await expect(panel.getByRole('alert')).toContainText('Fixture disconnect failed. Try again.');
  await expect(disconnect).toBeEnabled();
  await disconnect.click();
  await expect(signIn).toBeEnabled();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(model).toHaveCount(0);
  await expect(page.getByText('ChatGPT disconnected from Echo. Your saved notes remain here.', { exact: true })).toBeVisible();
  assert.equal(count('POST /api/chatgpt/logout'), 2);
  assert.equal((await request('/settings')).chatgptModel, 'fixture-notes-detailed', 'Disconnect retains the saved model preference.');

  await signIn.click();
  await expect(loginLink).toBeVisible();
  state = { ...disconnected(), login: { pending: false, error: 'Fixture sign-in expired. Please sign in again.' } };
  await expect(panel.getByRole('alert')).toContainText('Fixture sign-in expired. Please sign in again.', { timeout: 10000 });
  await expect(loginLink).toHaveCount(0);
  await expect(signIn).toBeEnabled();
  await refreshState({ ...disconnected(), installed: false });
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel).toContainText('Set up the local sign-in helper');
  await expect(panel).toContainText('npm install -g @openai/codex@0.160.0');
  await expect(panel).toContainText('ECHO_CODEX_BIN');
  await expect(signIn).toHaveCount(0);
  await audit('helper-missing-mobile');
  await refreshState({ ...disconnected(), error: 'Fixture helper is not ready. Restart it and check again.' });
  await expect(panel.getByRole('status')).toContainText('Fixture helper is not ready. Restart it and check again.');
  await refreshState(disconnected());
  await expect(panel.getByText('Fixture helper is not ready. Restart it and check again.', { exact: true })).toHaveCount(0);
  await expect(signIn).toBeEnabled();

  assert.deepEqual(forbiddenRequests, [], 'No real sign-in, external request, model download, generation, or unexpected mutation occurred.');
  assert.deepEqual(routeErrors, [], `Fixture route failures: ${routeErrors.join('\n')}`);
  assert.deepEqual(runtimeErrors, [], `Browser runtime failures: ${runtimeErrors.join('\n')}`);
  assert.deepEqual(consoleErrors, [], `Unexpected browser console failures: ${consoleErrors.join('\n')}`);
  console.log(JSON.stringify({ ok: true, checked: ['optional local default and privacy disclosure', 'sign-in failure, explicit safe popup, cancellation', 'pending login hydration and automatic completion polling', 'real persisted account model and default provider', 'allowance windows, unavailable usage, and exhausted allowance', 'model/status/disconnect error recovery', 'disconnect, expired login, missing helper, helper recovery', 'desktop/mobile layout and axe accessibility', 'no real authentication, generation, download, or external traffic'], statusRequests: count('GET /api/chatgpt'), settingsWrites, audits: audits.length, artifacts }, null, 2));
} catch (error) {
  if (page) {
    await page.screenshot({ path: `${artifacts}/failure.png`, fullPage: true }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(-9000));
  }
  console.error({ forbiddenRequests, routeErrors, runtimeErrors, consoleErrors });
  throw error;
} finally {
  await writeFile(`${artifacts}/accessibility.json`, JSON.stringify(audits, null, 2));
  if (browser) await browser.close();
  if (initialSettings) await request('/settings', 'PATCH', initialSettings);
}
