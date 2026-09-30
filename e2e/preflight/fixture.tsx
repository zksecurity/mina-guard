import React from 'react';
import { createRoot } from 'react-dom/client';
import TransactionPreflightPanel from '../../ui/components/TransactionPreflightPanel';
import { UploadSignedResponse, downloadOfflineBundle } from '../../ui/components/OfflineSigningFlow';
import * as online from '../../ui/lib/multisigClient';
import * as flow from '../../ui/lib/preflight-flow';
(window as any).online = online;
(window as any).flow = flow;
const root = createRoot(document.getElementById('root')!);
(window as any).unmount = () => root.unmount();
root.render(<><TransactionPreflightPanel /><UploadSignedResponse acceptActions={['approve', 'execute']} expectedContractAddress="vault" expectedProposalHash="42"
  beforeBroadcast={async () => { (window as any).policies++; }}
  onRecreate={async response => { (window as any).exports++; downloadOfflineBundle(response.action, { version: 2, action: response.action, proposal: { proposalHash: '42' } }); }}
  onComplete={() => { (window as any).completed++; }} /></>);
