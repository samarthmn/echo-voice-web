import {mkdir,rm,readdir,lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {buildExtension,EXTENSION_FILES} from './build-extension.mjs';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function packageExtension({outdir,archive} = {}) {
  const result = await buildExtension({outdir}); archive ??= path.join(project,'artifacts',`echo-extension-${result.version}.zip`);
  async function checkDirectory(dir) {for(const entry of await readdir(dir,{withFileTypes:true})) {const file = path.join(dir,entry.name); if(entry.isSymbolicLink()) throw new Error('Extension packaging refuses symlinks.'); if(entry.isDirectory()) await checkDirectory(file); else {const relative = path.relative(result.outdir,file).split(path.sep).join('/'); const stat = await lstat(file); if(!EXTENSION_FILES.includes(relative) && (stat.mode & 0o111 || /\.(?:js|mjs|cjs|exe|dll|so|dylib|sh)$/i.test(entry.name))) throw new Error(`Unexpected executable file in extension output: ${relative}`);}}}
  await checkDirectory(result.outdir); await mkdir(path.dirname(archive),{recursive:true});
  const existing = await lstat(archive).catch(error => {if(error.code === 'ENOENT') return null; throw error;}); if(existing?.isSymbolicLink()) throw new Error('Extension archive must not be a symlink.');
  await rm(archive,{force:true});
  await promisify(execFile)('python3',['-c','import pathlib,sys,zipfile,json\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],"w",compression=zipfile.ZIP_DEFLATED) as z:\n for name in json.loads(sys.argv[3]):\n  p=root/name\n  if p.is_symlink() or not p.is_file(): raise ValueError("Missing or unsafe extension asset: "+name)\n  z.write(p,name)',result.outdir,archive,JSON.stringify(EXTENSION_FILES)],{env:{...process.env,TMPDIR:path.join(project,'tmp')}});
  return {...result,archive};
}
if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {const result = await packageExtension(); console.log(`Packaged Echo extension: ${result.archive}\nStable development ID: ${result.extensionId}`);}
