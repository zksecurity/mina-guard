// -- HID device chooser -----------------------------------------------------
//
// Electron ships no WebHID picker, so `select-hid-device` has to be answered by
// us — but not from the renderer. Page code can hook DOM APIs and synthesise
// clicks, so a page-drawn chooser is one a compromised page answers for itself,
// silently granting access to any connected HID device. This module returns
// plain data; main.ts renders it with dialog.showMessageBox, which the OS draws
// out of the page's reach.

export interface HIDDeviceInfo {
  deviceId: string;
  name: string;
  vendorId: number;
  productId: number;
}

export interface HidPickerDialog {
  message: string;
  detail: string;
  /** Devices in `devices` order, then Cancel at `cancelId`. */
  buttons: string[];
  cancelId: number;
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

/** e.g. `Ledger Nano S (2c97:0001)`. Real ids go last, so a device whose name
 *  fakes a different pair still shows its own at the end of the label. */
export function formatDeviceLabel(d: HIDDeviceInfo): string {
  return `${d.name || 'Unknown Device'} (${hex4(d.vendorId)}:${hex4(d.productId)})`;
}

/** Cancel is last, so a device's button index is its index in `devices`, and it
 *  is the default: Esc, Enter, or dismissing the dialog all deny. */
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
