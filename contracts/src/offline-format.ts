/** Offline signing format versions, shared with browser code without importing o1js. */

/** Request bundle format the UI exports and the CLI accepts. Version 2 adds the
 *  SubVault owners and threshold to CREATE_CHILD approve bundles. */
export const OFFLINE_REQUEST_VERSION = 2;

/** Store checkpoint carried inside a request; its leaf encoding has not changed. */
export const STORE_CHECKPOINT_VERSION = 1;
