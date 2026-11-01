import type { Page } from '@playwright/test';

/**
 * Open an extension page. A freshly installed extension's pages reload once if
 * they load before the matching service worker is running (the extension's
 * stale-worker recovery). That reload can interrupt Playwright's navigation to
 * the same URL; it is benign, so wait for the page to finish loading instead.
 */
export async function openExtensionPage(page: Page, url: string): Promise<void> {
  try {
    await page.goto(url);
  } catch (error) {
    if (!String(error).includes('interrupted by another navigation')) throw error;
    await page.waitForURL(url);
    await page.waitForLoadState('load');
  }
}
