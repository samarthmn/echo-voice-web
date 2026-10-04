// Keep custom dialogs and the narrow-screen navigation drawer usable by keyboard.
// Native <dialog> elements manage their own focus and are deliberately excluded.
const focusable = 'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
let activeLayer;
let releaseLayer;

function syncLayer() {
  const dialog = document.querySelector('div[role="dialog"][aria-modal="true"]');
  const drawer = matchMedia('(max-width:700px)').matches && document.querySelector('.sidebar.open');
  const layer = dialog || drawer || null;
  if (layer === activeLayer) return;
  releaseLayer?.();
  activeLayer = layer;
  releaseLayer = null;
  if (!layer) return;

  const trigger = document.activeElement;
  const scroll = document.body.style.overflow;
  const blocked = [];
  // Inert each branch outside this layer, including the underlying workspace.
  let branch = layer;
  while (branch.parentElement && branch !== document.body) {
    for (const sibling of branch.parentElement.children) {
      if (sibling !== branch && !sibling.classList.contains('nav-scrim') && !sibling.inert) {
        sibling.inert = true;
        blocked.push(sibling);
      }
    }
    branch = branch.parentElement;
  }
  document.body.style.overflow = 'hidden';
  const items = () => [...layer.querySelectorAll(focusable)].filter(item => item.getClientRects().length && !item.closest('[inert]'));
  const initial = layer.querySelector('#new-meeting-title') || items()[0];
  initial?.focus({ preventScroll: true });

  const onKey = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      (dialog ? layer.querySelector('.dialog-close:not(:disabled)') : document.querySelector('.nav-scrim'))?.click();
    }
    if (event.key === 'Tab') {
      const controls = items(), first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !layer.contains(document.activeElement))) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !layer.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
  };
  document.addEventListener('keydown', onKey);
  releaseLayer = () => {
    document.removeEventListener('keydown', onKey);
    blocked.forEach(element => { element.inert = false; });
    document.body.style.overflow = scroll;
    const destination = trigger?.isConnected && !trigger.closest('[inert]') ? trigger : document.getElementById('workspace-main');
    destination?.focus({ preventScroll: true });
  };
}

// Reserve room above bottom controls instead of letting persistent notifications
// intercept clicks on Save, the audio player, or an active recording.
let notificationFrame;
const notificationBars = new Set();
const notificationResize = new ResizeObserver(scheduleNotificationLayout);
function scheduleNotificationLayout() {
  if (notificationFrame) return;
  notificationFrame = requestAnimationFrame(() => {
    notificationFrame = null;
    const bars = new Set(document.querySelectorAll('.settings-save-row,.review-player,.recorder-bar'));
    for (const bar of notificationBars) {
      if (!bars.has(bar)) { notificationResize.unobserve(bar); notificationBars.delete(bar); }
    }
    let bottom = matchMedia('(max-width:700px)').matches ? 16 : 24;
    for (const bar of bars) {
      if (!notificationBars.has(bar)) { notificationBars.add(bar); notificationResize.observe(bar); }
      bottom = Math.max(bottom, bar.getBoundingClientRect().height + (parseFloat(getComputedStyle(bar).bottom) || 0) + 12);
    }
    document.documentElement.style.setProperty('--notification-bottom', `${bottom}px`);
  });
}
new MutationObserver(() => { syncLayer(); scheduleNotificationLayout(); }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
window.addEventListener('resize', scheduleNotificationLayout);
matchMedia('(max-width:700px)').addEventListener('change', syncLayer);
syncLayer();
scheduleNotificationLayout();
