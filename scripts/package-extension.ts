import { errorInfo } from '../web/guards.ts';
import { lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildExtension, EXTENSION_FILES } from './build-extension.ts';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * Build and zip the extension. The default zip is for loading unpacked and keeps
 * manifest.json's `key`, so the ID stays stable. `store: true` builds the Chrome
 * Web Store upload instead: the store assigns its own ID and rejects a `key`.
 */
export async function packageExtension({
  outdir,
  archive,
  store = false,
}: { outdir?: string | undefined; archive?: string; store?: boolean } = {}) {
  const result = await buildExtension({
    outdir: outdir ?? (store ? path.join(project, 'dist', 'extension-store') : undefined),
  });
  archive ??= path.join(
    project,
    'dist',
    `echo-extension-${store ? 'store-' : ''}${result.version}.zip`,
  );
  if (store) {
    const manifestFile = path.join(result.outdir, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Record<string, unknown>;
    delete manifest['key'];
    await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  async function checkDirectory(dir: string) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Extension packaging refuses symlinks.');
      if (entry.isDirectory()) await checkDirectory(file);
      else {
        const relative = path.relative(result.outdir, file).split(path.sep).join('/');
        const stat = await lstat(file);
        if (
          !EXTENSION_FILES.includes(relative) &&
          (stat.mode & 0o111 || /\.(?:js|mjs|cjs|exe|dll|so|dylib|sh)$/i.test(entry.name))
        )
          throw new Error(`Unexpected executable file in extension output: ${relative}`);
      }
    }
  }
  await checkDirectory(result.outdir);
  await mkdir(path.dirname(archive), { recursive: true });
  const existing = await lstat(archive).catch((error: unknown) => {
    if (errorInfo(error).code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink()) throw new Error('Extension archive must not be a symlink.');
  await rm(archive, { force: true });
  for (const name of EXTENSION_FILES) {
    const asset = await lstat(path.join(result.outdir, name));
    if (!asset.isFile() || asset.isSymbolicLink())
      throw new Error(`Missing or unsafe extension asset: ${name}`);
  }
  await promisify(execFile)('/usr/bin/zip', ['-r', '-X', archive, ...EXTENSION_FILES], {
    cwd: result.outdir,
    env: { ...process.env, TMPDIR: path.join(project, 'tmp') },
  });
  return { ...result, archive };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const store = process.argv.includes('--store');
  const result = await packageExtension({ store });
  console.log(
    store
      ? `Packaged Echo extension for the Chrome Web Store: ${result.archive}`
      : `Packaged Echo extension: ${result.archive}\nStable development ID: ${result.extensionId}`,
  );
}
