/** Open a connected file input so native browser pickers can reliably target it. */
export function chooseJsonFile() {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,application/json';
    input.tabIndex = -1; input.setAttribute('aria-hidden', 'true');
    input.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none';
    let settled = false;
    const cleanup = () => {
      input.removeEventListener('cancel', cancel);
      input.removeEventListener('change', change);
      window.removeEventListener('pagehide', cancel);
      input.remove();
    };
    const finish = value => { if (!settled) { settled = true; cleanup(); resolve(value); } };
    const cancel = () => finish({ cancelled: true });
    const change = async () => {
      try {
        const file = input.files?.[0];
        if (!file) { cancel(); return; }
        if (file.size > 256 * 1024 * 1024) throw new Error('Choose a JSON file smaller than 256 MB.');
        finish({ name: file.name, value: JSON.parse(await file.text()) });
      } catch (error) {
        finish({ error: error instanceof SyntaxError ? 'This file is not valid JSON. Choose an Echo Voice export.' : error.message });
      }
    };
    input.addEventListener('cancel', cancel, { once: true });
    input.addEventListener('change', change, { once: true });
    window.addEventListener('pagehide', cancel, { once: true });
    document.body.appendChild(input);
    try { input.click(); } catch (error) { finish({ error: error.message || 'Unable to open the file. Please try again.' }); }
  });
}

window.echoFiles = { chooseJsonFile };
