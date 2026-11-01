/** Reconcile browser-owned jobs after a local server restart, without restarting inference. */
export function createProcessingHeartbeat({
  request,
  onRestore = () => {},
  schedule = setInterval,
  unschedule = clearInterval,
}: {
  request: (ids: string[], signal: AbortSignal) => Promise<{ restored?: string[] }>;
  onRestore?: (ids: string[]) => void;
  schedule?: (work: () => void, delay: number) => number | ReturnType<typeof setInterval>;
  unschedule?: (timer: number | ReturnType<typeof setInterval>) => void;
}) {
  const active = new Set<string>();
  let timer: number | ReturnType<typeof setInterval> | null = null,
    controller: AbortController | null = null,
    cursor = 0;
  async function pulse() {
    if (controller || !active.size) return;
    const ids = [...active];
    if (cursor >= ids.length) cursor = 0;
    const batch = ids.slice(cursor, cursor + 100);
    cursor += batch.length;
    const current = (controller = new AbortController());
    const deadline = setTimeout(() => current.abort(), 5000);
    try {
      const result = await request(batch, current.signal);
      if (current.signal.aborted) return;
      const restored = (result?.restored || []).filter((id) => active.has(id));
      if (restored.length) onRestore(restored);
    } catch {
      /* A server outage must not cancel a worker that is still computing. */
    } finally {
      clearTimeout(deadline);
      if (controller === current) controller = null;
    }
  }
  function clear() {
    active.clear();
    if (timer !== null) unschedule(timer);
    timer = null;
    controller?.abort();
  }
  return {
    start(id: string) {
      active.add(id);
      if (timer === null)
        timer = schedule(() => {
          void pulse();
        }, 10000);
    },
    stop(id: string) {
      active.delete(id);
      if (!active.size) clear();
    },
    clear,
    pulse,
  };
}
