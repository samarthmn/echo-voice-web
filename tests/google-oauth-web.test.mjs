import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

const project=process.cwd();
const binary=path.resolve(process.env.ECHO_TEST_BINARY||'target/debug/echo-server');
const clientId='synthetic-web-client.apps.googleusercontent.com',secret='synthetic-web-secret';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,{configured=true}={}){
  await mkdir(path.join(project,'tmp'),{recursive:true});
  const root=await mkdtemp(path.join(project,'tmp/google-web-'));
  const socket=createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');
  const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const base=`http://127.0.0.1:${port}`,origin=`http://localhost:${port}`;
  const redirect=`${origin}/api/integrations/google/callback`,data=path.join(root,'library');
  await writeFile(path.join(root,'echo.config.json'),JSON.stringify({bind:`127.0.0.1:${port}`,dataDir:data,googleRedirectUri:redirect,codexBinary:null}));
  // This isolated source folder contains no personal .env, accounts or recording library.
  const child=spawn(binary,[],{cwd:root,env:{PATH:process.env.PATH,HOME:process.env.HOME,TMPDIR:root,ECHO_TEST_MODE:'1',ECHO_TEST_STORAGE_KEY:Buffer.alloc(32,42).toString('base64'),ECHO_DATA_DIR:data,ECHO_BIND:`127.0.0.1:${port}`,ECHO_CONFIG_FILE:path.join(root,'echo.config.json'),GOOGLE_CLIENT_ID:configured?clientId:'',GOOGLE_CLIENT_SECRET:configured?secret:''},stdio:['ignore','pipe','pipe']});
  let logs='',failure;child.on('error',error=>{failure=error;});for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{logs=(logs+bytes).slice(-8192);});
  t.after(async()=>{if(child.exitCode===null){const stopped=once(child,'exit');child.kill('SIGTERM');let timer;await Promise.race([stopped,new Promise(resolve=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},3000);})]);clearTimeout(timer);}await rm(root,{recursive:true,force:true});});
  for(let attempt=0;attempt<100;attempt++){if(failure)throw failure;if(child.exitCode!==null)throw new Error('Synthetic source server exited');try{const response=await fetch(`${base}/api/storage`);if(response.ok){assert.equal((await response.json()).path,data);return {root,data,base,origin,redirect,logs:()=>logs};}}catch{}await delay(30);}
  throw new Error('Synthetic source server did not start');
}
const get=(base,route,headers={})=>fetch(base+route,{redirect:'manual',headers,signal:AbortSignal.timeout(3000)});
test('web OAuth remains optional and reports maintainer configuration without exposing secrets',async t=>{
  const s=await fixture(t,{configured:false});
  const status=await (await get(s.base,'/api/integrations/status')).json();
  assert.equal(status.google.mode,'source');assert.equal(status.google.configured,false);assert.equal(status.google.connected,false);
  const response=await get(s.origin,'/api/integrations/google/connect',{'Sec-Fetch-Mode':'navigate'});
  assert.equal(response.status,503);assert.match((await response.json()).error,/not configured/);
  assert.ok(!s.logs().includes(secret));
});
test('configured web OAuth uses its existing callback with PKCE and keeps denial and cancellation local',async t=>{
  const s=await fixture(t);
  const status=await (await get(s.base,'/api/integrations/status')).json();assert.equal(status.google.configured,true);assert.equal(status.google.mode,'source');assert.ok(!JSON.stringify(status).includes(secret));
  const canonical=await get(s.base,'/api/integrations/google/connect',{'Sec-Fetch-Mode':'navigate'});assert.equal(canonical.status,303);assert.equal(canonical.headers.get('location'),`${s.origin}/api/integrations/google/connect`);
  const started=await get(s.origin,'/api/integrations/google/connect',{'Sec-Fetch-Mode':'navigate'});
  assert.equal(started.status,303);const authorization=new URL(started.headers.get('location'));
  assert.equal(authorization.origin,'https://accounts.google.com');assert.equal(authorization.searchParams.get('redirect_uri'),s.redirect);assert.equal(authorization.searchParams.get('client_id'),clientId);assert.equal(authorization.searchParams.get('code_challenge_method'),'S256');assert.equal(authorization.searchParams.get('scope'),'openid email https://www.googleapis.com/auth/calendar.readonly');assert.ok(!authorization.searchParams.has('client_secret'));assert.ok(!authorization.searchParams.has('code_verifier'));assert.ok(!authorization.href.includes(secret));
  const cookie=started.headers.getSetCookie().find(value=>!value.includes('Max-Age=0')).split(';')[0];
  const state=authorization.searchParams.get('state');assert.ok(state);assert.ok(!cookie.includes(state));
  const forged=await get(s.origin,`/api/integrations/google/callback?state=wrong&error=access_denied`,{Cookie:cookie,'Sec-Fetch-Mode':'navigate'});assert.equal(forged.status,400);
  const denied=await get(s.origin,`/api/integrations/google/callback?state=${encodeURIComponent(state)}&error=access_denied`,{Cookie:cookie,'Sec-Fetch-Mode':'navigate'});assert.equal(denied.status,303);assert.ok(denied.headers.get('location').startsWith(`${s.origin}/?calendar=error`));assert.ok(!denied.headers.get('location').includes(secret));
  await get(s.origin,'/api/integrations/google/connect',{'Sec-Fetch-Mode':'navigate'});
  assert.equal((await (await get(s.base,'/api/integrations/status')).json()).google.pending,true);
  const cancelled=await fetch(`${s.base}/api/integrations/google/cancel`,{method:'POST',headers:{Origin:s.base,'Content-Type':'application/json'},body:'{}'});assert.equal(cancelled.status,200);assert.equal((await cancelled.json()).cancelled,true);
  assert.equal((await (await get(s.base,'/api/integrations/status')).json()).google.pending,false);
  await assert.rejects(readFile(path.join(s.data,'credentials/google.json')),error=>error.code==='ENOENT');assert.ok(!s.logs().includes(secret));
});
