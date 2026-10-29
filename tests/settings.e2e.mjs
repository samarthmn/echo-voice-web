import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { decodeBackup } from './helpers/encrypted-backup.mjs';

// Run against a fresh local data directory, for example:
// ECHO_DATA_DIR="$PWD/tmp/echo-settings-e2e" ECHO_BIND=127.0.0.1:3011 ./target/debug/echo-server
// ECHO_E2E_URL=http://localhost:3011 node tests/settings.e2e.mjs
const baseURL = process.env.ECHO_E2E_URL || 'http://localhost:3011';
const screenshotDir =
  process.env.ECHO_E2E_SCREENSHOTS || path.resolve('tmp/echo-settings-screenshots');

test(
  'Settings persist local preferences, vocabulary, backups, and explicit microphone access',
  { timeout: 120_000 },
  async (t) => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: [
        '--no-sandbox',
        '--use-fake-device-for-media-stream',
        '--use-fake-ui-for-media-stream',
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1060 },
      acceptDownloads: true,
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    await page.addInitScript(() => {
      window.__microphoneRequests = 0;
      window.__testTracks = [];
      const original = navigator.mediaDevices?.getUserMedia.bind(navigator.mediaDevices);
      if (original)
        navigator.mediaDevices.getUserMedia = async (...args) => {
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
      const initialVocabulary = await (
        await context.request.get(`${baseURL}/api/vocabulary`)
      ).json();
      const initialMeetings = await (await context.request.get(`${baseURL}/api/meetings`)).json();
      assert.equal(
        initialVocabulary.entries.length,
        0,
        'Run the suite with an empty test vocabulary.',
      );
      assert.equal(
        initialMeetings.meetings.length,
        0,
        'Run the suite with an empty test meeting library.',
      );
      isolatedEmpty = true;
      initialSettings = await (await context.request.get(`${baseURL}/api/settings`)).json();
      await page.goto(baseURL);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      assert.equal(await page.evaluate(() => window.__microphoneRequests), 0);

      await t.test('preferences save multilingual model/language choices', async () => {
        await page
          .getByRole('textbox', { name: 'Your name', exact: true })
          .fill('Settings verification');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
        assert.equal(
          (await (await context.request.get(`${baseURL}/api/settings`)).json()).name,
          'Settings verification',
        );
        await page
          .locator('select')
          .filter({ has: page.locator('option[value="auto"]') })
          .selectOption('fr');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
        assert.equal(
          (await (await context.request.get(`${baseURL}/api/settings`)).json()).language,
          'fr',
        );
        const speechSelect = page
          .locator('select')
          .filter({ has: page.locator('option[value="onnx-community/whisper-large-v3"]') });
        await speechSelect.selectOption('onnx-community/whisper-large-v3');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
        await page.route('**/api/settings', async (route) => {
          if (route.request().method() === 'GET')
            await new Promise((resolve) => setTimeout(resolve, 350));
          await route.continue();
        });
        await page.reload();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await page
          .getByRole('textbox', { name: 'Your name', exact: true })
          .fill('Keep this unsaved edit');
        await expect(
          page.locator('select').filter({ has: page.locator('option[value="auto"]') }),
        ).toHaveValue('fr');
        await expect(
          page
            .locator('select')
            .filter({ has: page.locator('option[value="onnx-community/whisper-large-v3"]') }),
        ).toHaveValue('onnx-community/whisper-large-v3');
        await expect(page.getByRole('textbox', { name: 'Your name', exact: true })).toHaveValue(
          'Keep this unsaved edit',
        );
        await page.unroute('**/api/settings');
        await page
          .locator('select')
          .filter({ has: page.locator('option[value="auto"]') })
          .selectOption(initialSettings.language);
        await page
          .locator('select')
          .filter({ has: page.locator('option[value="onnx-community/whisper-large-v3"]') })
          .selectOption(initialSettings.speechModel);
        await page
          .getByRole('textbox', { name: 'Your name', exact: true })
          .fill(initialSettings.name);
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(page.getByText('Changes saved', { exact: true })).toBeVisible();
        await page.screenshot({ path: `${screenshotDir}/general-desktop.png`, fullPage: true });
      });

      await t.test(
        'Notes model choices follow Ollama and legacy cloud preferences save locally',
        async () => {
          let status = { available: false, models: [] };
          await page.route('**/api/notes', (route) => route.fulfill({ json: status }));
          await page.route('**/api/settings', async (route) => {
            if (route.request().method() !== 'GET') return route.continue();
            const response = await route.fetch();
            const settings = await response.json();
            settings.notesProvider = 'chatgpt';
            settings.notesModel = 'missing:latest';
            await route.fulfill({ response, json: settings });
          });
          await page.reload();
          await page.getByRole('button', { name: 'Settings', exact: true }).click();
          const provider = page.getByRole('combobox', { name: /Default notes provider/ });
          const model = page.getByRole('combobox', { name: 'Default local notes model' });
          await expect(provider).toHaveValue('ollama');
          await expect(provider.locator('option')).toHaveCount(1);
          await expect(model).toBeDisabled();
          await expect(model).toContainText('Start Ollama to choose a model');
          status = { available: true, models: [] };
          await page.getByRole('button', { name: 'Check connection', exact: true }).click();
          await expect(page.getByText(/No models installed yet/)).toBeVisible();
          status = { available: true, models: ['fixture:latest'] };
          await page.getByRole('button', { name: 'Refresh installed models' }).click();
          await expect(model).toContainText('missing:latest (not installed)');
          await expect(model).toHaveValue('missing:latest');
          await expect(model).toContainText('fixture:latest (installed)');
          status = { available: true, models: ['fixture:latest', 'missing:latest'] };
          await page.getByRole('button', { name: 'Refresh installed models' }).click();
          await expect(model).toContainText('missing:latest (installed)');
          await expect(model).toHaveValue('missing:latest');
          await model.selectOption('fixture:latest');
          await page.getByRole('button', { name: 'Save changes', exact: true }).click();
          await expect
            .poll(
              async () =>
                (await (await context.request.get(`${baseURL}/api/settings`)).json()).notesProvider,
            )
            .toBe('ollama');
          await page.unroute('**/api/settings');
          await page.unroute('**/api/notes');
        },
      );

      await t.test('saving a new Ollama address refreshes models without remounting', async () => {
        let savedAddress = 'http://old-ollama:11434';
        let notesRequests = 0;
        let savedSettings;
        await page.route('**/api/settings', async (route) => {
          if (route.request().method() === 'PATCH') {
            savedSettings = route.request().postDataJSON();
            savedAddress = savedSettings.ollamaUrl;
          } else {
            savedSettings = await (await route.fetch()).json();
          }
          savedSettings.ollamaUrl = savedAddress;
          savedSettings.notesModel = 'saved:latest';
          await route.fulfill({ json: savedSettings });
        });
        await page.route('**/api/notes', async (route) => {
          notesRequests++;
          await new Promise((resolve) => setTimeout(resolve, 200));
          await route.fulfill({
            json: {
              available: true,
              models: savedAddress.includes('old-ollama')
                ? ['first:latest', 'saved:latest']
                : ['new:latest', 'saved:latest'],
            },
          });
        });
        await page.reload();
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const model = page.getByRole('combobox', { name: 'Default local notes model' });
        await expect(model).toContainText('first:latest (installed)');
        await expect(model).toHaveValue('saved:latest');
        const beforeSave = notesRequests;
        await page.getByText('Local notes connection', { exact: true }).click();
        await page.getByRole('textbox', { name: 'Ollama address' }).fill('http://new-ollama:11434');
        await page.getByRole('button', { name: 'Save changes', exact: true }).click();
        await expect(model).toContainText('new:latest (installed)');
        await expect(model).not.toContainText('first:latest');
        await expect(model).toHaveValue('saved:latest');
        assert.ok(notesRequests > beforeSave);
        await page.unroute('**/api/settings');
        await page.unroute('**/api/notes');
      });

      await t.test('localhost recognizes an IP-paired extension', async () => {
        await page.route('**/api/extensions/connections', (route) =>
          route.fulfill({ json: { connections: [], libraryId: 'library-1' } }),
        );
        await page.evaluate(() => {
          window.echoExtensionMessage = async () => ({
            installed: true,
            status: 'connected',
            endpoint: `http://127.0.0.1:${location.port}`,
            libraryId: 'library-1',
          });
        });
        await page.getByRole('button', { name: 'Browser extension', exact: true }).click();
        const panel = page.getByRole('region', { name: 'Browser extension connection' });
        await expect(panel.getByText('Connected', { exact: true })).toBeVisible();
        await expect(panel.getByText(/Connect it to this Echo instead/)).toHaveCount(0);
        await expect(panel.getByRole('button', { name: 'Connect browser extension' })).toHaveCount(
          0,
        );
        await page.unroute('**/api/extensions/connections');
      });

      await t.test(
        'vocabulary editing, filtering, toggling, import validation and export',
        async () => {
          await page.getByRole('button', { name: 'Vocabulary', exact: true }).click();
          await page.getByRole('button', { name: 'Add word', exact: true }).click();
          await expect(page.getByPlaceholder('e.g. Figma')).toBeFocused();
          await page.getByPlaceholder('e.g. Figma').fill('Echo Research');
          await page.getByPlaceholder('e.g. fig ma, figmah').fill('echo resurch, eco research');
          await page.getByRole('button', { name: 'Save word', exact: true }).click();
          await expect(
            page.getByRole('heading', { name: 'Echo Research', exact: true }),
          ).toBeVisible();
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
          await expect(page.getByRole('switch', { name: 'Enable Echo Labs' })).toHaveAttribute(
            'aria-checked',
            'true',
          );
          await page.getByRole('textbox', { name: 'Search vocabulary' }).fill('eco labs');
          await expect(page.getByRole('heading', { name: 'Echo Labs', exact: true })).toBeVisible();
          await page.getByRole('textbox', { name: 'Search vocabulary' }).fill('no-match');
          await expect(page.getByRole('heading', { name: 'No matching words' })).toBeVisible();
          await page.getByRole('textbox', { name: 'Search vocabulary' }).fill('');

          const chooser = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: 'Import', exact: true }).click();
          await (
            await chooser
          ).setFiles({
            name: 'vocabulary.json',
            mimeType: 'application/json',
            buffer: Buffer.from(
              JSON.stringify({
                entries: [
                  { term: 'Echo Labs', aliases: ['duplicate'], enabled: true },
                  { term: 'Dioxus', aliases: ['die ox us'], enabled: true },
                ],
              }),
            ),
          });
          await expect(page.getByRole('heading', { name: 'Dioxus', exact: true })).toBeVisible();
          assert.equal(
            (await (await context.request.get(`${baseURL}/api/vocabulary`)).json()).entries.length,
            2,
          );
          const invalidChooser = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: 'Import', exact: true }).click();
          await (
            await invalidChooser
          ).setFiles({
            name: 'invalid.json',
            mimeType: 'application/json',
            buffer: Buffer.from('{broken'),
          });
          await expect(page.getByRole('alert')).toContainText('not valid JSON');
          assert.equal(
            (await (await context.request.get(`${baseURL}/api/vocabulary`)).json()).entries.length,
            2,
          );

          const downloadPromise = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Export', exact: true }).click();
          const download = await downloadPromise;
          const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
          assert.equal(exported.entries.length, 2);
          assert.deepEqual(exported.entries.find((entry) => entry.term === 'Echo Labs').aliases, [
            'echo labz',
            'eco labs',
          ]);
          await page.screenshot({
            path: `${screenshotDir}/vocabulary-desktop.png`,
            fullPage: true,
          });
        },
      );

      await t.test(
        'backup requires an empty destination and restores the exported data',
        async () => {
          await page.getByRole('button', { name: 'Storage', exact: true }).click();
          await expect(page.getByText('Library location on this computer')).toBeVisible();
          await expect(page.getByRole('button', { name: 'Choose library file' })).toBeDisabled();
          await expect(
            page.getByRole('button', { name: 'Export library', exact: true }),
          ).toBeDisabled();
          await page.getByRole('button', { name: 'Save recovery phrase', exact: true }).click();
          await expect(page.locator('.recovery-words li')).toHaveCount(24);
          // Synthetic test-library phrase stays in memory and never enters screenshots/logs.
          const phraseWords = await page.locator('.recovery-words li').allTextContents();
          await page.setViewportSize({ width: 320, height: 740 });
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            true,
            'Recovery words fit at 320px',
          );
          await page.getByRole('button', { name: 'I saved the phrase', exact: true }).click();
          await expect(page.locator('.recovery-words')).toHaveCount(0);
          await page.getByLabel('Word 3', { exact: true }).fill('incorrect');
          await page.getByLabel('Word 11', { exact: true }).fill(phraseWords[10]);
          await page.getByLabel('Word 20', { exact: true }).fill(phraseWords[19]);
          await page.getByRole('button', { name: 'Confirm recovery phrase', exact: true }).click();
          await expect(page.getByRole('alert')).toBeVisible();
          await expect(
            page.getByRole('button', { name: 'Export library', exact: true }),
          ).toBeDisabled();
          await page.getByLabel('Word 3', { exact: true }).fill(phraseWords[2]);
          await page.getByRole('button', { name: 'Confirm recovery phrase', exact: true }).click();
          await expect(page.getByText('Recovery phrase saved', { exact: true })).toBeVisible();
          await page.setViewportSize({ width: 1440, height: 1060 });
          const downloadPromise = page.waitForEvent('download');
          await page.getByRole('button', { name: 'Export library' }).click();
          const backup = await downloadPromise;
          const backupPath = await backup.path();
          const envelope = JSON.parse(await readFile(backupPath, 'utf8'));
          assert.equal(envelope.format, 'echo-voice-encrypted');
          assert.ok(!JSON.stringify(envelope).includes('Echo Labs'));
          const exported = decodeBackup(envelope, phraseWords.join(' '));
          assert.equal(exported.format, 'echo-voice-web');
          assert.equal(exported.vocabulary.length, 2);
          assert.equal(exported.settings.ollamaUrl, undefined);
          await page.getByRole('button', { name: 'Vocabulary', exact: true }).click();
          await page.getByRole('button', { name: 'Remove Echo Labs', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'Echo Labs', exact: true })).toHaveCount(
            0,
          );
          await page.getByRole('button', { name: 'Remove Dioxus', exact: true }).click();
          await expect(page.getByRole('heading', { name: 'No vocabulary yet' })).toBeVisible();
          await page.getByRole('button', { name: 'Storage', exact: true }).click();
          await expect(page.getByRole('button', { name: 'Choose library file' })).toBeEnabled();
          const wrongChooser = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: 'Choose library file' }).click();
          await (
            await wrongChooser
          ).setFiles({
            name: 'wrong.json',
            mimeType: 'application/json',
            buffer: Buffer.from(JSON.stringify({ entries: [] })),
          });
          await expect(page.getByRole('alert')).toContainText('supported Echo library backup');
          const restoreChooser = page.waitForEvent('filechooser');
          await page.getByRole('button', { name: 'Choose library file' }).click();
          await (
            await restoreChooser
          ).setFiles({
            name: 'backup.json',
            mimeType: 'application/json',
            buffer: await readFile(backupPath),
          });
          await page.getByRole('button', { name: 'Restore library', exact: true }).click();
          await expect(
            page.getByText('Your library was restored from the backup.', { exact: true }),
          ).toBeVisible();
          assert.equal(
            (await (await context.request.get(`${baseURL}/api/vocabulary`)).json()).entries.length,
            2,
          );
          await expect(page.getByRole('button', { name: 'Choose library file' })).toBeDisabled();
          await page.screenshot({ path: `${screenshotDir}/storage-desktop.png`, fullPage: true });
        },
      );

      await t.test('microphone permission is explicit and test tracks are released', async () => {
        await page.getByRole('button', { name: 'New meeting', exact: true }).click();
        assert.equal(await page.evaluate(() => window.__microphoneRequests), 0);
        await page.getByRole('button', { name: 'Test access', exact: true }).click();
        await expect(page.getByText('Microphone access is ready', { exact: true })).toBeVisible();
        assert.equal(await page.evaluate(() => window.__microphoneRequests), 1);
        assert.equal(
          await page.evaluate(
            () =>
              window.__testTracks.length > 0 &&
              window.__testTracks.every((track) => track.readyState === 'ended'),
          ),
          true,
        );
        await page.getByRole('button', { name: 'Close new meeting', exact: true }).click();
      });

      await t.test('all three settings tabs fit a narrow screen', async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        for (const tab of ['General', 'Vocabulary', 'Storage']) {
          await page.getByRole('button', { name: tab, exact: true }).click();
          await expect(page.locator('.settings-page')).toBeVisible();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
            true,
            `${tab} must not overflow the viewport`,
          );
        }
        await page.screenshot({ path: `${screenshotDir}/help-mobile.png`, fullPage: true });
        assert.deepEqual(consoleErrors, [], 'No uncaught browser errors are expected.');
      });
    } finally {
      if (initialSettings)
        await context.request.patch(`${baseURL}/api/settings`, { data: initialSettings });
      if (isolatedEmpty) {
        const response = await context.request.get(`${baseURL}/api/vocabulary`);
        if (response.ok())
          for (const entry of (await response.json()).entries)
            await context.request.delete(`${baseURL}/api/vocabulary/${entry.id}`);
      }
      await browser.close();
    }
  },
);
