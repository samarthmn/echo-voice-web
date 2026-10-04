import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';

// Run against a fresh local data directory, for example:
// ECHO_DATA_DIR=/tmp/echo-settings-e2e ECHO_BIND=127.0.0.1:3011 ./target/debug/echo-server
// ECHO_E2E_URL=http://127.0.0.1:3011 node tests/settings.e2e.mjs
const baseURL = process.env.ECHO_E2E_URL || 'http://127.0.0.1:3011';
const screenshotDir = process.env.ECHO_E2E_SCREENSHOTS || '/tmp/echo-settings-screenshots';

test('Settings persist local preferences, vocabulary, backups, and explicit microphone access', { timeout: 120_000 }, async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1060 }, acceptDownloads: true, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  await page.addInitScript(() => {
    window.__microphoneRequests = 0;
    window.__testTracks = [];
    const original = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
    if (original) navigator.mediaDevices.getUserMedia = async (...args) => {
      window.__microphoneRequests++;
      const stream = await original(...args);
      window.__testTracks.push(...stream.getTracks());
      return stream;
    };
  });
  await mkdir(screenshotDir, { recursive: true });
  let initialSettings;
  let isolatedEmpty = false;
  try {
    const initialVocabulary = await (await context.request.get(`${baseURL}/api/vocabulary`)).json();
    const initialMeetings = await (await context.request.get(`${baseURL}/api/meetings`)).json();
    assert.equal(initialVocabulary.entries.length, 0, 'Run the suite with an empty test vocabulary.');
    assert.equal(initialMeetings.meetings.length, 0, 'Run the suite with an empty test meeting library.');
    isolatedEmpty = true;
    initialSettings = await (await context.request.get(`${baseURL}/api/settings`)).json();
    await page.goto(baseURL);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    assert.equal(await page.evaluate(() => window.__microphoneRequests), 0);

    await t.test('preferences save and conflicting model/language choices remain unsaved', async () => {
      await page.getByPlaceholder('What should we call you?').fill('Settings verification');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(page.getByText('Your preferences are up to date')).toBeVisible();
      assert.equal((await (await context.request.get(`${baseURL}/api/settings`)).json()).name, 'Settings verification');
      await page.locator('select').filter({ has: page.locator('option[value="auto"]') }).selectOption('fr');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('English-only');
      assert.equal((await (await context.request.get(`${baseURL}/api/settings`)).json()).language, 'en');
      const speechSelect = page.locator('select').filter({ has: page.locator('option[value="onnx-community/whisper-base"]') });
      await speechSelect.selectOption('onnx-community/whisper-base');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(page.getByText('Your preferences are up to date')).toBeVisible();
      await page.route('**/api/settings', async route => {
        if (route.request().method() === 'GET') await new Promise(resolve => setTimeout(resolve, 350));
        await route.continue();
      });
      await page.reload();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByPlaceholder('What should we call you?').fill('Keep this unsaved edit');
      await expect(page.locator('select').filter({ has: page.locator('option[value="auto"]') })).toHaveValue('fr');
      await expect(page.locator('select').filter({ has: page.locator('option[value="onnx-community/whisper-base"]') })).toHaveValue('onnx-community/whisper-base');
      await expect(page.getByPlaceholder('What should we call you?')).toHaveValue('Keep this unsaved edit');
      await page.unroute('**/api/settings');
      await page.locator('select').filter({ has: page.locator('option[value="auto"]') }).selectOption(initialSettings.language);
      await page.locator('select').filter({ has: page.locator('option[value="onnx-community/whisper-base"]') }).selectOption(initialSettings.speechModel);
      await page.getByPlaceholder('What should we call you?').fill(initialSettings.name);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(page.getByText('Your preferences are up to date')).toBeVisible();
      await page.screenshot({ path: `${screenshotDir}/general-desktop.png`, fullPage: true });
    });

    await t.test('ChatGPT notes are an explicit saved preference and older settings default to local', async () => {
      const generationRequests = [];
      const trackRequests = request => {
        if (request.method() === 'POST' && new URL(request.url()).pathname !== '/api/settings') generationRequests.push(request.url());
      };
      page.on('request', trackRequests);
      const providerSelect = page.getByRole('combobox', { name: /Default notes provider/ });
      await expect(providerSelect).toHaveValue('ollama');
      const originalOllamaModel = await page.getByPlaceholder('qwen2.5:3b').inputValue();
      await providerSelect.selectOption('chatgpt');
      await expect(page.getByRole('heading', { name: 'ChatGPT notes, by choice' })).toBeVisible();
      await expect(page.getByText('When you request ChatGPT notes, the meeting’s active transcript, including speaker labels, and instructions are sent to OpenAI. Your audio is not uploaded, and saving this preference sends no meeting content.')).toBeVisible();
      await expect(page.getByPlaceholder('qwen2.5:3b')).toHaveCount(0);
      await page.getByPlaceholder('What should we call you?').fill('Draft survives setup');
      await page.getByRole('button', { name: 'Set up ChatGPT', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Your models. Your choice.' })).toBeVisible();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(providerSelect).toHaveValue('chatgpt');
      await expect(page.getByPlaceholder('What should we call you?')).toHaveValue('Draft survives setup');
      assert.equal((await (await context.request.get(`${baseURL}/api/settings`)).json()).notesProvider, 'ollama', 'Setup navigation preserves a draft without saving it implicitly');
      await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
      await page.getByRole('button', { name: 'General', exact: true }).click();
      await expect(providerSelect).toHaveValue('chatgpt');
      await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
      await expect(providerSelect).toHaveValue('ollama');
      await expect(page.getByPlaceholder('What should we call you?')).toHaveValue(initialSettings.name);
      await providerSelect.selectOption('chatgpt');
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(page.getByText('Your preferences are up to date')).toBeVisible();
      const saved = await (await context.request.get(`${baseURL}/api/settings`)).json();
      assert.equal(saved.notesProvider, 'chatgpt');
      assert.equal(saved.chatgptModel, '');
      assert.equal(saved.notesModel, originalOllamaModel);
      await page.reload();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('combobox', { name: /Default notes provider/ })).toHaveValue('chatgpt');
      await expect(page.getByText('Account default', { exact: true })).toBeVisible();
      assert.deepEqual(generationRequests, [], 'Changing or restoring this preference must not send meeting content.');
      await page.getByRole('combobox', { name: /Default notes provider/ }).selectOption('ollama');
      await expect(page.getByPlaceholder('qwen2.5:3b')).toHaveValue(originalOllamaModel);
      await page.getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect(page.getByText('Your preferences are up to date')).toBeVisible();
      await page.route('**/api/settings', async route => {
        if (route.request().method() !== 'GET') return route.continue();
        const response = await route.fetch();
        const legacy = await response.json();
        delete legacy.notesProvider;
        delete legacy.chatgptModel;
        await route.fulfill({ response, json: legacy });
      });
      await page.reload();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('combobox', { name: /Default notes provider/ })).toHaveValue('ollama');
      await expect(page.getByPlaceholder('qwen2.5:3b')).toHaveValue(originalOllamaModel);
      await expect(page.getByText('Your preferences are up to date')).toBeVisible();
      await page.unroute('**/api/settings');
      page.off('request', trackRequests);
    });

    await t.test('vocabulary editing, filtering, toggling, import validation and export', async () => {
      await page.getByRole('button', { name: 'Vocabulary', exact: true }).click();
      await page.getByRole('button', { name: 'Add word', exact: true }).click();
      await expect(page.getByPlaceholder('e.g. Figma')).toBeFocused();
      await page.getByPlaceholder('e.g. Figma').fill('Echo Research');
      await page.getByPlaceholder('e.g. fig ma, figmah').fill('echo resurch, eco research');
      await page.getByRole('button', { name: 'Save word', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Echo Research', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Add word', exact: true })).toBeFocused();
      const toggle = page.getByRole('switch', { name: 'Enable Echo Research' });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await page.getByRole('button', { name: 'Edit Echo Research', exact: true }).click();
      await page.getByPlaceholder('e.g. Figma').fill('Echo Labs');
      await page.getByPlaceholder('e.g. fig ma, figmah').fill('echo labz, eco labs');
      await page.getByRole('button', { name: 'Save word', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Echo Labs', exact: true })).toBeVisible();
      await page.getByRole('switch', { name: 'Enable Echo Labs' }).click();
      await expect(page.getByRole('switch', { name: 'Enable Echo Labs' })).toHaveAttribute('aria-checked', 'true');
      await page.getByRole('textbox', { name: 'Search vocabulary' }).fill('eco labs');
      await expect(page.getByRole('heading', { name: 'Echo Labs', exact: true })).toBeVisible();
      await page.getByRole('textbox', { name: 'Search vocabulary' }).fill('no-match');
      await expect(page.getByRole('heading', { name: 'No matching words' })).toBeVisible();
      await page.getByRole('textbox', { name: 'Search vocabulary' }).fill('');

      const chooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      await (await chooser).setFiles({ name: 'vocabulary.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ entries: [{ term: 'Echo Labs', aliases: ['duplicate'], enabled: true }, { term: 'Dioxus', aliases: ['die ox us'], enabled: true }] })) });
      await expect(page.getByRole('heading', { name: 'Dioxus', exact: true })).toBeVisible();
      assert.equal((await (await context.request.get(`${baseURL}/api/vocabulary`)).json()).entries.length, 2);
      const invalidChooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      await (await invalidChooser).setFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
      await expect(page.getByRole('alert')).toContainText('not valid JSON');
      assert.equal((await (await context.request.get(`${baseURL}/api/vocabulary`)).json()).entries.length, 2);

      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      const download = await downloadPromise;
      const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
      assert.equal(exported.entries.length, 2);
      assert.deepEqual(exported.entries.find(entry => entry.term === 'Echo Labs').aliases, ['echo labz', 'eco labs']);
      await page.screenshot({ path: `${screenshotDir}/vocabulary-desktop.png`, fullPage: true });
    });

    await t.test('backup requires an empty destination and restores the exported data', async () => {
      await page.getByRole('button', { name: 'Storage', exact: true }).click();
      await expect(page.getByText('Library location on this computer')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Choose library file' })).toBeDisabled();
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Export library' }).click();
      const backup = await downloadPromise;
      const backupPath = await backup.path();
      const exported = JSON.parse(await readFile(backupPath, 'utf8'));
      assert.equal(exported.format, 'echo-voice-web');
      assert.equal(exported.vocabulary.length, 2);
      assert.equal(exported.settings.ollamaUrl, undefined);
      await page.getByRole('button', { name: 'Vocabulary', exact: true }).click();
      await page.getByRole('button', { name: 'Remove Echo Labs', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Echo Labs', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Remove Dioxus', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Make every word feel familiar' })).toBeVisible();
      await page.getByRole('button', { name: 'Storage', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Choose library file' })).toBeEnabled();
      const wrongChooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Choose library file' }).click();
      await (await wrongChooser).setFiles({ name: 'wrong.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ entries: [] })) });
      await expect(page.getByRole('alert')).toContainText('supported Echo Voice Web');
      const restoreChooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Choose library file' }).click();
      await (await restoreChooser).setFiles({ name: 'backup.json', mimeType: 'application/json', buffer: await readFile(backupPath) });
      await page.getByRole('button', { name: 'Restore library', exact: true }).click();
      await expect(page.getByText('Your library was restored from the backup.', { exact: true })).toBeVisible();
      assert.equal((await (await context.request.get(`${baseURL}/api/vocabulary`)).json()).entries.length, 2);
      await expect(page.getByRole('button', { name: 'Choose library file' })).toBeDisabled();
      await page.screenshot({ path: `${screenshotDir}/storage-desktop.png`, fullPage: true });
    });

    await t.test('microphone permission is explicit and test tracks are released', async () => {
      await page.getByRole('button', { name: 'Help & setup', exact: true }).click();
      assert.equal(await page.evaluate(() => window.__microphoneRequests), 0);
      await page.getByRole('button', { name: 'Test microphone access', exact: true }).click();
      await expect(page.getByText('Microphone access works. The test has ended; no audio was saved.')).toBeVisible();
      assert.equal(await page.evaluate(() => window.__microphoneRequests), 1);
      assert.equal(await page.evaluate(() => window.__testTracks.length > 0 && window.__testTracks.every(track => track.readyState === 'ended')), true);
      await page.screenshot({ path: `${screenshotDir}/help-desktop.png`, fullPage: true });
    });

    await t.test('all four settings tabs fit a narrow screen', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const tab of ['General', 'Vocabulary', 'Storage', 'Help & setup']) {
        await page.getByRole('button', { name: tab, exact: true }).click();
        await expect(page.locator('.settings-page')).toBeVisible();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${tab} must not overflow the viewport`);
      }
      await page.screenshot({ path: `${screenshotDir}/help-mobile.png`, fullPage: true });
      assert.deepEqual(consoleErrors, [], 'No uncaught browser errors are expected.');
    });
  } finally {
    if (initialSettings) await context.request.patch(`${baseURL}/api/settings`, { data: initialSettings });
    if (isolatedEmpty) {
      const response = await context.request.get(`${baseURL}/api/vocabulary`);
      if (response.ok()) for (const entry of (await response.json()).entries) await context.request.delete(`${baseURL}/api/vocabulary/${entry.id}`);
    }
    await browser.close();
  }
});
