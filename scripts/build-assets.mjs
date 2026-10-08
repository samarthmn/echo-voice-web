import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import {writeAssetManifest} from './asset-manifest.mjs';
import './copy-wasm.mjs';
await mkdir('public/js',{recursive:true});
await build({entryPoints:['web/bridge.js','web/inference-worker.js'],outdir:'public/js',bundle:true,format:'esm',splitting:true,platform:'browser',target:'es2022',minify:true,loader:{'.wasm':'file'},define:{'process.env.NODE_ENV':'"production"'}});
await writeAssetManifest();
