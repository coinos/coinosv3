import { NostrSync, publishOn } from '../src/nostr.js';
import { SyncOutbox } from '../src/sync-outbox.js';
import { adoptArkSnapshot } from '../src/features/ark.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

const identity = new NostrSync();
identity.load('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about');
const relays = [location.origin.replace('http', 'ws') + '/relay'];
identity.setRelays(relays);
const outbox = new SyncOutbox({ storage: localStorage, send: (event, targets) => publishOn(targets, event) });
const manager = {
  state: { vtxos: [], movements: [], actions: [] },
  _save() { document.body.textContent = String(this.state.vtxos.filter(v => v.state === 'spendable').reduce((n, v) => n + v.amountSat, 0)); },
};
window.syncTest = {
  save(arkState) {
    const dtag = 'bitcoin-wallet:x:browser-test:ark';
    const state = { netName: 'mainnet', arkState };
    outbox.enqueue({ pubkey: identity.pk, dtag, relays,
      digest: bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(state)))),
      sign: timestamp => identity.stateEvent(state, dtag, timestamp) });
  },
  async restore() {
    for (const s of await identity.fetchAllStates()) adoptArkSnapshot(manager, s.state.arkState);
    return manager.state;
  },
  records: () => outbox.records().map(r => ({ acknowledged: r.acknowledged, id: r.event.id })),
};
outbox.wake();
