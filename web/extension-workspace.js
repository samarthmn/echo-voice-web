/** Reconcile durable extension imports independently of capture and processing. */
export function createExtensionImportMonitor({request, onSaved, onChange, onReady = () => {}, interval = 5000, timers = globalThis}) {
  let stopped = false, timer, inFlight = false, primed = false;
  const announced = new Set();
  async function poll() {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const value = await request('/extensions/recordings');
      for (const recording of value.recordings || []) {
        if (recording.status !== 'complete' || !recording.meetingId || announced.has(recording.recordingId)) continue;
        const meeting = await request(`/meetings/${encodeURIComponent(recording.meetingId)}`);
        if (!meeting.tracks?.length) continue;
        announced.add(recording.recordingId);
        onReady(meeting);
        if (primed) { onChange(meeting); onSaved(meeting); }
      }
      primed = true;
    } catch { /* Echo downtime is independent from extension recording. */ }
    finally { inFlight = false; if (!stopped) timer = timers.setTimeout(poll, interval); }
  }
  return { start() { stopped = false; void poll(); }, stop() { stopped = true; timers.clearTimeout(timer); }, poll };
}

if (typeof window !== 'undefined') {
  const monitor = createExtensionImportMonitor({
    request: async path => {
      const response = await fetch(`/api${path}`, {signal: AbortSignal.timeout(10000), cache:'no-store'});
      if (!response.ok) throw new Error('Echo unavailable');
      return response.json();
    },
    onReady: meeting => window.dispatchEvent(new CustomEvent('echo-extension-import-ready', {detail:meeting})),
    onSaved: meeting => window.dispatchEvent(new CustomEvent('echo-recording-saved', {detail:meeting})),
    onChange: meeting => window.dispatchEvent(new CustomEvent('echo-library-changed', {detail:{meetingId:meeting.id}})),
  });
  monitor.start();
  window.addEventListener('pagehide', () => monitor.stop(), {once:true});
}
