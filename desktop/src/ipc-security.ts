import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';

const PORT = 5050;
const MAIN_ORIGIN = `http://127.0.0.1:${PORT}`;

type IpcEvent = IpcMainEvent | IpcMainInvokeEvent;

// Defense in depth behind the navigation lock: only the main frame can send
// IPC and it is pinned to the local origin, this catches a regression of that.
export function assertMainWindow(event: IpcEvent): void {
  let origin = '';
  try {
    origin = new URL(event.senderFrame?.url ?? '').origin;
  } catch {
    // no or malformed sender url, treat as untrusted
  }
  if (origin !== MAIN_ORIGIN) {
    throw new Error('Rejected IPC from untrusted sender');
  }
}
