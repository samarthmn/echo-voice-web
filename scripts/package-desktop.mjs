/** Native-host runtime packaging. Downloads are integrity checked; publishing/signing is separate. */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,cp,rm,lstat,readdir,chmod,open} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
const project=path.resolve(import.meta.dirname,'..');
export const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
export function verifyHash(bytes,expected){if(hash(bytes)!==expected)throw new Error('Runtime download checksum mismatch; no bundle was published.');}
const exact=new Set(['bin/echo-server','bin/node','scripts/native-speech.mjs','web/whisper-alignment.js','web/speech-errors.js','tools/codex/codex','tools/codex/LICENSE','manifest.json','licenses.json','package.json','google-oauth.json']);
export function desktopGoogleConfiguration(value){
  const fields=value&&typeof value==='object'?Object.keys(value).sort().join(','):'';
  if(!value||typeof value!=='object'||Array.isArray(value)||!['clientId,clientType,version','clientId,clientSecret,clientType,version'].includes(fields)
    ||value.version!==1||value.clientType!=='desktop'
    ||(value.clientId!==null&&(typeof value.clientId!=='string'||value.clientId.length>256||! /^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.clientId)))
    ||(Object.hasOwn(value,'clientSecret')&&(value.clientId===null||typeof value.clientSecret!=='string'||! /^[\x21-\x7e]{1,1024}$/.test(value.clientSecret))))throw new Error('Google release configuration requires version 1, desktop clientType, clientId (or null), and an optional bounded Desktop clientSecret. No web clients, tokens or custom endpoints are allowed.');
  return value;
}
export async function loadGoogleConfiguration(file=process.env.ECHO_GOOGLE_OAUTH_CONFIG||path.join(project,'release/google-oauth.json')){
  const invalid=()=>new Error('Could not load the publisher Calendar configuration. Use a valid private desktop configuration file; its contents have not been logged.');
  if(!path.isAbsolute(file))throw invalid();
  try{
    const info=await lstat(file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>4096)throw invalid();
    const input=await open(file,'r');const buffer=Buffer.alloc(4097);
    try{const {bytesRead}=await input.read(buffer,0,buffer.length,0);if(bytesRead>4096)throw invalid();return desktopGoogleConfiguration(JSON.parse(buffer.subarray(0,bytesRead).toString('utf8')));}
    finally{buffer.fill(0);await input.close();}
  }catch{throw invalid();}
}
export async function inspectBundle(directory){
  const files=[];
  async function visit(relative){for(const name of (await readdir(path.join(directory,relative))).sort()){
    const file=relative ? `${relative}/${name}` : name;const full=path.join(directory,file);const stat=await lstat(full);
    if(stat.isSymbolicLink())throw new Error(`Bundle cannot contain a symbolic link: ${file}`);
    if(/(^|\/)(\.env[^/]*|\.echo-data|profiles?|recordings?|logs?|\.git|\.npm|\.cache)(\/|$)|\.(sqlite(?:-wal|-shm)?|wav|mp3|flac|onnx|log)$/i.test(file)||/^models?(\/|$)/i.test(file))throw new Error(`Private or unrequested content: ${file}`);
    if(stat.isDirectory()){if(!['bin','public','scripts','web','node_modules','tools','licenses'].includes(file.split('/')[0]))throw new Error(`Unexpected bundle directory: ${file}`);await visit(file);}
    else if(stat.isFile()){if(!exact.has(file)&&!['public/','node_modules/','licenses/'].some(prefix=>file.startsWith(prefix)))throw new Error(`Unexpected bundle file: ${file}`);files.push({path:file,bytes:stat.size,sha256:hash(await readFile(full))});}
    else throw new Error(`Unexpected bundle entry: ${file}`);
  }}
  await visit('');return files;
}
export async function localRuntimeModules(directory,entry='scripts/native-speech.mjs'){
  const seen=new Set();
  async function visit(relative){
    if(seen.has(relative))return;seen.add(relative);
    const source=await readFile(path.join(directory,relative),'utf8');
    for(const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"](\.[^'"]+)['"]/g)){
      const next=path.posix.normalize(path.posix.join(path.posix.dirname(relative),match[1]));
      if(next.startsWith('../')||path.isAbsolute(next))throw new Error('Runtime module escapes packaged resources');
      await visit(next);
    }
  }
  await visit(entry);return [...seen];
}
// ONNX 1.21.0 uses global-agent and tar only in its npm installer. Installed Echo
// already contains the verified native binding and never runs that installer.
// Keep the dependency closure needed by inference, including shared/optional deps.
export async function pruneRuntimeDependencies(root){
  const retained=new Set();
  async function resolve(name,from,optional=false){
    if(!/^(@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(name))throw new Error('Invalid runtime dependency name');
    for(let current=from;;current=path.dirname(current)){
      const candidate=path.join(current,'node_modules',name);
      try{await lstat(path.join(candidate,'package.json'));return candidate;}catch(error){if(error.code!=='ENOENT')throw error;}
      if(current===root)break;
      if(path.relative(root,current).startsWith('..'))throw new Error('Runtime dependency escapes staging');
    }
    if(!optional)throw new Error(`Missing runtime dependency: ${name}`);
  }
  async function visit(directory){
    if(!directory||retained.has(directory))return;retained.add(directory);
    const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
    const dependencies={...pkg.dependencies,...pkg.optionalDependencies};
    if(pkg.name==='onnxruntime-node'){
      if(pkg.version!=='1.21.0')throw new Error('Reassess ONNX installer dependencies before changing the runtime version');
      for(const file of await readdir(path.join(directory,'dist'))){
        if(file.endsWith('.js')&&/\b(?:global-agent|tar)\b/.test(await readFile(path.join(directory,'dist',file),'utf8')))throw new Error('ONNX runtime now references an excluded installer dependency');
      }
      delete dependencies['global-agent'];delete dependencies.tar;
    }
    for(const name of Object.keys(dependencies))await visit(await resolve(name,directory,Object.hasOwn(pkg.optionalDependencies||{},name)));
  }
  for(const name of ['@huggingface/transformers','onnxruntime-node'])await visit(await resolve(name,root));
  const removed=[];
  async function prune(modules){
    let entries;try{entries=await readdir(modules,{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return;throw error;}
    async function candidate(directory){
      if(!retained.has(directory)){removed.push(path.relative(root,directory));await rm(directory,{recursive:true,force:true});}
      else await prune(path.join(directory,'node_modules'));
    }
    for(const entry of entries){
      if(entry.name.startsWith('.'))continue;
      const directory=path.join(modules,entry.name);
      if(entry.name.startsWith('@')){for(const name of await readdir(directory))await candidate(path.join(directory,name));if(!(await readdir(directory)).length)await rm(directory,{recursive:true});}
      else await candidate(directory);
    }
  }
  await prune(path.join(root,'node_modules'));
  for(const directory of retained){
    const pkg=JSON.parse(await readFile(path.join(directory,'package.json'),'utf8'));
    if(pkg.name==='sprintf-js')throw new Error('Vulnerable sprintf-js remains reachable in the installed runtime; resolve it before packaging');
    if(pkg.name==='onnxruntime-node')await rm(path.join(directory,'script'),{recursive:true,force:true});
  }
  return removed.sort();
}
export async function packageDesktop({server,withCodex=true}={}){
  const target=process.platform==='darwin'&&process.arch==='arm64'?'aarch64-apple-darwin':process.platform==='linux'&&process.arch==='x64'?'x86_64-unknown-linux-gnu':null;
  if(!target)throw new Error('Build on native Apple Silicon macOS or Ubuntu x64; other architectures remain unqualified.');
  const pins=JSON.parse(await readFile(path.join(project,'scripts/runtime-dependencies.json'),'utf8'));
  const google=await loadGoogleConfiguration();
  const pkg=JSON.parse(await readFile(path.join(project,'package.json'),'utf8'));
  const lockBytes=await readFile(path.join(project,'package-lock.json'));const lock=JSON.parse(lockBytes);
  for(const dependency of [...pins.npm.speech,pins.npm.optionalChatgpt]){if(lock.packages[`node_modules/${dependency.name}`]?.version!==dependency.version)throw new Error(`Pinned dependency version mismatch: ${dependency.name}`);}
  await mkdir(path.join(project,'tmp'),{recursive:true});const scratch=await mkdtemp(path.join(project,'tmp/desktop-package-'));const stage=path.join(scratch,'runtime');
  const run=(exe,args,cwd=project)=>execFileSync(exe,args,{cwd,stdio:'inherit',env:{...process.env,TMPDIR:scratch,npm_config_cache:path.join(scratch,'npm-cache')}});
  try{
    if(!server){run('npm',['run','build:assets']);run('cargo',['build','--locked','--release','-p','echo-server']);server=path.join(project,'target/release/echo-server');}
    for(const dir of ['bin','scripts','web','licenses'])await mkdir(path.join(stage,dir),{recursive:true});
    await cp(server,path.join(stage,'bin/echo-server'));await cp(path.join(project,'public'),path.join(stage,'public'),{recursive:true});
    await writeFile(path.join(stage,'google-oauth.json'),JSON.stringify(google,null,2)+'\n',{mode:0o600});
    for(const file of ['scripts/native-speech.mjs','web/whisper-alignment.js','web/speech-errors.js'])await cp(path.join(project,file),path.join(stage,file));
    await cp(path.join(project,'LICENSE'),path.join(stage,'licenses/Echo-LICENSE'));
    const node=pins.node.targets[target];const response=await fetch(`https://nodejs.org/dist/v${pins.node.version}/${node.archive}`);if(!response.ok)throw new Error('Could not download the pinned Node runtime.');const bytes=Buffer.from(await response.arrayBuffer());verifyHash(bytes,node.sha256);
    const archive=path.join(scratch,node.archive);await writeFile(archive,bytes);run('tar',['-xzf',archive,'-C',scratch]);const nodeRoot=path.join(scratch,node.archive.replace(/\.tar\.gz$/,''));
    await cp(path.join(nodeRoot,'bin/node'),path.join(stage,'bin/node'));await cp(path.join(nodeRoot,'LICENSE'),path.join(stage,'licenses/Node-LICENSE'));
    // npm verifies every package against the checked-in lock; no project install scripts run.
    const npmRoot=path.join(scratch,'npm-production');await mkdir(npmRoot);await writeFile(path.join(npmRoot,'package.json'),JSON.stringify(pkg));await writeFile(path.join(npmRoot,'package-lock.json'),lockBytes);
    run('npm',['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],npmRoot);
    await rm(path.join(npmRoot,'node_modules/.bin'),{recursive:true,force:true});
    const codex=pins.npm.optionalChatgpt.targets[target];
    if(withCodex){await mkdir(path.join(stage,'tools/codex'),{recursive:true});await cp(path.join(npmRoot,'node_modules/@openai',codex.package,'vendor',codex.triple,'bin/codex'),path.join(stage,'tools/codex/codex'));await cp(path.join(project,'third_party/codex-LICENSE'),path.join(stage,'tools/codex/LICENSE'));}
    await rm(path.join(npmRoot,'node_modules/@openai'),{recursive:true,force:true});
    // ONNX publishes several native targets together; ship only this build's ABI.
    const napi=path.join(npmRoot,'node_modules/onnxruntime-node/bin/napi-v3');
    for(const platform of await readdir(napi)){if(platform!==process.platform)await rm(path.join(napi,platform),{recursive:true,force:true});else for(const arch of await readdir(path.join(napi,platform)))if(arch!==process.arch)await rm(path.join(napi,platform,arch),{recursive:true,force:true});}
    const excludedInstallPackages=await pruneRuntimeDependencies(npmRoot);
    await cp(path.join(npmRoot,'node_modules'),path.join(stage,'node_modules'),{recursive:true});
    await writeFile(path.join(stage,'package.json'),JSON.stringify({name:'echo-installed-runtime',version:pkg.version,private:true,type:'module'}));
    const licenses=[{name:'node',version:pins.node.version,license:pins.node.license,notice:'licenses/Node-LICENSE'}];
    async function inventory(dir){for(const entry of await readdir(dir,{withFileTypes:true})){if(!entry.isDirectory())continue;const sub=path.join(dir,entry.name);try{const dep=JSON.parse(await readFile(path.join(sub,'package.json'),'utf8'));licenses.push({name:dep.name,version:dep.version,license:dep.license||'SEE PACKAGE NOTICES',path:path.relative(stage,sub)});}catch{}if(entry.name.startsWith('@')||entry.name==='node_modules')await inventory(sub);}}
    await inventory(path.join(stage,'node_modules'));if(withCodex)licenses.push({name:'@openai/codex',version:pins.npm.optionalChatgpt.version,license:pins.npm.optionalChatgpt.license,notice:'tools/codex/LICENSE'});
    await writeFile(path.join(stage,'licenses.json'),JSON.stringify(licenses,null,2)+'\n');
    for(const file of ['bin/node','bin/echo-server',...(withCodex?['tools/codex/codex']:[])])await chmod(path.join(stage,file),0o755);
    const modules=await localRuntimeModules(stage);
    run(path.join(stage,'bin/node'),['--input-type=module','-e',`await import('onnxruntime-node');await import('@huggingface/transformers');for(const file of ${JSON.stringify(modules)})await import('./'+file);console.log('Bundled native speech engine, helper and lazy local dependencies ready')`],stage);
    const manifest={appVersion:pkg.version,extensionVersion:JSON.parse(await readFile(path.join(project,'extension/manifest.json'),'utf8')).version,extensionProtocolMin:1,extensionProtocolMax:1,librarySchemaVersion:1,libraryProtectionVersion:1,extensionJournalVersion:2,vaultVersion:1,receiptVersion:1,target,nodeVersion:pins.node.version,packageLockSha256:hash(lockBytes),excludedInstallPackages,nativeLargeV3:true,optionalChatgpt:withCodex,signing:'unsigned-development',qualification:'pending-clean-machine-tests',files:await inspectBundle(stage)};
    await writeFile(path.join(stage,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
    const output=path.join(project,'artifacts/desktop-runtime',target);await mkdir(path.dirname(output),{recursive:true});await rm(output,{recursive:true,force:true});await cp(stage,output,{recursive:true});
    const overlay=path.join(project,'artifacts/desktop-runtime',`tauri-${target}.json`);await writeFile(overlay,JSON.stringify({bundle:{resources:{[`${output}/`]:'runtime/'}}},null,2)+'\n');
    console.log(`Verified unsigned runtime: ${output}\nTauri bundle overlay: ${overlay}\nSigning, notarization, and clean-machine qualification remain pending.`);return {output,overlay,manifest};
  }finally{await rm(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){const args=process.argv.slice(2);const at=args.indexOf('--server');await packageDesktop({server:at>=0?path.resolve(args[at+1]):undefined,withCodex:!args.includes('--without-codex')});}
