import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const base = process.env.ECHO_E2E_URL || 'http://127.0.0.1:3000';
const screenshots = process.env.ECHO_AUDIT_SCREENSHOTS || '/tmp/echo-accessibility';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
const page = await context.newPage();
const errors = [], results = [];
page.on('pageerror', error => errors.push(error.message));
await mkdir(screenshots, { recursive: true });
async function audit(name) {
  const overlay = await page.locator('[aria-modal="true"], .sidebar.open').count();
  await page.screenshot({ path: `${screenshots}/${name}.png`, fullPage: !overlay });
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'best-practice']).analyze();
  results.push({ name, violations: result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })) })) });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}: horizontal overflow`);
}
async function navigate(name) {
  if (await page.getByRole('button', { name: 'Open navigation', exact: true }).isVisible()) {
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  }
  await page.locator('.sidebar').getByRole('button', { name: new RegExp(`^${name}( \\d+)?$`) }).click();
}
try {
  await page.goto(base);
  await page.getByRole('heading', { name: 'Overview' }).waitFor();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#workspace-main')).toBeFocused();
  for (const [name, slug] of [['Overview', 'overview'], ['All meetings', 'library'], ['Models', 'models'], ['Calendar', 'calendar']]) {
    await navigate(name); await audit(`${slug}-desktop`);
  }
  const connect = page.getByRole('button', { name: 'Connect Google Calendar', exact: true });
  await connect.click();
  const close = page.getByRole('button', { name: 'Close connection setup' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Recheck connections' })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(close).toBeFocused();
  await page.keyboard.press('Control+k'); await expect(page.getByRole('dialog')).toBeVisible();
  await audit('calendar-dialog-desktop');
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(connect).toBeFocused();
  assert.equal(await page.locator('[inert]').count(), 0);
  console.log('PASS: calendar dialog focus containment, Escape, focus restoration, and shortcut isolation.');

  const newMeeting = page.getByRole('button', { name: 'New meeting', exact: true }).first();
  await newMeeting.click(); await expect(page.locator('#new-meeting-title')).toBeFocused();
  await audit('new-meeting-desktop');
  await page.keyboard.press('Escape'); await expect(newMeeting).toBeFocused();
  assert.equal(await page.locator('[inert]').count(), 0);
  console.log('PASS: recording setup focus and dismissal without requesting microphone access.');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.getByRole('heading', { name: 'Overview' }).waitFor();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeFocused();
  await expect(page.locator('.sidebar')).toBeHidden();
  const menu = page.getByRole('button', { name: 'Open navigation' });
  await menu.click(); await expect(page.locator('.sidebar .brand')).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.locator('.sidebar').getByRole('button', { name: 'Settings' })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('.sidebar .brand')).toBeFocused();
  await audit('navigation-mobile');
  await page.keyboard.press('Escape'); await expect(menu).toBeFocused(); await expect(menu).toHaveAttribute('aria-expanded', 'false');
  assert.equal(await page.locator('[inert]').count(), 0);
  for (const [name, slug] of [['Overview', 'overview'], ['Models', 'models'], ['Calendar', 'calendar']]) {
    await navigate(name); await audit(`${slug}-mobile`);
  }
  await page.getByRole('button', { name: 'Connect Google Calendar', exact: true }).click();
  await audit('calendar-dialog-mobile'); await page.keyboard.press('Escape');
  await newMeeting.click(); await audit('new-meeting-mobile'); await page.keyboard.press('Escape');
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => window.echoTheme.set(theme), theme);
    await page.reload();
    await page.getByRole('heading', { name: 'Overview', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme, 'Appearance survives reload');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const [name, slug] of [['Overview', 'overview'], ['All meetings', 'library'], ['Models', 'models'], ['Calendar', 'calendar'], ['Settings', 'settings']]) {
        await navigate(name); await audit(slug + '-' + theme + '-' + width);
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Switch to dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Switch to light mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  console.log('PASS: mobile navigation keyboard containment and responsive page/dialog layouts.');
  assert.deepEqual(errors, [], 'No browser runtime errors');
  await writeFile(`${screenshots}/results.json`, JSON.stringify(results, null, 2));
  const violations = results.filter(result => result.violations.length);
  assert.deepEqual(violations, [], 'Automated accessibility findings; see screenshot-directory results.json');
  console.log(`PASS: ${results.length} page states with zero automated accessibility findings.`);
} finally {
  await writeFile(`${screenshots}/results.json`, JSON.stringify(results, null, 2));
  await browser.close();
}
