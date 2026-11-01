import { chromium } from '@playwright/test';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromium } from './browser-path.ts';

/**
 * Render every raster brand asset from brand/logo.svg (see brand/README.md).
 * Outputs are committed; rerun after changing the logo: `pnpm build:brand`.
 */
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const brand = path.join(project, 'brand');
const BG = '#f5ead8';
const TEXT = '#201e1d';
const MUTED = '#645c50';
const ACCENT_TEXT = '#8c491a';

async function fontFace(family: string, file: string, weight: string): Promise<string> {
  const data = await readFile(path.join(project, 'public', 'fonts', file));
  return `@font-face{font-family:'${family}';font-weight:${weight};src:url(data:font/woff2;base64,${data.toString('base64')}) format('woff2')}`;
}

const logo = await readFile(path.join(brand, 'logo.svg'), 'utf8');
const fonts = await fontFace('Mulish', 'mulish-latin-wght-normal.woff2', '200 1000');

function page(body: string, background = 'transparent'): string {
  return `<!doctype html><meta charset="utf-8"><style>${fonts}
    *{box-sizing:border-box;margin:0}html,body{width:100%;height:100%;background:${background}}
    body{font-family:Mulish,sans-serif;color:${TEXT};display:flex}
    .mark svg{display:block;width:100%;height:100%}
    h1{font-weight:850;letter-spacing:-0.03em;line-height:1}
    p{text-wrap:balance}
  </style>${body}`;
}

/** The logo filling a square canvas, inset by `padding` (fraction of the size). */
function icon(padding: number, background = 'transparent'): string {
  return page(
    `<div class="mark" style="margin:auto;width:${(1 - 2 * padding) * 100}%;height:${(1 - 2 * padding) * 100}%">${logo}</div>`,
    background,
  );
}

function card(width: number, title: string, line: string, foot: string): string {
  const unit = width / 1200;
  return page(
    `<div style="margin:auto;display:flex;align-items:center;gap:${56 * unit}px;padding:0 ${96 * unit}px;width:100%">
      <div class="mark" style="flex:none;width:${300 * unit}px;height:${300 * unit}px">${logo}</div>
      <div>
        <h1 style="font-size:${112 * unit}px">${title}</h1>
        <p style="font-size:${38 * unit}px;line-height:1.3;margin-top:${22 * unit}px;font-weight:600">${line}</p>
        <p style="font-size:${26 * unit}px;margin-top:${26 * unit}px;color:${MUTED}">${foot}</p>
      </div>
    </div>`,
    BG,
  );
}

const TAGLINE = 'Meeting notes that never leave your Mac.';
const SUMMARY = 'Open-source recorder, transcriber and note-taker. Local AI, self-hosted.';

const outputs: [file: string, width: number, height: number, html: string][] = [
  ['png/logo-512.png', 512, 512, icon(0)],
  ['png/apple-touch-icon.png', 180, 180, icon(0.12, BG)],
  ['extension/16.png', 16, 16, icon(0)],
  ['extension/32.png', 32, 32, icon(0)],
  ['extension/48.png', 48, 48, icon(0.02)],
  ['extension/128.png', 128, 128, icon(0.06)],
  ['png/favicon-16.png', 16, 16, icon(0)],
  ['png/favicon-32.png', 32, 32, icon(0)],
  ['png/favicon-48.png', 48, 48, icon(0.02)],
  // Chrome Web Store: 128×128 icon with 96×96 artwork and transparent padding.
  ['store/icon-128.png', 128, 128, icon(0.125)],
  [
    'store/tile-440x280.png',
    440,
    280,
    page(
      `<div style="margin:auto;display:flex;align-items:center;gap:22px">
        <div class="mark" style="width:104px;height:104px">${logo}</div>
        <div><h1 style="font-size:56px">Echo</h1>
        <p style="font-size:16px;font-weight:600;margin-top:8px;max-width:210px;line-height:1.3">Local meeting recorder and transcriber</p></div>
      </div>`,
      BG,
    ),
  ],
  ['social/og-image.png', 1200, 630, card(1200, 'Echo', TAGLINE, SUMMARY)],
  [
    'social/github-social-preview.png',
    1280,
    640,
    card(
      1280,
      'Echo',
      TAGLINE,
      `${SUMMARY}<br><span style="color:${ACCENT_TEXT}">github.com/samarthmn/echo-voice-web</span>`,
    ),
  ],
];

/** A PNG-in-ICO container (Windows Vista+ and every browser read it). */
function ico(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const entry = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, entry);
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(png.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map(({ png }) => png)]);
}

const browser = await chromium.launch({ executablePath: await resolveChromium() });
try {
  const rendered = new Map<string, Buffer>();
  for (const [file, width, height, html] of outputs) {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
    const tab = await context.newPage();
    await tab.setContent(html);
    await tab.evaluate(() => document.fonts.ready);
    const png = await tab.screenshot({ omitBackground: true });
    await context.close();
    await mkdir(path.dirname(path.join(brand, file)), { recursive: true });
    await writeFile(path.join(brand, file), png);
    rendered.set(file, png);
  }
  const favicon = ico(
    [16, 32, 48].map((size) => {
      const png = rendered.get(`png/favicon-${size}.png`);
      if (!png) throw new Error(`Missing ${size}px favicon render.`);
      return { size, png };
    }),
  );
  await writeFile(path.join(brand, 'favicon.ico'), favicon);
} finally {
  await browser.close();
}

// Copy the outputs to where the app and the extension load them.
await copyFile(path.join(brand, 'logo.svg'), path.join(project, 'public', 'favicon.svg'));
await copyFile(path.join(brand, 'favicon.ico'), path.join(project, 'public', 'favicon.ico'));
await copyFile(
  path.join(brand, 'png', 'apple-touch-icon.png'),
  path.join(project, 'public', 'apple-touch-icon.png'),
);
for (const size of [16, 32, 48, 128])
  await copyFile(
    path.join(brand, 'extension', `${size}.png`),
    path.join(project, 'extension', 'icons', `${size}.png`),
  );
console.log(`Brand assets written to ${path.relative(project, brand)}/`);
