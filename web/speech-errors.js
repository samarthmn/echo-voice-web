/** Preserve exceptions from native/WASM runtimes, which may throw numbers or strings. */
export function speechErrorDetail(error) {
  if (typeof error?.message === 'string' && error.message.trim()) return error.message.trim();
  if (typeof error === 'number' || typeof error === 'bigint') return `ONNX runtime exception ${error}`;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    try {
      const value = JSON.stringify(error);
      if (value && value !== '{}') return value;
    } catch { /* Some native exception objects contain cycles. */ }
  }
  return 'The speech runtime returned an unknown error';
}

/** Distinguish native encoder failures from the decoder's timestamp generation. */
export function traceSpeechSessions(sessions, onPhase) {
  for (const [name, phase] of [['model', 'running the speech encoder'], ['decoder_model_merged', 'running the word timestamp decoder']]) {
    const session = sessions[name];
    const run = session.run.bind(session);
    session.run = (...args) => { onPhase(phase, name); return run(...args); };
  }
}

/** Observe actual Whisper generation calls; v3 has no pipeline chunk callback. */
export function traceSpeechChunks(model, samples, onProgress, onPhase) {
  const window = 29 * 16000, jump = (29 - 2 * 5) * 16000;
  const total = 1 + Math.ceil(Math.max(0, samples - window) / jump);
  let chunk = 0, decoderSteps = 0;
  const publish = status => onProgress({ status, chunk, totalChunks: total });
  const generate = model.generate.bind(model);
  model.generate = async (...args) => {
    chunk++; decoderSteps = 0;
    publish(`Transcribing chunk ${chunk} of ${total}`);
    const result = await generate(...args);
    publish(`Aligned chunk ${chunk} of ${total}`);
    return result;
  };
  traceSpeechSessions(model.sessions, (phase, name) => {
    onPhase(phase);
    if (name === 'model') publish(`Encoding chunk ${chunk} of ${total}`);
    else if (++decoderSteps === 1 || decoderSteps % 32 === 0) {
      publish(`Generating text for chunk ${chunk} of ${total} · ${decoderSteps} decoder steps`);
    }
  });
}

/** Include the failing phase and a recovery path without guessing why ONNX threw. */
export function speechFailureMessage(error, { download = false, phase = 'processing audio', modelName = 'Speech model' } = {}) {
  const detail = speechErrorDetail(error).split('\n')[0].slice(0, 1000);
  let recovery = 'Retry with Large V3 Turbo or close other tabs and retry.';
  if (download && /failed to fetch|networkerror|network request|fetch failed/i.test(detail)) {
    recovery = 'Check your connection to Hugging Face and retry. Completed files are kept.';
  } else if (/quota/i.test(detail)) {
    recovery = 'Free disk space or remove an unused model, then retry.';
  } else if (/out of memory|memory access|allocat|bad_alloc/i.test(detail)) {
    recovery = 'The speech runtime hit a memory error. Close other tabs and try Large V3 Turbo or a computer with more memory.';
  }
  return `${modelName} failed while ${phase}: ${detail}. ${recovery}${download ? '' : ' Saved audio and transcripts are unchanged.'}`;
}
