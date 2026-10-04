import { mkdir, copyFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('onnxruntime-web'));
const output = new URL('../public/wasm/', import.meta.url);
await mkdir(output, { recursive: true });
const names = (await readdir(dist)).filter(name => /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(name));
if (!names.length) throw new Error('ONNX WASM runtime files are missing. Reinstall dependencies.');
await Promise.all(names.map(name => copyFile(join(dist, name), new URL(name, output))));
console.log(`Prepared ${names.length} local ONNX runtime files.`);
