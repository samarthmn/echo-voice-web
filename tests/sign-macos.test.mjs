import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,rm,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {entitlementsFor,releaseServerPreflight,signingArguments,signingInventory,validateEntitlements,validateManifest,validateReleaseGuard,validateSignature} from '../scripts/sign-macos.mjs';

const prefix='Contents/Resources/runtime/';
const jit='com.apple.security.cs.allow-jit';
const syntheticMachO=Buffer.from('cffaedfe00000000','hex');
test('signing assigns only inspected execution exceptions to their owning tools',()=>{
  assert.deepEqual(entitlementsFor(`${prefix}bin/node`),[jit]);
  assert.deepEqual(entitlementsFor(`${prefix}tools/codex/codex`),[jit,'com.apple.security.cs.allow-unsigned-executable-memory']);
  for(const file of ['app',`${prefix}bin/echo-server`,`${prefix}node_modules/native.node`]){
    assert.deepEqual(entitlementsFor(file),[]);
    assert.ok(!signingArguments(file,'identity','entitlements.plist').includes('--entitlements'));
  }
  assert.ok(signingArguments(`${prefix}bin/node`,'identity','entitlements.plist').includes('--entitlements'));
  assert.ok(!signingArguments('app','identity').includes('--deep'));
  assert.throws(()=>validateEntitlements({[jit]:true,'com.apple.security.get-task-allow':true},`${prefix}bin/node`),/Unexpected entitlements/);
  assert.throws(()=>validateEntitlements({[jit]:true},'app'),/Unexpected entitlements/);
});
test('release signature verification rejects ad-hoc, wrong-team, untimestamped and unhardened code',()=>{
  const good='Authority=Developer ID Application: Test (ABCDEFGHIJ)\nTeamIdentifier=ABCDEFGHIJ\nTimestamp=1 Oct 2026\nCodeDirectory v=20500 size=100 flags=0x10000(runtime) hashes=1\n';
  assert.doesNotThrow(()=>validateSignature(good,'ABCDEFGHIJ','test'));
  for(const bad of [good.replace('ABCDEFGHIJ\n','ZZZZZZZZZZ\n'),good.replace('Authority=Developer ID Application:','Signature=adhoc:'),good.replace('Timestamp=1 Oct 2026\n',''),good.replace('flags=0x10000(runtime)','flags=0x2(adhoc)')])assert.throws(()=>validateSignature(bad,'ABCDEFGHIJ','test'));
});
test('manifest validation refuses altered, omitted and extra runtime resources',()=>{
  const file={path:'bin/node',bytes:5,sha256:'123'};
  const manifest={target:'aarch64-apple-darwin',libraryProtectionVersion:1,files:[file]};
  assert.doesNotThrow(()=>validateManifest(manifest,[file,{path:'manifest.json',bytes:99,sha256:'ignored'}]));
  for(const actual of [[],[{...file,sha256:'changed'}],[file,{path:'extra',bytes:1,sha256:'more'}]])assert.throws(()=>validateManifest(manifest,actual));
  assert.throws(()=>validateManifest({...manifest,libraryProtectionVersion:0},[file]));
});
test('release guard requires safe failure without database creation, not a crash or unrelated error',()=>{
  const safe={status:1,signal:null,stdout:'',stderr:'Error: cannot unlock this library'};
  assert.doesNotThrow(()=>validateReleaseGuard(safe,[]));
  for(const failure of [{...safe,status:0},{...safe,status:null,signal:'SIGKILL'},{...safe,error:new Error('timeout')},{...safe,stderr:'resources are missing'},{...safe,status:null}])assert.throws(()=>validateReleaseGuard(failure,[]),/production key-policy/);
  for(const file of ['workspace.sqlite','workspace.sqlite-wal','workspace.sqlite-shm'])assert.throws(()=>validateReleaseGuard(safe,[file]),/production key-policy/);
});
test('packaged server preflight isolates every writable path and rejects a debug-style server',async()=>{
  await mkdir('tmp',{recursive:true});const root=await mkdtemp(path.resolve('tmp/macos-guard-test-'));
  try{
    await mkdir(path.join(root,'bin'));
    const program=String.raw`
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
const env=process.env;
assert.deepEqual(process.argv.slice(2),['--check-library']);
assert.equal(env.ECHO_RUNTIME_MODE,'installed');assert.equal(env.ECHO_TEST_MODE,'1');
assert.equal(Buffer.from(env.ECHO_TEST_STORAGE_KEY,'base64').length,32);
for(const key of ['ECHO_DATA_DIR','ECHO_CACHE_DIR','ECHO_LOG_DIR','ECHO_RUNTIME_DIR','ECHO_CONFIG_FILE'])assert.ok(env[key].startsWith(process.cwd()+path.sep),key);
assert.equal(env.TMPDIR,process.cwd());assert.equal(env.ECHO_RESOURCE_DIR,path.dirname(path.dirname(process.argv[1])));
assert.equal(env.ECHO_CODEX_BIN,undefined);assert.equal(env.GOOGLE_CLIENT_SECRET,undefined);
fs.mkdirSync(env.ECHO_DATA_DIR,{recursive:true});
`;
    const server=path.join(root,'bin/echo-server');
    await writeFile(server,`#!${process.execPath}\n${program}\nconsole.error('cannot unlock this library');process.exit(1);\n`,{mode:0o700});
    assert.deepEqual(await releaseServerPreflight(root),{fixtureKeyRejected:true,databaseCreated:false});
    await writeFile(server,`#!${process.execPath}\n${program}\nfs.writeFileSync(path.join(env.ECHO_DATA_DIR,'workspace.sqlite'),'synthetic debug db');\n`,{mode:0o700});
    await assert.rejects(releaseServerPreflight(root),/production key-policy/);
    await writeFile(server,`#!${process.execPath}\n${program}\nfs.writeFileSync(path.join(env.ECHO_DATA_DIR,'workspace.sqlite'),'synthetic db');console.error('cannot unlock this library');process.exit(1);\n`,{mode:0o700});
    await assert.rejects(releaseServerPreflight(root),/production key-policy/);
  }finally{await rm(root,{recursive:true,force:true});}
});
test('inventory locates resource Mach-O code, orders tools last, and refuses symlink escapes',async()=>{
  await mkdir('tmp',{recursive:true});const root=await mkdtemp(path.resolve('tmp/macos-sign-test-'));
  try{
    const files=['Contents/MacOS/echo-desktop',`${prefix}bin/node`,`${prefix}bin/echo-server`,`${prefix}node_modules/native.node`];
    for(const file of files){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),syntheticMachO);}
    assert.deepEqual(await signingInventory(root),[`${prefix}bin/echo-server`,`${prefix}node_modules/native.node`,`${prefix}bin/node`]);
    await symlink(path.join(root,`${prefix}bin/node`),path.join(root,'linked-code'));
    await assert.rejects(signingInventory(root),/symbolic link/);
    await rm(path.join(root,'linked-code'));
    await writeFile(path.join(root,'unexpected-native'),syntheticMachO);
    await assert.rejects(signingInventory(root),/new native-code location/);
  }finally{await rm(root,{recursive:true,force:true});}
});
