// -- HID device chooser -----------------------------------------------------
//
// Electron ships no built-in WebHID picker (Chromium's lives in browser chrome
// Electron doesn't include), so `select-hid-device` has to be answered by us.
// The chooser must NOT be drawn in the renderer: page code can hook DOM APIs
// and synthesise clicks, so a page-realm chooser is one the page can answer for
// itself — a compromised renderer would silently grant itself any connected
// HID device, including hardware wallets it has no business touching. This
// module only builds the spec; main.ts renders it with dialog.showMessageBox,
// which the OS draws and page code cannot reach.

export interface HIDDeviceInfo {
  deviceId: string;
  name: string;
  vendorId: number;
  productId: number;
}

export interface HidPickerDialog {
  message: string;
  detail: string;
  /** Device buttons in `devices` order, then Cancel at `cancelId`. */
  buttons: string[];
  cancelId: number;
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

/** e.g. `Ledger Nano S (2c97:0001)` — ids included so lookalike names differ. */
export function formatDeviceLabel(d: HIDDeviceInfo): string {
  return `${d.name || 'Unknown Device'} (${hex4(d.vendorId)}:${hex4(d.productId)})`;
}

/**
 * Builds the chooser shown for a `select-hid-device` request.
 *
 * Cancel is last so a device's button index is its index in `devices`, and it
 * is also the default action: closing the dialog, hitting Esc, or pressing
 * Enter all deny access rather than granting the first device.
 */
export function buildHidPickerDialog(devices: HIDDeviceInfo[]): HidPickerDialog {
  const buttons = devices.map(formatDeviceLabel);
  return {
    message: 'Select HID Device',
    detail: devices.length === 0
      ? 'No devices found. Connect your Ledger and try again.'
      : 'MinaGuard is requesting direct access to a USB device. Approve only the '
        + 'hardware wallet you are connecting on purpose — if you did not just '
        + 'ask to connect one, cancel.',
    buttons: [...buttons, 'Cancel'],
    cancelId: buttons.length,
  };
}
