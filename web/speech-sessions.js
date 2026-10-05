/** Keep only one full Large V3 session resident during each native forward pass. */
export function alternateSpeechSessions(model, config, cache) {
  const files = { model: 'encoder_model_quantized.onnx', decoder_model_merged: 'decoder_model_merged_quantized.onnx' };
  const records = Object.entries(files).map(([name, file]) => {
    const original = model.sessions[name];
    if (!original || typeof original.constructor.create !== 'function' || typeof original.release !== 'function') {
      throw new Error('The speech runtime cannot manage this model’s memory. Try Large V3 Turbo.');
    }
    return {
      name, current: original, closed: false, forwards: 0,
      create: original.constructor.create.bind(original.constructor),
      url: `https://huggingface.co/${config.checkpoint}/resolve/${config.revision}/onnx/${file}`,
      inputNames: [...original.inputNames], outputNames: [...original.outputNames], config: original.config,
    };
  });
  let chain = Promise.resolve();
  const serial = operation => { const result = chain.then(operation); chain = result.catch(() => {}); return result; };
  async function drop(record) {
    if (!record.current) return;
    await record.current.release();
    record.current = null;
  }
  const ensureOpen = record => { if (record.closed) throw new Error('The speech session was disposed. Retry transcription.'); };
  async function load(record) {
    if (record.current) return;
    ensureOpen(record);
    const saved = await cache.match(record.url);
    if (!saved) throw new Error('A saved Large V3 model file is missing. Download Large V3 again; saved audio is unchanged.');
    const bytes = new Uint8Array(await saved.arrayBuffer());
    ensureOpen(record);
    const session = await record.create(bytes, { ...config.session_options, executionProviders: ['wasm'] });
    record.current = session;
    session.config = record.config;
    if (record.closed) { await drop(record); ensureOpen(record); }
    if (JSON.stringify(session.inputNames) !== JSON.stringify(record.inputNames)
      || JSON.stringify(session.outputNames) !== JSON.stringify(record.outputNames)) {
      await drop(record);
      throw new Error('The saved Large V3 model does not match its pinned configuration. Download it again.');
    }
  }
  for (const record of records) {
    const dispose = () => {
      record.closed = true;
      return serial(() => drop(record));
    };
    model.sessions[record.name] = {
      inputNames: record.inputNames, outputNames: record.outputNames, config: record.config,
      // Transformers.js 3.8 disposes session.handler directly, rather than release().
      handler: { dispose }, release: dispose,
      run: (...args) => serial(async () => {
        ensureOpen(record);
        for (const other of records) if (other !== record) await drop(other);
        await load(record);
        ensureOpen(record);
        const result = await record.current.run(...args);
        record.forwards++;
        return result;
      }),
    };
  }
  return { didForward: () => records.every(record => record.forwards > 0) };
}

/** Exercise the real encoder and a bounded decoder step without saving dummy text. */
export async function verifySpeechForward(transcriber, lifecycle) {
  const { input_features } = await transcriber.processor(new Float32Array(16000));
  await transcriber.model.generate({ inputs: input_features, language: 'english', task: 'transcribe', max_new_tokens: 1 });
  if (!lifecycle.didForward()) throw new Error('Large V3 did not complete its local execution check. Try Large V3 Turbo.');
  return true;
}
