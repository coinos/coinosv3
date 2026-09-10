// Cross-device sync feature — encrypted wallet state on Nostr relays
// (NIP-44 to self, replaceable kind 30078) plus the wallet's nostr identity
// (used e.g. to DM locked-gift claim codes). Installed onto the core wallet;
// a build without sync ships none of it and never talks to a relay.

import {
  NostrSync, getSyncConfig, setSyncConfig, npubOf, syncDtag, deviceDtag,
  domainDtag, isOurDtag, isCoreDtag, isOwnDeviceDtag,
  fetchNostrProfile, PROFILE_RELAYS, DEFAULT_SYNC_RELAYS, queryOn, publishOn,
  finalizeEvent,
} from '../nostr.js';
import { t } from '../i18n.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { base64 } from '@scure/base';
import { SyncOutbox } from '../sync-outbox.js';
import {
  sealBlob, openBlob, sha256Hex, blobAuth, uploadBlob, deleteBlob, fetchBlob,
  blossomServers, getBlossomConfig, setBlossomConfig, DEFAULT_BLOSSOM_SERVERS,
} from '../sync-blob.js';

let sharedOutbox;
function syncOutbox() {
  if (sharedOutbox) return sharedOutbox;
  if (typeof localStorage === 'undefined') return null;
  sharedOutbox = new SyncOutbox({
    storage: localStorage,
    send: (event, relays) => publishOn(relays, event),
    upload: (server, bytes, auth) => uploadBlob(server, bytes, auth),
    remove: (server, sha, auth) => deleteBlob(server, sha, auth),
  });
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('online', () => sharedOutbox.wake());
    window.addEventListener('pageshow', () => sharedOutbox.wake());
    window.addEventListener('storage', e => { if (e.key?.startsWith('btc-wallet-sync-outbox:')) sharedOutbox.wake(); });
    document.addEventListener('visibilitychange', () => {
      // Ark flushes its cache synchronously on hide; the save hook below has
      // already persisted encrypted events even if the network is suspended.
      if (document.visibilityState === 'visible') sharedOutbox.wake();
    });
  }
  sharedOutbox.wake();
  return sharedOutbox;
}

// Keep a published snapshot under the relay's event-size cap. relay.coinos.io
// rejects events over 64KB and nip44 expands the plaintext ~1.5x, so the JSON
// must stay under ~40KB. The on-chain tx history is the main unbounded growth;
// drop the oldest (this.txs is newest-first) — another device backfills the
// rest with a rescan. Only trims oversized snapshots, so typical wallets are
// untouched.
const RELAY_JSON_BUDGET = 40000;
function trimForRelay(snap) {
  if (JSON.stringify(snap).length <= RELAY_JSON_BUDGET) return snap;
  const s = { ...snap };
  let txs = (s.txs || []).slice();
  while (txs.length > 25 && JSON.stringify(s).length > RELAY_JSON_BUDGET) {
    txs = txs.slice(0, Math.max(25, txs.length - 25));
    s.txs = txs;
  }
  return s;
}

// Split a snapshot into per-domain pieces, each published as its own
// replaceable event: an extension registered with a `domain` claims its keys,
// everything left is the core wallet. Every piece carries netName + savedAt so
// readers can apply the same guards as for full snapshots. Small events scale
// on vanilla relays (no special size rules) and only changed domains
// republish, so a payment burst no longer re-uploads the whole wallet.
export function splitSnapshotDomains(snap, extensions = []) {
  const core = { ...snap };
  const out = {};
  for (const e of extensions) {
    if (!e.domain || !e.save) continue;
    let obj;
    try { obj = e.save(); } catch { continue; }
    const keys = Object.keys(obj || {});
    if (!keys.length) continue;
    out[e.domain] = { netName: snap.netName, savedAt: snap.savedAt, ...obj };
    for (const k of keys) delete core[k];
  }
  out.core = core;
  return out;
}

export function installSyncWallet(wallet, { outbox = syncOutbox() } = {}) {
  if (wallet.syncFromNostr) return; // already installed
  wallet.nostr = new NostrSync();

  // A pointer state ({ blob: { sha256, servers } }) stands in for a domain
  // that lives on Blossom. Resolve it: our own outbox copy first (no network),
  // else the servers the pointer names plus the configured ones, verified by
  // hash and opened with the same self-key. Unresolvable pointers are dropped
  // — a stale local copy beats applying nothing, and the next boot retries.
  const blobCache = new Map(); // sha256 -> parsed state (a session's worth)
  async function resolveStates(list) {
    const out = [];
    for (const s of list) {
      const b = s.state && s.state.blob;
      if (!b) { out.push(s); continue; }
      if (!/^[0-9a-f]{64}$/.test(b.sha256 || '')) continue;
      let state = blobCache.get(b.sha256);
      if (!state) {
        let bytes = outbox ? outbox.localBlob(b.sha256) : null;
        if (!bytes && !wallet.offline) {
          bytes = await fetchBlob([...new Set([...(Array.isArray(b.servers) ? b.servers : []), ...blossomServers()])], b.sha256);
        }
        if (!bytes || !wallet.nostr.ck) continue;
        try { state = JSON.parse(openBlob(wallet.nostr.ck, bytes)); } catch { continue; }
        if (!state) continue;
        blobCache.set(b.sha256, state);
        if (blobCache.size > 40) blobCache.delete(blobCache.keys().next().value);
      }
      out.push({ ...s, state: { netName: s.state.netName, savedAt: s.state.savedAt, ...state } });
    }
    return out;
  }

  Object.assign(wallet, {
    // Our nostr identity (used to DM a locked gift's claim code to the recipient).
    nostrPubkey() { return (this.nostr && this.nostr.pk) || null; },

    nostrNpub() { const pk = this.nostrPubkey(); return pk ? npubOf(pk) : null; },

    // Send a nostr DM (e.g. a locked gift's claim code) to a recipient pubkey.
    async sendNostrDM(recipientPkHex, text) {
      return this.nostr && this.nostr.sk ? this.nostr.sendDM(recipientPkHex, text) : false;
    },

    // Generic event publish/fetch on the configured sync relays — the seam
    // other features (ark zaps) use to speak their own kinds. No-ops when
    // sync is disabled or the wallet is offline.
    async nostrPublish(partial) {
      const sync = getSyncConfig();
      if (this.offline || !sync.enabled || !this.nostr.sk) return null;
      this.nostr.setRelays(sync.relays);
      return this.nostr.publishEvent(partial);
    },
    // Publish an event signed by another key (the NWC wallet service keys).
    async nostrPublishSigned(evt) {
      const sync = getSyncConfig();
      if (this.offline || !sync.enabled) return null;
      this.nostr.setRelays(sync.relays);
      return this.nostr.publishSigned(evt);
    },
    async nostrFetch(filter, maxWait) {
      const sync = getSyncConfig();
      if (this.offline || !sync.enabled) return [];
      this.nostr.setRelays(sync.relays);
      return this.nostr.fetchEvents(filter, maxWait);
    },
    nostrSubscribe(filter, onEvent) {
      const sync = getSyncConfig();
      if (this.offline || !sync.enabled) return () => {};
      this.nostr.setRelays(sync.relays);
      return this.nostr.subscribeEvents(filter, onEvent);
    },

    // Sign an event with our nostr key without publishing (NIP-57 zap request).
    nostrSign(partial) { return this.nostr ? this.nostr.signEvent(partial) : null; },

    // Fetch a pubkey's profile (name/picture + lud16/lud06 for zaps) from the
    // broad profile relays — independent of whether cross-device sync is on.
    async nostrProfile(pkHex) {
      if (this.offline) return null;
      return fetchNostrProfile(pkHex);
    },

    // Relays to advertise in a zap request so we can later find the receipt:
    // our sync relays plus the broad profile relays.
    nostrRelays() {
      const sync = getSyncConfig();
      const base = sync.enabled ? sync.relays : [];
      return [...new Set([...base, ...PROFILE_RELAYS])].slice(0, 8);
    },

    // Pull the latest state from Nostr; apply it if it's newer than what we have.
    // Returns true if state was applied (so the caller can skip a full scan).
    async syncFromNostr() {
      const sync = getSyncConfig();
      if (this.offline || !sync.enabled) return false;
      this.nostr.setRelays(sync.relays);
      const identity = this.nostr.pk;
      const network = this.netName;
      let all;
      try {
        all = await this.nostr.fetchAllStates();
      } catch {
        all = [];
      }
      if (this.nostr.pk !== identity || this.netName !== network) return false;
      // A failed publish is still a recoverable encrypted local snapshot.
      // Merge it even if the relay is down or holds only the old deposits.
      all = [...all, ...this.nostr.decodeStateEvents(outbox?.events(identity) || [])];
      all = (await resolveStates(all)).sort((a, b) => b.created_at - a.created_at);
      if (this.nostr.pk !== identity || this.netName !== network) return false;
      // Each device publishes to its OWN slot now, so there can be several
      // snapshots for this network. Keep only ours-for-this-network: the
      // netName inside is the real guard against cross-network bleed (legacy
      // shared-tag events are ambiguous), the d-tag check filters the rest.
      const mine = all.filter((s) => s.state.netName === this.netName && isOurDtag(s.dtag, this.netName));
      if (!mine.length) return false;
      // Merge every device's merge-safe extension state (ark vtxos union) — a
      // device sees ALL devices' coins, not only the newest snapshot's. Domain
      // fragments route themselves: an extension's load() only reads its keys.
      for (const s of mine) this._mergeSnapshotExtensions(s.state);
      // Apply the newest CORE-carrying snapshot for the rescannable on-chain
      // state. Domain fragments (ark/nwc slices) must never be applied as a
      // full snapshot — they'd blank the core fields they don't carry.
      const fulls = mine.filter((s) => isCoreDtag(s.dtag, this.netName));
      const newest = fulls[0] && fulls[0].state; // fetchAllStates returns newest-first
      const localTxs = this.txs || [];
      if (newest && (newest.savedAt || 0) > (this._savedAt || 0)) {
        this._applySnapshot(newest); // re-runs extension loads (idempotent merge)
        this.emit();
      }
      // On-chain tx history: UNION across every device's core and what this
      // device already had, newest-first so the freshest confirmation data
      // wins per txid. Newest-core-wholesale alone lost history: a device
      // whose history fetch keeps failing (mobile 429 storms) publishes a
      // THIN core — balance present, txs empty — and every fresh device then
      // adopted it and showed a balance with no transactions (adam's phone,
      // 2026-09-04) while a fat core sat shadowed in an older device slot.
      // Safe because history is append-mostly and every SUCCESSFUL local
      // scan still prunes rows its addresses no longer report.
      const byId = new Map();
      for (const list of [this.txs || [], localTxs, ...fulls.map((s) => s.state.txs || [])]) {
        for (const t of list) if (t && t.txid && !byId.has(t.txid)) byId.set(t.txid, t);
      }
      if (byId.size > (this.txs || []).length) {
        this.txs = [...byId.values()];
        this._sortTxs();
        this.emit();
      }
      this.saveCache(); // persist the merged result + republish our own slot
      return true;
    },
  });

  // identity follows the open wallet
  wallet.registerLoadHook(() => {
    if (wallet.mnemonic) wallet.nostr.load(wallet.mnemonic, wallet.passphrase, wallet.accountIndex || 0);
    else wallet.nostr.unload();
    outbox?.wake();
    adoptSyncRelays().catch(() => {});
  });

  // Sync rides the user's own relays: their NIP-65 (kind 10002) write set —
  // the login npub's first, else the wallet key's — falling back to the
  // coinos relay. A wallet key with no NIP-65 gets one published (default
  // relay, signed silently) so other clients can find this identity's events.
  async function adoptSyncRelays() {
    if (wallet.offline || !wallet.nostr.pk) return;
    const pks = [];
    try {
      const login = wallet.loadFeatureState('nostrlogin', {});
      if (login && /^[0-9a-f]{64}$/.test(login.pubkey || '')) pks.push(login.pubkey);
    } catch {}
    pks.push(wallet.nostr.pk);
    const evs = await queryOn([...new Set([...PROFILE_RELAYS, ...DEFAULT_SYNC_RELAYS])], { kinds: [10002, 10063], authors: pks }, 3500);
    const newestFor = (pk, kind = 10002) => evs.filter((e) => e.pubkey === pk && e.kind === kind).sort((a, b) => b.created_at - a.created_at)[0];
    // The user's own Blossom server list (BUD-03) leads for oversized sync
    // domains, the coinos server stays as a mirror — unless they typed a list
    // in Settings, which is theirs to keep.
    if (!getBlossomConfig().manual) {
      for (const pk of pks) {
        const e = newestFor(pk, 10063);
        const servers = e && e.tags.filter((x) => x[0] === 'server' && x[1]).map((x) => x[1]);
        if (servers && servers.length) { setBlossomConfig({ servers: [...servers, ...DEFAULT_BLOSSOM_SERVERS], manual: false }); break; }
      }
    }
    const writeRelays = (e) => e.tags
      .filter((x) => x[0] === 'r' && x[1] && (!x[2] || x[2] === 'write'))
      .map((x) => x[1].trim()).filter((r) => /^wss?:\/\//.test(r)).slice(0, 4);
    for (const pk of pks) {
      const e = newestFor(pk);
      const relays = e && writeRelays(e);
      if (relays && relays.length) {
        setSyncConfig({ enabled: true, relays: [...new Set([...relays, ...DEFAULT_SYNC_RELAYS])].slice(0, 5) });
        break;
      }
    }
    // a brand-new wallet identity: announce its relays (NIP-65)
    if (wallet.nostr.sk && !newestFor(wallet.nostr.pk)) {
      const evt = finalizeEvent({
        kind: 10002, content: '',
        tags: DEFAULT_SYNC_RELAYS.map((r) => ['r', r]),
        created_at: Math.floor(Date.now() / 1000),
      }, wallet.nostr.sk);
      publishOn([...new Set([...PROFILE_RELAYS, ...DEFAULT_SYNC_RELAYS])], evt);
    }
  }
  // Live cross-device state: subscribe to ALL our devices' slots so a save on
  // another device merges here within seconds. Merge-safe extension state (ark
  // vtxos union) applies live; full snapshots stay a load-time affair. With
  // per-device slots no device overwrites another's, so this only ever adds.
  let stateUnsub = null;
  wallet.registerRealtimeHook({
    start: () => {
      const sync = getSyncConfig();
      if (!sync.enabled || !wallet.nostr.pk) return;
      wallet.nostr.setRelays(sync.relays);
      if (stateUnsub) { try { stateUnsub(); } catch {} }
      stateUnsub = wallet.nostr.subscribeStates((v, dtag) => {
        if (!v.netName || v.netName !== wallet.netName) return;
        if (!isOurDtag(dtag, wallet.netName)) return;
        if (isOwnDeviceDtag(dtag, wallet.netName) && (v.savedAt || 0) === (wallet._savedAt || 0)) return; // our own echo
        if (!v.blob) { wallet._mergeSnapshotExtensions(v); return; }
        const pk = wallet.nostr.pk;
        resolveStates([{ state: v, dtag }]).then((r) => {
          if (r[0] && wallet.nostr.pk === pk && wallet.netName === r[0].state.netName) wallet._mergeSnapshotExtensions(r[0].state);
        }).catch(() => {});
      });
    },
    stop: () => { if (stateUnsub) { try { stateUnsub(); } catch {} stateUnsub = null; } },
  });

  // Capture and sign changed domains NOW, under the saving wallet's identity.
  // The encrypted outbox survives page suspension, logout and relay failure.
  // Looking up extensions/keys inside a delayed callback could mix accounts;
  // canceling that callback on stop discarded the only copy of recent change.
  wallet.registerCacheSavedHook((snap) => {
    const sync = getSyncConfig();
    if (wallet.offline || !sync.enabled || !wallet.nostr.pk || !outbox) return;
    try {
      const domains = splitSnapshotDomains(snap, wallet._cacheExtensions || []);
      domains.core = trimForRelay(domains.core);
      const { sk, ck, pk } = wallet.nostr;
      for (const [name, obj] of Object.entries(domains)) {
        const { savedAt, ...data } = obj;
        const text = JSON.stringify(data);
        const digest = bytesToHex(sha256(new TextEncoder().encode(text)));
        const dtag = domainDtag(snap.netName, name);
        let blob = null, evtObj = obj;
        if (text.length > RELAY_JSON_BUDGET) {
          // Too big for a relay event (and for NIP-44): seal the whole domain
          // into a Blossom envelope; the event becomes a pointer to its hash.
          const servers = blossomServers();
          const bytes = sealBlob(ck, JSON.stringify(obj));
          const sha = sha256Hex(bytes);
          blob = { sha256: sha, size: bytes.length, data: base64.encode(bytes), servers,
            auth: blobAuth(sk, 'upload', [sha]), deleteAuthFor: (old) => blobAuth(sk, 'delete', [old]) };
          evtObj = { netName: obj.netName, savedAt: obj.savedAt, blob: { v: 1, sha256: sha, size: bytes.length, servers } };
        }
        outbox.enqueue({ pubkey: pk, dtag, digest, relays: sync.relays, blob,
          sign: createdAt => wallet.nostr.stateEvent(evtObj, dtag, createdAt) });
      }
    } catch (e) { console.warn('wallet sync snapshot could not be queued:', e.message); }
  });
}

export function syncFeature(ctx) {
  const { h, ui, render, wallet, toast } = ctx;
  installSyncWallet(wallet);

  // Settings → Nostr: which Blossom servers hold this wallet's oversized
  // sync domains. Self-hosters and the privacy-minded point it elsewhere.
  function storageCard() {
    if (ui.syncServersDraft == null) ui.syncServersDraft = blossomServers().join('\n');
    const pending = (sharedOutbox?.records() || []).filter((r) => r.blob && !(r.uploaded || []).length).length;
    const save = (servers, manual) => {
      const list = setBlossomConfig({ servers, manual });
      if (!list.length) { toast(t('syncStorageInvalid')); return; }
      ui.syncServersDraft = list.join('\n');
      toast(t('syncStorageSaved'));
      // pending blobs pick up the new list on their next save; nudge one
      try { wallet.saveCache(); } catch {}
      render();
    };
    return h('div', { class: 'card col', 'data-key': 'syncstorage' },
      h('h3', {}, t('syncStorageTitle')),
      h('p', { class: 'small muted', style: 'margin:0' }, t('syncStorageHow')),
      h('textarea', { rows: 3, style: 'font-size:12px', value: ui.syncServersDraft,
        onInput: (e) => { ui.syncServersDraft = e.target.value; } }),
      pending ? h('div', { class: 'small faint' }, t('syncStoragePending', { n: pending })) : null,
      h('div', { class: 'row gap6' },
        h('button', { class: 'btn-ghost small', onClick: () => save(ui.syncServersDraft.split(/\s+/), true) }, t('syncStorageSave')),
        h('button', { class: 'btn-ghost small', onClick: () => save(DEFAULT_BLOSSOM_SERVERS, false) }, t('syncStorageReset'))));
  }

  return {
    id: 'sync',
    nostrSettingsCards: () => [storageCard()],
    forgetAll: () => sharedOutbox?.clear(),
  };
}
