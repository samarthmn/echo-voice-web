import { constants } from 'node:fs';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

export async function resolveChromium() {
  const explicit = process.env.CHROMIUM_PATH;
  const candidates = explicit
    ? [explicit]
    : [
        chromium.executablePath(),
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      ];
  for (const candidate of candidates) {
    try {
      const resolved = await realpath(path.resolve(candidate));
      await access(resolved, constants.X_OK);
      return resolved;
    } catch {
      // Try the next installed browser.
    }
  }
  throw new Error(
    explicit
      ? `CHROMIUM_PATH is not an executable browser: ${explicit}`
      : 'No Chromium browser found. Run pnpm exec playwright install chromium or set CHROMIUM_PATH.',
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(await resolveChromium());
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
