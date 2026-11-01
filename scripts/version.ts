import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Echo has one version: `[workspace.package] version` in Cargo.toml. This
 * script copies it into package.json, the extension manifest and Cargo.lock.
 *
 *   node scripts/version.ts            print the version
 *   node scripts/version.ts 1.2.3      set every file to 1.2.3
 *   node scripts/version.ts --check    fail if any file disagrees
 */
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = (name: string) => path.join(project, name);
const SEMVER = /^\d+\.\d+\.\d+$/;
const WORKSPACE_VERSION = /(\[workspace\.package\][^[]*?\nversion = ")([^"]+)(")/;
const LOCK_VERSION = (crate: string) =>
  new RegExp(`(\\[\\[package\\]\\]\\nname = "${crate}"\\nversion = ")([^"]+)(")`);
const JSON_VERSION = /("version": ")([^"]+)(")/;

interface Target {
  name: string;
  pattern: RegExp;
}
const TARGETS: Target[] = [
  { name: 'package.json', pattern: JSON_VERSION },
  { name: 'extension/manifest.json', pattern: JSON_VERSION },
  { name: 'Cargo.lock', pattern: LOCK_VERSION('echo-app') },
  { name: 'Cargo.lock', pattern: LOCK_VERSION('echo-server') },
];

function read(source: string, pattern: RegExp, name: string): string {
  const version = pattern.exec(source)?.[2];
  if (!version) throw new Error(`No version found in ${name}.`);
  return version;
}

async function canonical(): Promise<string> {
  return read(await readFile(file('Cargo.toml'), 'utf8'), WORKSPACE_VERSION, 'Cargo.toml');
}

async function setVersion(version: string) {
  if (!SEMVER.test(version)) throw new Error(`Not a MAJOR.MINOR.PATCH version: ${version}`);
  const cargo = await readFile(file('Cargo.toml'), 'utf8');
  await writeFile(file('Cargo.toml'), cargo.replace(WORKSPACE_VERSION, `$1${version}$3`));
  for (const { name, pattern } of TARGETS) {
    const source = await readFile(file(name), 'utf8');
    read(source, pattern, name);
    await writeFile(file(name), source.replace(pattern, `$1${version}$3`));
  }
}

async function check(): Promise<string[]> {
  const version = await canonical();
  const mismatches: string[] = [];
  for (const { name, pattern } of TARGETS) {
    const found = read(await readFile(file(name), 'utf8'), pattern, name);
    if (found !== version) mismatches.push(`${name} has ${found}, Cargo.toml has ${version}`);
  }
  return mismatches;
}

const argument = process.argv[2];
if (argument === '--check') {
  const mismatches = await check();
  if (mismatches.length) {
    console.error(`Version mismatch. Run: node scripts/version.ts ${await canonical()}`);
    for (const line of mismatches) console.error(`  ${line}`);
    process.exit(1);
  }
} else if (argument) {
  await setVersion(argument);
  console.log(`Echo version is now ${argument}.`);
} else {
  console.log(await canonical());
}
