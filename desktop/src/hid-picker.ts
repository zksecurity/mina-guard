interface HIDDeviceInfo {
  deviceId: string;
  name: string;
  vendorId: number;
  productId: number;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function buildPickerScript(devices: HIDDeviceInfo[]): string {
  const deviceItems = devices.map((d) => {
    const name = escapeHtml(d.name || 'Unknown Device');
    const ids = `${d.vendorId.toString(16).padStart(4, '0')}:${d.productId.toString(16).padStart(4, '0')}`;
    return `{ deviceId: ${JSON.stringify(d.deviceId)}, name: ${JSON.stringify(name)}, ids: ${JSON.stringify(ids)} }`;
  });

  return `
    new Promise((resolve) => {
      const devices = [${deviceItems.join(',')}];

      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:99999;';

      const modal = document.createElement('div');
      modal.style.cssText = 'background:#1C1C1C;border:1px solid #303033;border-radius:12px;padding:24px;min-width:340px;max-width:420px;font-family:system-ui,-apple-system,sans-serif;color:#fff;';

      const title = document.createElement('h3');
      title.textContent = 'Select HID Device';
      title.style.cssText = 'margin:0 0 16px 0;font-size:1.1rem;font-weight:500;';
      modal.appendChild(title);

      function cleanup(deviceId) {
        overlay.remove();
        resolve(deviceId);
      }

      if (devices.length === 0) {
        const empty = document.createElement('p');
        empty.textContent = 'No devices found. Connect your Ledger and try again.';
        empty.style.cssText = 'color:#A1A3A7;font-size:0.875rem;margin:0 0 16px 0;';
        modal.appendChild(empty);
      } else {
        const list = document.createElement('div');
        list.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:16px;';

        devices.forEach((d) => {
          const btn = document.createElement('button');
          btn.style.cssText = 'display:flex;justify-content:space-between;align-items:center;width:100%;padding:12px 16px;background:#121312;border:1px solid #303033;border-radius:8px;color:#fff;font-size:0.9rem;cursor:pointer;text-align:left;';
          btn.onmouseenter = () => { btn.style.borderColor = '#12FF80'; };
          btn.onmouseleave = () => { btn.style.borderColor = '#303033'; };

          const nameSpan = document.createElement('span');
          nameSpan.innerHTML = d.name;
          btn.appendChild(nameSpan);

          const idSpan = document.createElement('span');
          idSpan.textContent = d.ids;
          idSpan.style.cssText = 'color:#A1A3A7;font-size:0.75rem;font-family:monospace;';
          btn.appendChild(idSpan);

          btn.onclick = () => cleanup(d.deviceId);
          list.appendChild(btn);
        });

        modal.appendChild(list);
      }

      const cancelBtn = document.createElement('button');
      cancelBtn.textContent = 'Cancel';
      cancelBtn.style.cssText = 'width:100%;padding:10px;background:transparent;border:1px solid #303033;border-radius:8px;color:#A1A3A7;font-size:0.875rem;cursor:pointer;';
      cancelBtn.onmouseenter = () => { cancelBtn.style.borderColor = '#A1A3A7'; };
      cancelBtn.onmouseleave = () => { cancelBtn.style.borderColor = '#303033'; };
      cancelBtn.onclick = () => cleanup('');
      modal.appendChild(cancelBtn);

      overlay.appendChild(modal);
      overlay.onclick = (e) => { if (e.target === overlay) cleanup(''); };
      document.body.appendChild(overlay);
    });
  `;
}
