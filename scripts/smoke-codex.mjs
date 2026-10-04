// Initialize the real pinned helper with managed config, without signing in or sending data.
import { spawn, execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import path from 'node:path';

const targets = {
  'linux-x64': ['linux-x64', 'x86_64-unknown-linux-musl'],
  'linux-arm64': ['linux-arm64', 'aarch64-unknown-linux-musl'],
  'darwin-x64': ['darwin-x64', 'x86_64-apple-darwin'],
  'darwin-arm64': ['darwin-arm64', 'aarch64-apple-darwin'],
  'win32-x64': ['win32-x64', 'x86_64-pc-windows-msvc'],
  'win32-arm64': ['win32-arm64', 'aarch64-pc-windows-msvc'],
};
const target = targets[`${process.platform}-${process.arch}`];
const helper = target && path.resolve('node_modules/@openai', `codex-${target[0]}`, 'vendor', target[1], 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
let available = false;
if (helper) { try { await access(helper); available = true; } catch {} }
if (!available) {
  console.log('SKIP: the pinned optional Codex helper is not installed on this platform.');
} else {
  await mkdir('tmp', { recursive: true });
  const home = await mkdtemp(path.resolve('tmp/codex-config-smoke-'));
  const env = { PATH: process.env.PATH, CODEX_HOME: home, TMPDIR: home };
  for (const key of ['SystemRoot', 'WINDIR', 'LANG', 'LC_ALL']) if (process.env[key]) env[key] = process.env[key];
  let child;
  try {
    const version = execFileSync(helper, ['--version'], { env, encoding: 'utf8', timeout: 8000 }).trim();
    if (version !== 'codex-cli 0.160.0') throw new Error(`Unexpected helper version: ${version}`);
    await writeFile(path.join(home, 'config.toml'), await readFile('server/src/chatgpt-config.toml'), { mode: 0o600 });
    const work = path.join(home, 'work'); await mkdir(path.join(work, '.git'), { recursive: true });
    child = spawn(helper, ['app-server', '--stdio', '--strict-config'], { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let diagnostic = ''; child.stderr.on('data', chunk => { diagnostic += chunk; });
    const lines = createInterface({ input: child.stdout });
    let timer;
    await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Strict-config initialization timed out: ${diagnostic}`)), 15000);
      child.on('error', reject);
      child.on('exit', code => reject(new Error(`Strict-config helper exited (${code}): ${diagnostic}`)));
      lines.on('line', line => {
        let response; try { response = JSON.parse(line); } catch { return; }
        if (response.id !== 1) return;
        if (response.error) reject(new Error(`Strict-config rejected initialization: ${JSON.stringify(response.error)}`));
        else if (response.result) resolve();
        else reject(new Error('Initialization returned no result.'));
      });
      child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'echo_voice_config_smoke', version: '0.1.0' }, capabilities: { experimentalApi: true } } }) + '\n');
    }).finally(() => { clearTimeout(timer); lines.close(); });
    child.stdin.write('{"method":"initialized"}\n');
    console.log('PASS: Codex 0.160.0 accepted the final managed config with --strict-config.');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      await exited; clearTimeout(timer);
    }
    await rm(home, { recursive: true, force: true });
  }
}
