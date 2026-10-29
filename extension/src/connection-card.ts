// The connection card and status line shared by the popup and Setup (same element ids).
import type { ConnectionStatus } from './connection';
import type { PairingView } from './pairing';
import { element, request, showError } from './ui';
import { ConnectionView, connectionStatusOf, connectionSummary, STATUS_DOT } from './status-labels';
const COPY: Record<'none' | 'waiting' | 'revoked', { title: string; detail: string }> = {
  none: {
    title: 'Connect to Echo',
    detail: 'Recordings are saved in this browser until you connect.',
  },
  waiting: {
    title: 'Click Allow in the Echo tab',
    detail: 'Echo is asking whether this browser may send it recordings.',
  },
  revoked: {
    title: 'Echo disconnected this browser',
    detail: 'Your recordings are still saved here. Connect again to send them to Echo.',
  },
};
export function connectionCard(onChange: () => Promise<void>) {
  let view: ConnectionView = { phase: 'none', revoked: false };
  let online = true;
  let failure: string | undefined;
  const connect = element<HTMLButtonElement>('connect');
  const status = (): ConnectionStatus => connectionStatusOf(view, online);
  function render() {
    const current = status();
    element('connection').textContent = connectionSummary(current, view.endpoint);
    element('connection-dot').className = `status-dot ${STATUS_DOT[current]}`;
    const card = current === 'connected' || current === 'echo-offline' ? undefined : COPY[current];
    element('connection-card').hidden = !card;
    if (!card) return;
    element('connection-title').textContent = card.title;
    const detail = element('connection-detail');
    detail.replaceChildren();
    if (current === 'waiting') {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      spinner.setAttribute('aria-hidden', 'true');
      detail.append(spinner);
    }
    detail.append(failure ?? view.notice ?? card.detail);
    connect.hidden = current === 'waiting';
    connect.textContent =
      current === 'revoked' ? 'Connect again' : failure ? 'Retry' : 'Connect to Echo';
    element('show-echo').hidden = current !== 'waiting';
    // Without a request id (its reservation reply was lost) there is no Echo tab to show.
    element<HTMLButtonElement>('show-echo').disabled = !view.requestId;
    element('cancel-connect').hidden = current !== 'waiting';
  }
  async function pairing(message: { type: string; endpoint?: string }, button: HTMLButtonElement) {
    button.disabled = true;
    try {
      const next: PairingView = await request(message);
      failure = undefined;
      view = { ...next, revoked: false };
    } catch (error) {
      failure = (error as Error).message;
    } finally {
      button.disabled = false;
      render();
    }
    await onChange().catch(showError);
  }
  connect.addEventListener('click', () => {
    const manual = document.getElementById('endpoint') as HTMLInputElement | null;
    void pairing({ type: 'PAIR_BEGIN', endpoint: manual?.value.trim() || undefined }, connect);
  });
  for (const [id, type] of [
    ['show-echo', 'PAIR_SHOW_APPROVAL'],
    ['cancel-connect', 'PAIR_CANCEL'],
  ] as const) {
    const button = element<HTMLButtonElement>(id);
    button.addEventListener('click', () => void pairing({ type }, button));
  }
  return {
    status,
    update(next: ConnectionView) {
      if (next.phase !== view.phase) failure = undefined;
      view = next;
      if (next.phase !== 'connected') online = true;
      render();
    },
    setOnline(value: boolean) {
      online = value;
      render();
    },
  };
}
