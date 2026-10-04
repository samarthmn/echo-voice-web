#!/usr/bin/env node
// Isolated Codex 0.160 protocol double. Never contacts a service or reads host auth.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

if (process.argv.includes('--version')) {
  let version = 'codex-cli 0.160.0';
  try { version = JSON.parse(readFileSync(join(process.env.CODEX_HOME, 'fixture-control.json'), 'utf8')).helperVersion || version; } catch {}
  process.stdout.write(`${version}\n`);
  process.exit(0);
}
const home = process.env.CODEX_HOME;
if (!home || !process.argv.includes('app-server')) process.exit(2);
const path = name => join(home, name);
const read = (name, fallback) => { try { return JSON.parse(readFileSync(path(name), 'utf8')); } catch { return fallback; } };
const control = () => read('fixture-control.json', {});
const log = value => appendFileSync(path('fixture-log.ndjson'), `${JSON.stringify(value)}\n`);
const send = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const notify = (method, params) => send({ method, params });
const reply = (request, result) => send({ id: request.id, result });
const fail = (request, message) => send({ id: request.id, error: { code: -32000, message } });
const authenticated = () => read('fixture-account.json', false);
const setAccount = value => writeFileSync(path('fixture-account.json'), JSON.stringify(value));
let loginId;
let sequence = 0;

log({ event: 'spawn', argv: process.argv.slice(2), cwd: process.cwd(), home,
  inheritedCredentialNames: ['OPENAI_API_KEY', 'CHATGPT_ACCESS_TOKEN', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'HOME', 'USERPROFILE'].filter(key => key in process.env),
  config: readFileSync(path('config.toml'), 'utf8') });

function completeLogin() {
  setAccount(true);
  notify('account/login/completed', { loginId, success: true, error: null });
  loginId = undefined;
}
function completeTurn(request, turnId) {
  const mode = control().mode;
  const threadId = request.params.threadId;
  if (mode === 'crash') process.exit(17);
  if (mode === 'tool-request') {
    send({ id: 'fixture-tool-request', method: 'item/commandExecution/requestApproval', params: { threadId, turnId, command: 'never execute this' } });
    return;
  }
  if (mode === 'quota-error') {
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'failed', error: { message: 'usage limit reached', codexErrorInfo: 'usageLimitExceeded' }, items: [] } });
    return;
  }
  const evidence = { text: 'Release Friday.', passageIds: [mode === 'bad-evidence' ? 'invented' : 'p1'], owner: null, dueDate: null };
  const content = mode === 'bad-json' ? 'invalid JSON' : JSON.stringify({ summary: [evidence], decisions: [], actions: [] });
  const item = { id: `item-${sequence}`, type: 'agentMessage', phase: mode === 'null-phase' ? null : mode === 'commentary-only' ? 'commentary' : 'final_answer', text: content };
  const tool = { id: 'tool-item', type: 'commandExecution', command: 'never execute this', status: 'completed' };
  notify('thread/tokenUsage/updated', { threadId, turnId, tokenUsage: { last: { inputTokens: 123, outputTokens: 45, cachedInputTokens: 20, totalTokens: 168 }, total: {} } });
  // Unrelated messages must not become this turn's notes.
  notify('item/completed', { threadId: 'different-thread', turnId, item: { ...item, text: '{}' }, completedAtMs: Date.now() });
  if (mode === 'tool-event') notify('item/started', { threadId, turnId, item: tool });
  if (mode !== 'final-items-only') notify('item/completed', { threadId, turnId, item, completedAtMs: Date.now() });
  notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', error: null, items: mode === 'tool-final-item' ? [item, tool] : [item] } });
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  let request;
  try { request = JSON.parse(line); } catch { process.exit(3); }
  log({ event: 'received', ...request });
  const settings = control();
  if (request.method === undefined) return;
  switch (request.method) {
    case 'initialize': return reply(request, { userAgent: 'codex-cli/0.160.0', platformFamily: 'unix', platformOs: 'linux' });
    case 'initialized': return;
    case 'account/read': {
      if (loginId && settings.completeLogin) completeLogin();
      const account = settings.apiKeyAccount ? { type: 'apiKey' } : authenticated() ? { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' } : null;
      return reply(request, { account, requiresOpenaiAuth: true });
    }
    case 'account/login/start': {
      loginId = `fixture-login-${++sequence}`;
      const result = { type: 'chatgpt', loginId, authUrl: settings.unsafeAuthUrl || 'https://auth.openai.com/authorize?state=fixture-only' };
      if (settings.immediateLogin) {
        // A legitimate completion may already be queued when the start RPC resolves.
        setAccount(true);
        process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n${JSON.stringify({ method: 'account/login/completed', params: { loginId, success: true, error: null } })}\n`);
        loginId = undefined;
        return;
      }
      return reply(request, result);
    }
    case 'account/login/cancel': loginId = undefined; return reply(request, { status: 'cancelled' });
    case 'account/logout': setAccount(false); loginId = undefined; return reply(request, {});
    case 'account/rateLimits/read': return reply(request, { ordinaryUsageAllowed: settings.mode === 'unknown-allowance' ? null : settings.mode !== 'quota', rateLimits: { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 2000000000 }, secondary: null, credits: { hasCredits: true, balance: 'do-not-expose' } } });
    case 'model/list': return reply(request, { data: [
      { id: 'catalog-id', model: 'fixture-codex', displayName: 'Fixture Codex', hidden: false, isDefault: true },
      { id: 'hidden-id', model: 'hidden-codex', displayName: 'Hidden Codex', hidden: true, isDefault: false },
    ], nextCursor: null });
    case 'thread/start': return reply(request, { thread: { id: `thread-${++sequence}`, environments: settings.mode === 'unsafe-environment' ? [{ id: 'host' }] : [] }, model: settings.mode === 'wrong-model' ? 'unexpected-model' : request.params.model, modelProvider: 'openai', approvalPolicy: 'never', sandbox: { type: 'readOnly', networkAccess: settings.mode === 'unsafe-network' }, cwd: process.cwd() });
    case 'turn/start': {
      const turnId = `turn-${++sequence}`;
      reply(request, { turn: { id: turnId, status: 'inProgress', items: [] } });
      setTimeout(() => completeTurn(request, turnId), settings.delayMs ?? 20);
      return;
    }
    default: return fail(request, `Unexpected fixture request: ${request.method}`);
  }
}).on('close', () => process.exit(0));
