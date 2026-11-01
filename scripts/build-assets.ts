import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { writeAssetManifest } from './asset-manifest.ts';
import './copy-wasm.ts';
await mkdir('public/js', { recursive: true });
await build({
  entryPoints: ['web/bridge.ts', 'web/inference-worker.ts', 'web/extension-connect.ts'],
  outdir: 'public/js',
  bundle: true,
  format: 'esm',
  splitting: true,
  platform: 'browser',
  target: 'es2022',
  minify: true,
  loader: { '.wasm': 'file' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
await writeAssetManifest();
