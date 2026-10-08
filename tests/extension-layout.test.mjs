import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
import {cp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
test('popup has an intrinsic width, reachable controls at zoom, and responsive setup',async () => {
  const scratch = path.join(project,'tmp','extension-popup-layout'); await mkdir(scratch,{recursive:true}); process.env.TMPDIR = scratch;
  let browser;
  try {
    await mkdir(path.join(scratch,'fonts')); await mkdir(path.join(scratch,'icons'));
    for(const name of ['popup.html','setup.html']) {
      // A local HTML/CSS fixture only: no extension installation, runtime, account or capture controls.
      const html = (await readFile(path.join(project,'extension',name),'utf8')).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'');
      await writeFile(path.join(scratch,name),html);
    }
    await cp(path.join(project,'extension/ui.css'),path.join(scratch,'ui.css'));
    await cp(path.join(project,'public/design-tokens.css'),path.join(scratch,'design-tokens.css'));
    await cp(path.join(project,'public/favicon.svg'),path.join(scratch,'icons/echo.svg'));
    for(const name of ['inter-400.woff2','inter-500.woff2','inter-600.woff2']) await cp(path.join(project,'public/fonts',name),path.join(scratch,'fonts',name));
    const executablePath = process.env.CHROMIUM_PATH || (process.platform === 'darwin' ? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser':'/usr/bin/chromium');
    browser = await chromium.launch({executablePath,headless:true,env:{...process.env,TMPDIR:scratch}});
    const page = await browser.newPage({viewport:{width:190,height:600}}); await page.goto(pathToFileURL(path.join(scratch,'popup.html')).href);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.getBoundingClientRect().width),390,'intrinsic width must not collapse to the initial 190px host viewport');
    await page.setViewportSize({width:390,height:600});
    await page.evaluate(() => {
      document.getElementById('mic-device-field').hidden=false;
      document.getElementById('mic-device').add(new Option('System default microphone','default'));
      document.getElementById('meeting').textContent='Google Meet · This tab is ready.';
    });
    const normal = await page.evaluate(() => {
      const heading = document.querySelector('#start-panel h1');const start = document.getElementById('start').getBoundingClientRect();
      return {headingLines:Math.round(heading.getBoundingClientRect().height/parseFloat(getComputedStyle(heading).lineHeight)),startBottom:start.bottom,titleWidth:document.getElementById('title').getBoundingClientRect().width,scrollWidth:document.documentElement.scrollWidth};
    });
    assert.equal(normal.headingLines,1);assert.ok(normal.startBottom<=600,JSON.stringify(normal));assert.ok(normal.titleWidth>=300,JSON.stringify(normal));assert.equal(normal.scrollWidth,390);
    for(const zoom of [1.5,2]) {
      await page.setViewportSize({width:Math.round(390*zoom),height:600});await page.evaluate(zoom => {document.documentElement.style.zoom=String(zoom)},zoom);
      const width = await page.evaluate(() => document.documentElement.scrollWidth);assert.ok(width<=Math.round(390*zoom),`horizontal overflow at ${zoom}x`);
      await page.locator('#start').scrollIntoViewIfNeeded();const bounds = await page.locator('#start').boundingBox();assert.ok(bounds.y>=0&&bounds.y+bounds.height<=600,`Start reachable at ${zoom}x: ${JSON.stringify(bounds)}`);
    }
    await page.goto(pathToFileURL(path.join(scratch,'setup.html')).href);await page.setViewportSize({width:320,height:600});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth),320,'setup stays responsive at 320px');
    console.log(`Popup layout: ${normal.titleWidth}px input; one-line heading; Start bottom ${normal.startBottom}px; 150%/200% zoom reachable; setup 320px.`);
  } finally {if(browser)await browser.close();await rm(scratch,{recursive:true,force:true,maxRetries:3});}
});
