import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = process.cwd(), data = await mkdtemp(path.join(tmpdir(), 'echo-workspace-e2e-'));
const socket = createServer();
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.env.ECHO_TEST_BINARY || 'target/debug/echo-server', [], {
 cwd: root, env: { ...process.env, ECHO_DATA_DIR: data, ECHO_BIND: `127.0.0.1:${port}`, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }, stdio: 'pipe',
});
let browser, serverError, serverExited = false, serverLog = '';
const errors = [];
server.stdout.on('data', value => { serverLog = (serverLog + value).slice(-8000); });
server.stderr.on('data', value => { serverLog = (serverLog + value).slice(-8000); });
const serverExit = new Promise(resolve => {
 server.once('error', error => { serverError = error; serverExited = true; resolve(); });
 server.once('exit', () => { serverExited = true; resolve(); });
});
function requireServer() {
 if (serverError) throw new Error(`The isolated workspace test server could not start: ${serverError.message}`);
 if (serverExited) throw new Error(`The isolated workspace test server exited. Refusing to use another workspace. ${serverLog}`);
}
async function ready() {
 const deadline = Date.now() + 15000;
 while (Date.now() < deadline) {
  requireServer();
  let storage;
  try {
   const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
   if (health.ok) {
    const response = await fetch(`${base}/api/storage`, { signal: AbortSignal.timeout(1000) });
    if (response.ok) storage = await response.json();
   }
  } catch {}
  requireServer();
  if (storage) {
   if (typeof storage.path !== 'string' || path.resolve(storage.path) !== path.resolve(data)) throw new Error('The workspace test port belongs to another data folder. Refusing to run tests against it.');
   return;
  }
  await delay(100);
 }
 throw new Error(`The isolated workspace test server did not become ready within 15 seconds. ${serverLog}`);
}
async function shutdown() {
 if (!serverExited) server.kill('SIGINT');
 await Promise.race([serverExit, delay(2000, undefined, { ref: false })]);
 if (!serverExited) { server.kill('SIGKILL'); await Promise.race([serverExit, delay(1000, undefined, { ref: false })]); }
 if (serverExited) await rm(data, { recursive: true, force: true });
 else console.error(`The test server did not exit; isolated data was preserved at ${data}.`);
}
try{
 await ready();
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
 const context=await browser.newContext({viewport:{width:1440,height:1050},permissions:['microphone'],reducedMotion:'reduce'});const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!m.text().includes('Failed to load resource'))errors.push(m.text())});
 await page.goto(base);await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();assert.equal(await page.locator('.boot-screen').count(),0);
 await page.getByRole('button',{name:'New meeting',exact:true}).click();await page.getByRole('heading', { name: 'New meeting', exact: true }).waitFor();assert.equal(await page.getByRole('button',{name:'Start recording',exact:true}).isDisabled(),true);
 await page.getByLabel('Meeting name Optional').fill('Browser recording check');
 await page.getByText('I have permission from everyone being recorded.').click();
 await page.evaluate(() => {
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  window.__startupOriginalGetUserMedia = original;
  navigator.mediaDevices.getUserMedia = async (...args) => {
   await new Promise(resolve => { window.__releaseStartupMicrophone = resolve; });
   return original(...args);
  };
 });
 await page.getByRole('button',{name:'Start recording',exact:true}).click();
 await page.waitForFunction(() => typeof window.__releaseStartupMicrophone === 'function');
 assert.equal(await page.getByRole('dialog').getByRole('button',{name:/Online meeting/}).isDisabled(),true,'Cannot switch modes while microphone startup is pending');
 assert.equal(await page.getByLabel('I have permission from everyone being recorded.').isDisabled(),true,'Consent cannot be changed after recording startup begins');
 await page.evaluate(() => {
  navigator.mediaDevices.getUserMedia = window.__startupOriginalGetUserMedia;
  window.__releaseStartupMicrophone();
  delete window.__startupOriginalGetUserMedia; delete window.__releaseStartupMicrophone;
 });
 await page.getByRole('region',{name:'Active recording controls'}).waitFor();
 await page.locator('#new-meeting-dialog').waitFor({state:'detached'});
 for (const width of [320, 390]) {
  await page.setViewportSize({ width, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Active recording controls must fit a mobile viewport');
 }
 await page.setViewportSize({ width: 1440, height: 1050 });
 await page.keyboard.press('Control+j');
 await page.waitForTimeout(150);
 assert.equal(await page.getByRole('dialog').count(),0,'New-meeting shortcut stays disabled during active recording');
 await page.getByRole('button',{name:'Models',exact:true}).click();await page.getByRole('heading', { name: 'Models', exact: true }).waitFor();await page.getByRole('button',{name:'Pause recording',exact:true}).click();await page.getByText('Recording paused',{exact:true}).waitFor();await page.getByRole('button',{name:'Resume recording',exact:true}).click();await page.getByRole('button',{name:'Mute capture',exact:true}).click();await page.getByRole('button',{name:'Unmute capture',exact:true}).waitFor();await page.getByRole('button',{name:'Unmute capture',exact:true}).click();await page.waitForTimeout(1400);await page.getByRole('button',{name:'Stop & save',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.recorder-bar'),{timeout:15000});
 const library=await(await fetch(`${base}/api/meetings`)).json();assert.equal(library.meetings.length,1);const meeting=library.meetings[0];assert.equal(meeting.title,'Browser recording check');assert.equal(meeting.status,'saved');assert.equal(meeting.tracks.length,1);assert.ok(meeting.tracks[0].bytes>1000);assert.ok(meeting.duration>1);console.log('PASS: actual UI capture, persistent controls, pause/mute/resume, final saved audio.');
 await page.keyboard.press('Control+k');await page.locator('#library-search').waitFor();await page.locator('#library-search').fill('Browser recording');assert.equal(await page.locator('.meeting-card').count(),1);await page.locator('#library-search').fill('No such conversation');await page.getByRole('heading',{name:'No meetings found.'}).waitFor();console.log('PASS: keyboard search and empty search state.');
 await page.getByRole('button',{name:'New meeting',exact:true}).first().click();await page.getByLabel('Meeting name Optional').fill('Denied microphone test');await page.getByText('I have permission from everyone being recorded.').click();await page.evaluate(()=>{window.__originalGetUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Permission denied','NotAllowedError')}});await page.getByRole('button',{name:'Start recording',exact:true}).click();await page.getByRole('alert').filter({hasText:'Microphone permission was denied'}).waitFor();await page.getByRole('button',{name:'Close new meeting',exact:true}).click();assert.equal(await page.getByRole('button',{name:'New meeting',exact:true}).first().isEnabled(),true);assert.equal(await page.locator('.recorder-bar').count(),0);await page.evaluate(()=>navigator.mediaDevices.getUserMedia=window.__originalGetUserMedia);console.log('PASS: denied microphone shows actionable error and allows a new attempt.');

 await page.getByRole('button',{name:'Calendar',exact:true}).click();await page.getByRole('heading', { name: 'Calendar', exact: true }).waitFor();await page.getByRole('button',{name:'Connect calendar',exact:true}).click();await page.getByRole('heading',{name:'Calendar setup'}).waitFor();await page.getByRole('button',{name:'Close connection setup'}).click();console.log('PASS: calendar clearly requires real connection setup.');
 await page.setViewportSize({width:390,height:844});for(const [nav,title] of [['Overview','Overview'],['Models','Models'],['Calendar','Calendar']]){await page.getByRole('button',{name:'Open navigation',exact:true}).click();await page.getByRole('button',{name:nav,exact:true}).click();await page.getByRole('heading',{name:title,exact:true}).waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${nav} overflow`);}
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();
 await page.locator('.sidebar .brand').click();
 await page.getByRole('heading',{name:'Overview',exact:true}).waitFor();
 assert.equal(await page.locator('.sidebar.open').count(),0,'Brand navigation closes the mobile drawer');
 assert.equal(await page.locator('[inert]').count(),0,'Brand navigation releases the underlying workspace');
 console.log('PASS: mobile navigation and no horizontal overflow on core screens.');assert.deepEqual(errors,[]);console.log('PASS: zero browser page or console errors.');
}catch(e){if(browser){const pages=browser.contexts().flatMap(c=>c.pages());const artifacts=process.env.ECHO_WORKSPACE_TEST_ARTIFACTS||path.join(root,'tmp','workspace-test');await mkdir(artifacts,{recursive:true});await pages[0]?.screenshot({path:path.join(artifacts,'failure.png'),fullPage:true,timeout:5000}).catch(()=>{});}throw e;}
finally{try{await browser?.close();}finally{await shutdown();}}
