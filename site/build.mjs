import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'artifacts/site');
const publisher = JSON.parse(await readFile(path.join(root, 'release/publisher.json'), 'utf8'));
if (publisher.publicationStatus !== 'pending-tested-candidate-approval') {
  throw new Error('Reconcile the approved release status and site copy before creating a public site build.');
}
await mkdir(path.join(output, 'assets/fonts'), { recursive: true });
for (const file of ['design-tokens.css', 'favicon.svg']) {
  await cp(path.join(root, 'public', file), path.join(output, 'assets', file));
}
await cp(path.join(root, 'public/fonts'), path.join(output, 'assets/fonts'), { recursive: true });
const fonts = await readFile(path.join(root, 'public/fonts/inter.css'), 'utf8');
await writeFile(path.join(output, 'assets/fonts/inter.css'), fonts.replaceAll("url('/fonts/", "url('/assets/fonts/"));
await cp(path.join(root, 'site/styles.css'), path.join(output, 'assets/styles.css'));
for (const page of ['', 'downloads', 'privacy', 'support']) {
  const destination = path.join(output, page);
  await mkdir(destination, { recursive: true });
  let html = await readFile(path.join(root, 'site', page, 'index.html'), 'utf8');
  const fields = { publisher: publisher.publisher, supportEmail: publisher.supportEmail, website: publisher.website };
  for (const [key, value] of Object.entries(fields)) {
    html = html.replaceAll(`{{${key}}}`, value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'));
  }
  if (/\{\{/.test(html)) throw new Error(`Unresolved site field: ${page || 'home'}`);
  await writeFile(path.join(destination, 'index.html'), html);
}
await writeFile(path.join(output, 'robots.txt'), 'User-agent: *\nDisallow: /\n');
console.log(`Prepared local preview: ${output}. No upload or publication performed.`);
