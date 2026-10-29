import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(project, 'tmp', 'extension-runtime', 'efficiency');
await mkdir(scratch, { recursive: true });
async function moduleFor(name) {
  const outfile = path.join(scratch, `${name}.mjs`);
  await build({
    entryPoints: [path.join(project, 'extension', 'src', `${name}.ts`)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
  });
  return import(pathToFileURL(outfile).href);
}
const core = await moduleFor('core');
const adapters = await moduleFor('adapters');
const audio = await moduleFor('audio');
const uploads = await moduleFor('upload-scheduler');

function fakeClock() {
  let now = 0;
  let next = 0;
  const timers = new Map();
  return {
    timers,
    now: () => now,
    setTimeout(callback, ms) {
      timers.set(++next, { callback, due: now + ms });
      return next;
    },
    clearTimeout: (id) => timers.delete(id),
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter(([, timer]) => timer.due <= end);
        if (!due.length) break;
        due.sort((a, b) => a[1].due - b[1].due);
        const [id, timer] = due[0];
        timers.delete(id);
        now = timer.due;
        timer.callback();
        for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
      }
      now = end;
    },
  };
}
function scheduler(outcomes) {
  const clock = fakeClock();
  const passes = [];
  const settled = [];
  const api = uploads.uploadScheduler(
    async () => {
      passes.push(clock.now());
      return outcomes.shift() ?? 'idle';
    },
    (state) => settled.push(state),
    clock,
  );
  return { clock, passes, settled, api };
}
test('committed audio uploads are coalesced and spaced; nothing is scheduled while idle', async () => {
  const h = scheduler([]);
  h.api.request();
  h.api.request();
  await h.clock.advance(0);
  assert.deepEqual(h.passes, [0]);
  assert.equal(h.clock.timers.size, 0, 'an idle scheduler holds no timer');
  assert.deepEqual(h.settled, [{ failures: 0 }]);
  h.api.request();
  h.api.request();
  assert.equal(h.api.busy(), true);
  await h.clock.advance(uploads.UPLOAD_INTERVAL_MS);
  assert.deepEqual(h.passes, [0, uploads.UPLOAD_INTERVAL_MS]);
  await h.clock.advance(60_000);
  assert.equal(h.passes.length, 2, 'no polling without new audio');
  assert.equal(h.api.busy(), false);
});
test('a backlog continues immediately; offline Echo backs off exponentially up to five minutes', async () => {
  const h = scheduler(['more', 'more', 'offline', 'offline', 'offline']);
  await h.api.retryNow();
  await h.clock.advance(0);
  assert.deepEqual(h.passes, [0, 0, 0]);
  assert.deepEqual(h.settled.at(-1), { failures: 1, retryAt: 10_000 });
  assert.equal(h.api.busy(), false, 'a pending offline retry lets the worker close the document');
  h.api.request();
  await h.clock.advance(9_999);
  assert.equal(h.passes.length, 3, 'new audio never retries before the backoff ends');
  await h.clock.advance(1);
  assert.equal(h.passes.length, 4);
  assert.deepEqual(h.settled.at(-1), { failures: 2, retryAt: 30_000 });
  await h.clock.advance(20_000);
  assert.deepEqual(h.settled.at(-1), { failures: 3, retryAt: 70_000 });
  assert.equal(uploads.backoffDelay(20), uploads.BACKOFF_MAX_MS);
  assert.equal(uploads.BACKOFF_MAX_MS, 5 * 60_000);
});
test('connect or a user retry uploads at once, and a resumed backoff keeps growing', async () => {
  const h = scheduler(['offline', 'offline']);
  await h.api.retryNow(4);
  assert.deepEqual(h.settled.at(-1), { failures: 5, retryAt: 160_000 });
  await h.api.retryNow();
  assert.deepEqual(h.passes, [0, 0], 'retryNow ignores the pending backoff');
  assert.deepEqual(h.settled.at(-1), { failures: 1, retryAt: 10_000 });
});
test('an unexpected pass failure backs off instead of looping', async () => {
  const clock = fakeClock();
  const settled = [];
  const api = uploads.uploadScheduler(
    async () => {
      throw new Error('storage unavailable');
    },
    (state) => settled.push(state),
    clock,
  );
  const warn = console.warn;
  console.warn = () => {};
  try {
    await api.retryNow();
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(settled, [{ failures: 1, retryAt: 10_000 }]);
});
test('meeting identity ignores hash and volatile query parameters for every service', () => {
  const same = (urls) => {
    const identities = urls.map((url) => core.meetingIdentity(url));
    assert.ok(identities[0], urls[0]);
    for (const identity of identities) assert.equal(identity, identities[0], urls.join(' | '));
  };
  same([
    'https://meet.google.com/abc-defg-hij',
    'https://meet.google.com/abc-defg-hij/',
    'https://meet.google.com/abc-defg-hij?authuser=1&hs=122',
    'https://meet.google.com/ABC-DEFG-HIJ?pli=1#details',
  ]);
  same([
    'https://us02web.zoom.us/wc/123456789/join?pwd=secret&fromPWA=1',
    'https://us02web.zoom.us/wc/123456789/start',
    'https://us02web.zoom.us/wc/join/123456789',
    'https://us02web.zoom.us/wc/123456789#footer',
  ]);
  same([
    'https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d&anon=true',
    'https://teams.microsoft.com/v2/#/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=other',
    'https://teams.microsoft.com/v2/#/conversations/19:meeting_abc@thread.v2?ctx=chat',
    'https://teams.microsoft.com/v2/?culture=de-de#/calendarv2',
  ]);
  same([
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=a',
    'https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/1?context=b#x',
  ]);
  assert.notEqual(
    core.meetingIdentity('https://meet.google.com/abc-defg-hij'),
    core.meetingIdentity('https://meet.google.com/xyz-abcd-efg'),
  );
  assert.notEqual(
    core.meetingIdentity('https://teams.microsoft.com/v2/#/l/meetup-join/a'),
    core.meetingIdentity('https://teams.live.com/v2/#/l/meetup-join/a'),
  );
  assert.equal(core.meetingIdentity('https://zoom.us.evil/wc/123/join'), undefined);
});
test('a Teams view without a meeting cannot start recording but keeps a running one', () => {
  const chat = 'https://teams.microsoft.com/v2/#/conversations/19:abc';
  assert.equal(core.meetingFor(chat), null);
  assert.equal(core.meetingProvider(chat), 'teams');
  const join = 'https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19%3ameeting_abc';
  const meeting = core.meetingFor(join);
  assert.equal(meeting.provider, 'teams');
  const observation = {
    url: chat,
    state: 'unmuted',
    seq: 1,
    documentId: 'document',
    receivedAt: 1000,
  };
  assert.equal(core.microphoneAllowed(observation, meeting.identity, 'document', 1500), true);
});
// Minimal DOM for adapters.observeDocument: attributes, text, toolbar containers and layout.
function element(attributes = {}, text = '', { box = 40, children = [] } = {}) {
  const node = {
    id: attributes.id ?? '',
    textContent: text,
    layoutReads: 0,
    getAttribute: (name) => attributes[name] ?? null,
    getBoundingClientRect() {
      node.layoutReads++;
      return { width: box, height: box };
    },
    querySelectorAll: (selector) =>
      selector === 'button,[role="button"]' ? children.filter((child) => child.button) : [],
    button: true,
  };
  return node;
}
function page({ lang = 'de', buttons = [], toolbar, texts = [] } = {}) {
  return {
    documentElement: { lang },
    querySelectorAll(selector) {
      if (selector === 'button,[role="button"]') return buttons;
      if (selector.startsWith('[role="alert"]')) return [...texts, ...buttons];
      return toolbar && selector.includes(toolbar.match) ? [toolbar.node] : [];
    },
  };
}
globalThis.getComputedStyle = () => ({ visibility: 'visible', display: 'block' });
test('Meet microphone state is read from data-is-muted in any interface language', () => {
  const mic = (muted) =>
    element({ 'data-is-muted': String(muted), 'aria-label': 'Mikrofon deaktivieren (Strg + D)' });
  const camera = element({
    'data-is-muted': 'false',
    'aria-label': 'Kamera deaktivieren (Strg + E)',
  });
  assert.equal(
    adapters.observeDocument('meet', page({ buttons: [mic(false), camera] })),
    'unmuted',
  );
  assert.equal(adapters.observeDocument('meet', page({ buttons: [mic(true), camera] })), 'muted');
  const japanese = element({ 'data-is-muted': 'true', 'aria-label': 'マイクをオンにする (⌘ + d)' });
  assert.equal(
    adapters.observeDocument('meet', page({ lang: 'ja', buttons: [japanese] })),
    'muted',
  );
});
test('localized controls without a language-independent signal stay unknown and exclude the mic', () => {
  const german = element({ 'aria-label': 'Mikrofon deaktivieren (Strg + D)' });
  assert.equal(adapters.observeDocument('meet', page({ buttons: [german] })), 'unknown');
  const zoom = element({ 'aria-label': 'Stummschaltung aufheben', 'aria-pressed': 'true' });
  assert.equal(adapters.observeDocument('zoom', page({ buttons: [zoom] })), 'unknown');
  const pressed = element({ id: 'microphone-button', 'aria-pressed': 'false' });
  assert.equal(
    adapters.observeDocument('teams', page({ buttons: [pressed] })),
    'unknown',
    'aria-pressed polarity is never guessed',
  );
});
test('Teams data-state is language independent; conflicts and duplicates are ambiguous', () => {
  const teams = (state, label = 'マイクをミュート') =>
    element({ id: 'microphone-button', 'data-state': state, 'aria-label': label });
  assert.equal(adapters.observeDocument('teams', page({ buttons: [teams('mic-off')] })), 'muted');
  assert.equal(adapters.observeDocument('teams', page({ buttons: [teams('mic')] })), 'unmuted');
  assert.equal(
    adapters.observeDocument('teams', page({ lang: 'en', buttons: [teams('mic', 'Unmute')] })),
    'unknown',
    'an attribute contradicting its English label is ambiguous',
  );
  assert.equal(
    adapters.observeDocument('teams', page({ buttons: [teams('mic'), teams('mic-off')] })),
    'unknown',
  );
});
test('scans stay inside the call toolbar and measure layout only for microphone candidates', () => {
  const mic = element({
    'data-is-muted': 'false',
    'aria-label': 'Mikrofon deaktivieren (Strg + D)',
  });
  const others = Array.from({ length: 50 }, (_, i) =>
    element({ 'aria-label': `Schaltfläche ${i}` }),
  );
  const stray = element({
    'data-is-muted': 'true',
    'aria-label': 'Mikrofon aktivieren (Strg + D)',
  });
  const toolbar = {
    match: '[role="toolbar"]',
    node: element({}, '', { children: [mic, ...others] }),
  };
  const doc = page({ buttons: [stray, mic, ...others], toolbar });
  assert.equal(adapters.observeDocument('meet', doc, 10_000), 'unmuted', 'stray control ignored');
  assert.equal(mic.layoutReads, 1);
  assert.ok(others.every((button) => button.layoutReads === 0));
  adapters.observeDocument('meet', doc, 10_500);
  assert.equal(mic.layoutReads, 1, 'layout is reused briefly');
  adapters.observeDocument('meet', doc, 11_000);
  assert.equal(mic.layoutReads, 2);
  const hidden = element({ 'data-is-muted': 'false', 'aria-label': 'Mic (Ctrl + D)' }, '', {
    box: 0,
  });
  assert.equal(adapters.observeDocument('meet', page({ buttons: [hidden] })), 'unknown');
});
test('English prejoin and ended texts still win over a microphone toggle', () => {
  const mic = element({ 'data-is-muted': 'false', 'aria-label': 'Turn off microphone (⌘ + d)' });
  const join = element({}, 'Join now');
  assert.equal(
    adapters.observeDocument('meet', page({ lang: 'en', buttons: [mic, join] })),
    'prejoin',
  );
});
test('audio thread reuses its mixing and resampling buffers', () => {
  const mixer = new audio.PCMMixer();
  const tab = [new Float32Array(128).fill(0.25)];
  const mic = [new Float32Array(128).fill(0.25)];
  const first = mixer.mix(tab, mic, true, 128);
  assert.equal(first[0], 0.5, 'sources below the limiter knee sum unchanged');
  const second = mixer.mix(tab, mic, false, 128);
  assert.equal(first.buffer, second.buffer);
  assert.equal(second[0], 0.25, 'tab audio at unity gain while the mic is gated');
  const loud = mixer.mix([new Float32Array(1).fill(0.9)], [new Float32Array(1).fill(0.9)], true, 1);
  assert.ok(loud[0] > 0.9 && loud[0] < 1, `soft limited, not clipped: ${loud[0]}`);
  assert.equal(audio.softClip(-3), -audio.softClip(3));
  const resampler = new audio.PCMResampler(48000);
  const a = resampler.process(new Float32Array(128).fill(0.5));
  const b = resampler.process(new Float32Array(128).fill(0.5));
  assert.equal(a.buffer, b.buffer);
  assert.ok(b.length >= 42 && b.length <= 44);
});
