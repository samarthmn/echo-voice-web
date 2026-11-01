import { defined, object, text, numeric } from '../helpers/assertions.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const fakeModules: Record<string, string> = {
  pairing:
    'export const pendingConnect=async()=>undefined;export const confirmConnect=async()=>({});export const beginPairing=async()=>({});export const resumePairing=async()=>({});export const cancelPairing=async()=>({});export const showPairingApproval=async()=>({});export const pairingView=async()=>({phase:"none"});export const whenConnected=()=>{};',
  connection:
    'export async function connectionStatus(){return {status:"none"}};export async function disconnect(){};export async function livePreview(){}',
  'external-messages': 'export async function externalMessage(){return {}}',
  'library-actions':
    'export async function openEcho(){}; export async function deleteLocalRecording(){}',
  settings:
    "export async function settings(){return {enabledProviders:['meet'],micGranted:false,micDeviceId:'default',rememberedConsent:globalThis.remembered??[],liveTranscription:false}};export async function saveSettings(){return {}};export async function readLink(){return {state:'none'}};export async function connectedPair(){};export async function revokeCredential(){};export async function wasRevoked(){return false}",
  storage:
    'export async function allRecordings(){return []};export const pruneReceipts=async()=>{};',
};
const built = await build({
  entryPoints: ['extension/src/background.ts'],
  bundle: true,
  format: 'iife',
  write: false,
  plugins: [
    {
      name: 'background-events',
      setup(builder) {
        builder.onResolve(
          {
            filter:
              /^\.\/(settings|storage|library-actions|connection|pairing|external-messages)(?:\.ts)?$/,
          },
          (args) => ({ path: args.path.slice(2).replace(/\.ts$/, ''), namespace: 'mock' }),
        );
        builder.onLoad({ filter: /.*/, namespace: 'mock' }, (args) => ({
          contents: defined(fakeModules[args.path]),
        }));
      },
    },
  ],
});
const MEET_URL = 'https://meet.google.com/abc-defg-hij';
interface Owner {
  tabId: number;
  identity: string;
  recordingId: string;
  documentId: string;
  gateRevision: number;
}
interface Sender {
  id?: string;
  url?: string;
  tab?: { id: number };
  frameId?: number;
  documentId?: string;
}
interface Events {
  message: (message: unknown, sender: Sender, respond: (reply: unknown) => void) => unknown;
  installed: (details: { reason: string }) => void;
  startup: () => void;
  external: (...args: unknown[]) => unknown;
  removed: (id: number) => void;
  updated: (id: number, change: Partial<chrome.tabs.Tab>, tab: Partial<chrome.tabs.Tab>) => void;
  activated: (details: unknown) => void;
  command: (name: string, tab?: unknown) => void;
  alarm: (alarm: { name: string }) => void;
}
function harness({
  url = MEET_URL,
  identity = 'https://meet.google.com/abc-defg-hij',
  recording = true,
  remembered = [] as string[],
} = {}) {
  let setupOpened = 0;
  let popupOpened = 0;
  let closedDocuments = 0;
  const intervals: number[] = [];
  const session: Record<string, unknown> = {};
  const alarms: { name: string; cleared?: boolean; when?: number }[] = [];
  const badges: unknown[] = [];
  let owner: Owner | undefined = recording
    ? { tabId: 7, identity, recordingId: 'recording', documentId: 'original', gateRevision: 0 }
    : undefined;
  let probeDocumentId: string | null | Error = 'original';
  const events: Partial<Events> = {};
  const sent: Record<string, unknown>[] = [];
  const event = <K extends keyof Events>(name: K) => ({
    addListener: (listener: Events[K]) => {
      events[name] = listener;
    },
  });
  const context = {
    URL,
    Date,
    Map,
    Promise,
    crypto: globalThis.crypto,
    remembered,
    setInterval(_callback: unknown, ms: number) {
      intervals.push(ms);
      return intervals.length;
    },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    chrome: {
      runtime: {
        openOptionsPage: async () => {
          setupOpened++;
        },
        id: 'synthetic',
        getURL: (path: unknown) => `chrome-extension://synthetic/${String(path)}`,
        getContexts: async () => [{}],
        sendMessage: async (message: unknown) => {
          sent.push(object(message));
          return { ok: true, value: {} };
        },
        onMessage: event('message'),
        onInstalled: event('installed'),
        onStartup: event('startup'),
        onMessageExternal: event('external'),
      },
      permissions: { contains: async () => true },
      tabCapture: { getMediaStreamId: async () => 'stream' },
      scripting: {
        executeScript: async (options: {
          target: { tabId: number; frameIds: number[] };
          func?: () => unknown;
          files?: string[];
        }) => {
          assert.equal(options.target.tabId, 7);
          if (options.func) {
            assert.deepEqual([...options.target.frameIds], [0]);
            assert.equal(options.func(), undefined);
          } else assert.deepEqual([...defined(options.files)], ['content.js']);
          if (probeDocumentId instanceof Error) throw probeDocumentId;
          return [{ frameId: 0, documentId: probeDocumentId }];
        },
      },
      storage: {
        session: {
          get: async (key: string) => (key === 'captureOwner' ? { captureOwner: owner } : session),
          set: async (value: Record<string, unknown> | ArrayLike<unknown>) => {
            for (const [key, item] of Object.entries(value))
              if (key === 'captureOwner') {
                const o = object(item);
                owner = {
                  tabId: numeric(o['tabId']),
                  identity: text(o['identity']),
                  recordingId: text(o['recordingId']),
                  documentId: text(o['documentId']),
                  gateRevision: numeric(o['gateRevision']),
                };
              } else session[key] = item;
          },
          remove: async (key: string) => {
            if (key === 'captureOwner') owner = undefined;
            else Reflect.deleteProperty(session, key);
          },
          setAccessLevel: async () => {},
        },
      },
      tabs: {
        get: async () => ({ id: 7, url, active: true }),
        query: async () => [],
        onRemoved: event('removed'),
        onUpdated: event('updated'),
        onActivated: event('activated'),
      },
      action: {
        setBadgeText: async (details: unknown) => {
          badges.push(details);
        },
        setBadgeBackgroundColor: async () => {},
        setTitle: async () => {},
        openPopup: async () => {
          popupOpened++;
        },
      },
      commands: { onCommand: event('command') },
      offscreen: {
        closeDocument: async () => {
          closedDocuments++;
        },
      },
      alarms: {
        create: async (name: string, info: { when?: number }) => {
          alarms.push({ name, ...info });
        },
        clear: async (name: string) => {
          alarms.push({ name, cleared: true });
        },
        onAlarm: event('alarm'),
      },
    },
  };
  vm.runInNewContext(defined(built.outputFiles[0]).text, context);
  return {
    events,
    sent,
    intervals,
    session,
    alarms,
    badges,
    popupOpened: () => popupOpened,
    closedDocuments: () => closedDocuments,
    setupOpened: () => setupOpened,
    owner: () => owner,
    clear: () => {
      owner = undefined;
    },
    probe: (documentId: string | null | Error) => {
      probeDocumentId = documentId;
    },
    observation: (
      state = 'muted',
      documentId = 'original',
      observedUrl = url,
      respond: (value: unknown) => void = () => {},
    ) =>
      defined(events.message)(
        { type: 'MUTE_OBSERVATION', seq: 1, observedAt: Date.now(), url: observedUrl, state },
        { id: 'synthetic', tab: { id: 7 }, frameId: 0, documentId, url: observedUrl },
        respond,
      ),
    fromOffscreen: (message: unknown) =>
      defined(events.message)(
        message,
        { id: 'synthetic', url: 'chrome-extension://synthetic/offscreen.html' },
        () => {},
      ),
    pagehide: (patch = {}) => {
      defined(events.message)(
        { type: 'MEETING_PAGEHIDE', seq: 1, observedAt: Date.now(), url, state: 'unknown' },
        { id: 'synthetic', tab: { id: 7 }, frameId: 0, documentId: 'original', url, ...patch },
        () => {},
      );
    },
  };
}
async function settle() {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
}
for (const [reason, trigger] of [
  [
    'meeting-changed',
    (h) => {
      defined(h.events.updated)(
        7,
        { url: 'https://meet.google.com/xyz-abcd-efg' },
        { url: 'https://meet.google.com/xyz-abcd-efg' },
      );
    },
  ],
  [
    'tab-closed',
    (h) => {
      defined(h.events.removed)(7);
    },
  ],
  ['document-changed', (h) => h.observation('muted', 'new-document')],
  [
    'meeting-changed',
    (h) => h.observation('muted', 'original', 'https://meet.google.com/xyz-abcd-efg'),
  ],
  ['meeting-ended', (h) => h.observation('ended')],
] satisfies [string, (h: ReturnType<typeof harness>) => unknown][])
  void test(`background ${reason} pathway sends a fixed interrupted-stop reason`, async () => {
    const h = harness();
    defined(trigger)(h);
    await settle();
    const control = h.sent.find((message) => message['type'] === 'CONTROL');
    assert.equal(defined(control)['action'], 'stop');
    assert.equal(defined(control)['interrupted'], true);
    assert.equal(defined(control)['interruptionReason'], reason);
    assert.equal(defined(control)['recordingId'], 'recording');
    assert.equal(JSON.stringify(control).includes('https://'), false);
  });
void test('mute and unrelated tab loading do not stop a healthy recording', async () => {
  const h = harness();
  defined(h.events.updated)(8, { status: 'loading' }, {});
  h.observation('muted');
  await settle();
  assert.equal(
    h.sent.some((message) => message['type'] === 'CONTROL'),
    false,
  );
});
void test('same-document loading and completion keep capture active with microphone excluded during verification', async () => {
  const h = harness();
  defined(h.events.updated)(
    7,
    { status: 'loading' },
    { url: 'https://meet.google.com/abc-defg-hij' },
  );
  await settle();
  defined(h.events.updated)(
    7,
    { status: 'complete' },
    { url: 'https://meet.google.com/abc-defg-hij' },
  );
  await settle();
  assert.equal(
    h.sent.some((message) => message['type'] === 'CONTROL'),
    false,
  );
  assert.ok(h.sent.some((message) => message['type'] === 'GATE' && !message['allowed']));
});
void test('same-URL replacement is stopped using Chrome document identity even without a pagehide report', async () => {
  const h = harness();
  defined(h.events.updated)(
    7,
    { status: 'loading' },
    { url: 'https://meet.google.com/abc-defg-hij' },
  );
  await settle();
  h.probe('replacement');
  defined(h.events.updated)(
    7,
    { status: 'complete' },
    { url: 'https://meet.google.com/abc-defg-hij' },
  );
  await settle();
  assert.equal(
    defined(h.sent.find((message) => message['type'] === 'CONTROL'))['interruptionReason'],
    'document-changed',
  );
});
void test('Start pins the owner document from Chrome injection even before a mute observation arrives', async () => {
  const h = harness();
  h.clear();
  const reply = await new Promise((resolve) =>
    defined(h.events.message)(
      { type: 'START', tabId: 7, consent: true, micEnabled: false },
      { id: 'synthetic', url: 'chrome-extension://synthetic/popup.html' },
      resolve,
    ),
  );
  assert.equal(object(reply)['ok'], true);
  assert.equal(defined(h.owner()).documentId, 'original');
});
for (const documentId of [null, new Error('permission lost')])
  void test('an unavailable document probe stops conservatively', async () => {
    const h = harness();
    h.probe(documentId);
    defined(h.events.updated)(7, { status: 'loading' }, {});
    await settle();
    assert.equal(
      defined(h.sent.find((message) => message['type'] === 'CONTROL'))['interruptionReason'],
      'document-unavailable',
    );
  });
void test('original top-frame pagehide stops capture and excludes microphone before stop', async () => {
  const h = harness();
  h.pagehide();
  await settle();
  const stop = h.sent.findIndex((message) => message['type'] === 'CONTROL');
  assert.ok(stop > 0);
  assert.equal(defined(h.sent[stop])['interruptionReason'], 'document-changed');
  assert.ok(
    h.sent.slice(0, stop).some((message) => message['type'] === 'GATE' && !message['allowed']),
  );
});
for (const patch of [
  { frameId: 1 },
  { id: 'another-extension' },
  { documentId: 'unrelated-document' },
  { url: 'https://private.invalid/' },
])
  void test(`untrusted/subframe/stale document pagehide cannot stop the original capture: ${JSON.stringify(patch)}`, async () => {
    const h = harness();
    h.pagehide(patch);
    await settle();
    assert.equal(
      h.sent.some((message) => message['type'] === 'CONTROL'),
      false,
    );
  });
const contentBuilt = await build({
  entryPoints: ['extension/src/content.ts'],
  bundle: true,
  format: 'iife',
  write: false,
});
function contentHarness() {
  let now = 1000;
  let nextTimer = 0;
  let label = 'Turn off microphone';
  let scans = 0;
  let failSend: string | undefined;
  const sent: Record<string, unknown>[] = [];
  const observers: { callback: () => void; disconnected: boolean }[] = [];
  interface Timer {
    callback: () => void;
    due: number;
    interval: number;
  }
  const timers = new Map<number, Timer>();
  const handlers = new Set<(event: { isTrusted: boolean }) => void>();
  const addTimer = (callback: () => void, ms: number, repeat = false) => {
    const id = ++nextTimer;
    timers.set(id, { callback, due: now + ms, interval: repeat ? ms : 0 });
    return id;
  };
  const context = vm.createContext({
    __echoMuteObserverV1: true,
    URL,
    Date: class extends Date {
      static override now() {
        return now;
      }
    },
    location: { href: 'https://meet.google.com/abc-defg-hij' },
    document: {
      documentElement: {},
      querySelectorAll(selector: string) {
        if (selector === 'button,[role="button"]') {
          scans++;
          return [
            {
              getBoundingClientRect: () => ({ width: 40, height: 40 }),
              getAttribute: (name: string) => (name === 'aria-label' ? label : null),
              textContent: '',
            },
          ];
        }
        return [];
      },
    },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
    MutationObserver: class {
      constructor(publicCallback: () => void) {
        this.callback = publicCallback;
        observers.push(this);
      }
      callback: () => void;
      disconnected = false;
      observe() {}
      disconnect() {
        this.disconnected = true;
      }
    },
    setTimeout: (callback: () => void, ms: number) => addTimer(callback, ms),
    clearTimeout: (id: number) => timers.delete(id),
    setInterval: (callback: () => void, ms: number) => addTimer(callback, ms, true),
    clearInterval: (id: number) => timers.delete(id),
    window: {
      addEventListener(_name: string, callback: (event: { isTrusted: boolean }) => void) {
        handlers.add(callback);
      },
      removeEventListener(_name: string, callback: (event: { isTrusted: boolean }) => void) {
        handlers.delete(callback);
      },
    },
    chrome: {
      runtime: {
        sendMessage(message: unknown) {
          if (failSend === 'sync') throw new Error('extension invalidated');
          if (failSend === 'async') return Promise.reject(new Error('extension invalidated'));
          if (failSend === 'retire') return Promise.resolve({ observe: false });
          sent.push(object(message));
          return Promise.resolve();
        },
      },
    },
  });
  const inject = () => {
    vm.runInContext(defined(contentBuilt.outputFiles[0]).text, context);
  };
  inject();
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      let first: [number, Timer] | undefined;
      for (const [id, timer] of timers)
        if (timer.due <= end && (!first || timer.due < first[1].due)) first = [id, timer];
      if (!first) break;
      const [id, timer] = first;
      now = timer.due;
      if (timer.interval) timer.due += timer.interval;
      else timers.delete(id);
      timer.callback();
    }
    now = end;
  };
  return {
    sent,
    observers,
    timers,
    handlers,
    inject,
    advance,
    scans: () => scans,
    label: (value: string) => {
      label = value;
    },
    fail: (value: string) => {
      failSend = value;
    },
    mutate: () => {
      for (const observer of observers) if (!observer.disconnected) observer.callback();
    },
    pagehide: (isTrusted: boolean) => {
      for (const handler of [...handlers]) handler({ isTrusted });
    },
  };
}
void test('mutation bursts scan once per 100 ms and report the latest mute state without stale caching', () => {
  const h = contentHarness();
  assert.equal(h.scans(), 1);
  assert.equal(defined(h.sent[0])['state'], 'unmuted');
  for (let i = 0; i < 1000; i++) h.mutate();
  assert.equal(h.scans(), 1);
  assert.equal(h.timers.size, 2);
  h.advance(50);
  h.label('Turn on microphone');
  h.mutate();
  h.advance(49);
  assert.equal(h.sent.length, 1);
  h.advance(1);
  assert.equal(h.scans(), 2);
  assert.equal(defined(h.sent.at(-1))['state'], 'muted');
  assert.equal(defined(h.sent.at(-1))['observedAt'], 1100);
  h.label('Unrecognized microphone control');
  for (let i = 0; i < 100; i++) {
    h.advance(10);
    h.mutate();
  }
  assert.equal(defined(h.sent.at(-1))['state'], 'unknown');
  assert.equal(h.scans(), h.sent.length);
  const sentCount = () => h.sent.length;
  assert.ok(sentCount() <= 12);
  for (let i = 1; i < h.sent.length; i++)
    assert.ok(
      numeric(defined(h.sent[i])['observedAt']) - numeric(defined(h.sent[i - 1])['observedAt']) >=
        100,
    );
});
void test('the independent 500 ms heartbeat scans fresh controls without mutation events', () => {
  const h = contentHarness();
  h.label('Turn on microphone');
  h.advance(500);
  assert.equal(h.sent.length, 2);
  assert.equal(defined(h.sent[1])['state'], 'muted');
  assert.equal(defined(h.sent[1])['observedAt'], 1500);
  h.advance(500);
  assert.equal(h.sent.length, 3);
  assert.equal(defined(h.sent[2])['observedAt'], 2000);
});
void test('trusted pagehide sends unknown immediately and cancels pending scans; forged events do neither', () => {
  const h = contentHarness();
  h.advance(50);
  h.mutate();
  h.pagehide(false);
  assert.equal(h.sent.length, 1);
  assert.equal(h.timers.size, 2);
  h.pagehide(true);
  assert.equal(h.sent.length, 2);
  assert.equal(defined(h.sent[1])['type'], 'MEETING_PAGEHIDE');
  assert.equal(defined(h.sent[1])['state'], 'unknown');
  assert.equal(defined(h.sent[1])['observedAt'], 1050);
  assert.equal(h.scans(), 1);
  assert.equal(h.timers.size, 0);
  assert.equal(h.handlers.size, 0);
  assert.equal(defined(h.observers[0]).disconnected, true);
  h.advance(1000);
  assert.equal(h.sent.length, 2);
});
void test('reinjecting content cancels pending scans and preserves sequence across observer replacement', () => {
  const h = contentHarness();
  h.advance(50);
  h.mutate();
  assert.equal(h.timers.size, 2);
  h.inject();
  assert.equal(h.observers.length, 2);
  assert.equal(defined(h.observers[0]).disconnected, true);
  assert.equal(defined(h.observers[1]).disconnected, false);
  assert.equal(h.timers.size, 1);
  assert.equal(h.handlers.size, 1);
  assert.deepEqual(
    h.sent.map((message) => message['seq']),
    [0, 1],
  );
  h.advance(100);
  assert.equal(h.sent.length, 2, 'old trailing scan was cancelled');
  h.pagehide(true);
  assert.equal(defined(h.sent.at(-1))['seq'], 2);
});
for (const failure of ['sync', 'async'])
  void test(`observer ${failure} runtime disconnect disposes heartbeat and pending mutation timer`, async () => {
    const h = contentHarness();
    h.advance(50);
    h.mutate();
    h.fail(failure);
    h.advance(50);
    await settle();
    assert.equal(defined(h.observers[0]).disconnected, true);
    assert.equal(h.timers.size, 0);
    assert.equal(h.handlers.size, 0);
    const scans = h.scans();
    h.advance(1000);
    h.mutate();
    assert.equal(h.scans(), scans);
  });
void test('an observer retires when the worker reports that its tab is not recording', async () => {
  const h = contentHarness();
  h.fail('retire');
  h.advance(500);
  await settle();
  assert.equal(defined(h.observers[0]).disconnected, true);
  assert.equal(h.timers.size, 0);
  assert.equal(h.handlers.size, 0);
});

void test('setup opens on first install only, never on extension update', async () => {
  const h = harness();
  defined(h.events.installed)({ reason: 'update' });
  await settle();
  assert.equal(h.setupOpened(), 0);
  defined(h.events.installed)({ reason: 'install' });
  await settle();
  assert.equal(h.setupOpened(), 1);
});
void test('an idle worker keeps no timers and retires observers of tabs that are not recording', async () => {
  const h = harness({ recording: false });
  await settle();
  assert.equal(h.intervals.length, 0, 'no gate or claim polling while nothing records');
  let reply: unknown;
  h.observation('unmuted', 'original', MEET_URL, (value: unknown) => {
    reply = value;
  });
  await settle();
  assert.equal(object(reply)['observe'], false);
  assert.equal(
    h.sent.some((message) => message['type'] === 'GATE'),
    false,
  );
});
void test('a recording runs the gate on observations and once a second, and keeps its observer', async () => {
  const h = harness();
  let reply: unknown;
  h.observation('unmuted', 'original', MEET_URL, (value: unknown) => {
    reply = value;
  });
  await settle();
  assert.equal(object(reply)['observe'], true);
  assert.deepEqual([...h.intervals], [1000]);
  assert.ok(h.sent.some((message) => message['type'] === 'GATE' && message['allowed']));
});
void test('Teams in-meeting hash navigation keeps recording and the microphone gate', async () => {
  const join =
    'https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d';
  const h = harness({ url: join, identity: 'https://teams.microsoft.com/v2' });
  const moved = 'https://teams.microsoft.com/v2/#/conversations/19:meeting_abc@thread.v2?ctx=chat';
  defined(h.events.updated)(7, { url: moved }, { url: moved });
  h.observation('unmuted', 'original', moved);
  await settle();
  assert.equal(
    h.sent.some((message) => message['type'] === 'CONTROL'),
    false,
  );
  assert.ok(h.sent.some((message) => message['type'] === 'GATE' && message['allowed']));
  const elsewhere = 'https://teams.live.com/v2/#/l/meetup-join/other';
  defined(h.events.updated)(7, { url: elsewhere }, { url: elsewhere });
  await settle();
  assert.equal(
    defined(h.sent.find((message) => message['type'] === 'CONTROL'))['interruptionReason'],
    'meeting-changed',
  );
});
void test('the shortcut stops an active recording', async () => {
  const h = harness();
  defined(h.events.command)('toggle-recording', { id: 7, url: MEET_URL });
  await settle();
  const stop = h.sent.find((message) => message['type'] === 'CONTROL');
  assert.equal(defined(stop)['action'], 'stop');
  assert.equal(defined(stop)['interrupted'], undefined);
  assert.equal(h.owner(), undefined);
});
void test('the shortcut starts only where consent is remembered, otherwise it opens the popup', async () => {
  const unconfirmed = harness({ recording: false });
  defined(unconfirmed.events.command)('toggle-recording', {
    id: 7,
    url: MEET_URL,
    title: 'Standup',
  });
  await settle();
  assert.equal(
    unconfirmed.sent.some((message) => message['type'] === 'START'),
    false,
  );
  assert.match(text(unconfirmed.session['recorderError']), /participants consent/);
  assert.equal(unconfirmed.popupOpened(), 1);
  const remembered = harness({ recording: false, remembered: ['meet'] });
  defined(remembered.events.command)('toggle-recording', {
    id: 7,
    url: MEET_URL,
    title: 'Standup',
  });
  await settle();
  const start = remembered.sent.find((message) => message['type'] === 'START');
  assert.equal(object(defined(start)['recording'])['consent'], true);
  assert.equal(object(defined(start)['recording'])['title'], 'Standup');
  assert.equal(defined(start)['micEnabled'], false);
  assert.equal(defined(remembered.owner()).tabId, 7);
});
void test('settled uploads close an idle offscreen document and schedule the offline retry', async () => {
  const h = harness({ recording: false });
  h.fromOffscreen({ type: 'UPLOADS_SETTLED', failures: 2, retryAt: 123456 });
  await settle();
  assert.deepEqual(h.alarms, [{ name: 'echo-transfer', when: 123456 }]);
  assert.equal(h.session['uploadFailures'], 2);
  assert.equal(h.closedDocuments(), 1);
  const recording = harness();
  recording.fromOffscreen({ type: 'UPLOADS_SETTLED', failures: 0 });
  await settle();
  assert.equal(recording.closedDocuments(), 0, 'a recording keeps its offscreen document');
});
void test('an enabled meeting tab shows the ready badge; recording shows REC everywhere', async () => {
  const h = harness({ recording: false });
  defined(h.events.activated)({ tabId: 7 });
  await settle();
  assert.equal(object(h.badges.at(-1))['text'], '●');
  assert.equal(object(h.badges.at(-1))['tabId'], 7);
  h.fromOffscreen({ type: 'CAPTURE_STATUS', active: { recordingId: 'recording', paused: false } });
  await settle();
  assert.equal(object(h.badges.at(-1))['text'], 'REC');
  assert.equal(object(h.badges.at(-1))['tabId'], undefined);
});
