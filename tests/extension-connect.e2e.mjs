import { chromium, expect } from '@playwright/test';

const base = process.env.ECHO_E2E_URL || 'http://localhost:3100';
const requestId = '11111111-1111-4111-8111-111111111111';
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  headless: true,
});
try {
  for (const action of ['approve', 'reject']) {
    const page = await browser.newPage({ viewport: { width: 375, height: 812 } });
    await page.route(`**/api/extensions/requests/${requestId}**`, async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          json: {
            requestId,
            name: 'Test browser',
            origin: `chrome-extension://${'a'.repeat(32)}`,
            status: 'pending',
            expiresAt: Math.floor(Date.now() / 1000) + 600,
          },
        });
      } else {
        expect(new URL(route.request().url()).pathname).toBe(
          `/api/extensions/requests/${requestId}/${action}`,
        );
        await route.fulfill({ json: { status: action === 'approve' ? 'approved' : 'rejected' } });
      }
    });
    await page.goto(`${base}/extension-connect.html#request=${requestId}`);
    await expect(page.getByText('Test browser')).toBeVisible();
    await page
      .getByRole('button', { name: action === 'approve' ? 'Allow' : "Don't allow", exact: true })
      .click();
    await expect(page.getByRole('status')).toHaveText(
      action === 'approve'
        ? 'You can close this tab.'
        : 'Start again from the Echo extension: click the Echo icon, then Connect to Echo.',
    );
    await expect(
      page.getByRole('heading', {
        name: action === 'approve' ? 'Browser connected' : 'Connection declined',
      }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to Echo' })).toBeVisible();
    await page.close();
  }
  console.log('PASS: extension approval and rejection');
} finally {
  await browser.close();
}
