import { FONT_FILES, writeTokens } from './build-tokens.ts';
import { extensionManifest } from './guards.ts';
import { errorInfo } from '../web/guards.ts';
import { build } from 'esbuild';
import { cp, mkdir, readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { WithImplicitCoercion } from 'buffer';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT_LICENSES = ['OFL-Mulish.txt'];
export const EXTENSION_FILES = [
  'manifest.json',
  'background.js',
  'offscreen.js',
  'popup.js',
  'setup.js',
  'content.js',
  'worklet.js',
  'popup.html',
  'setup.html',
  'offscreen.html',
  'ui.css',
  'tokens.css',
  'icons/echo.svg',
  'icons/16.png',
  'icons/32.png',
  'icons/48.png',
  'icons/128.png',
  ...FONT_LICENSES.map((name) => `fonts/${name}`),
  ...FONT_FILES.map((name) => `fonts/${name}`),
];
/**
 * The Chrome Web Store assigns its own ID, different from the unpacked build's
 * (which comes from manifest.json's key). Set it here once the listing exists;
 * the web app then talks to whichever build is installed.
 */
const STORE_EXTENSION_ID = '';
export function extensionId(key: WithImplicitCoercion<string>) {
  return createHash('sha256')
    .update(Buffer.from(key, 'base64'))
    .digest('hex')
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (n) => String.fromCharCode(97 + parseInt(n, 16)));
}
/** Content hash of the extension sources; pages compare it with the running service worker. */
async function buildId() {
  const hash = createHash('sha256');
  for (const dir of ['extension', 'extension/src']) {
    for (const name of (await readdir(path.join(project, dir))).sort()) {
      if (!/\.(ts|html|css|json)$/.test(name)) continue;
      hash.update(name).update(await readFile(path.join(project, dir, name)));
    }
  }
  return hash.digest('hex').slice(0, 16);
}
export async function buildExtension({
  outdir = path.join(project, 'extension', 'dist'),
}: { outdir?: string | undefined } = {}) {
  await mkdir(outdir, { recursive: true });
  for (const name of ['', ...EXTENSION_FILES]) {
    const stat = await lstat(path.join(outdir, name)).catch((error: unknown) => {
      if (errorInfo(error).code === 'ENOENT') return null;
      throw error;
    });
    if (stat?.isSymbolicLink())
      throw new Error(`Refusing extension output symlink: ${name || outdir}`);
  }
  const manifest = extensionManifest(
    JSON.parse(await readFile(path.join(project, 'extension', 'manifest.json'), 'utf8')) as unknown,
  );
  const define = { __ECHO_BUILD__: JSON.stringify(await buildId()) };
  await build({
    absWorkingDir: project,
    entryPoints: ['background', 'offscreen', 'popup', 'setup'].map(
      (name) => `extension/src/${name}.ts`,
    ),
    bundle: true,
    outdir,
    format: 'esm',
    platform: 'browser',
    target: 'chrome120',
    legalComments: 'none',
    minify: false,
    define,
  });
  await build({
    absWorkingDir: project,
    entryPoints: ['content', 'worklet'].map((name) => `extension/src/${name}.ts`),
    bundle: true,
    outdir,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    legalComments: 'none',
    minify: false,
    define,
  });
  for (const name of [
    'manifest.json',
    'popup.html',
    'setup.html',
    'offscreen.html',
    'ui.css',
    'icons/16.png',
    'icons/32.png',
    'icons/48.png',
    'icons/128.png',
  ]) {
    await mkdir(path.dirname(path.join(outdir, name)), { recursive: true });
    await cp(path.join(project, 'extension', name), path.join(outdir, name));
  }
  await writeTokens(path.join(outdir, 'tokens.css'), 'fonts/');
  await cp(path.join(project, 'public', 'favicon.svg'), path.join(outdir, 'icons', 'echo.svg'));
  await mkdir(path.join(outdir, 'fonts'), { recursive: true });
  for (const name of [...FONT_LICENSES, ...FONT_FILES])
    await cp(path.join(project, 'public', 'fonts', name), path.join(outdir, 'fonts', name));
  const id = extensionId(manifest.key);
  const idFile = path.join(project, 'public', 'js', 'extension-id.json');
  await mkdir(path.dirname(idFile), { recursive: true });
  const ids = [id, STORE_EXTENSION_ID].filter((value) => /^[a-p]{32}$/.test(value));
  await writeFile(idFile, `${JSON.stringify({ ids }, null, 2)}\n`);
  return { outdir, extensionId: id, version: manifest.version };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildExtension({
    outdir: process.env['ECHO_EXTENSION_OUTDIR']
      ? path.resolve(process.env['ECHO_EXTENSION_OUTDIR'])
      : undefined,
  });
  console.log(
    `Echo extension ${result.version}: ${result.outdir}\nStable development ID: ${result.extensionId}`,
  );
}
