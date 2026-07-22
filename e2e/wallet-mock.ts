/**
 * Mock `window.mina` provider injected before app JS loads. Shared by the
 * chain e2e suite (helpers.ts) and the UI suite (ui/), which must not import
 * helpers.ts because that module pulls in o1js.
 */
export const MOCK_WALLET_SCRIPT = `
  window.__testActiveAddress = null;
  window.__testEventHandlers = {};

  window.mina = {
    requestAccounts() {
      return Promise.resolve(
        window.__testActiveAddress ? [window.__testActiveAddress] : []
      );
    },
    getAccounts() {
      return Promise.resolve(
        window.__testActiveAddress ? [window.__testActiveAddress] : []
      );
    },
    requestNetwork() {
      // Real Auro returns { networkID: 'mina:<net>' }; getAuroNetwork parses
      // networkID. Without it, getAuroNetwork returns null and the app's
      // network-mismatch gate blocks signing.
      return Promise.resolve({ networkID: 'mina:testnet', chainId: 'testnet', name: 'testnet' });
    },
    sendTransaction() {
      // In test mode the worker signs and sends directly; this is a no-op fallback.
      return Promise.resolve({ hash: 'mock-unused' });
    },
    signFields() {
      return Promise.resolve({ data: [], signature: '' });
    },
    signMessage() {
      return Promise.resolve({
        publicKey: '', data: '',
        signature: { field: '0', scalar: '0' },
      });
    },
    on(event, handler) {
      if (!window.__testEventHandlers[event]) {
        window.__testEventHandlers[event] = [];
      }
      window.__testEventHandlers[event].push(handler);
    },
    removeListener(event, handler) {
      if (window.__testEventHandlers[event]) {
        window.__testEventHandlers[event] =
          window.__testEventHandlers[event].filter(function(h) { return h !== handler; });
      }
    },
  };

  window.__testSwitchAccount = function(newAddress) {
    window.__testActiveAddress = newAddress;
    var handlers = window.__testEventHandlers['accountsChanged'] || [];
    handlers.forEach(function(h) { h([newAddress]); });
  };
`;
