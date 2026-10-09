import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {setTimeout as pause} from 'node:timers/promises';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const clientId='123_synthetic-installed.apps.googleusercontent.com';
async function fixture(t,tokens) {
  await mkdir(path.join(root,'tmp'),{recursive:true});
  const scratch=await mkdtemp(path.join(root,'tmp/google-oauth-installed-'));
  const resource=path.join(scratch,'resources');const data=path.join(scratch,'library');const cwd=path.join(scratch,'foreign');
  for(const dir of [resource,data,cwd,path.join(resource,'public')])await mkdir(dir,{recursive:true});
  await writeFile(path.join(resource,'public/index.html'),'synthetic installed resource');
  const descriptor=path.join(resource,'google-oauth.json');
  await writeFile(descriptor,JSON.stringify({version:1,clientType:'desktop',clientId}));
  await writeFile(path.join(cwd,'.env'),'GOOGLE_CLIENT_ID=foreign-cwd\nGOOGLE_CLIENT_SECRET=foreign-secret\n');
  const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
  await writeFile(path.join(data,'config.json'),JSON.stringify({bind:`127.0.0.1:${port}`,dataDir:'ignored',googleRedirectUri:'https://foreign.invalid/callback',codexBinary:null}),{mode:0o600});
  if(tokens){await mkdir(path.join(data,'credentials'));await writeFile(path.join(data,'credentials/google.json'),JSON.stringify(tokens));}
  const env={...process.env,ECHO_RUNTIME_MODE:'installed',ECHO_TEST_MODE:'1',ECHO_TEST_STORAGE_KEY:Buffer.alloc(32,42).toString('base64'),ECHO_RESOURCE_DIR:resource,ECHO_DATA_DIR:data,ECHO_CACHE_DIR:path.join(scratch,'cache'),ECHO_LOG_DIR:path.join(scratch,'logs'),ECHO_RUNTIME_DIR:path.join(scratch,'runtime'),ECHO_BIND:`127.0.0.1:${port}`,GOOGLE_CLIENT_ID:'foreign-environment',GOOGLE_CLIENT_SECRET:'foreign-secret'};
  const child=spawn(process.env.ECHO_TEST_BINARY||path.join(root,'target/debug/echo-server'),[],{cwd,env,stdio:['ignore','pipe','pipe']});
  let logs='';child.stdout.on('data',bytes=>logs+=bytes);child.stderr.on('data',bytes=>logs+=bytes);
  async function stop(){if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');child.kill('SIGINT');const timer=setTimeout(()=>child.kill('SIGKILL'),3000);await exited;clearTimeout(timer);}
  t.after(async()=>{await stop();await rm(scratch,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  for(let i=0;;i++){if(child.exitCode!==null||i===100)assert.fail(`Synthetic server startup failed: ${logs}`);try{if((await fetch(`${base}/api/health`)).ok)break;}catch{}await pause(30);}
  const status=async()=> (await(await fetch(`${base}/api/integrations/status`)).json()).google;
  async function begin(){
    const request=await fetch(`http://localhost:${port}/api/integrations/google/connect`,{redirect:'manual'});
    assert.equal(request.status,303);const bootstrap=request.headers.get('location');assert.match(bootstrap,/^http:\/\/127\.0\.0\.1:\d+\/start\?request=/);
    const response=await fetch(bootstrap,{redirect:'manual'});assert.equal(response.status,303);
    const destination=new URL(response.headers.get('location'));
    assert.equal(destination.origin,'https://accounts.google.com');assert.equal(destination.searchParams.get('client_id'),clientId);
    assert.equal(destination.searchParams.get('code_challenge_method'),'S256');assert.equal(destination.searchParams.get('code_challenge').length,43);
    assert.equal(destination.searchParams.get('scope'),'openid email https://www.googleapis.com/auth/calendar.readonly');
    assert.equal(destination.searchParams.has('client_secret'),false);assert.equal(destination.searchParams.has('code_verifier'),false);
    const callback=destination.searchParams.get('redirect_uri');assert.match(callback,/^http:\/\/127\.0\.0\.1:\d+\/$/);assert.notEqual(new URL(callback).port,String(port));
    const cookie=response.headers.getSetCookie().find(value=>!value.includes('Max-Age=0')).split(';')[0];
    assert.equal(destination.href.includes('foreign'),false);assert.equal(cookie.includes('{'),false);
    return{callback,cookie,state:destination.searchParams.get('state')};
  }
  return{base,port,data,descriptor,status,begin,stop,logs:()=>logs};
}
async function closed(url){for(let i=0;i<100;i++){try{await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(100)});}catch{return;}await pause(10);}assert.fail('Temporary OAuth listener remained open');}

test('installed descriptor drives isolated PKCE while callbacks preserve the stable workspace origin',async t=>{
  const f=await fixture(t);const original=await readFile(f.descriptor);
  const status=await f.status();assert.equal(status.configured,true);assert.equal(status.mode,'installed');assert.equal(status.connected,false);
  let pending=await f.begin();assert.equal((await f.status()).pending,true);
  const wrong=await fetch(`${pending.callback}?state=wrong&error=access_denied`,{headers:{Cookie:pending.cookie},redirect:'manual'});assert.equal(wrong.status,400);assert.equal((await f.status()).pending,true);
  const denied=await fetch(`${pending.callback}?state=${pending.state}&error=access_denied`,{headers:{Cookie:pending.cookie},redirect:'manual'});assert.equal(denied.status,303);assert.match(denied.headers.get('location'),new RegExp(`^http://localhost:${f.port}/\\?calendar=error`));await closed(pending.callback);
  pending=await f.begin();const cancelled=await fetch(`${f.base}/api/integrations/google/cancel`,{method:'POST',headers:{Origin:f.base}});assert.equal((await cancelled.json()).cancelled,true);await closed(pending.callback);
  pending=await f.begin();await f.stop();await closed(pending.callback);
  assert.deepEqual(await readFile(f.descriptor),original);
  await assert.rejects(access(path.join(f.data,'credentials/google.json')));
  assert.equal(f.logs().includes(pending.state),false);assert.equal(f.logs().includes('foreign-secret'),false);
});

test('installed missing or malformed descriptor ignores inherited web credentials',async t=>{
  const f=await fixture(t);await rm(f.descriptor);
  assert.equal((await f.status()).configured,false);
  let response=await fetch(`${f.base}/api/integrations/google/connect`,{redirect:'manual'});assert.equal(response.status,503);assert.match((await response.json()).error,/publisher/);
  await writeFile(f.descriptor,JSON.stringify({version:1,clientType:'desktop',clientId,clientSecret:'forbidden\ncontrol'}));
  assert.equal((await f.status()).configured,false);
  response=await fetch(`${f.base}/api/integrations/google/connect`,{redirect:'manual'});assert.equal(response.status,503);
});

test('installed Desktop parameter remains outside browser redirects, status and logs',async t=>{
  const f=await fixture(t);const secret='synthetic-desktop-package-secret';
  await writeFile(f.descriptor,JSON.stringify({version:1,clientType:'desktop',clientId,clientSecret:secret}));
  const status=await f.status();assert.equal(status.configured,true);assert.equal(JSON.stringify(status).includes(secret),false);
  const pending=await f.begin();assert.equal(JSON.stringify(pending).includes(secret),false);
  const denied=await fetch(`${pending.callback}?state=${pending.state}&error=access_denied`,{headers:{Cookie:pending.cookie},redirect:'manual'});
  assert.equal(denied.status,303);assert.equal(denied.headers.get('location').includes(secret),false);await closed(pending.callback);
  assert.equal(f.logs().includes(secret),false);await assert.rejects(access(path.join(f.data,'credentials/google.json')));
});

test('installed legacy client mismatch and expired missing refresh offer reconnect without token requests',async t=>{
  const legacy=await fixture(t,{access_token:'synthetic-legacy',refresh_token:'synthetic-refresh',expires_at:Date.now()+3_600_000,email:'synthetic@example.test'});
  let status=await legacy.status();assert.equal(status.connected,false);assert.equal(status.reconnectRequired,true);
  const before=await readFile(path.join(legacy.data,'credentials/google.json'));assert.equal(before.subarray(0,8).toString(),'ECHOENC1');
  assert.equal((await fetch(`${legacy.base}/api/integrations/calendar`)).status,401);assert.deepEqual(await readFile(path.join(legacy.data,'credentials/google.json')),before);
  const missing=await fixture(t,{access_token:'synthetic-expired',refresh_token:null,expires_at:42,email:'synthetic@example.test',client_id:clientId});
  assert.equal((await fetch(`${missing.base}/api/integrations/calendar`)).status,401);
  status=await missing.status();assert.equal(status.connected,false);assert.equal(status.reconnectRequired,true);
});
