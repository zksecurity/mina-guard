'use client';

import { useEffect, useState } from 'react';
import type { MinaGuardConfig } from '@/types/mina-guard-config';
import NodeEndpointsModal from './NodeEndpointsModal';

/** Compact header control showing the current network. Only visible inside
 *  the Electron desktop app (where `window.__minaGuardConfig` is injected by
 *  the preload). Clicking opens the change-endpoints modal. */
export default function NodeEndpointsChip() {
  const [config, setConfig] = useState<MinaGuardConfig | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    setConfig(window.__minaGuardConfig ?? null);
  }, []);

  if (!config) return null;

  return (
    <>
      <button
        onClick={() => setEditing(true)}
        title={`${config.networkId} — ${config.minaEndpoint}\n(click to change)`}
        aria-label="Change node endpoints"
        className="flex items-center justify-center rounded-lg p-1.5 text-safe-text hover:text-white hover:bg-safe-hover transition-colors"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {editing && (
        <NodeEndpointsModal
          initial={{ minaEndpoint: config.minaEndpoint, archiveEndpoint: config.archiveEndpoint }}
          onClose={() => setEditing(false)}
        />
      )}
    </>
  );
}
