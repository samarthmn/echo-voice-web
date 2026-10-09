/** Explicit, inside-out signing of an existing Echo release bundle. No notarization or publication. */
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {cp,lstat,mkdir,mkdtemp,open,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {inspectBundle,localRuntimeModules} from './package-desktop.mjs';

const project=path.resolve(import.meta.dirname,'..');
const resourcePrefix='Contents/Resources/runtime/';
const nodePath=`${resourcePrefix}bin/node`;
const codexPath=`${resourcePrefix}tools/codex/codex`;
const mainPath='Contents/MacOS/echo-desktop';
const jit='com.apple.security.cs.allow-jit';
const unsignedMemory='com.apple.security.cs.allow-unsigned-executable-memory';
export const entitlementsFor=file=>file===nodePath?[jit]:file===codexPath?[jit,unsignedMemory]:[];
export const entitlementPlist=keys=>`<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>${keys.map(key=>`<key>${key}</key><true/>`).join('')}</dict></plist>\n`;

export function isMachO(bytes){
  return bytes.length>=4&&new Set(['feedface','cefaedfe','feedfacf','cffaedfe','cafebabe','bebafeca','cafebabf','bfbafeca']).has(bytes.subarray(0,4).toString('hex'));
}
export async function signingInventory(app){
  const files=[];
  async function visit(relative){
    for(const name of (await readdir(path.join(app,relative))).sort()){
      const file=relative?`${relative}/${name}`:name;
      const full=path.join(app,file),entry=await lstat(full);
      if(entry.isSymbolicLink())throw new Error(`Unexpected symbolic link in this bundle: ${file}`);
      if(entry.isDirectory())await visit(file);
      else if(entry.isFile()){
        const handle=await open(full,'r');const head=Buffer.alloc(4);
        try{await handle.read(head,0,4,0);}finally{await handle.close();}
        if(!isMachO(head))continue;
        if(file!==mainPath&&!file.startsWith(resourcePrefix))throw new Error(`Review new native-code location before signing: ${file}`);
        files.push(file);
      }else throw new Error(`Unexpected bundle entry: ${file}`);
    }
  }
  if((await lstat(app)).isSymbolicLink())throw new Error('The app path cannot be a symbolic link.');
  await visit('');
  for(const required of [mainPath,nodePath,`${resourcePrefix}bin/echo-server`])if(!files.includes(required))throw new Error(`Missing native executable: ${required}`);
  // The outer app seals its main executable. Sign resource libraries before tools.
  return files.filter(file=>file!==mainPath).sort((a,b)=>Number(entitlementsFor(a).length>0)-Number(entitlementsFor(b).length>0)||a.localeCompare(b));
}
export function validateManifest(original,actual){
  if(original.target!=='aarch64-apple-darwin'||original.libraryProtectionVersion!==1)throw new Error('Build a current Apple Silicon protected runtime before signing.');
  const expected=new Map(original.files?.map(file=>[file.path,file])||[]);
  const files=actual.filter(file=>file.path!=='manifest.json');
  if(expected.size!==files.length)throw new Error('Runtime inventory changed after packaging. Rebuild it.');
  for(const file of files){const item=expected.get(file.path);if(!item||item.bytes!==file.bytes||item.sha256!==file.sha256)throw new Error(`Runtime differs from its packaged manifest: ${file.path}`);}
}
export function signingArguments(file,identity,entitlementFile){
  const args=['--force','--sign',identity,'--timestamp','--options','runtime'];
  if(entitlementsFor(file).length)args.push('--entitlements',entitlementFile);
  if(file!=='app')args.push('--identifier',`app.echovoice.desktop.${createHash('sha256').update(file).digest('hex').slice(0,24)}`);
  return args;
}
export function validateSignature(details,team,file){
  if(!details.includes(`TeamIdentifier=${team}\n`)||!details.includes('Authority=Developer ID Application:')||!/^Timestamp=.+$/m.test(details)||!/^CodeDirectory .+flags=0x[0-9a-f]+\([^\n]*runtime[^\n]*\)/m.test(details))throw new Error(`Missing Developer ID, team, timestamp or hardened runtime: ${file}`);
}
export function validateEntitlements(actual,file){
  const expected=entitlementsFor(file);
  if(Object.keys(actual).length!==expected.length||expected.some(key=>actual[key]!==true))throw new Error(`Unexpected entitlements: ${file}`);
}
export function validateReleaseGuard(result,files){
  const output=String(result.stdout||'')+String(result.stderr||'');
  if(result.error||result.signal||!Number.isInteger(result.status)||result.status===0||!/cannot unlock this library/i.test(output)||files.some(file=>/^workspace\.sqlite(?:$|-)/.test(file))){
    throw new Error('The packaged server failed the production key-policy check. Rebuild echo-server in release mode before signing.');
  }
}
export async function releaseServerPreflight(runtime){
  await mkdir(path.join(project,'tmp'),{recursive:true});
  const scratch=await mkdtemp(path.join(project,'tmp/macos-release-guard-'));
  const library=path.join(scratch,'library');
  try{
    // Installed mode skips .env discovery. All writable paths are session-owned;
    // the known fixture override is rejected before any production keyring access.
    const env={
      HOME:process.env.HOME,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',TMPDIR:scratch,
      ECHO_RUNTIME_MODE:'installed',ECHO_RESOURCE_DIR:path.resolve(runtime),
      ECHO_DATA_DIR:library,ECHO_CACHE_DIR:path.join(scratch,'cache'),
      ECHO_LOG_DIR:path.join(scratch,'logs'),ECHO_RUNTIME_DIR:path.join(scratch,'runtime'),
      ECHO_CONFIG_FILE:path.join(scratch,'config.json'),ECHO_BIND:'127.0.0.1:0',
      ECHO_TEST_MODE:'1',ECHO_TEST_STORAGE_KEY:Buffer.alloc(32,81).toString('base64'),RUST_LOG:'error',
    };
    const result=spawnSync(path.join(path.resolve(runtime),'bin/echo-server'),['--check-library'],{
      cwd:scratch,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000,killSignal:'SIGKILL',maxBuffer:65536,
    });
    const files=await readdir(library).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
    validateReleaseGuard(result,files);
    return {fixtureKeyRejected:true,databaseCreated:false};
  }finally{await rm(scratch,{recursive:true,force:true});}
}
const command=(executable,args,options={})=>execFileSync(executable,args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],...options});
function readEntitlements(file){
  // codesign emits XML on stdout and diagnostics on stderr; an empty stdout means none.
  const xml=command('/usr/bin/codesign',['--display','--entitlements',':-',file]);
  return xml.trim()?JSON.parse(command('/usr/bin/plutil',['-convert','json','-o','-','--','-'],{input:xml})):{};
}
function details(file){
  const result=spawnSync('/usr/bin/codesign',['--display','--verbose=4',file],{encoding:'utf8'});
  if(result.error||result.status!==0)throw new Error(`Cannot inspect signature: ${file}`,{cause:result.error});
  return result.stdout+result.stderr;
}
export async function verifyMacBundle(app,team){
  if(!/^[A-Z0-9]{10}$/.test(team||''))throw new Error('Supply the authorized 10-character signing --team.');
  const native=await signingInventory(app);
  for(const file of [...native,'app']){
    const full=file==='app'?app:path.join(app,file);
    command('/usr/bin/codesign',['--verify','--strict','--verbose=2',full]);
    validateSignature(details(full),team,file);
    validateEntitlements(readEntitlements(full),file);
  }
  command('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',app]);
  const runtime=path.join(app,resourcePrefix);
  validateManifest(JSON.parse(await readFile(path.join(runtime,'manifest.json'),'utf8')),await inspectBundle(runtime));
  return native;
}

// Generated in memory: a one-element ONNX Identity graph, no model download or user data.
export const nativeSmokeSource=String.raw`
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(process.cwd()+'/package.json');
const ort=require('onnxruntime-node');
const sharp=require('sharp');
const varint=n=>{const bytes=[];do{let b=n&127;n>>>=7;if(n)b|=128;bytes.push(b);}while(n);return bytes;};
const integer=(field,n)=>Buffer.from([...varint(field*8),...varint(n)]);
const data=(field,value)=>{const b=Buffer.isBuffer(value)?value:Buffer.from(value);return Buffer.concat([Buffer.from([...varint(field*8+2),...varint(b.length)]),b]);};
const cat=(...parts)=>Buffer.concat(parts);
const value=name=>cat(data(1,name),data(2,data(1,cat(integer(1,1),data(2,data(1,integer(1,1)))))));
const graph=cat(data(1,cat(data(1,'x'),data(2,'y'),data(4,'Identity'))),data(2,'echo-signing-smoke'),data(11,value('x')),data(12,value('y')));
const model=cat(integer(1,8),data(7,graph),data(8,integer(2,13)));
const session=await ort.InferenceSession.create(model,{executionProviders:['cpu']});
try{const result=await session.run({x:new ort.Tensor('float32',new Float32Array([42]),[1])});assert.equal(result.y.data[0],42);}finally{await session.release();}
const png=await sharp(Buffer.from([17,34,51]),{raw:{width:1,height:1,channels:3}}).png().toBuffer();
assert.equal((await sharp(png).metadata()).width,1);
let sum=0;const hot=x=>x*2+1;for(let i=0;i<1000000;i++)sum+=hot(i);assert.equal(sum,1000000000000);
await WebAssembly.compile(new Uint8Array([0,97,115,109,1,0,0,0]));
await import(process.cwd()+'/scripts/native-speech.mjs');
await import(process.cwd()+'/web/speech-errors.js');
console.log('Node runtime smoke: JIT, WebAssembly, native ONNX inference, sharp and speech modules passed.');
`;

export async function signMacBundle({app,output,identity,team,sign=false}){
  if(process.platform!=='darwin')throw new Error('Run macOS signing on macOS.');
  if(!app||!app.endsWith('.app'))throw new Error('Supply --app pointing to an existing Echo Voice.app.');
  app=path.resolve(app);const native=await signingInventory(app);
  const runtime=path.join(app,resourcePrefix);
  const original=JSON.parse(await readFile(path.join(runtime,'manifest.json'),'utf8'));
  validateManifest(original,await inspectBundle(runtime));
  await localRuntimeModules(runtime);
  const bundleInfo=JSON.parse(command('/usr/bin/plutil',['-convert','json','-o','-',path.join(app,'Contents/Info.plist')]));
  if(bundleInfo.CFBundleIdentifier!=='app.echovoice.desktop'||bundleInfo.CFBundleShortVersionString!==original.appVersion)throw new Error('App identity/version does not match its packaged runtime. Rebuild the app.');
  const pins=JSON.parse(await readFile(path.join(project,'scripts/runtime-dependencies.json'),'utf8'));
  if(original.nodeVersion!==pins.node.version)throw new Error('Node version no longer matches the inspected runtime pin.');
  const plan={app,native:native.map(file=>({path:file,entitlements:entitlementsFor(file)})),outerBundleLast:true,refreshManifestBeforeOuterSignature:true,productionKeyPolicy:'unchecked-in-inspection-mode',notarization:'separate',qualification:'pending'};
  if(!sign)return plan;
  if(!/^[A-Z0-9]{10}$/.test(team||'')||!/^Developer ID Application: .+ \([A-Z0-9]{10}\)$/.test(identity||'')||!identity.endsWith(`(${team})`))throw new Error('Select an exact Developer ID Application identity and matching 10-character --team.');
  if(!output?.endsWith('.app'))throw new Error('Supply a new --output .app path; the original is never modified.');
  output=path.resolve(output);
  const artifactRoot=path.join(project,'artifacts/desktop-runtime');
  if(!output.startsWith(`${artifactRoot}${path.sep}`)||output===app)throw new Error('Signed output must be a new path under artifacts/desktop-runtime.');
  try{await lstat(output);throw new Error('Signed output exists. Choose a new path.');}catch(error){if(error.code!=='ENOENT')throw error;}
  await mkdir(path.dirname(output),{recursive:true});
  if(!(await realpath(path.dirname(output))).startsWith(`${await realpath(artifactRoot)}${path.sep}`)&&await realpath(path.dirname(output))!==await realpath(artifactRoot))throw new Error('Signed output parent cannot escape through a symbolic link.');
  await mkdir(path.join(project,'tmp'),{recursive:true});const scratch=await mkdtemp(path.join(project,'tmp/macos-sign-'));
  let ownsOutput=false;
  try{
    await mkdir(output);ownsOutput=true;
    await cp(app,output,{recursive:true,errorOnExist:true,force:false});
    // Check the exact staged server before the first signing/keychain operation.
    await releaseServerPreflight(path.join(output,resourcePrefix));
    plan.productionKeyPolicy='verified-fixture-key-rejection';
    const nodeExisting=readEntitlements(path.join(output,nodePath));
    if(!nodeExisting[jit])throw new Error('The pinned upstream Node no longer claims allow-jit; review its entitlement requirements.');
    if(native.includes(codexPath))validateEntitlements(readEntitlements(path.join(output,codexPath)),codexPath);
    for(const file of native){
      const keys=entitlementsFor(file);const entFile=path.join(scratch,'entitlements.plist');
      if(keys.length)await writeFile(entFile,entitlementPlist(keys));
      command('/usr/bin/codesign',[...signingArguments(file,identity,entFile),path.join(output,file)]);
    }
    const signedRuntime=path.join(output,resourcePrefix);
    const environment={...process.env,TMPDIR:scratch,NODE_OPTIONS:'',NODE_PATH:''};
    for(const key of Object.keys(environment))if(key.startsWith('DYLD_'))delete environment[key];
    console.log(command(path.join(signedRuntime,'bin/node'),['--input-type=module','-e',nativeSmokeSource],{cwd:signedRuntime,env:environment,timeout:120000}).trim());
    if(native.includes(codexPath)){
      const codexVersion=command(path.join(output,codexPath),['--version'],{env:environment,timeout:30000}).trim();
      if(codexVersion!==`codex-cli ${pins.npm.optionalChatgpt.version}`)throw new Error('Signed Codex version does not match the pinned optional helper.');
    }
    original.signing='developer-id';original.signingTeamId=team;
    original.files=(await inspectBundle(signedRuntime)).filter(file=>file.path!=='manifest.json');
    await writeFile(path.join(signedRuntime,'manifest.json'),JSON.stringify(original,null,2)+'\n');
    command('/usr/bin/codesign',[...signingArguments('app',identity),output]);
    await verifyMacBundle(output,team);
    return {...plan,output,signing:'verified-developer-id',notarization:'not-submitted',qualification:'pending'};
  }catch(error){
    // Preserve only the original. A partial signed output must not resemble a release artifact.
    if(ownsOutput)await rm(output,{recursive:true,force:true});throw error;
  }finally{await rm(scratch,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2),allowed=new Set(['--app','--output','--identity','--team','--sign','--verify']);
  for(let i=0;i<args.length;i++){if(!allowed.has(args[i]))throw new Error(`Unknown argument: ${args[i]}`);if(!['--sign','--verify'].includes(args[i])){if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`Missing value: ${args[i]}`);i++;}}
  const value=key=>{const i=args.indexOf(key);return i<0?undefined:args[i+1];};
  if(args.includes('--verify')){if(args.includes('--sign'))throw new Error('Choose either --verify or --sign.');await verifyMacBundle(path.resolve(value('--app')),value('--team'));console.log('Signatures and runtime manifest verified; notarization and clean-machine qualification are separate.');}
  else console.log(JSON.stringify(await signMacBundle({app:value('--app'),output:value('--output'),identity:value('--identity'),team:value('--team'),sign:args.includes('--sign')}),null,2));
}
