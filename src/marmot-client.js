// White Noise in the app: this device's Marmot standing (its MLS signature
// key, proof and published KeyPackage), its groups, and their relay traffic.
// Protocol rules live in marmot.js and storage in marmot-store.js; the
// messages feature hears about everything through `on(type, group, data)`.
//
// One client per (wallet, nostr identity). MLS state is per DEVICE: a second
// device of the same account is a second leaf with its own KeyPackage, and
// only the device whose KeyPackage an inviter picked is in that group.

import * as M from './marmot.js';
import { marmotStore } from './marmot-store.js';
import { subscribeOn, queryOn, publishOn, fetchInboxRelays, PROFILE_RELAYS, finalizeEvent } from './nostr.js';
import { wrapDM } from './dm.js';
import { dlog } from './debug.js';

// Where the groups we found live. Signed into group state, so every member
// reads and writes the same list.
export const GROUP_RELAYS = ['wss://relay.coinos.io', 'wss://nos.lol', 'wss://relay.damus.io'];

const DAY = 86400;
const KP_REFRESH = 30 * DAY;     // republish well inside the 84-day lifetime
const REACH_TTL = 10 * 60_000;
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function marmotClient({ scope, pubkey, identity, on, relays = GROUP_RELAYS }) {
  const store = marmotStore(scope);
  const groups = new Map();   // mls group id (hex) -> record
  const subs = new Map();     // route id -> { unsub, gid }
  const reach = new Map();    // pubkey -> { at, p }
  const inbox = new Map();    // gid -> queued 445 events
  let dev = null, stopped = false, loaded = null, kpBusy = null;
  const dirty = new Set();
  let flushTimer = 0, rotateTimer = 0;

  const emit = (type, g, data) => { try { on(type, g, data); } catch (e) { dlog('marmot: listener', e); } };

  // ---- storage ----

  function load() {
    if (!loaded)
      loaded = store.all().then((all) => {
        dev = all.get('dev') || null;
        for (const [k, v] of all) if (k.startsWith('g:') && v && v.tip) groups.set(v.id, v);
      }).catch((e) => { dlog('marmot: store', e); });
    return loaded;
  }
  const touch = (g) => {
    dirty.add(g.id);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 400);
  };
  async function flush() {
    clearTimeout(flushTimer);
    const ids = [...dirty];
    dirty.clear();
    await Promise.all(ids.map((id) => groups.has(id) ? store.put('g:' + id, groups.get(id)) : null)).catch((e) => dlog('marmot: save', e));
  }
  // before anything of ours leaves: a ratchet that moved must be on disk first
  const persist = (g) => { dirty.delete(g.id); return store.put('g:' + g.id, g); };
  const saveDev = () => store.put('dev', dev);

  // ---- this device ----

  async function signer({ interactive = false } = {}) {
    const id = await identity();
    if (!id || !id.signer || id.pubkey !== pubkey) return null;
    if (id.signer instanceof Uint8Array) return { raw: id.signer, sign: async (e) => finalizeEvent(e, id.signer) };
    // an interactive signer is a trip through another app per call: never unasked
    if (id.signer.interactive && !interactive) return null;
    return { raw: null, adapter: id.signer, sign: (e) => id.signer.signEvent(e) };
  }

  async function ownWriteRelays() {
    const lists = await queryOn(PROFILE_RELAYS, { kinds: [10002], authors: [pubkey] }, 2500);
    const newest = lists.sort((a, b) => b.created_at - a.created_at)[0];
    return newest ? writeRelays(newest) : [];
  }
  const writeRelays = (ev) => ev.tags.filter((t) => t[0] === 'r' && t[1] && (!t[2] || t[2] === 'write')).map((t) => t[1]).filter(M.relayOk);

  // Make sure other people can invite us: a device record, and a current
  // KeyPackage where our NIP-65 write relays say to look. Silent unless
  // `interactive`; returns whether we are reachable.
  function ready(opts = {}) {
    if (!kpBusy) kpBusy = ensure(opts).catch((e) => { dlog('marmot: keypackage', e); return false; }).finally(() => { kpBusy = null; });
    return kpBusy;
  }
  async function ensure(opts) {
    await load();
    const cur = dev && dev.kps && dev.kps.find((k) => k.eventId);
    if (cur && cur.notAfter - now() > 14 * DAY && now() - cur.at < KP_REFRESH) return true;
    const s = await signer(opts);
    if (!s) return false;
    if (!dev) { dev = { ...(await M.newDevice(s.sign, pubkey)), kps: [] }; await saveDev(); }
    return publishKeyPackage(s);
  }

  async function publishKeyPackage(s) {
    const kp = M.newKeyPackage(dev);
    // the private half is on disk before the public half is findable
    dev.kps.push({ ...kp, eventId: null, at: now() });
    await saveDev();
    const ev = await s.sign(M.keyPackageEvent(dev, kp));
    // White Noise looks KeyPackages up through the account's kind 10002 write
    // relays (the sync feature publishes that list for a seed-derived
    // identity; a login npub's list is its other clients' business).
    const own = await ownWriteRelays();
    const ok = await publishOn([...new Set([...own.slice(0, 6), ...PROFILE_RELAYS])], ev);
    const rec = dev.kps.find((k) => k.ref === kp.ref);
    if (!ok) { dev.kps = dev.kps.filter((k) => k !== rec); await saveDev(); return false; }
    rec.eventId = ev.id;
    // the slot now holds the replacement: older packages' init keys are done
    dev.kps = dev.kps.filter((k) => k === rec);
    await saveDev();
    return true;
  }

  // Somebody else's KeyPackage, or null when they cannot be invited.
  function lookup(pk) {
    const hit = reach.get(pk);
    if (hit && Date.now() - hit.at < REACH_TTL) return hit.p;
    const p = (async () => {
      const lists = await queryOn(PROFILE_RELAYS, { kinds: [10002], authors: [pk] }, 2500);
      const newest = lists.sort((a, b) => b.created_at - a.created_at)[0];
      const where = [...new Set([...(newest ? writeRelays(newest).slice(0, 5) : []), ...PROFILE_RELAYS])];
      const evs = await queryOn(where, { kinds: [M.KIND.KEY_PACKAGE], authors: [pk] }, 2500);
      return M.pickKeyPackage(evs.map((e) => M.readKeyPackageEvent(e)).filter(Boolean));
    })().catch(() => null);
    reach.set(pk, { at: Date.now(), p });
    return p;
  }

  // ---- relay traffic ----

  const routeRelays = (g) => (M.groupView(g.tip).routing || {}).relays || relays;

  function watch(g) {
    if (stopped || g.removed) return;
    for (const r of M.routes(g)) {
      if (subs.has(r.id)) continue;
      const unsub = subscribeOn(r.relays, { kinds: [M.KIND.GROUP], '#h': [r.id], since: M.since(g), limit: 500 }, (ev) => queue(g.id, ev));
      subs.set(r.id, { unsub, gid: g.id });
    }
  }
  function unwatch(gid) {
    for (const [id, s] of subs) if (s.gid === gid) { try { s.unsub(); } catch {} subs.delete(id); }
  }

  // Relays replay history newest-first and commits only apply oldest-first:
  // collect a moment, then feed the batch in timestamp order.
  function queue(gid, ev) {
    let q = inbox.get(gid);
    if (!q) { inbox.set(gid, (q = [])); setTimeout(() => drain(gid), 150); }
    q.push(ev);
  }
  function drain(gid) {
    const q = inbox.get(gid) || [];
    inbox.delete(gid);
    const g = groups.get(gid);
    if (!g || stopped) return;
    q.sort((a, b) => a.created_at - b.created_at);
    for (const ev of q) {
      let out;
      try { out = M.receive(g, ev); } catch (e) { dlog('marmot: receive', e); continue; }
      heard(g, out);
    }
    touch(g);
  }

  function heard(g, out) {
    for (const o of out) {
      if (o.id) emit('message', g, o);
      else if (o.epoch !== undefined) { watch(g); emit('state', g); }
      else if (o.removed) { g.removed = true; unwatch(g.id); emit('removed', g); }
      else if (o.withdrawn) emit('withdrawn', g, o.withdrawn);
      else if (o.selfRemove !== undefined) letGo(g);
      else if (o.invalid) dlog('marmot: rejected input', o.invalid);
    }
  }

  // A member asked to leave: any remaining member may commit it. Wait a
  // random beat so a whole group does not answer at once, then look again.
  function letGo(g) {
    setTimeout(() => {
      if (stopped || g.removed || g.leaving || g.pending) return;
      if (!(g.tip.pending || []).length) return;
      commit(g, []).catch((e) => dlog('marmot: self-remove commit', e));
    }, 1500 + Math.random() * 4000);
  }

  // Publish-before-apply: the commit becomes group state only once a relay
  // has it. A failed publish is retried with the SAME bytes, and given up
  // only when the relays demonstrably never took it.
  async function commit(g, proposals) {
    const p = M.stage(g, { proposals });
    await persist(g);
    const where = routeRelays(g);
    let ok = false;
    for (let i = 0; i < 3 && !ok; i++) {
      if (i) await sleep(1500 * i);
      ok = await publishOn(where, p.ev);
    }
    if (!ok) ok = (await queryOn(where, { ids: [p.ev.id] }, 2500)).length > 0;
    // it may have settled while we waited: confirmed by its own echo, or
    // beaten by a peer's commit from the same epoch
    if (g.pending === p) {
      heard(g, ok ? M.confirm(g) : M.drop(g));
      await persist(g);
    }
    if (!g.via || g.via.digest !== p.edge.digest) throw new Error(ok ? 'another change got there first' : 'relays did not accept the change');
    return p;
  }

  async function deliverWelcome(g, welcome, cands) {
    const s = await signer({ interactive: true });
    if (!s) throw new Error('no signer');
    const where = routeRelays(g);
    for (const c of cands) {
      const wrap = await wrapDM(s.raw || s.adapter, c.pubkey, M.welcomeRumor(pubkey, welcome, c.id, where));
      const inboxRelays = await fetchInboxRelays(c.pubkey).catch(() => []);
      publishOn([...new Set([...inboxRelays.slice(0, 5), ...where])], wrap);
    }
  }

  // ---- what the app can do ----

  async function candidates(pks) {
    const cands = await Promise.all(pks.map(lookup));
    const missing = pks.filter((_, i) => !cands[i]);
    if (missing.length) { const e = new Error('not reachable'); e.missing = missing; throw e; }
    return cands;
  }

  // A direct chat (no name, both sides admins) or a named group.
  async function create({ name = '', members }) {
    if (!(await ready({ interactive: true }))) throw new Error('no signer');
    const cands = await candidates(members);
    const direct = !name && members.length === 1;
    const { g, welcome } = M.found(dev, { name, relays, invitees: cands, adminKeys: direct ? members : [] });
    groups.set(g.id, g);
    await persist(g);
    await deliverWelcome(g, welcome, cands);
    watch(g);
    emit('state', g);
    return g;
  }

  // `inner` comes from event(): the app shows it before it has left.
  async function send(g, inner) {
    const ev = M.send(g, inner);
    await persist(g);
    const ok = await publishOn(routeRelays(g), ev);
    if (!ok) { g.log = g.log.filter((m) => m.id !== inner.id); touch(g); }
    return ok;
  }

  async function add(g, pks) {
    const cands = await candidates(pks);
    for (const c of cands) if (!M.fits(g.tip, c)) throw new Error('their app cannot join this group');
    const p = await commit(g, M.invite(cands));
    // the Welcome only after the commit is out: joiners must not get ahead of members
    await deliverWelcome(g, p.welcome, cands);
  }

  const kick = (g, pk) => commit(g, M.remove(g, pk));
  const rename = (g, name) => commit(g, [M.setProfile(name, M.groupView(g.tip).about)]);

  // Leaving: an admin first hands the group to whoever stays (an admin cannot
  // self-remove), then the SelfRemove proposal goes out for a peer to commit.
  async function leave(g) {
    if (!g.removed && !g.leaving && M.accounts(g.tip).length > 1) {
      const v = M.groupView(g.tip);
      if (v.admins.includes(pubkey)) {
        const rest = v.admins.filter((a) => a !== pubkey);
        await commit(g, [M.setAdmins(rest.length ? rest : M.accounts(g.tip).filter((a) => a !== pubkey))]);
      }
      const ev = M.leave(g);
      await persist(g);
      await publishOn(routeRelays(g), ev);
    }
    forget(g);
  }

  function forget(g) {
    unwatch(g.id);
    groups.delete(g.id);
    dirty.delete(g.id);
    store.del('g:' + g.id).catch(() => {});
    emit('gone', g);
  }

  // A Welcome from our inbox. Joining is automatic (the group's contents are
  // what tell us who is asking); `fresh` marks it for the app to confirm.
  async function welcome(rumor) {
    await load();
    if (!dev || stopped) return null;
    let j;
    try { j = M.join(dev, rumor, dev.kps); } catch (e) { dlog('marmot: welcome', e); return null; }
    const old = groups.get(j.g.id);
    // a retained copy is never silently replaced; a group we were removed from can be rejoined
    if (old && !old.removed) return null;
    if (old) j.g.log = old.log;
    groups.set(j.g.id, j.g);
    await persist(j.g);
    watch(j.g);
    emit('joined', j.g);
    // The package that got us in is spent: put a new one in the slot — but
    // not at once. Several invitations may have used it while we were away,
    // and its private half must still be here when the next Welcome opens.
    clearTimeout(rotateTimer);
    rotateTimer = setTimeout(() => {
      if (!stopped) signer().then((s) => s && publishKeyPackage(s)).catch(() => {});
    }, 45_000);
    // …and move our leaf off the keys that package exposed
    setTimeout(() => {
      const g = groups.get(j.g.id);
      if (g && !stopped && !g.removed && !g.pending) commit(g, []).catch((e) => dlog('marmot: self-update', e));
    }, 4000 + Math.random() * 6000);
    return j.g;
  }

  function accept(g) { g.fresh = false; touch(g); emit('state', g); }

  async function start() {
    await load();
    if (stopped) return;
    for (const g of groups.values()) {
      watch(g);
      // a commit that was on its way out when the app closed: same bytes, again
      if (g.pending) {
        const p = g.pending;
        publishOn(routeRelays(g), p.ev).then(async (ok) => {
          if (g.pending !== p) return;
          if (!ok) ok = (await queryOn(routeRelays(g), { ids: [p.ev.id] }, 2500)).length > 0;
          if (g.pending !== p) return;
          heard(g, ok ? M.confirm(g) : M.drop(g));
          touch(g);
        });
      }
    }
    emit('loaded', null);
  }

  function resubscribe() {
    for (const s of subs.values()) { try { s.unsub(); } catch {} }
    subs.clear();
    for (const g of groups.values()) watch(g);
  }

  function stop() {
    stopped = true;
    clearTimeout(rotateTimer);
    for (const s of subs.values()) { try { s.unsub(); } catch {} }
    subs.clear();
    flush();
  }

  return {
    pubkey, groups, load, start, stop, resubscribe, ready, lookup, welcome, accept,
    create, send, add, kick, rename, leave, forget,
    event: (kind, content, tags) => M.appEvent(pubkey, kind, content, tags),
    view: (g) => M.groupView(g.tip),
    peer: (g) => M.directPeer(g),
    accounts: (g) => M.accounts(g.tip),
    isAdmin: (g) => M.isAdmin(g),
    // has this device ever been given its standing (a signed proof)?
    isSetUp: () => !!dev,
    relaysInUse: () => [...new Set([...groups.values()].filter((g) => !g.removed).flatMap(routeRelays))],
  };
}
