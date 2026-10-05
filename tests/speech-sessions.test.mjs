import test from 'node:test';
import assert from 'node:assert/strict';
import { alternateSpeechSessions, verifySpeechForward } from '../web/speech-sessions.js';
import { speechModelConfig } from '../web/models.js';

const config = speechModelConfig('onnx-community/whisper-large-v3');
function fixture() {
  const alive = new Set(), calls = [], cached = new Map();
  let createOverride;
  class Session {
    constructor(name) {
      this.name = name;
      this.inputNames = name === 'model' ? ['input_features'] : ['input_ids', 'encoder_hidden_states'];
      this.outputNames = name === 'model' ? ['last_hidden_state'] : ['logits', 'cross_attentions.0'];
      this.config = { device: 'wasm', dtype: 'q8', kv_cache_dtype: 'float32', name };
      alive.add(this);
    }
    static async create(bytes, options) {
      assert.equal(this, Session, 'Factory must retain its native constructor owner');
      calls.push({ type: 'create', marker: bytes[0], options });
      if (createOverride) return createOverride(bytes, options);
      return new Session(bytes[0] === 11 ? 'model' : 'decoder_model_merged');
    }
    async run(...args) {
      assert.ok(alive.has(this), 'Forward must use a live native session');
      assert.equal(alive.size, 1, 'Only one native session may be resident at a forward');
      calls.push({ type: 'run', owner: this, args });
      return { native: this.name };
    }
    async release() {
      assert.ok(alive.has(this), 'Native session must be released exactly once');
      calls.push({ type: 'release', owner: this });
      alive.delete(this);
    }
  }
  const original = { model: new Session('model'), decoder_model_merged: new Session('decoder_model_merged') };
  for (const [name, file, marker] of [['model', 'encoder_model_quantized.onnx', 11], ['decoder_model_merged', 'decoder_model_merged_quantized.onnx', 22]]) {
    cached.set(`https://huggingface.co/${config.checkpoint}/resolve/${config.revision}/onnx/${file}`, marker);
  }
  const cache = { async match(url) { return cached.has(url) ? new Response(Uint8Array.of(cached.get(url))) : undefined; } };
  const model = { sessions: { ...original } };
  const lifecycle = alternateSpeechSessions(model, config, cache);
  const dispose = async () => {
    // Exercise the installed Transformers disposal route, which calls handler.dispose().
    const { PreTrainedModel } = await import('@huggingface/transformers');
    await PreTrainedModel.prototype.dispose.call(model);
  };
  return { model, lifecycle, original, alive, calls, cached, cache, Session, dispose, override: fn => { createOverride = fn; } };
}

test('alternating sessions preserve metadata, native ownership and reload options without simultaneous forwards', async () => {
  const f = fixture(), feeds = { input_features: {} }, fetches = ['last_hidden_state'], options = {};
  assert.deepEqual(f.model.sessions.model.inputNames, f.original.model.inputNames);
  assert.deepEqual(f.model.sessions.decoder_model_merged.outputNames, f.original.decoder_model_merged.outputNames);
  assert.equal(f.model.sessions.model.config, f.original.model.config);
  await f.model.sessions.model.run(feeds, fetches, options);
  assert.equal(f.lifecycle.didForward(), false);
  await f.model.sessions.decoder_model_merged.run({ input_ids: {} });
  await f.model.sessions.decoder_model_merged.run({ input_ids: {} });
  await f.model.sessions.model.run(feeds);
  assert.equal(f.lifecycle.didForward(), true);
  const loads = f.calls.filter(call => call.type === 'create');
  assert.deepEqual(loads.map(call => call.marker), [22, 11], 'Consecutive decoder steps reuse the resident decoder');
  for (const load of loads) {
    assert.deepEqual(load.options.executionProviders, ['wasm']);
    assert.equal(load.options.extra.session.disable_prepacking, '1');
  }
  const runs = f.calls.filter(call => call.type === 'run');
  assert.equal(runs[0].owner, f.original.model);
  assert.equal(runs[0].args[0], feeds); assert.equal(runs[0].args[1], fetches); assert.equal(runs[0].args[2], options);
  assert.equal(runs[1].owner.config, f.original.decoder_model_merged.config);
  await f.dispose();
  assert.equal(f.alive.size, 0);
  await f.dispose();
  await assert.rejects(f.model.sessions.model.run(feeds), /disposed/);
});

test('missing cached weights and native reload failures fail honestly and remain disposable', async () => {
  for (const mode of ['missing', 'native']) {
    const f = fixture();
    await f.model.sessions.model.run({ input_features: {} });
    if (mode === 'missing') f.cached.clear(); else f.override(() => { throw 777001; });
    await assert.rejects(f.model.sessions.decoder_model_merged.run({ input_ids: {} }), mode === 'missing' ? /model file is missing/ : reason => reason === 777001);
    assert.equal(f.lifecycle.didForward(), false);
    assert.equal(f.alive.size, 0);
    await f.dispose();
  }
});

test('changed cache metadata is rejected and the unexpected native session is released', async () => {
  const f = fixture();
  await f.model.sessions.model.run({ input_features: {} });
  f.override(() => { const session = new f.Session('decoder_model_merged'); session.inputNames = ['wrong']; return session; });
  await assert.rejects(f.model.sessions.decoder_model_merged.run({ input_ids: {} }), /pinned configuration/);
  assert.equal(f.alive.size, 0);
  await f.dispose();
});

test('disposal during a native reload cannot resurrect a session or run on disposed weights', async () => {
  const f = fixture();
  await f.model.sessions.model.run({ input_features: {} });
  let finishCreate;
  f.override(() => new Promise(resolve => { finishCreate = () => resolve(new f.Session('decoder_model_merged')); }));
  const forward = f.model.sessions.decoder_model_merged.run({ input_ids: {} });
  const rejected = assert.rejects(forward, /disposed/);
  while (!finishCreate) await new Promise(resolve => setImmediate(resolve));
  const disposing = Promise.all(Object.values(f.model.sessions).map(session => session.handler.dispose()));
  finishCreate();
  await Promise.all([rejected, disposing]);
  assert.equal(f.alive.size, 0);
  assert.equal(f.calls.filter(call => call.type === 'run').length, 1);
});

test('Large qualification requires actual encoder and decoder forwards and limits decoder generation', async () => {
  const f = fixture(), features = {};
  const transcriber = {
    processor: async audio => { assert.equal(audio.length, 16000); assert.ok(audio.every(value => value === 0)); return { input_features: features }; },
    model: f.model,
  };
  f.model.generate = async options => {
    assert.equal(options.inputs, features);
    assert.deepEqual({ language: options.language, task: options.task, max_new_tokens: options.max_new_tokens }, { language: 'english', task: 'transcribe', max_new_tokens: 1 });
    await f.model.sessions.model.run({ input_features: features });
    return f.model.sessions.decoder_model_merged.run({ input_ids: {} });
  };
  assert.equal(await verifySpeechForward(transcriber, f.lifecycle), true);
  await f.dispose();
  const noForward = fixture();
  noForward.model.generate = async () => ({});
  await assert.rejects(verifySpeechForward({ processor: transcriber.processor, model: noForward.model }, noForward.lifecycle), /execution check/);
  await noForward.dispose();
});

test('failed encoder execution never qualifies the cache and native exceptions remain intact', async () => {
  const f = fixture();
  f.original.model.run = async () => { assert.equal(f.alive.size, 1); throw 991122; };
  f.model.generate = options => f.model.sessions.model.run({ input_features: options.inputs });
  await assert.rejects(verifySpeechForward({ processor: async () => ({ input_features: {} }), model: f.model }, f.lifecycle), reason => reason === 991122);
  assert.equal(f.lifecycle.didForward(), false);
  assert.equal(f.cached.size, 2, 'A failed execution must retain downloaded files');
  await f.dispose();
  assert.equal(f.alive.size, 0);
});
