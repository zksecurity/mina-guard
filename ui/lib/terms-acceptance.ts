/**
 * Version of the terms and beta-risk text a visitor accepts before connecting
 * a wallet. Bump it when either changes materially so everyone accepts again.
 */
export const TERMS_VERSION = 'terms-v1';
export const TERMS_ACCEPTED_KEY = 'minaguard:terms-accepted';
export const TERMS_ACCEPTED_EVENT = 'minaguard:terms-accepted';

/** True when this browser accepted the current terms version. */
export function hasAcceptedTerms(): boolean {
  try {
    return localStorage.getItem(TERMS_ACCEPTED_KEY) === TERMS_VERSION;
  } catch {
    return false;
  }
}

/** Records acceptance in this browser and tells open components. */
export function recordTermsAcceptance(): void {
  try {
    localStorage.setItem(TERMS_ACCEPTED_KEY, TERMS_VERSION);
  } catch {
    // With storage blocked, acceptance lasts until the page reloads.
  }
  window.dispatchEvent(new Event(TERMS_ACCEPTED_EVENT));
}
