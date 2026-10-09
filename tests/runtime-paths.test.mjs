import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, writeFile, rm, chmod, readdir} from 'node:fs/promises';
import {createServer} from 'node:net';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const root = path.resolve(import.meta.dirname, '..');

test('installed server uses explicit read-only resources and ignores foreign cwd config and dotenv', async () => {
  await mkdir(path.join(root, 'tmp'), {recursive:true});
  const scratch = await mkdtemp(path.join(root, 'tmp/runtime-paths-'));
  const resource = path.join(scratch, 'Echo resources café');
  const cwd = path.join(scratch, 'unrelated cwd');
  const data = path.join(scratch, 'private library');
  for (const dir of [resource, cwd, data, path.join(resource, 'public')]) await mkdir(dir, {recursive:true});
  await writeFile(path.join(resource, 'public/index.html'), 'installed-resource-marker');
  await writeFile(path.join(cwd, 'echo.config.json'), JSON.stringify({bind:'127.0.0.1:1',dataDir:'wrong-library',googleRedirectUri:'https://wrong.invalid',codexBinary:'/wrong/helper'}));
  await writeFile(path.join(cwd, '.env'), 'GOOGLE_CLIENT_ID=unexpected-cwd-client\nGOOGLE_CLIENT_SECRET=unexpected-cwd-secret\nECHO_CODEX_BIN=/wrong/helper\n');
  await chmod(resource, 0o555);
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const env = {...process.env, ECHO_TEST_MODE:'1', ECHO_TEST_STORAGE_KEY:Buffer.alloc(32,42).toString('base64'), ECHO_RUNTIME_MODE:'installed', ECHO_RESOURCE_DIR:resource, ECHO_DATA_DIR:data, ECHO_CACHE_DIR:path.join(scratch, 'cache'), ECHO_LOG_DIR:path.join(scratch, 'logs'), ECHO_RUNTIME_DIR:path.join(scratch, 'runtime'), ECHO_BIND:`127.0.0.1:${port}`};
  delete env.GOOGLE_CLIENT_ID; delete env.GOOGLE_CLIENT_SECRET; delete env.ECHO_CONFIG_FILE;
  const child = spawn(process.env.ECHO_TEST_BINARY || path.join(root, 'target/debug/echo-server'), [], {cwd, env, stdio:['ignore','pipe','pipe']});
  let logs=''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
  try {
    let response;
    for(let i=0;i<100;i++) { if(child.exitCode !== null) assert.fail(`Server exited: ${logs}`); try { response = await fetch(`http://127.0.0.1:${port}/`); break; } catch { await delay(50); } }
    assert.ok(response, logs); assert.equal(await response.text(), 'installed-resource-marker');
    const storage = await (await fetch(`http://127.0.0.1:${port}/api/storage`)).json();
    assert.equal(path.resolve(storage.path), data);
    const integrations = await (await fetch(`http://127.0.0.1:${port}/api/integrations/status`)).json();
    assert.equal(integrations.google.configured, false, 'foreign cwd OAuth settings must not enable an installed integration');
    assert.deepEqual((await readdir(resource)).sort(), ['public']);
    assert.deepEqual((await readdir(cwd)).sort(), ['.env','echo.config.json']);
  } finally { child.kill('SIGINT'); await Promise.race([new Promise(r => child.once('exit',r)),delay(3000)]); if(child.exitCode === null) child.kill('SIGKILL'); await chmod(resource, 0o755); await rm(scratch,{recursive:true,force:true}); }
});
