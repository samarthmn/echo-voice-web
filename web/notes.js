let state = { status: 'idle', model: '', progress: 0 };
let activePull = null;

/** Keep local model downloads alive when the user switches workspace pages. */
export function getDownloadState() { return { ...state }; }
function publish(next) {
  state = { ...next };
  window.dispatchEvent(new CustomEvent('echo-notes-download-state', { detail: getDownloadState() }));
}

/** Consume Ollama's NDJSON stream and require its final success confirmation. */
export function downloadModel(model) {
  if (activePull) return activePull;
  publish({ status: 'downloading', model, progress: 0, detail: 'Preparing download…' });
  const job = (async () => {
    let reader;
    try {
      const response = await fetch('/api/notes/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `The local server returned ${response.status}. Check Ollama and retry.`);
      if (!response.body) throw new Error('Ollama returned no download progress. Check its connection and retry.');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let rest = '', success = false;
      const consume = line => {
        if (!line.trim()) return;
        let progress;
        try { progress = JSON.parse(line); } catch { throw new Error('Ollama returned invalid download progress. Retry the download.'); }
        if (progress.error) throw new Error(progress.error);
        if (progress.status === 'success') success = true;
        const percent = progress.total ? Math.min(100, Math.max(0, Math.round(progress.completed / progress.total * 100) || 0)) : 0;
        publish({ status: 'downloading', model, progress: percent, detail: progress.status || 'Downloading…' });
      };
      while (true) {
        const { done, value } = await reader.read();
        rest += decoder.decode(value, { stream: !done });
        const lines = rest.split('\n'); rest = lines.pop();
        for (const line of lines) consume(line);
        if (done) break;
      }
      consume(rest);
      if (!success) throw new Error('Download ended before Ollama confirmed success. Retry the download.');
      publish({ status: 'completed', model, progress: 100 });
    } catch (error) {
      publish({ status: 'failed', model, progress: 0, error: error.message || 'Notes model download failed. Check Ollama and retry.' });
      throw error;
    } finally {
      await reader?.cancel().catch(() => {});
    }
  })().finally(() => { if (activePull === job) activePull = null; });
  activePull = job;
  return job;
}

window.echoNotes = { getDownloadState, downloadModel };
