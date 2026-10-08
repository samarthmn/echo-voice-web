import {build} from 'esbuild';
import {cp,mkdir,readFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const EXTENSION_FILES = ['manifest.json','background.js','offscreen.js','popup.js','setup.js','content.js','worklet.js','popup.html','setup.html','offscreen.html','ui.css','design-tokens.css','icons/echo.svg','icons/16.png','icons/32.png','icons/48.png','icons/128.png','fonts/inter-400.woff2','fonts/inter-500.woff2','fonts/inter-600.woff2','fonts/LICENSE'];
export function extensionId(key) {return createHash('sha256').update(Buffer.from(key,'base64')).digest('hex').slice(0,32).replace(/[0-9a-f]/g,n => String.fromCharCode(97 + parseInt(n,16)));}
export async function buildExtension({outdir = path.join(project,'extension','dist')} = {}) {
  await mkdir(outdir,{recursive:true});
  for(const name of ['',...EXTENSION_FILES]) {const stat = await lstat(path.join(outdir,name)).catch(error => {if(error.code === 'ENOENT') return null; throw error;}); if(stat?.isSymbolicLink()) throw new Error(`Refusing extension output symlink: ${name || outdir}`);}
  const manifest = JSON.parse(await readFile(path.join(project,'extension','manifest.json'),'utf8'));
  await build({absWorkingDir:project,entryPoints:['background','offscreen','popup','setup'].map(name => `extension/src/${name}.ts`),bundle:true,outdir,format:'esm',platform:'browser',target:'chrome120',legalComments:'none',minify:false});
  await build({absWorkingDir:project,entryPoints:['content','worklet'].map(name => `extension/src/${name}.ts`),bundle:true,outdir,format:'iife',platform:'browser',target:'chrome120',legalComments:'none',minify:false});
  for(const name of ['manifest.json','popup.html','setup.html','offscreen.html','ui.css','icons/16.png','icons/32.png','icons/48.png','icons/128.png']) {await mkdir(path.dirname(path.join(outdir,name)),{recursive:true}); await cp(path.join(project,'extension',name),path.join(outdir,name));}
  await cp(path.join(project,'public','design-tokens.css'),path.join(outdir,'design-tokens.css'));
  await cp(path.join(project,'public','favicon.svg'),path.join(outdir,'icons','echo.svg'));
  await mkdir(path.join(outdir,'fonts'),{recursive:true});
  for(const name of ['inter-400.woff2','inter-500.woff2','inter-600.woff2','LICENSE']) await cp(path.join(project,'public','fonts',name),path.join(outdir,'fonts',name));
  return {outdir,extensionId:extensionId(manifest.key),version:manifest.version};
}
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildExtension({outdir:process.env.ECHO_EXTENSION_OUTDIR ? path.resolve(process.env.ECHO_EXTENSION_OUTDIR) : undefined});
  console.log(`Echo extension ${result.version}: ${result.outdir}\nStable development ID: ${result.extensionId}`);
}
