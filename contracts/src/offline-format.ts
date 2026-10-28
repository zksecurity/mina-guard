/** Offline signing format versions, shared with browser code without importing o1js. */

/** Request bundle format the UI exports and the CLI accepts. Version 2 added
 *  the SubVault configuration; version 3 requires an explicit owner-action fee. */
export const OFFLINE_REQUEST_VERSION = 3;

/** Allowed owner-request fee bounds, in nanomina. The UI selects within this
 *  range and the offline CLI enforces it on the untrusted request bundle. */
export const OFFLINE_MIN_FEE_NANOMINA = 10_000_000;
export const OFFLINE_MAX_FEE_NANOMINA = 100_000_000;

/** Store checkpoint carried inside a request; its leaf encoding has not changed. */
export const STORE_CHECKPOINT_VERSION = 1;

/** Signed owner response; unchanged by version 3 requests. */
export const OFFLINE_RESPONSE_VERSION = 1;
