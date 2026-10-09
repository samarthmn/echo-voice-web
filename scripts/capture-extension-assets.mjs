import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {access, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {chromium} from '@playwright/test';
import {buildExtension, EXTENSION_FILES} from './build-extension.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(project, 'docs', 'extension-assets');
const temporary = path.join(project, 'tmp');
await mkdir(temporary, {recursive: true});
const scratch = await mkdtemp(path.join(temporary, 'extension-store-assets-'));
const previousTmp = process.env.TMPDIR;
process.env.TMPDIR = temporary;
const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin'
  ? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' : '/usr/bin/chromium');
// The fresh extension is unpaired. Also block network traffic at the browser
// proxy so neither this computer's Echo library nor any account can be reached.
const denyProxy = createServer((_request, response) => {response.writeHead(403); response.end();});
denyProxy.on('connect', (_request, socket) => socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'));
let context;
const hashes = {};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function capture(page, name, width, height) {
  await page.setViewportSize({width, height});
  await page.evaluate(async ({width, height}) => {
    await document.fonts.ready;
    // A viewport resize and font completion can precede the compositor's new
    // frame. Wait for layout/paint before capturing responsive or fixed content.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    assertViewport();
    function assertViewport() {
      if (window.innerWidth !== width || window.innerHeight !== height) {
        throw new Error('Capture viewport has not reached the requested dimensions.');
      }
    }
  }, {width, height});
  const png = await page.screenshot({animations: 'disabled', fullPage: false, type: 'png'});
  assert.equal(png.readUInt32BE(16), width);
  assert.equal(png.readUInt32BE(20), height);
  assert.equal(png[24], 8, 'PNG must use eight bits per color channel');
  assert.equal(png[25], 2, 'Store image must be RGB without an alpha channel');
  await writeFile(path.join(output, name), png);
  hashes[name] = {width, height, sha256: digest(png)};
}
try {
  await access(executablePath);
  const built = await buildExtension({outdir: path.join(scratch, 'unpacked')});
  await new Promise((resolve, reject) => {denyProxy.once('error', reject); denyProxy.listen(0, '127.0.0.1', resolve);});
  context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
    executablePath, headless: true, viewport: {width: 1280, height: 800}, deviceScaleFactor: 1,
    colorScheme: 'light', locale: 'en-US', timezoneId: 'UTC',
    proxy: {server: `http://127.0.0.1:${denyProxy.address().port}`},
    args: [`--disable-extensions-except=${built.outdir}`, `--load-extension=${built.outdir}`,
      '--proxy-bypass-list=<-loopback>', '--disable-background-networking'],
    env: {...process.env, TMPDIR: temporary},
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', {timeout: 20000});
  assert.equal(worker.url(), `chrome-extension://${built.extensionId}/background.js`);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${built.extensionId}/setup.html`);
  await page.getByRole('button', {name: 'Create recovery phrase', exact: true}).waitFor();
  await page.getByRole('button', {name: 'Enable Google Meet', exact: true}).waitFor();
  const state = await page.evaluate(async () => (await chrome.runtime.sendMessage({type: 'STATE'})).value);
  assert.equal(state.recordings.length, 0);
  assert.ok(!state.settings.activeLibraryId);
  assert.ok(!state.vault.ready);
  assert.equal(await page.locator('#vault-phrase li').count(), 0);
  assert.ok(await page.locator('#error').isHidden());
  await capture(page, 'setup-protection-1280x800.png', 1280, 800);

  // Real user navigation only. Do not seed storage, grant permissions, inject
  // fixture recordings, alter the DOM, or simulate a connected destination.
  await page.locator('#provider-step > summary').scrollIntoViewIfNeeded();
  await page.evaluate(() => document.querySelector('#provider-step').scrollIntoView({block: 'start'}));
  assert.equal(await page.locator('#vault-phrase li').count(), 0);
  assert.ok(await page.locator('#ready').isHidden());
  await capture(page, 'setup-choices-1280x800.png', 1280, 800);
  assert.deepEqual(errors, []);

  const promo = await context.newPage();
  await promo.goto(pathToFileURL(path.join(output, 'promo.html')).href);
  await promo.locator('.brand img').waitFor();
  assert.ok(await promo.locator('.brand img').evaluate(image => image.complete && image.naturalWidth > 0));
  await capture(promo, 'promo-440x280.png', 440, 280);
  const bundleHashes = {};
  for (const file of EXTENSION_FILES) bundleHashes[file] = digest(await readFile(path.join(built.outdir, file)));
  const sourceHashes = {};
  for (const file of ['scripts/capture-extension-assets.mjs', 'docs/extension-assets/promo.html', 'public/fonts/inter.css']) {
    sourceHashes[file] = digest(await readFile(path.join(project, file)));
  }
  await writeFile(path.join(output, 'capture-provenance.json'), JSON.stringify({
    capturedAt: new Date().toISOString(), extensionVersion: built.version,
    browserVersion: context.browser().version(), extensionId: built.extensionId,
    source: 'Unmodified buildExtension output; fresh isolated profile; all HTTP(S) denied by local proxy.',
    states: {initial: 'Unpaired, no recordings, no recovery phrase generated, no provider permissions.',
      choices: 'Same initial setup, scrolled to meeting-service and microphone choices; no permissions granted.'},
    assets: hashes, bundleHashes, sourceHashes,
    pending: ['Approved connected destination', 'Actual qualified recording and pause', 'Saved recording and recovery history', 'Current companion workspace'],
  }, null, 2) + '\n');
  console.log(`Prepared ${Object.keys(hashes).length} draft images in docs/extension-assets; no accounts, recording, or recovery words used.`);
} finally {
  await context?.close();
  denyProxy.closeAllConnections();
  if (denyProxy.listening) await new Promise(resolve => denyProxy.close(resolve));
  await rm(scratch, {recursive: true, force: true, maxRetries: 3});
  if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp;
}
