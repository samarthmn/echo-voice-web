/** Browser microphone capture. Audio is uploaded only to the same-origin local server. */
export function createRecorderController({ request = localRequest } = {}) {
  let state = { status: 'idle', elapsed: 0, muted: false, level: 0, hasPendingAudio: false };
  let session = null;
  let starting = false;
  let disposed = false;

  function update(changes) {
    if (disposed || !Object.keys(changes).some((key) => state[key] !== changes[key])) return;
    state = { ...state, ...changes };
    window.dispatchEvent(new CustomEvent('echo-recorder-state', { detail: { ...state } }));
  }

  function elapsed(s) {
    return Math.max(0, (s.activeMs + (s.activeSince === null ? 0 : performance.now() - s.activeSince)) / 1000);
  }

  function freezeClock(s) {
    if (s.activeSince !== null) {
      s.activeMs += performance.now() - s.activeSince;
      s.activeSince = null;
    }
  }

  function closeMuteGap(s) {
    if (s.muteStart !== null) {
      const end = elapsed(s);
      if (end > s.muteStart) s.gaps.push({ start: s.muteStart, end, reason: 'Microphone muted' });
      s.muteStart = null;
    }
  }

  function release(s) {
    clearInterval(s.clock);
    cancelAnimationFrame(s.frame);
    for (const track of s.stream.getTracks()) {
      track.removeEventListener('ended', s.onTrackEnded);
      track.stop();
    }
    if (s.context && s.context.state !== 'closed') void s.context.close().catch(() => {});
    update({ level: 0 });
  }

  function startMeter(s) {
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      s.context = new AudioContextClass();
      const source = s.context.createMediaStreamSource(s.stream);
      const analyser = s.context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const values = new Uint8Array(analyser.fftSize);
      let lastUpdate = 0;
      const measure = (now) => {
        if (s.stopping || session !== s) return;
        if (now - lastUpdate > 80) {
          lastUpdate = now;
          analyser.getByteTimeDomainData(values);
          const power = values.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / values.length;
          const level = s.muted || s.recorder.state !== 'recording' ? 0 : Math.min(1, Math.sqrt(power) * 4);
          update({ level: Math.round(level * 100) / 100 });
        }
        s.frame = requestAnimationFrame(measure);
      };
      void s.context.resume().catch(() => {});
      s.frame = requestAnimationFrame(measure);
    } catch {
      // A missing audio meter must not prevent microphone capture.
      if (s.context) void s.context.close().catch(() => {});
    }
  }

  async function upload(s, chunk) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, attempt * 750));
      const form = new FormData();
      const extension = chunk.mimeType.includes('mp4') ? 'm4a' : chunk.mimeType.includes('ogg') ? 'ogg' : 'webm';
      form.append('file', chunk.blob, `microphone-${chunk.sequence}.${extension}`);
      form.append('sequence', String(chunk.sequence));
      form.append('trackId', s.trackId);
      form.append('label', 'Microphone');
      form.append('mimeType', chunk.mimeType);
      try {
        await request(`/meetings/${encodeURIComponent(s.meeting.id)}/audio`, { method: 'POST', body: form });
        return;
      } catch (error) {
        lastError = error;
        if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) break;
      }
    }
    throw lastError || new Error('Audio could not be saved to your local server.');
  }

  function drain(s) {
    if (s.draining) return s.draining;
    if (s.uploadError) return Promise.reject(s.uploadError);
    s.draining = (async () => {
      try {
        while (s.queue.length) {
          // Keep the front chunk until acknowledged. Sequence numbers make retries idempotent.
          await upload(s, s.queue[0]);
          s.queue.shift();
        }
      } catch (error) {
        s.uploadError = error;
        s.interrupted = true;
        s.interruptionReason = 'Recording stopped after a save error. All retained audio has now been saved.';
        if (!s.stopping) void finalize(s).catch(() => {});
        throw error;
      } finally {
        s.draining = null;
      }
    })();
    return s.draining;
  }

  async function awaitCaptureStopped(s) {
    if (s.stopEventReceived) return;
    let timer;
    try {
      await Promise.race([
        s.captureStopped,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('The browser has not finished the final audio chunk. Keep this page open and retry saving.')), 15000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function finalize(s) {
    if (s.saved) return Promise.resolve(s.saved);
    if (s.finalizing) return s.finalizing;
    s.stopping = true;
    freezeClock(s);
    closeMuteGap(s);
    clearInterval(s.clock);
    update({ status: 'saving', elapsed: elapsed(s), level: 0, error: undefined });
    s.finalizing = (async () => {
      try {
        if (s.recorder.state !== 'inactive') s.recorder.stop();
        // MediaRecorder emits its last dataavailable before stop. Never finalize before it.
        await awaitCaptureStopped(s);
        release(s);
        await drain(s);
        const meeting = await request(`/meetings/${encodeURIComponent(s.meeting.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ duration: elapsed(s), status: s.interrupted ? 'interrupted' : 'saved', gaps: s.gaps }),
        });
        s.saved = meeting;
        update({ status: 'idle', elapsed: elapsed(s), muted: false, level: 0, error: s.interruptionReason || undefined, hasPendingAudio: false });
        window.dispatchEvent(new CustomEvent('echo-recording-saved', { detail: meeting }));
        // A consumer callback failure must never turn an already saved recording into a failed save.
        try {
          Promise.resolve(s.onSaved?.(meeting)).catch((error) => console.error('Recording saved, but its UI callback failed.', error));
        } catch (error) { console.error('Recording saved, but its UI callback failed.', error); }
        return meeting;
      } catch (error) {
        release(s);
        update({ status: 'error', elapsed: elapsed(s), level: 0, error: `${errorMessage(error)} Your unsaved audio is retained in this tab. Keep it open and retry saving.` });
        throw error;
      } finally {
        s.finalizing = null;
      }
    })();
    return s.finalizing;
  }

  async function start({ meeting, deviceId, startMuted = false, onSaved } = {}) {
    if (disposed) throw new Error('The recorder has been disposed.');
    if (starting || (session && !session.saved)) throw new Error('Save the current recording before starting another one.');
    if (!meeting?.id) throw new Error('Create a meeting before starting the recorder.');
    if (!meeting.consent) throw new Error('Confirm participant consent before recording.');
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      const error = new Error('Microphone recording requires localhost or a secure HTTPS page. Open Echo Voice on localhost.');
      update({ status: 'error', error: error.message });
      throw error;
    }
    if (typeof MediaRecorder === 'undefined') {
      const error = new Error('This browser does not support audio recording. Use a current version of Chrome, Edge, Firefox, or Safari.');
      update({ status: 'error', error: error.message });
      throw error;
    }
    starting = true;
    update({ status: 'idle', elapsed: 0, muted: startMuted, level: 0, error: undefined, meetingId: meeting.id });
    let stream;
    let markedRecording = false;
    try {
      // An explicitly selected microphone must never silently fall back to another device.
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true }, video: false });
      if (disposed) throw new Error('Recorder closed before microphone permission was granted.');
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) throw new Error('The selected microphone is no longer connected. Select a microphone and try again.');
      const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      await request(`/meetings/${encodeURIComponent(meeting.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'recording', error: '' }),
      });
      markedRecording = true;
      if (disposed) throw new Error('Recorder closed before capture started.');
      if (!stream.getAudioTracks().some((track) => track.readyState === 'live')) throw new Error('The microphone disconnected before capture started.');
      let resolveStopped;
      const s = {
        meeting, stream, recorder, onSaved, trackId: crypto.randomUUID(),
        activeMs: 0, activeSince: null, muted: startMuted, muteStart: startMuted ? 0 : null,
        gaps: [...(meeting.gaps || [])], queue: [], sequence: 0, draining: null, uploadError: null,
        finalizing: null, stopping: false, saved: null, interrupted: false, interruptionReason: '',
        clock: null, frame: 0, context: null, stopEventReceived: false,
        captureStopped: new Promise((resolve) => { resolveStopped = resolve; }),
        onTrackEnded: null,
      };
      session = s;
      for (const track of stream.getAudioTracks()) track.enabled = !startMuted;
      recorder.addEventListener('dataavailable', (event) => {
        if (!event.data?.size || s.saved) return;
        s.queue.push({ blob: event.data, sequence: s.sequence++, mimeType: recorder.mimeType || event.data.type || 'audio/webm' });
        if (!s.uploadError) void drain(s).catch(() => {});
      });
      recorder.addEventListener('stop', () => {
        s.stopEventReceived = true;
        resolveStopped();
        if (!s.stopping) {
          s.interrupted = true;
          s.interruptionReason = 'The browser stopped microphone capture. Audio recorded before the interruption was saved.';
          void finalize(s).catch(() => {});
        }
      });
      recorder.addEventListener('error', (event) => {
        s.interrupted = true;
        s.interruptionReason = `Microphone capture was interrupted: ${errorMessage(event.error || new Error('browser recording error'))}`;
        void finalize(s).catch(() => {});
      });
      s.onTrackEnded = () => {
        if (s.stopping) return;
        s.interrupted = true;
        s.interruptionReason = 'The microphone disconnected or permission was revoked. Audio recorded before the interruption was saved.';
        void finalize(s).catch(() => {});
      };
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', s.onTrackEnded);
      recorder.start(5000);
      s.activeSince = performance.now();
      s.clock = setInterval(() => update({ elapsed: elapsed(s) }), 250);
      update({ status: 'recording', elapsed: 0, muted: startMuted, error: undefined, hasPendingAudio: true });
      startMeter(s);
    } catch (error) {
      if (stream) for (const track of stream.getTracks()) track.stop();
      // A failed start has no captured chunks and must not block a corrected device selection.
      if (session && !session.activeSince && !session.queue.length) session = null;
      const message = microphoneError(error);
      if (markedRecording) {
        void request(`/meetings/${encodeURIComponent(meeting.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'interrupted', error: message }),
        }).catch(() => {});
      }
      update({ status: 'error', level: 0, error: message, hasPendingAudio: false });
      throw new Error(message);
    } finally {
      starting = false;
    }
  }

  function pause() {
    const s = session;
    if (!s || s.stopping || s.recorder.state !== 'recording') return;
    try {
      s.recorder.pause();
      freezeClock(s);
      update({ status: 'paused', elapsed: elapsed(s), level: 0 });
    } catch (error) {
      s.interrupted = true;
      s.interruptionReason = errorMessage(error);
      void finalize(s).catch(() => {});
    }
  }

  function resume() {
    const s = session;
    if (!s || s.stopping || s.recorder.state !== 'paused') return;
    try {
      s.recorder.resume();
      s.activeSince = performance.now();
      update({ status: 'recording', error: undefined });
    } catch (error) {
      s.interrupted = true;
      s.interruptionReason = errorMessage(error);
      void finalize(s).catch(() => {});
    }
  }

  function toggleMute() {
    const s = session;
    if (!s || s.stopping || s.saved) return;
    s.muted = !s.muted;
    for (const track of s.stream.getAudioTracks()) track.enabled = !s.muted;
    if (s.muted) s.muteStart = elapsed(s);
    else closeMuteGap(s);
    update({ muted: s.muted, ...(s.muted ? { level: 0 } : {}) });
  }

  function stop() {
    if (!session) return Promise.reject(new Error(starting ? 'Wait for the microphone permission request to finish.' : 'There is no recording to save.'));
    return finalize(session);
  }

  function retry() {
    if (!session) return Promise.reject(new Error('There is no retained recording to retry.'));
    if (session.finalizing) return session.finalizing;
    session.uploadError = null;
    return finalize(session);
  }

  function beforeUnload(event) {
    if (starting || (session && !session.saved)) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  function dispose() {
    if (disposed) return;
    if (session && !session.saved) void finalize(session).catch(() => {});
    if (session) release(session);
    window.removeEventListener('beforeunload', beforeUnload);
    disposed = true;
  }

  window.addEventListener('beforeunload', beforeUnload);
  return { get state() { return { ...state }; }, start, pause, resume, toggleMute, stop, retry, dispose };
}

async function localRequest(path, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(`/api${path}`, { ...init, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error || `The local server returned ${response.status}.`);
      error.status = response.status;
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('The local server took too long to respond.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function errorMessage(error) { return error?.message || String(error || 'An unexpected recording error occurred.'); }

function microphoneError(error) {
  switch (error?.name) {
    case 'NotAllowedError': case 'SecurityError': return 'Microphone permission was denied. Allow microphone access in your browser’s site settings, then try again.';
    case 'NotFoundError': return 'No microphone was found. Connect a microphone and try again.';
    case 'OverconstrainedError': return 'The selected microphone is unavailable. Choose a connected microphone and try again.';
    case 'NotReadableError': case 'AbortError': return 'The microphone could not be opened. Check that it is connected and available, then try again.';
    default: return errorMessage(error);
  }
}

if (typeof window !== 'undefined') window.echoRecorder = createRecorderController();
