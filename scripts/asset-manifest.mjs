import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Fingerprint actual browser assets, including the separately built Rust WASM. */
export async function writeAssetManifest(publicRoot = resolve('public')) {
  const versions = {};
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else if (/\.(?:js|mjs|wasm|css)$/.test(entry.name)) {
        const url = '/' + path.slice(publicRoot.length + 1).split('\\').join('/');
        versions[url] = createHash('sha256').update(await readFile(path)).digest('hex');
      }
    }
  }
  await collect(publicRoot);
  await mkdir(join(publicRoot, 'js'), { recursive: true });
  await writeFile(join(publicRoot, 'js/asset-manifest.json'), JSON.stringify(versions));
  return versions;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await writeAssetManifest();
}
