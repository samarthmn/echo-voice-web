import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm,symlink,cp,access} from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
test('runtime manifest rejects private data, unexpected contents and symlinks before publication',async()=>{
  await mkdir(path.join(root,'tmp'),{recursive:true});const dir=await mkdtemp(path.join(root,'tmp/package-validation-'));
  try {
    const {inspectBundle}=await import('../scripts/package-desktop.mjs');
    await mkdir(path.join(dir,'public'));await writeFile(path.join(dir,'public/index.html'),'safe');
    let files=await inspectBundle(dir);assert.match(files[0].sha256,/^[a-f0-9]{64}$/);assert.equal(files[0].path,'public/index.html');
    for(const name of ['.env','workspace.sqlite','recording.wav','profile.json','server.log','unexpected.txt']){await writeFile(path.join(dir,name),'private');await assert.rejects(inspectBundle(dir),/Unexpected|Private/);await rm(path.join(dir,name));}
    await symlink(root,path.join(dir,'public/link'));await assert.rejects(inspectBundle(dir),/symbolic link/);
  } finally{await rm(dir,{recursive:true,force:true});}
});
test('dependency integrity verification rejects changed downloaded runtime',async()=>{const {verifyHash}=await import('../scripts/package-desktop.mjs');assert.throws(()=>verifyHash(Buffer.from('wrong'),'0'.repeat(64)),/checksum/);});

test('release Calendar configuration accepts bounded Desktop parameters only',async()=>{
  const {desktopGoogleConfiguration}=await import('../scripts/package-desktop.mjs');
  const unavailable={version:1,clientType:'desktop',clientId:null};assert.deepEqual(desktopGoogleConfiguration(unavailable),unavailable);
  const configured={...unavailable,clientId:'123-example.apps.googleusercontent.com'};assert.deepEqual(desktopGoogleConfiguration(configured),configured);
  const withSecret={...configured,clientSecret:'synthetic-desktop-secret'};assert.deepEqual(desktopGoogleConfiguration(withSecret),withSecret);
  for(const value of [{...unavailable,clientSecret:'synthetic'},{...configured,clientType:'web'},{...configured,clientId:'https://untrusted.invalid'},{...configured,tokenEndpoint:'https://untrusted.invalid'}, {...configured,clientId:'x'.repeat(300)+'.apps.googleusercontent.com'},...['','x'.repeat(1025),'with space','line\nbreak','null\u0000byte','del\u007fbyte','nonascii-é',null,42].map(clientSecret=>({...configured,clientSecret}))])assert.throws(()=>desktopGoogleConfiguration(value),/No web clients, tokens or custom endpoints/);
});

test('publisher build input is bounded, explicit and never reflected in errors',async()=>{
  const {loadGoogleConfiguration}=await import('../scripts/package-desktop.mjs');
  const folder=await mkdtemp(path.join(root,'tmp/package-google-config-'));
  const file=path.join(folder,'private.json');
  try{
    const config={version:1,clientType:'desktop',clientId:'123-synthetic.apps.googleusercontent.com'};
    await writeFile(file,JSON.stringify(config));assert.deepEqual(await loadGoogleConfiguration(file),config);
    const withSecret={...config,clientSecret:'private-test-secret'};
    await writeFile(file,JSON.stringify(withSecret));assert.deepEqual(await loadGoogleConfiguration(file),withSecret);
    for(const content of ['private-test-secret is not JSON','x'.repeat(4097),JSON.stringify({...withSecret,redirectUri:'https://invalid.example'})]){
      await writeFile(file,content);
      await assert.rejects(loadGoogleConfiguration(file),error=>error.message.includes('contents have not been logged')&&!error.message.includes('private-test-secret'));
    }
    await symlink(file,path.join(folder,'link'));
    await assert.rejects(loadGoogleConfiguration(path.join(folder,'link')));
    await assert.rejects(loadGoogleConfiguration('relative.json'));
    const template=await loadGoogleConfiguration(path.join(root,'release/google-oauth.json'));assert.equal(template.clientId,null);assert.equal(Object.hasOwn(template,'clientSecret'),false);
  }finally{await rm(folder,{recursive:true,force:true});}
});

test('runtime module closure includes lazy speech error helpers and rejects missing files',async()=>{
  const {localRuntimeModules}=await import('../scripts/package-desktop.mjs');
  await mkdir(path.join(root,'tmp'),{recursive:true});const dir=await mkdtemp(path.join(root,'tmp/package-modules-'));
  try{
    await mkdir(path.join(dir,'scripts'));await mkdir(path.join(dir,'web'));
    for(const file of ['scripts/native-speech.mjs','web/whisper-alignment.js'])await cp(path.join(root,file),path.join(dir,file));
    await assert.rejects(localRuntimeModules(dir),/speech-errors/);
    await cp(path.join(root,'web/speech-errors.js'),path.join(dir,'web/speech-errors.js'));
    assert.ok((await localRuntimeModules(dir)).includes('web/speech-errors.js'));
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('installed runtime excludes installer-only vulnerabilities while preserving shared and nested inference dependencies',async()=>{
  const {pruneRuntimeDependencies}=await import('../scripts/package-desktop.mjs');
  const dir=await mkdtemp(path.join(root,'tmp/package-dependencies-'));
  async function pkg(name,data={}){const folder=path.join(dir,'node_modules',name);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'package.json'),JSON.stringify({name,version:'1.0.0',...data}));return folder;}
  try{
    await pkg('@huggingface/transformers',{dependencies:{'onnxruntime-node':'1.21.0',shared:'1'},optionalDependencies:{'missing-platform':'1'}});
    const onnx=await pkg('onnxruntime-node',{version:'1.21.0',dependencies:{'onnxruntime-common':'1','global-agent':'1',tar:'1'}});
    await mkdir(path.join(onnx,'dist'));await writeFile(path.join(onnx,'dist/index.js'),'require("onnxruntime-common");');await mkdir(path.join(onnx,'script'));await writeFile(path.join(onnx,'script/install.js'),'require("global-agent");');
    await pkg('onnxruntime-common',{dependencies:{nested:'1'}});await pkg('onnxruntime-common/node_modules/nested',{name:'nested'});
    await pkg('global-agent',{dependencies:{shared:'1','sprintf-js':'1'}});await pkg('tar');await pkg('sprintf-js');await pkg('shared');await pkg('@scure/bip39');
    const removed=await pruneRuntimeDependencies(dir);
    assert.ok(removed.includes('node_modules/global-agent'));assert.ok(removed.includes('node_modules/sprintf-js'));assert.ok(removed.includes('node_modules/tar'));
    await access(path.join(dir,'node_modules/shared/package.json'));await access(path.join(dir,'node_modules/onnxruntime-common/node_modules/nested/package.json'));
    await assert.rejects(access(path.join(onnx,'script')),/ENOENT/);
    await writeFile(path.join(onnx,'dist/index.js'),'require("global-agent");');
    await assert.rejects(pruneRuntimeDependencies(dir),/excluded installer dependency/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
