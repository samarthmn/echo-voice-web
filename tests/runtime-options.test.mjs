import test from 'node:test';
import assert from 'node:assert/strict';
import { wasmThreadCount } from '../web/runtime-options.js';
import { speechModelConfig, DEFAULT_SPEECH_MODEL } from '../web/models.js';

test('WASM remains single threaded when the document is not isolated', () => {
  for (const cores of [2, 8, 32]) assert.equal(wasmThreadCount(false, cores), 1);
});

test('isolated WASM uses at most four threads and leaves half the reported cores available', () => {
  for (const [cores, expected] of [[1, 1], [2, 1], [4, 2], [6, 3], [8, 4], [32, 4]]) {
    assert.equal(wasmThreadCount(true, cores), expected);
  }
});

test('unknown or invalid hardware concurrency safely uses one thread', () => {
  for (const cores of [undefined, null, '8', NaN, Infinity, -4]) assert.equal(wasmThreadCount(true, cores), 1);
});

test('the installed Transformers library forwards Large memory options to both actual session constructors', async t => {
  const sessions = [];
  // Intercept only ONNX session construction; use the installed model loader and
  // cache lookup code, without downloading weights or pretending to infer audio.
  const { InferenceSession } = await import('onnxruntime-node');
  const originalCreate = InferenceSession.create;
  t.after(() => { InferenceSession.create = originalCreate; });
  InferenceSession.create = async (bytes, options) => {
    sessions.push({ marker: bytes[0], options });
    return { inputNames: [], outputNames: [], release: async () => {} };
  };
  const { env, AutoModelForSpeechSeq2Seq } = await import('@huggingface/transformers');
  env.allowLocalModels = true;
  env.useFSCache = false;
  env.useBrowserCache = false;
  env.useCustomCache = true;
  env.customCache = { match: async key => {
    const path = String(key);
    if (path.endsWith('encoder_model_quantized.onnx')) return new Response(Uint8Array.of(11));
    if (path.endsWith('decoder_model_merged_quantized.onnx')) return new Response(Uint8Array.of(22));
    if (path.endsWith('generation_config.json')) return new Response('{}');
    assert.fail(`Unexpected model file: ${path}`);
  }, put: async () => { assert.fail('This model-load test must remain offline.'); } };
  const large = speechModelConfig('onnx-community/whisper-large-v3');
  const model = await AutoModelForSpeechSeq2Seq.from_pretrained(large.checkpoint, {
    config: { model_type: 'whisper', is_encoder_decoder: true, encoder_layers: 32, decoder_layers: 32, d_model: 1280, decoder_attention_heads: 20 },
    local_files_only: true, device: 'cpu', dtype: large.dtype,
    session_options: large.session_options, revision: large.revision,
  });
  assert.deepEqual(sessions.map(({ marker }) => marker).sort(), [11, 22]);
  for (const session of sessions) assert.equal(session.options.extra.session.disable_prepacking, '1');
  assert.equal(model.sessions.model.config.dtype, 'q8');
  assert.equal(model.sessions.decoder_model_merged.config.dtype, 'q8');
  assert.equal(speechModelConfig(DEFAULT_SPEECH_MODEL).session_options, undefined);
  await model.dispose();
});
