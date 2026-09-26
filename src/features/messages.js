// Messages — Concord community chat (CORD-01..05) + NIP-17 private DMs.
//
// Communities are end-to-end private: there is no global discovery in
// Concord, membership travels by invite. coinos ships with one built-in
// community (below) so every user starts somewhere; beyond it users join by
// invite link, by direct invite (giftwrapped to their npub), or by founding
// their own community in-app.
//
// Identity: the session's nostr login when a signer is live, else the
// wallet's NIP-06 key. Community traffic encrypts under stream keys the app
// holds (signers only sign seals); DMs seal to the peer, which is what the
// widened signer adapters (encryptTo/decryptFrom) exist for. The DM inbox
// listens for both identities and decrypts with whichever keys are present.

import {
  subscribeOn, publishOn, queryOn, fetchInboxRelays, relayAlive, liveRelayList, resetRelay,
  npubOf, neventOf, parseNostrPubkey, parseNostrRef, generateSecretKey, getPublicKey, finalizeEvent, nip44,
  PROFILE_RELAYS, openWrapsOffthread, unwrapDMsOffthread,
} from '../nostr.js';
import {
  channelKey, channelStream, channelEpoch, channelIsPrivate, controlKey, guestbookKey, openWrap, wrapRumor, rumorWithId,
  foldControl, foldGuestbook, observeAuthor, eventMs, msTags, makeEdition,
  communityId, parseInviteLink, makeInviteLink, makeInviteBundleEvent, openInviteBundle,
} from '../concord.js';
import { makeDMRumor, makeDMReaction, unwrapDM, wrapDM } from '../dm.js';
import {
  EMOJI_SET_KIND, EMOJI_LIST_KIND, EMOJI_PARTIAL_RE, PACK_LINK_RE,
  emojiTagMap, splitEmoji, emojiOnlyCount, outboundEmojiTags, shortcodeOf,
  packAddr, packNaddr, parsePackRef, parsePackAddr, parseEmojiSet,
} from '../emoji.js';
import { saveInbox } from '../dm-inbox.js';
import { mergeFeedWindow } from '../feed-window.js';
import { createThreadStore } from '../thread-cache.js';
import { createFeedCache, FEED_CACHE_POSTS } from '../feed-cache.js';
import { makeSearcher, resultRows, fallbackAvatar, warmSearch, punkImageUrl, punkSmallUrl } from '../recipient-search.js';
import { getNetwork } from '../api.js';
import { decodeBolt11 } from '../ark/lightning.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { base64urlnopad } from '@scure/base';
import { t } from '../i18n.js';
import { animateZap, warmZapSound } from '../zap-animation.js';
import { SIGNER_SILENT } from '../dm.js';

// The coinos community's join material lives in ../community.js — shared
// with the public read-only chat page so the two can never drift.
import { COMMUNITY, EPOCH } from '../community.js';
const DM_RELAYS = ['wss://relay.coinos.io', 'wss://nos.lol'];
const NOTIFIER = 'https://nwcpush.coinos.io';
const APP_BASE = 'https://v3.coinos.io';
const CACHE_MAX = 50; // messages kept per channel / per DM thread in feature state
// NIP-89 client attribution on PUBLIC notes (posts + thread replies) — other
// clients render it as "via coinos". Name-only: the fuller form appends a
// kind-31990 handler coordinate, which we haven't published. Deliberately
// absent from anything encrypted (DMs, community wraps) — those are private
// and need no billboard.
const CLIENT_TAG = ['client', 'coinos', '31990:72bdbc57bdd6dfc4e62685051de8041d148c3c68fe42bf301f71aa6cf53e52fb:coinos'];

// A view the URL asks to open (a notification tap): read once, then taken
// off the address so a reload doesn't repeat it.
const OPEN_VIEW = (() => {
  try {
    const v = new URLSearchParams(location.search).get('open');
    if (!v) return null;
    const u = new URL(location.href); u.searchParams.delete('open');
    history.replaceState(null, '', u.pathname + (u.search || ''));
    return v;
  } catch { return null; }
})();

export function messagesFeature(ctx) {
  const { h, ui, render, wallet, toast, hook } = ctx;

  // ---- persisted state ----------------------------------------------------

  const st = () => {
    const s = wallet.loadFeatureState('messages', {});
    s.joined ||= {}; // { [cid]: { [pubkey]: true } }
    s.cache ||= {}; // { [channelId]: [msgs] }
    s.communities ||= []; // join material beyond the built-in
    s.invites ||= {}; // { [cid]: { sk, token, url } } — minted links
    s.dms ||= {}; // { [peerPk]: [{ id, from, text, t }] }
    s.declined ||= {}; // direct-invite rumor ids dismissed
    s.tombstones ||= {}; // { [cid]: removed_at ms } — left communities (CORD-02 §8)
    s.read ||= {}; // { ['dm:'+pk | 'ch:'+id]: created_at } — last message we've seen
    s.notify ||= {}; // { [cid]: true } — communities that may buzz your phone (opt-in)
    s.drafts ||= {}; // { ['dm:'+pk | 'ch:'+id]: text } — half-typed messages
    s.zaps ||= {}; // { [eventId]: { s: sats, m: 1 } } — last known zap tallies
    s.feeds ||= []; // custom feeds: { id, name, follows, authors: [pk], topics: [tag] }
    for (const c of s.communities) c.added_at ||= Date.now();
    // pre-multi-community shape: joined was { [pubkey]: true } for coinos
    for (const k of Object.keys(s.joined))
      if (s.joined[k] === true) { (s.joined[COMMUNITY.community_id] ||= {})[k] = true; delete s.joined[k]; }
    return s;
  };
  const save = (s) => wallet.saveFeatureState('messages', s);

  const communities = () => [COMMUNITY, ...st().communities];

  // ---- custom emoji (NIP-30 tags, NIP-51 emoji sets) ----------------------
  // A message that says :pika_wave: carries an ["emoji", code, url] tag for
  // it, so RENDERING never needs anything held locally. Two sources feed
  // what you can type and pick: packs you hold (kind 30030 sets, listed in
  // your kind 10030 — the list Vector reads and writes too, so a pack added
  // in either app shows in both) and shortcodes LEARNED from messages seen,
  // so anyone can answer a :pika_wave: with one.
  const EMOJI_STATE = 'emoji';
  const LEARNED_MAX = 400;
  let emojiState = null;
  const emojiSt = () => {
    if (!emojiState) {
      const s = wallet.loadFeatureState(EMOJI_STATE, {}) || {};
      s.packs ||= {};   // { [addr]: { title, image, emojis: [[code, url]], at } }
      s.order ||= [];   // pack addrs in picker order
      s.learned ||= {}; // { [code]: url }, insertion-ordered, oldest first
      s.list ||= { at: 0, tags: [] }; // our kind 10030 as last seen or published
      s.unfetched ||= []; // listed packs no relay answered for — kept on the list
      emojiState = s;
    }
    return emojiState;
  };
  // Learned shortcodes arrive in bursts (a backfill), so those writes are
  // coalesced; a pack change is one deliberate act and lands at once — a
  // tap-then-navigate must never lose it.
  let emojiSaveTimer = 0;
  const saveEmoji = (now = false) => {
    clearTimeout(emojiSaveTimer);
    const write = () => { try { wallet.saveFeatureState(EMOJI_STATE, emojiSt()); } catch {} };
    if (now) write(); else emojiSaveTimer = setTimeout(write, 500);
  };
  // code → image url: held packs first (in order), then what's been seen
  const emojiUrl = (code) => {
    const s = emojiSt();
    for (const addr of s.order) {
      const p = s.packs[addr];
      if (!p) continue;
      for (const [c, u] of p.emojis) if (c === code) return u;
    }
    return s.learned[code] || null;
  };
  // everything typeable: [{ code, url, pack }], packs first, newest-seen next
  function customEmojis() {
    const s = emojiSt();
    const out = [];
    const seen = new Set();
    for (const addr of s.order) {
      const p = s.packs[addr];
      if (!p) continue;
      for (const [code, url] of p.emojis) {
        if (seen.has(code)) continue;
        seen.add(code);
        out.push({ code, url, pack: p.title });
      }
    }
    for (const [code, url] of Object.entries(s.learned).reverse()) {
      if (seen.has(code)) continue;
      seen.add(code);
      out.push({ code, url, pack: '' });
    }
    return out;
  }
  // Remember the emoji tags a message (or reaction) arrived with. Bounded:
  // the oldest fall off, and re-seeing one moves it back to the front.
  function noteEmoji(rumor) {
    const m = emojiTagMap(rumor && rumor.tags);
    if (!m.size) return;
    const s = emojiSt();
    let changed = false;
    for (const [code, url] of m) {
      if (s.learned[code] === url) continue;
      delete s.learned[code];
      s.learned[code] = url;
      changed = true;
    }
    if (!changed) return;
    const keys = Object.keys(s.learned);
    for (const k of keys.slice(0, Math.max(0, keys.length - LEARNED_MAX))) delete s.learned[k];
    saveEmoji();
  }
  const emojiRelays = (extra = []) => [...new Set([...extra, ...zapRelays(), ...DM_RELAYS, ...STOCK_RELAYS])];
  async function fetchPack(ref) {
    const evs = await queryOn(emojiRelays(ref.relays), { kinds: [EMOJI_SET_KIND], authors: [ref.pubkey], '#d': [ref.identifier] }, 6000).catch(() => []);
    const newest = (evs || []).sort((a, b) => b.created_at - a.created_at)[0];
    return newest ? parseEmojiSet(newest) : null;
  }
  function holdPack(pack) {
    const s = emojiSt();
    s.packs[pack.addr] = { title: pack.title, image: pack.image, emojis: pack.emojis, at: pack.at };
    if (!s.order.includes(pack.addr)) s.order.push(pack.addr);
    s.unfetched = s.unfetched.filter((a) => a !== pack.addr);
    saveEmoji(true);
  }
  const hasPack = (addr) => !!emojiSt().packs[addr];
  // A pasted naddr / Vector share link, or the Add button on a pack link in
  // chat: fetch the set, hold it, and put it on our list.
  async function addPack(input) {
    const ref = parsePackRef(input);
    if (!ref) { toast(t('msgEmojiPackBad')); return false; }
    const addr = packAddr(ref.pubkey, ref.identifier);
    if (hasPack(addr)) { toast(t('msgEmojiPackHave')); return true; }
    ui.emojiBusy = true; render();
    const pack = await fetchPack(ref);
    ui.emojiBusy = false;
    if (!pack) { toast(t('msgEmojiPackBad')); render(); return false; }
    holdPack(pack);
    toast(t('msgEmojiPackAdded', { name: pack.title }));
    render();
    publishEmojiList().catch(() => {});
    return true;
  }
  function removePack(addr) {
    const s = emojiSt();
    delete s.packs[addr];
    s.order = s.order.filter((a) => a !== addr);
    s.unfetched = s.unfetched.filter((a) => a !== addr);
    saveEmoji(true);
    render();
    publishEmojiList().catch(() => {});
  }
  // a plain (unwrapped) event signed by the chat identity
  const signPlain = (id, evt) => (id.signer instanceof Uint8Array ? finalizeEvent(evt, id.signer) : id.signer.signEvent(evt));
  // Our kind 10030: the packs held as `a` tags. Every other tag of the list
  // we last saw rides along (inline emoji, whatever another client keeps
  // there), so publishing from here never strips what Vector wrote.
  async function publishEmojiList() {
    const id = await identity();
    if (!id) return;
    const s = emojiSt();
    const kept = (s.list.tags || []).filter((x) => x[0] !== 'a');
    const created_at = Math.max(Math.floor(Date.now() / 1000), (s.list.at || 0) + 1);
    const tags = [...kept, ...[...new Set([...s.order, ...s.unfetched])].map((a) => ['a', a])];
    const evt = await signPlain(id, { kind: EMOJI_LIST_KIND, content: '', tags, created_at });
    s.list = { at: created_at, tags };
    saveEmoji(true);
    publishOn(emojiRelays(), evt);
  }
  // Adopt the newest kind 10030 on the relays when it's newer than what we
  // hold: packs it lists arrive, packs it dropped go. Ten-minute throttle.
  let emojiSyncAt = 0;
  async function syncEmoji({ force = false } = {}) {
    if (!force && Date.now() - emojiSyncAt < 10 * 60_000) return;
    emojiSyncAt = Date.now();
    const pks = myPubkeys();
    if (!pks.length) return;
    try {
      const evs = await queryOn(emojiRelays(), { kinds: [EMOJI_LIST_KIND], authors: pks }, 5000);
      const newest = (evs || []).sort((a, b) => b.created_at - a.created_at)[0];
      const s = emojiSt();
      if (!newest || newest.created_at <= (s.list.at || 0)) return;
      const want = (newest.tags || []).filter((x) => x[0] === 'a' && parsePackAddr(x[1])).map((x) => x[1]);
      s.list = { at: newest.created_at, tags: newest.tags || [] };
      s.order = s.order.filter((a) => want.includes(a));
      for (const a of Object.keys(s.packs)) if (!s.order.includes(a)) delete s.packs[a];
      s.unfetched = [];
      saveEmoji();
      let changed = false;
      for (const addr of want) {
        if (s.packs[addr]) continue;
        const pack = await fetchPack(parsePackAddr(addr));
        if (pack) { holdPack(pack); changed = true; } else s.unfetched.push(addr);
      }
      // the list's own order wins over arrival order
      s.order = want.filter((a) => s.packs[a]);
      saveEmoji(true);
      if (changed) scheduleRepaint();
    } catch { emojiSyncAt = 0; }
  }
  const emojiImg = (code, url, cls = 'cemoji') =>
    feedPaint && !feedMedia(url) ? ':' + code + ':' : h('img', { class: cls, src: url, alt: ':' + code + ':', title: ':' + code + ':', loading: 'lazy' });
  // A reaction's content as shown on its chip: the picture for a :code: we
  // know (its own tag taught it to us), the text otherwise.
  function reactNode(emoji) {
    const code = shortcodeOf(emoji);
    const url = code && emojiUrl(code);
    return url ? emojiImg(code, url) : emoji;
  }
  // the NIP-30 tag a :code: reaction travels with
  const reactEmojiTags = (emoji) => {
    const code = shortcodeOf(emoji);
    const url = code && emojiUrl(code);
    return url ? [['emoji', code, url]] : [];
  };
  // a bubble that is nothing but one to three custom emoji shows them big
  const emojiJumbo = (text, em) => {
    if (!em || !em.size) return false;
    const n = emojiOnlyCount(splitEmoji(text, (c) => em.get(c)));
    return n > 0 && n <= 3;
  };
  // A pack share link (Vector's, or ours) rendered as what it is: one tap
  // adds the pack right here. Never an outbound link — on a phone the
  // vectorapp.io address belongs to the Vector app, and a tap on it walked
  // out of coinos into Vector.
  function packLinkNode(url, naddr) {
    const ref = parsePackRef(naddr);
    const addr = ref && packAddr(ref.pubkey, ref.identifier);
    const have = !!addr && hasPack(addr);
    return h('button', {
      class: 'pack-link', type: 'button', title: url, disabled: have || !!ui.emojiBusy,
      onClick: (e) => { e.stopPropagation(); addPack(naddr); },
    }, '🎨 ' + t('msgEmojiPackLink'), ' · ', h('b', {}, have ? t('msgEmojiPackHave') : t('msgEmojiPackAdd')));
  }
  // our share link for a pack — opens in the coinos app on a phone
  const packShareLink = (addr) => APP_BASE + '/emojis/pack/' + packNaddr(addr);

  // ---- unread -------------------------------------------------------------
  // A conversation is unread when its newest message from someone else is
  // newer than the last one we looked at. The watermark is the rumor's own
  // created_at, not a local clock, so it means the same thing on every device
  // the state syncs to. Our own messages never count — sending isn't reading,
  // but you've obviously seen what you wrote.

  const dmRead = (pk) => 'dm:' + pk;
  const chRead = (id) => 'ch:' + id;
  // The list screen has a watermark of its own: standing on it answers the
  // header dot ("someone's waiting" — you've now been shown who), while each
  // row keeps its own dot until that conversation is actually opened.
  const HOME_READ = 'home';

  const newestFrom = (entries, theirs) => {
    let ts = 0;
    for (const m of entries) if (theirs(m)) ts = Math.max(ts, m.rumor.created_at || 0);
    return ts;
  };

  function markRead(key, ts) {
    const s = st();
    if (!ts || (s.read[key] || 0) >= ts) return;
    s.read[key] = ts;
    bumpMsgRev();
    save(s);
    // read markers ride their own sync domain (registered below) — nudging
    // the cache is what gets the watermark onto the relays for other devices
    try { wallet.saveCache(); } catch {}
  }

  // One tap, every dot: advance each conversation's watermark to its newest
  // foreign message — DMs and community channels alike.
  function markAllRead() {
    const s = st();
    const my = myPubkeys();
    let changed = false;
    const bump = (key, ts) => { if (ts && (s.read[key] || 0) < ts) { s.read[key] = ts; changed = true; } };
    for (const [pk, msgs] of threads) bump(dmRead(pk), newestFrom(msgs.values(), (m) => !m.mine));
    for (const room of rooms.values())
      for (const [id, msgs] of room.byChannel)
        bump(chRead(id), newestFrom(msgs.values(), (m) => !my.includes(m.author)));
    if (changed) { bumpMsgRev(); save(s); try { wallet.saveCache(); } catch {} }
    render();
  }

  const anyUnread = () => {
    for (const [pk, msgs] of threads) if (dmUnread(pk, msgs)) return true;
    for (const room of rooms.values()) if (roomUnread(room)) return true;
    return false;
  };

  // Read state syncs across devices: each watermark only ever grows, so a
  // per-key max is a clean commutative merge — a thread read anywhere is
  // read everywhere.
  if (wallet.registerCacheExtension && !wallet._msgReadSync) {
    wallet._msgReadSync = true;
    wallet.registerCacheExtension({
      domain: 'msgread',
      mergeAlways: true,
      save: () => {
        const read = wallet.loadFeatureState('messages', {}).read || {};
        return Object.keys(read).length ? { msgRead: read } : {};
      },
      load: (d) => {
        if (!d.msgRead) return;
        const s = wallet.loadFeatureState('messages', {});
        s.read ||= {};
        let changed = false;
        for (const [k, v] of Object.entries(d.msgRead)) {
          if (typeof v === 'number' && (s.read[k] || 0) < v) { s.read[k] = v; changed = true; }
        }
        if (changed) { bumpMsgRev(); wallet.saveFeatureState('messages', s); }
      },
    });
  }

  // Per-conversation dots for the list screen: newer than when we last had
  // that thread (or any channel of that room) open.
  const dmUnread = (pk, msgs) =>
    newestFrom(msgs.values(), (m) => !m.mine) > (st().read[dmRead(pk)] || 0);
  function roomUnread(room) {
    const s = st();
    const my = myPubkeys();
    for (const [id, msgs] of room.byChannel)
      if (newestFrom(msgs.values(), (m) => !my.includes(m.author)) > (s.read[chRead(id)] || 0)) return true;
    return false;
  }

  // How many conversations are waiting on us — the header only draws a dot, but
  // a count keeps the door open for a number later. Floored by the list-screen
  // watermark: once you've seen the list, the header stops repeating it.
  //
  // Memoized on a revision counter: the header asks on EVERY render, and the
  // walk touches every cached message in every thread and room — a phone
  // paid that for each toast and repaint. Message arrivals and read-marks
  // bump the revision; everything else reuses the answer.
  let msgRev = 0;
  const bumpMsgRev = () => { msgRev++; };
  let _unreadMemo = { rev: -1, val: 0 };
  function unreadCount() {
    if (_unreadMemo.rev === msgRev) return _unreadMemo.val;
    _unreadMemo = { rev: msgRev, val: unreadCountNow() };
    return _unreadMemo.val;
  }
  function unreadCountNow() {
    const s = st();
    const my = myPubkeys();
    const seen = s.read[HOME_READ] || 0;
    let n = 0;
    for (const [pk, msgs] of threads)
      if (newestFrom(msgs.values(), (m) => !m.mine) > Math.max(seen, s.read[dmRead(pk)] || 0)) n++;
    for (const room of rooms.values())
      for (const [id, msgs] of room.byChannel)
        if (newestFrom(msgs.values(), (m) => !my.includes(m.author)) > Math.max(seen, s.read[chRead(id)] || 0)) n++;
    return n;
  }
  const communityById = (cid) => communities().find((c) => c.community_id === cid);

  // ---- identity -----------------------------------------------------------

  // Who we speak as. If the user logged in with a nostr account we speak as
  // that account or not at all — falling back to the wallet's own key would
  // sign under a pubkey that isn't the one their avatar and profile show,
  // which reads to everyone else as a different person entirely.
  async function identity() {
    const id = hook('nostrLoginIdentity');
    if (id) {
      const signer = id.signer || (await hook('nostrLoginResume'));
      return signer ? { pubkey: id.pubkey, signer } : null;
    }
    if (wallet.nostr && wallet.nostr.sk) return { pubkey: wallet.nostr.pk, signer: wallet.nostr.sk };
    return null;
  }
  const myPubkeys = () => {
    const pks = [];
    const id = hook('nostrLoginIdentity');
    if (id) pks.push(id.pubkey);
    if (wallet.nostr && wallet.nostr.pk && !pks.includes(wallet.nostr.pk)) pks.push(wallet.nostr.pk);
    return pks;
  };
  const isMe = (pk) => myPubkeys().includes(pk);
  // The ONE nostr identity this wallet uses for DMs: the login identity when
  // signed in (extension/bunker/passkey/Google), else the seed-derived key. A
  // wallet has two keys (seed + login), but only this one should receive and
  // advertise DMs — advertising/polling the seed key as a SECOND inbox is what
  // produced duplicate welcome DMs and split a person's messages across two
  // identities. isMe/dmDecryptors stay tolerant of both so already-received
  // messages still thread and align; we just stop treating the seed key as a
  // live second inbox. (One key here, but kept as a list for the '#p' filters.)
  const dmSubKeys = () => {
    const id = hook('nostrLoginIdentity');
    const pk = (id && id.pubkey) || (wallet.nostr && wallet.nostr.pk) || null;
    return pk ? [pk] : [];
  };
  // "No identity" while soft-locked means the keys left with the lock — say
  // that, not "signer disconnected" (which reads as a nostr-login problem).
  const noIdToast = () => {
    // A missing signer gets the reconnect screen, not a dead-end toast —
    // logging out and back in was the workaround nobody should need.
    if (!wallet.watchOnly && hook('nostrReconnectPrompt')) return;
    toast(t(wallet.watchOnly ? 'msgLockedChat' : 'msgNoIdentity'));
  };
  // Thrown by the publish paths after noIdToast already did the talking
  // (opened the reconnect screen, or toasted): callers must not toast it
  // again — a pasted-nsec login that lost its signer on reload used to get
  // the toast INSTEAD of the screen with the nsec field this way.
  class NoIdentity extends Error { constructor() { super(t('msgNoIdentity')); this.silent = true; } }
  const requireIdentity = async () => {
    const id = await identity();
    if (!id) { noIdToast(); throw new NoIdentity(); }
    return id;
  };

  // ---- shared runtime -----------------------------------------------------

  const rooms = new Map(); // cid -> room runtime
  const threads = new Map(); // peerPk -> Map(rumorId -> { rumor, mine })
  // DM reactions, keyed by the reacted message's id — no thread needed, so a
  // reaction that arrives before its message still lands. Ephemeral like the
  // community ones: the wrap backlog rebuilds them on reload.
  const dmReacts = new Map(); // rumorId -> Map(authorPk -> emoji)
  const dmReactAt = new Map(); // `${rumorId}|${authorPk}` -> ms of the reaction that stands
  const pendingDirect = new Map(); // rumor id -> { bundle, from }
  const profiles = new Map(); // pubkey -> profile | null while loading
  const seenWraps = new Set();
  // Wraps this device already opened (or gave up on), remembered ACROSS
  // boots: relays re-serve their last ~400 wraps on every subscribe, and a
  // remote-signer wallet paid two NIP-46 round trips (sign + verify each)
  // per wrap to rediscover DMs it already had — ~4s of a phone's boot.
  // Keyed by an id prefix (64 bits is plenty for "skip this one").
  const WRAPS_MAX = 1500;
  const wrapKey = (id) => String(id).slice(0, 16);
  let wrapLog = null, wrapsTimer = 0;
  function loadSeenWraps() {
    if (wrapLog) return;
    wrapLog = (st().wraps || []).slice(-WRAPS_MAX);
    for (const k of wrapLog) seenWraps.add(k);
  }
  function rememberWrap(id) {
    const k = wrapKey(id);
    if (!wrapLog) wrapLog = [];
    if (!seenWraps.has(k)) wrapLog.push(k);
    seenWraps.add(k);
    clearTimeout(wrapsTimer);
    wrapsTimer = setTimeout(() => {
      try { const s = st(); s.wraps = wrapLog.slice(-WRAPS_MAX); wrapLog = s.wraps; save(s); } catch {}
    }, 1500);
  }
  let dmStarted = false;
  let allUnsubs = [];
  let dmUnsubs = []; // the DM wrap subscriptions alone, so they can be rebuilt

  let repaintTimer = null;
  const scheduleRepaint = () => {
    if (repaintTimer) return;
    repaintTimer = setTimeout(() => {
      repaintTimer = null;
      if (ui.screen === 'wallet') renderThreadStable();
    }, 80);
  };

  // Profiles persist across sessions (capped) so known faces paint right
  // away instead of flashing the punk fallback; entries refresh in the
  // background once a day.
  const PROFILE_TTL = 24 * 3600_000;
  let profilesWarmed = false;
  function warmProfiles() {
    if (profilesWarmed) return;
    // The cache lives under the WALLET's namespace. The header avatar can
    // ask for a face before the wallet has its keys (a silent sign-in still
    // resuming at boot), and warming then read an empty slot under a bogus
    // key and counted itself done — online the relays papered over it, but
    // offline every cached face stayed a punk. Wait for the keys; init()
    // warms again once they're there.
    if (!wallet.mnemonic && !wallet.xprv && !wallet.xpub) return;
    profilesWarmed = true;
    const cached = wallet.loadFeatureState('profiles', {});
    for (const [pk, p] of Object.entries(cached)) if (!profiles.has(pk)) profiles.set(pk, p);
  }
  function persistProfile(pk, p) {
    // A faceless answer is not a fact worth writing down — persisting
    // {name:null, picture:null} rows only evicts real faces from the cap and
    // spreads a cold-relay miss across sessions.
    if (!p || (!p.name && !p.picture)) return;
    const s = wallet.loadFeatureState('profiles', {});
    s[pk] = { name: p.name || null, picture: p.picture || null, nip05: p.nip05 || null, lud16: p.lud16 || null,
      about: p.about || null, banner: p.banner || null, eventAt: p.eventAt || 0, t: Date.now(),
      ...(p.thumbFor === p.picture && p.thumb
        ? { thumb: p.thumb, thumbFor: p.thumbFor, thumbPx: p.thumbPx || 0 } : {}),
      ...(p.thumbFail ? { thumbFail: p.thumbFail, thumbFailAt: p.thumbFailAt || 0, thumbFails: p.thumbFails || 1,
        thumbFailVersion: p.thumbFailVersion || 0 } : {}) };
    // Thumbnails are the bulk of this blob, so they live on a budget: the
    // least recently seen faces give theirs up first. The row itself stays —
    // that face just paints the way it used to.
    if (JSON.stringify(s).length > THUMB_BUDGET) {
      // never our own: the header face is the one that must paint offline
      const mine = new Set(myPubkeys());
      const oldestFirst = Object.keys(s).filter((k) => s[k].thumb && !mine.has(k)).sort((a, b) => (s[a].t || 0) - (s[b].t || 0));
      for (const k of oldestFirst) {
        delete s[k].thumb; delete s[k].thumbFor;
        if (JSON.stringify(s).length <= THUMB_BUDGET) break;
      }
    }
    const keys = Object.keys(s);
    if (keys.length > 150) {
      // the user's own faces never churn out — their avatar going punk over
      // a busy community room is the one eviction people actually notice
      const keep = new Set([(hook('nostrLoginIdentity') || {}).pubkey,
        wallet.nostrPubkey && wallet.nostrPubkey()].filter(Boolean));
      const evictable = keys.filter((k) => !keep.has(k));
      for (const k of evictable.sort((a, b) => (s[a].t || 0) - (s[b].t || 0)).slice(0, keys.length - 150)) delete s[k];
    }
    wallet.saveFeatureState('profiles', s);
  }
  // A punk picture is OUR OWN art. Every coinos user who keeps the default
  // publishes https://v3.coinos.io/punks/N.webp as their nostr picture, and
  // the legacy coinos.io copies 502 for a third of the set — so painting
  // those from the local files means no network, no broken faces, and the
  // right size for the circle being drawn.
  // Absolute (what the wizard publishes) or the bare relative path an older
  // build wrote into a few profiles.
  const PUNK_PIC_RE = /^(?:https?:\/\/(?:[a-z0-9-]+\.)*coinos\.io\/)?punks\/(\d{1,2})\.webp$/i;
  const localPunk = (url, big) => {
    const m = PUNK_PIC_RE.exec(url || '');
    return m ? punkImageUrl(m[1], !big) : null;
  };

  // A refreshed profile whose picture hasn't changed keeps the thumbnail we
  // already made of it — otherwise every relay refresh throws the local copy
  // away and the original gets downloaded all over again.
  const keepThumb = (pk, entry) => {
    const prev = profiles.get(pk);
    if (!prev || !entry || !entry.picture) return entry;
    if (prev.thumb && prev.thumbFor === entry.picture) {
      // thumbPx rides along: without it a refreshed profile looks like a
      // thumbnail of unknown size and gets remade on every relay refresh
      entry.thumb = prev.thumb; entry.thumbFor = prev.thumbFor; entry.thumbPx = prev.thumbPx || 0;
    }
    if (prev.thumbFail === entry.picture) {
      entry.thumbFail = prev.thumbFail;
      entry.thumbFailAt = prev.thumbFailAt || 0;
      entry.thumbFails = prev.thumbFails || 1;
      entry.thumbFailVersion = prev.thumbFailVersion || 0;
    }
    return entry;
  };

  // Pull the picture bytes into the HTTP cache the moment we learn the URL —
  // an avatar div then paints instantly instead of holding its quiet circle
  // while the image downloads.
  const preloadPicture = (p) => { try { if (p?.picture) new Image().src = localPunk(p.picture) || (p.thumbFor === p.picture && p.thumb) || p.picture; } catch {} };

  // A profile picture is whatever its owner uploaded, and that is very often
  // the full-size original: among the faces this wallet had cached, one was a
  // 5MB JPEG and another 3.9MB — megabytes fetched and decoded to paint a
  // 30px circle, which is the second of blank circles you see after a
  // refresh. So the first time we see a picture we downscale it ONCE and keep
  // the thumbnail beside the profile. Every later boot paints the face from
  // localStorage in the first frame, with no network at all.
  //
  // Reading the pixels needs CORS (a tainted canvas can't be exported). Most
  // avatar hosts allow it; the ones that don't are remembered as failures and
  // keep today's behaviour rather than being retried every boot.
  const THUMB_PX = 144;      // the 44px feed circle at 3x, with room to spare;
                             // the 64px profile avatar layers the original
                             // over it anyway
  // Chars of data URL for one face. Scaled with THUMB_PX: the busiest
  // picture on hand fit 9000 at 96px and needs 12827 at 144px — measured in
  // the browser, not estimated, because its own webp encoder is nothing
  // like as kind to noise as an offline one. A face over the cap keeps
  // painting from its original, which is the old behaviour, so the cap only
  // decides who gets the fast path.
  const THUMB_MAX = 16_000;
  // ...and for all of them together. Raised with THUMB_PX: a 144px face
  // costs about 5.4KB against 96px's 3.2KB, and the budget is what decides
  // how many faces paint instantly rather than fetching their original —
  // this holds about fifty, which covers a feed and an inbox at once. The
  // blob carries each profile's bio and banner as well now — a couple of
  // hundred bytes each, and the reason a profile page paints on the first
  // tap — so the ceiling is raised to keep the same number of faces.
  const THUMB_BUDGET = 320_000;
  const THUMB_SLOW = 20_000; // a host that won't answer must not hold a slot
  const THUMB_RETRY = 6 * 3600_000; // ...and must not be written off for good
  const THUMB_RETRY_MAX = 14 * 24 * 3600_000; // a host that never works, backed off
  // Older crossOrigin <img> attempts could fail on a cached no-CORS response.
  // Those failures must not suppress the corrected fetch/blob path.
  const THUMB_VERSION = 1;
  const thumbing = new Set();
  const thumbQueue = new Map();
  function makeThumb(pk, p) {
    if (!p || !p.picture || typeof document === 'undefined') return;
    // thumbPx: a thumbnail made when the circles were smaller is too soft for
    // today's, so it's remade once. The old one keeps painting until then.
    if (p.thumbFor === p.picture && p.thumbPx === THUMB_PX) return;
    if (localPunk(p.picture)) return; // our own art, already the right size on disk
    // A failed attempt is usually the network, not the host: these images sit
    // on CDNs that answer in 700ms one minute and time out the next. So every
    // failure is tried again — backing off each time, so a host that truly
    // won't have us is asked about twice a month rather than every boot.
    if (p.thumbFailVersion === THUMB_VERSION && p.thumbFail === p.picture
      && Date.now() - (p.thumbFailAt || 0) < Math.min(THUMB_RETRY * 2 ** ((p.thumbFails || 1) - 1), THUMB_RETRY_MAX)) return;
    if (thumbing.has(pk)) return;
    if (thumbing.size >= 3 && !isMe(pk)) { thumbQueue.set(pk, p); return; }
    // Making the thumbnail costs one more fetch of the original today to
    // save every fetch after it — but not on a connection someone is
    // nursing. Data Saver keeps today's behaviour.
    try { if (navigator.connection && navigator.connection.saveData) return; } catch {}
    thumbing.add(pk);
    const url = p.picture;
    const done = (patch) => {
      thumbing.delete(pk);
      const entry = { ...(profiles.get(pk) || p), ...patch };
      if (patch.thumb) {
        delete entry.thumbFail; delete entry.thumbFailAt;
        delete entry.thumbFails; delete entry.thumbFailVersion;
      }
      profiles.set(pk, entry);
      persistProfile(pk, entry);
      persistThreadProfile(pk);
      if (patch.thumb) scheduleRepaint();
      // Every warmed face gets a turn; the old concurrency guard silently
      // discarded everyone after the first three in a batch.
      for (const [nextPk, next] of thumbQueue) {
        if (thumbing.size >= 3) break;
        thumbQueue.delete(nextPk);
        makeThumb(nextPk, profiles.get(nextPk) || next);
      }
    };
    const failed = () => done({ thumbFail: url, thumbFailAt: Date.now(), thumbFailVersion: THUMB_VERSION,
      thumbFails: (p.thumbFailVersion === THUMB_VERSION && p.thumbFail === url ? p.thumbFails || 0 : 0) + 1 });
    // Fetch the bytes rather than pointing a crossOrigin <img> at the URL.
    // The avatar itself is painted as a plain background-image, so the
    // picture is already in the HTTP cache as a no-CORS entry — and a
    // crossOrigin <img> for the same URL reuses that entry and fails the CORS
    // check, which is how a host that allows us perfectly well (verified: the
    // same fetch succeeds) came to be written off. Drawing from a blob also
    // keeps the canvas untainted, so nothing here depends on the element's
    // CORS bookkeeping at all.
    (async () => {
      let bmp = null;
      try {
        const res = await fetch(url, { mode: 'cors', cache: 'reload', signal: AbortSignal.timeout(THUMB_SLOW) });
        if (!res.ok) throw new Error('http ' + res.status);
        bmp = await createImageBitmap(await res.blob());
        // centre-crop to a square, the way background-size:cover paints it
        const side = Math.min(bmp.width, bmp.height);
        if (!side) throw new Error('empty');
        const c = document.createElement('canvas');
        c.width = c.height = THUMB_PX;
        c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2,
          side, side, 0, 0, THUMB_PX, THUMB_PX);
        let data = c.toDataURL('image/webp', 0.75);
        if (!data.startsWith('data:image/webp')) data = c.toDataURL('image/jpeg', 0.7);
        if (data.length > THUMB_MAX) data = c.toDataURL('image/webp', 0.5); // a busy picture, leaned on harder
        if (data.length > THUMB_MAX) throw new Error('too big');
        done({ thumb: data, thumbFor: url, thumbPx: THUMB_PX });
      } catch { failed(); } finally { try { bmp && bmp.close(); } catch {} }
    })();
  }

  // A profile that came back EMPTY is usually not proof there's no kind 0.
  // A feed holds a couple of dozen relay subscriptions open, relays cap what
  // one connection may ask at once, and a batch of a dozen pubkeys routinely
  // comes back with seven — the rest aren't missing, they're crowded out.
  // Trusting that silence for ten minutes is what left real accounts wearing
  // a punk and an npub. So a miss is retried soon and backs off only if it
  // keeps missing: fifteen seconds, then half a minute, then a minute, up to
  // the ten minutes that's right for someone who genuinely has no profile.
  const EMPTY_RETRY = 10 * 60_000;
  const emptyRetry = (p) => Math.min(15_000 * Math.pow(2, Math.max(0, (p && p.miss) || 1) - 1), EMPTY_RETRY);
  // A feed row keeps the presentation it had when admitted. Background
  // profile/quote refreshes must not rewrite text or replace faces mid-read.
  let feedPaint = null;
  function profileOf(pk) {
    if (!feedPaint) return liveProfileOf(pk);
    if (!feedPaint.profiles.has(pk)) {
      const p = { ...(liveProfileOf(pk) || {}) };
      let url = avatarUrl(p, pk);
      if (!feedMedia(url) && feedMedia(p.picture)) url = p.picture;
      if (!feedMedia(url)) p.picture = null;
      else p.picture = url;
      delete p.thumb;
      delete p.loading;
      feedPaint.profiles.set(pk, p);
    }
    return feedPaint.profiles.get(pk);
  }
  function liveProfileOf(pk) {
    warmProfiles();
    const cur = profiles.get(pk);
    if (cur !== undefined && (cur === null
      || Date.now() - (cur.t || 0) < (!cur.name && !cur.picture ? emptyRetry(cur) : PROFILE_TTL))) return cur;
    profiles.set(pk, cur || null); // null = loading, no fallback art yet
    wantProfile(pk);
    return cur || null;
  }

  // Profiles are asked for in BATCHES.
  //
  // One REQ per pubkey was the old shape, and it looked fine until a feed
  // painted eighty rows at once: eighty REQs in the same breath, against
  // relays that cap how many a connection may have open. Most were refused,
  // the five-second timeout expired, and an empty answer was remembered for
  // ten minutes — which is the punk-and-a-shortened-npub row. Measured
  // against this wallet's own feed, 131 of the 133 people on screen had a
  // kind 0 sitting on relays we were already connected to.
  const PROF_BATCH = 200;
  // Relays that exist to index profiles rather than to carry conversation.
  // We don't read notes from these, so they never appear in the batch above —
  // but they are the ones most likely to hold the kind 0 of someone whose
  // own relays we can't reach.
  const PROFILE_INDEX_RELAYS = ['wss://purplepag.es', 'wss://user.kindpag.es', 'wss://relay.nostr.band'];
  let profQueue = new Set(), profTimer = null, profInFlight = new Set();
  function wantProfile(pk) {
    if (!pk || profQueue.has(pk) || profInFlight.has(pk)) return;
    profQueue.add(pk);
    if (profTimer) return;
    // a short beat, so one paint's worth of rows becomes one request
    profTimer = setTimeout(() => { profTimer = null; const b = [...profQueue]; profQueue = new Set(); fetchProfiles(b).catch(() => {}); }, 250);
  }

  function applyProfile(pk, ev) {
    let m = null;
    try { m = JSON.parse(ev.content); } catch { m = null; }
    if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
    const prev = profiles.get(pk);
    if ((prev?.eventAt || 0) > ev.created_at) return true;
    const p = {
      name: m.display_name || m.name || null,
      picture: m.picture || null,
      nip05: m.nip05 || null,
      lud16: typeof m.lud16 === 'string' ? m.lud16.trim() : null,
      // The batch downloaded this person's WHOLE kind 0 to get their name.
      // Keeping the bio and the banner costs one more field each and is the
      // difference between a profile page that paints and one that jumps
      // when the fetch lands a second later. 1000 chars is what the page
      // renders anyway.
      about: typeof m.about === 'string' ? m.about.slice(0, 1000) : null,
      banner: typeof m.banner === 'string' ? m.banner.slice(0, 400) : null,
    };
    const entry = keepThumb(pk, { ...p, eventAt: ev.created_at, t: Date.now(), miss: 0 });
    profiles.set(pk, entry);
    // A page and the batched avatar lookup must share their answer. A slow
    // page miss must never erase a name/photo the batch already found.
    if (fullInFlight.has(pk) || fullProfiles.has(pk)) {
      fullProfiles.set(pk, m);
      fullFetched.add(pk);
      fullMisses.delete(pk);
      persistPage('full', pk, m);
    }
    persistProfile(pk, entry);
    persistThreadProfile(pk);
    preloadPicture(entry);
    return true;
  }

  async function fetchProfiles(pks) {
    for (const pk of pks) profInFlight.add(pk);
    try {
      const found = new Set();
      for (let i = 0; i < pks.length; i += PROF_BATCH) {
        const slice = pks.slice(i, i + PROF_BATCH);
        const evs = await queryOn(zapRelays(), { kinds: [0], authors: slice }, 5000).catch(() => []);
        const newest = new Map();
        for (const ev of evs || []) {
          const c = newest.get(ev.pubkey);
          if (!c || ev.created_at > c.created_at) newest.set(ev.pubkey, ev);
        }
        for (const [pk, ev] of newest) { if (applyProfile(pk, ev)) found.add(pk); }
        // paint what this batch found before going after the stragglers —
        // the outbox fallback below can take seconds, and there's no reason
        // for a face we already have to wait behind one we don't
        if (newest.size) scheduleRepaint();
      }
      // Whoever our relays have never heard of: ask the relays they publish
      // to. Same outbox plan the feed uses, so it costs the lists we already
      // have rather than a round trip each — plus the relays whose whole job
      // is holding kind 0s, which we deliberately don't read notes from and
      // so never ask in the batch above.
      const left = pks.filter((pk) => !found.has(pk));
      if (left.length) {
        const idx = await queryOn(PROFILE_INDEX_RELAYS, { kinds: [0], authors: left }, 5000).catch(() => []);
        const idxNewest = new Map();
        for (const ev of idx || []) {
          const c = idxNewest.get(ev.pubkey);
          if (!c || ev.created_at > c.created_at) idxNewest.set(ev.pubkey, ev);
        }
        for (const [pk, ev] of idxNewest) { if (applyProfile(pk, ev)) found.add(pk); }
        if (idxNewest.size) scheduleRepaint();
      }
      const stillLeft = pks.filter((pk) => !found.has(pk));
      if (stillLeft.length) {
        const left = stillLeft;
        await fetchRelayLists(left);
        await Promise.all(outboxPlan(left).map(async ({ relays, authors }) => {
          const evs = await queryOn(relays, { kinds: [0], authors }, 5000).catch(() => []);
          const newest = new Map();
          for (const ev of evs || []) {
            const c = newest.get(ev.pubkey);
            if (!c || ev.created_at > c.created_at) newest.set(ev.pubkey, ev);
          }
          for (const [pk, ev] of newest) { if (applyProfile(pk, ev)) found.add(pk); }
        }));
      }
      // nobody has one: mark the clock so it's retried in minutes, not asked
      // again on every paint
      for (const pk of pks) {
        if (found.has(pk)) continue;
        const prev = profiles.get(pk);
        profiles.set(pk, { ...(prev || {}), t: Date.now(), miss: ((prev && prev.miss) || 0) + 1 });
      }
      scheduleRepaint();
    } finally {
      for (const pk of pks) profInFlight.delete(pk);
    }
  }
  const displayName = (pk) => {
    const p = profileOf(pk);
    if (p && p.name) return p.name;
    const npub = npubOf(pk);
    return npub ? npub.slice(0, 12) : pk.slice(0, 12);
  };

  // Community wraps decrypt with real secp256k1 work (NIP-44), and a relay
  // backlog delivers hundreds at once. Decrypting them inline in the
  // subscription callbacks blocked the main thread in one burst on boot — the
  // stutter felt when dragging the balance carousel right after a refresh.
  // Queue the decrypt work and run it time-sliced: ~8ms of work, then yield so
  // input and paint get a turn. Chat catches up a few frames later; the wallet
  // stays responsive. (Same pattern the DM inbox drain already uses.)
  // Open one community wrap off the main thread when the crypto worker is
  // up (the decrypt + seal verify per wrap is the remaining boot secp256k1
  // the profiler pinned); the time-sliced queue below stays as the fallback,
  // so a dead worker only changes where the crypto runs, never whether chat
  // catches up. The stream conversation key is group material every member
  // derives — no secret crosses the thread boundary.
  function openWrapBg(wrap, stream, cb) {
    const job = openWrapsOffthread([wrap], stream.convKey);
    if (!job) { enqueueRoomWork(() => cb(openWrap(wrap, stream))); return; }
    job.then((r) => {
      if (r) cb(r[0]);
      else enqueueRoomWork(() => cb(openWrap(wrap, stream))); // worker died mid-job
    });
  }

  const roomWork = [];
  let roomWorking = false;
  function enqueueRoomWork(fn) {
    roomWork.push(fn);
    if (roomWorking) return;
    roomWorking = true;
    (async () => {
      try {
        let t0 = performance.now();
        while (roomWork.length) {
          try { roomWork.shift()(); } catch {}
          if (performance.now() - t0 > 8) { await new Promise((r) => setTimeout(r)); t0 = performance.now(); }
        }
      } finally { roomWorking = false; }
    })();
  }

  // ---- community rooms ----------------------------------------------------

  // subscribe:false builds the room from LOCAL CACHE only — no relay
  // subscription, so none of the gift-wrap verify/decrypt (real secp256k1)
  // runs. That's the boot default: the home screen and its unread dot read
  // the last-known cached messages, and the heavy live backfill waits until
  // the user actually opens Chat (homeView/room view pass subscribe:true).
  function ensureRoom(jm, { subscribe = true } = {}) {
    let room = rooms.get(jm.community_id);
    if (room) { if (subscribe) subscribeRoom(room); return room; }
    const root = hexToBytes(jm.community_root);
    // CORD-02 §5: a Community past the control_root split hands members the
    // Control Plane's signer pubkey in the invite — the address to read at —
    // while the wraps still decrypt under the community_root-derived key. A
    // legacy Community (the built-in coinos one) has no control_pk: the one
    // derivation is both address and key, and its sk still signs our writes.
    const controlRead = controlKey(root, jm.community_id, jm.root_epoch || EPOCH);
    const control = /^[0-9a-f]{64}$/.test(jm.control_pk || '') && jm.control_pk !== controlRead.pk
      ? { pk: jm.control_pk, sk: null, convKey: controlRead.convKey }
      : controlRead;
    // A channel's stream follows its own key and epoch (CORD-03): public ones
    // rotate with the base epoch, private ones carry theirs in the join
    // material. A channel only known from the Control fold is public.
    const chEntry = (id) => (jm.channels || []).find((c) => c.id === id) || { id };
    room = {
      jm,
      control,
      guestbook: guestbookKey(root, jm.community_id, jm.root_epoch || EPOCH),
      chStream: (id) => channelStream(jm, chEntry(id)),
      chEpoch: (id) => channelEpoch(jm, chEntry(id)),
      folded: null,
      controlEntries: [],
      guestEntries: [],
      members: new Map(),
      byChannel: new Map(),
      edits: new Map(),
      deletes: new Set(),
      reactions: new Map(),
      reactAt: new Map(), // `${target}|${author}` -> ms of the reaction that stands
      presence: new Map(), // pubkey -> ms of their last beat (this session only)
      typing: new Map(), // pubkey -> { ch, t }
      subbed: new Set(),
      subscribed: false,
      relays: jm.relays && jm.relays.length ? jm.relays : DM_RELAYS,
    };
    rooms.set(jm.community_id, room);

    const refold = () => { room.folded = foldControl(room.controlEntries, { ownerHex: jm.owner, cid: jm.community_id }); };
    const refoldGuestbook = () => {
      room.members = foldGuestbook(room.guestEntries, { nowMs: Date.now(), banned: room.folded?.banned, ownerHex: jm.owner });
      for (const [, msgs] of room.byChannel)
        for (const { rumor, author } of msgs.values()) {
          const tms = eventMs(rumor);
          if (tms) observeAuthor(room.members, author, tms);
        }
    };
    // The replay of stored wraps arrives one event at a time, and folding
    // after every wrap paints each intermediate state: a superseded ban-list
    // version blinks members' messages out until the newest version lands,
    // and the member count creeps upward as joins stream in. Fold once per
    // burst instead — a short quiet gap ends the burst — so the page goes
    // from cache straight to the settled state.
    let foldTimer = 0;
    room.scheduleFold = () => {
      clearTimeout(foldTimer);
      foldTimer = setTimeout(() => {
        refold();
        refoldGuestbook();
        // An invite may grant no channels at all (a Vector link carries only
        // the private ones): the public channels are learned from the
        // Control fold, so a room open on the relays follows them as they
        // fold in — otherwise the room stays "No messages yet" forever.
        if (room.subscribed) for (const c of roomChannels(room)) subChannel(room, c.id);
        // remember the settled count — next session's list paints it
        // immediately instead of "encrypted" flipping to a number
        const s = st();
        (s.memberCounts ||= {})[jm.community_id] =
          [...room.members.values()].filter((m) => m.state === 'join').length;
        save(s);
        scheduleRepaint();
      }, 250);
    };

    // warm from local cache so the page (and the unread dot) paint before —
    // and without needing — any relay subscription
    const cached = st().cache;
    for (const c of jm.channels || [])
      for (const m of cached[c.id] || []) {
        const msgs = room.byChannel.get(c.id) || room.byChannel.set(c.id, new Map()).get(c.id);
        if (!msgs.has(m.rumor.id)) msgs.set(m.rumor.id, m);
      }
    bumpMsgRev();
    if (subscribe) subscribeRoom(room);
    return room;
  }

  // Open the relay subscriptions for a room — the heavy path (gift-wrap
  // verify + decrypt). Deferred until Chat is opened; idempotent.
  function subscribeRoom(room) {
    if (room.subscribed) return;
    room.subscribed = true;
    const scheduleFold = room.scheduleFold;
    room.unsubs = room.unsubs || [];
    const keep = (...us) => { for (const u of us) { allUnsubs.push(u); room.unsubs.push(u); } };
    keep(
      subscribeOn(room.relays, { kinds: [1059], authors: [room.control.pk], limit: 500 }, (wrap) => {
        if (seenWraps.has(wrap.id)) return;
        seenWraps.add(wrap.id);
        openWrapBg(wrap, room.control, (opened) => {
          if (!opened || opened.rumor.kind !== 3308) return;
          room.controlEntries.push(opened);
          scheduleFold();
        });
      }, { onclose: noteSubClosed }),
      subscribeOn(room.relays, { kinds: [1059], authors: [room.guestbook.pk], limit: 500 }, (wrap) => {
        if (seenWraps.has(wrap.id)) return;
        seenWraps.add(wrap.id);
        openWrapBg(wrap, room.guestbook, (opened) => {
          if (!opened) return;
          room.guestEntries.push(opened);
          scheduleFold();
        });
      }, { onclose: noteSubClosed })
    );
    for (const c of room.jm.channels || []) subChannel(room, c.id);
  }

  function subChannel(room, id) {
    if (room.subbed.has(id)) return;
    room.subbed.add(id);
    // a fold-discovered channel warms from its cache here, the way the
    // invite's own channels do when the room is built
    if (!room.byChannel.has(id)) {
      const msgs = new Map();
      for (const m of st().cache[id] || []) msgs.set(m.rumor.id, m);
      if (msgs.size) { room.byChannel.set(id, msgs); bumpMsgRev(); }
    }
    // derive the stream key once per channel, not once per wrap — groupKey
    // does an hkdf + ECDH each call, real curve work on a 200-wrap backfill
    const stream = room.chStream(id);
    const u = subscribeOn(room.relays, { kinds: [1059, 21059], authors: [stream.pk], limit: 200 }, (wrap) => {
      if (seenWraps.has(wrap.id)) return;
      seenWraps.add(wrap.id);
      openWrapBg(wrap, stream, (opened) => {
        if (!opened) return;
        onChat(room, id, opened);
      });
    }, { onclose: noteSubClosed });
    allUnsubs.push(u); (room.unsubs = room.unsubs || []).push(u);
  }

  // The relay pool reconnects a dropped socket, but one that ERRORED is
  // given up on — and a phone freezing the tab does exactly that to every
  // subscription we hold. Messages sent while the app was away then never
  // arrived, and nothing after them did either, until a reload. So coming
  // back (and coming online) rebuilds every live wrap subscription: DMs and
  // rooms. The windows they ask for overlap what we already hold, and
  // seenWraps drops the repeats before any decryption, so this costs a few
  // round trips and nothing else.
  function resubscribeStreams() {
    const wasDm = dmStarted;
    const wanted = [...rooms.values()].filter((r) => r.subscribed);
    tearingDown = true; // our own closes are not a relay giving up on us
    try {
      if (wasDm) {
        for (const u of dmUnsubs) { try { u(); } catch {} }
        dmUnsubs = []; dmStarted = false;
      }
      for (const room of wanted) {
        for (const u of room.unsubs || []) { try { u(); } catch {} }
        room.unsubs = []; room.subscribed = false; room.subbed.clear();
      }
    } finally { tearingDown = false; }
    if (wasDm) startDMs();
    for (const room of wanted) subscribeRoom(room);
  }

  // ---- subscription watchdog ------------------------------------------------
  // The resume hook above rebuilds after an absence it was TOLD about. It
  // isn't told when a socket errors while the page stays on screen (a wifi
  // hop, a laptop lid, a phone freezing the tab without the away timer
  // noticing, another tab clearing that timer first) — and an errored
  // socket is dropped from the pool with every subscription it carried.
  // The room then sits quietly stale until a reload, while another client
  // is ringing about new messages. So whenever the app is on screen — on
  // focus, on becoming visible, and every ten seconds in between — the pool
  // is asked whether each relay the inbox and the rooms listen on still
  // holds a live socket; a relay that closed a subscription on us counts
  // too. Anything missing rebuilds the lot. A rebuild is a few round trips
  // (seenWraps drops the replay before any decryption), but a relay that
  // keeps refusing is retried on a growing backoff, not every tick.
  let tearingDown = false;
  let subsDead = false;
  let lastRebuild = 0;
  let rebuildBackoff = 15_000;
  let watchdogArmed = false;
  function noteSubClosed() {
    if (tearingDown || !allUnsubs.length) return;
    subsDead = true;
    setTimeout(ensureLive, 500);
  }
  function ensureLive() {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!allUnsubs.length) return; // nothing is meant to be live yet
    const urls = new Set();
    if (dmStarted) for (const u of liveRelayList(DM_RELAYS)) urls.add(u);
    for (const room of rooms.values()) if (room.subscribed) for (const u of liveRelayList(room.relays)) urls.add(u);
    const dead = [...urls].filter((u) => !relayAlive(u));
    if (!dead.length && !subsDead) { rebuildBackoff = 15_000; return; }
    const now = Date.now();
    if (now - lastRebuild < rebuildBackoff) return;
    lastRebuild = now;
    rebuildBackoff = Math.min(rebuildBackoff * 2, 5 * 60_000);
    subsDead = false;
    console.warn('chat: relay socket gone (' + (dead.join(', ') || 'subscription closed') + ') — resubscribing');
    // a relay the pool is stuck dialing would just hand the rebuild the same
    // hung promise — drop it so the rebuild dials afresh
    tearingDown = true;
    try { for (const u of dead) resetRelay(u); } finally { tearingDown = false; }
    resubscribeStreams();
  }
  function armWatchdog() {
    if (watchdogArmed || typeof window === 'undefined') return;
    watchdogArmed = true;
    const soon = () => setTimeout(ensureLive, 300);
    window.addEventListener('focus', soon);
    window.addEventListener('pageshow', soon);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') soon(); });
    setInterval(ensureLive, 10_000);
  }

  function onChat(room, channelId, { rumor, author }) {
    const tag = (k) => rumor.tags?.find((x) => x[0] === k);
    // CORD-03 §3: the rumor must commit to the channel/epoch that decrypted it
    if (tag('channel')?.[1] !== channelId || tag('epoch')?.[1] !== String(room.chEpoch(channelId))) return;
    if (room.folded && room.folded.banned.has(author)) return;
    if (rumor.kind === PRESENCE || rumor.kind === TYPING) {
      // Dated by the beat itself, never by arrival. Relays hand back stored
      // beats when we subscribe, and treating those as "just now" would light
      // up the whole member list as online. Clamped to now so a fast clock
      // can't hold someone online forever.
      const ts = Math.min(Date.now(), eventMs(rumor) || rumor.created_at * 1000);
      if (ts > (room.presence.get(author) || 0)) room.presence.set(author, ts);
      if (rumor.kind === TYPING && Date.now() - ts < TYPING_MS) {
        room.typing.set(author, { ch: channelId, t: ts });
        setTimeout(scheduleRepaint, TYPING_MS + 100); // clear itself when it lapses
      }
      scheduleRepaint();
      return;
    }
    noteEmoji(rumor); // custom emoji seen here become custom emoji you can send
    if (rumor.kind === 9) {
      const msgs = room.byChannel.get(channelId) || room.byChannel.set(channelId, new Map()).get(channelId);
      msgs.set(rumor.id, { rumor, author });
      bumpMsgRev();
      room.typing.delete(author); // the message itself ends the "typing…"
      schedulePersist(room);
    } else if (rumor.kind === 5) {
      for (const e of rumor.tags.filter((x) => x[0] === 'e')) {
        const m = room.byChannel.get(channelId)?.get(e[1]);
        if (!m || m.author === author) room.deletes.add(e[1]);
      }
      schedulePersist(room);
    } else if (rumor.kind === 3302) {
      const target = tag('e')?.[1];
      if (target) {
        const cur = room.edits.get(target);
        if (!cur || eventMs(rumor) > eventMs(cur.rumor)) room.edits.set(target, { rumor, author });
      }
    } else if (rumor.kind === 7) {
      const target = tag('e')?.[1];
      if (target) {
        // One reaction per author, the NEWEST by the rumor's own clock — not
        // the last to arrive. A reload's backfill hands them back in relay
        // order, and the flame swapped for confetti came back as the flame.
        const key = target + '|' + author;
        const at = eventMs(rumor) || rumor.created_at * 1000;
        if (at >= (room.reactAt.get(key) || 0)) {
          room.reactAt.set(key, at);
          const r = room.reactions.get(target) || room.reactions.set(target, new Map()).get(target);
          r.set(author, rumor.content);
        }
      }
    }
    const tms = eventMs(rumor);
    if (tms) observeAuthor(room.members, author, tms);
    scheduleRepaint();
  }

  const roomChannels = (room) => {
    if (room.folded && room.folded.channels.size) {
      // a private channel is only ours if the invite handed us its key
      const held = (id) => (room.jm.channels || []).some((c) => c.id === id && channelIsPrivate(room.jm, c));
      return [...room.folded.channels.entries()]
        .filter(([id, c]) => !c.private || held(id))
        .map(([id, c]) => ({ id, name: c.name }));
    }
    return room.jm.channels || [];
  };

  // Messages that ARRIVE get cached too, not only ones we send: the cache
  // used to be written on our own actions alone, so a member who only reads
  // had nothing on an offline boot — the room said "No messages yet" with a
  // hundred messages read the day before. A backfill lands in a burst, so
  // the write waits for it to settle.
  const persistTimers = new Map(); // room -> timer
  function schedulePersist(room) {
    clearTimeout(persistTimers.get(room));
    persistTimers.set(room, setTimeout(() => { persistTimers.delete(room); try { persistCache(room); } catch {} }, 2500));
  }
  function persistCache(room) {
    const s = st();
    for (const [chId, msgs] of room.byChannel) {
      // Pending entries stay out of the cache: unconfirmed means the relay
      // never took it, and a reload would resurrect it dimmed forever.
      s.cache[chId] = [...msgs.values()]
        .filter((m) => !room.deletes.has(m.rumor.id) && !m.pending)
        .sort((a, b) => eventMs(a.rumor) - eventMs(b.rumor))
        .slice(-CACHE_MAX);
    }
    save(s);
  }

  async function ensureJoined(room, id) {
    const s = st();
    const j = (s.joined[room.jm.community_id] ||= {});
    if (j[id.pubkey]) return;
    const { created_at, ms } = msTags(Date.now());
    const tags = [ms];
    if (room.jm.invitedBy) tags.push(['invite', room.jm.invitedBy, room.jm.inviteLabel || '']);
    const wrap = await wrapRumor({ kind: 3306, pubkey: id.pubkey, content: 'join', tags, created_at }, id.signer, room.guestbook);
    publishOn(room.relays, wrap);
    j[id.pubkey] = true;
    save(s);
  }

  // ---- drafts -------------------------------------------------------------
  // Half-typed text survives navigation and reloads: one draft per
  // conversation ('dm:<pk>' / 'ch:<channelId>'), kept in feature state.
  // The session map is authoritative while the app runs; persistence rides a
  // debounce so typing doesn't hammer storage.
  const sessionDrafts = new Map();
  let draftPersist = 0;
  const POST_DRAFT = 'post'; // the profile page's new-post composer
  const draftFor = (key) =>
    (sessionDrafts.has(key) ? sessionDrafts.get(key) : (st().drafts || {})[key] || '');
  function setDraft(key, text) {
    sessionDrafts.set(key, text);
    clearTimeout(draftPersist);
    draftPersist = setTimeout(() => {
      const s = st();
      s.drafts ||= {};
      for (const [k, v] of sessionDrafts) { if (v) s.drafts[k] = v; else delete s.drafts[k]; }
      save(s);
    }, 800);
  }

  // The morph never rewrites a focused field's value (it would fight the user
  // mid-keystroke), and the composer is focused at the moment you send — so
  // clearing the draft alone leaves the sent text sitting in the input.
  // Clear the live element too.
  function clearDraft(key) {
    setDraft(key, '');
    ui.emojiAc = null;
    const inp = document.getElementById('msg-draft');
    if (inp) inp.value = '';
  }

  async function sendMessage(room, chId) {
    const text = draftFor('ch:' + chId).trim();
    if (!text) return;
    const id = await identity();
    if (!id) { noIdToast(); return; }
    // The rumor id is a plain hash, so the message can be on screen before
    // any signing, encryption or network runs. The pending flag never shows —
    // it only keeps unconfirmed messages out of the cache and marks what to
    // withdraw if signing fails.
    const { created_at, ms } = msTags(Date.now());
    // an armed reply context e-tags the quoted message (rendered as a quote
    // by replyQuote on every device that has the original)
    const replyTo = ui.msgReplyTo && room.byChannel.get(chId)?.has(ui.msgReplyTo) ? ui.msgReplyTo : null;
    ui.msgReplyTo = null;
    ui.emojiAc = null;
    // every :code: we can resolve travels with its picture (NIP-30), so the
    // room renders it whether or not anyone else holds the pack
    const rumor = rumorWithId({
      kind: 9, pubkey: id.pubkey, content: text,
      tags: [['channel', chId], ['epoch', String(room.chEpoch(chId))], ...(replyTo ? [['e', replyTo]] : []), ...outboundEmojiTags(text, emojiUrl), ms], created_at,
    });
    const msgs = room.byChannel.get(chId) || room.byChannel.set(chId, new Map()).get(chId);
    const entry = { rumor, author: id.pubkey, pending: true };
    msgs.set(rumor.id, entry);
    clearDraft('ch:' + chId);
    ui.msgStick = true;
    render();
    try {
      const wrap = await wrapRumor(rumor, id.signer, room.chStream(chId));
      seenWraps.add(wrap.id); // our own echo has nothing to add
      const ok = await publishOn(room.relays, wrap);
      if (!ok) { toast(t('msgSendFailed')); return; }
      delete entry.pending;
      ensureJoined(room, id).catch(() => {});
      persistCache(room);
    } catch (e) {
      // Signing or wrapping failed — the message never existed on the wire,
      // so it leaves the screen rather than sit there looking sent.
      msgs.delete(rumor.id);
      toast(e.message || String(e));
      render();
    }
  }

  // A reaction is a kind-7 rumor on the channel stream — same envelope as a
  // message, content = the emoji. One reaction per author per message (the
  // fold keeps the latest), so picking a different emoji replaces yours;
  // tapping an existing chip joins that vote. Optimistic like sendMessage:
  // the chip appears immediately, the wire catches up.
  const REACT_EMOJIS = ['👍', '❤️', '😂', '🔥', '🎉', '🙏'];
  // The full picker behind the quick row: a searchable grid. Names are the
  // search terms; the list is curated rather than the whole Unicode table,
  // which is plenty for a reaction and keeps the bundle small.
  const EMOJI_LIB = `👀 eyes seen look|👍 thumbs up like yes|👎 thumbs down no|❤️ heart love red|🧡 orange heart|💛 yellow heart|💚 green heart|💙 blue heart|💜 purple heart|🖤 black heart|🤍 white heart|💔 broken heart|❤️‍🔥 heart fire|💯 100 hundred|😂 laugh joy tears|🤣 rofl laughing|😀 grin smile|😄 smile happy|😁 beaming grin|😅 sweat smile|😊 blush smile|🙂 slight smile|😉 wink|😍 heart eyes love|🥰 smiling hearts love|😘 kiss blow|😗 kiss|🤩 star struck wow|🥳 party celebrate|😎 cool sunglasses|🤓 nerd glasses|🧐 monocle thinking|🤔 thinking hmm|🤨 raised eyebrow skeptical|😐 neutral meh|😑 expressionless|😶 no mouth silent|🙄 eye roll|😏 smirk|😒 unamused|😞 disappointed sad|😔 pensive sad|😟 worried|😕 confused|🙁 frown sad|☹️ frowning sad|😢 cry tear sad|😭 sob crying|😤 huff steam angry|😠 angry|😡 rage furious|🤬 swearing cursing|🤯 mind blown exploding|😳 flushed embarrassed|🥺 pleading puppy eyes|😱 scream fear|😨 fearful|😰 anxious sweat|😥 sad relieved|😓 downcast sweat|🤗 hug|🤭 hand over mouth giggle|🤫 shush quiet|🤥 lying|😬 grimace awkward|😴 sleeping zzz|🤤 drooling|😪 sleepy|😷 mask sick|🤒 thermometer sick|🤕 bandage hurt|🤢 nauseated|🤮 vomit|🤧 sneeze|🥵 hot|🥶 cold freezing|🥴 woozy|😵 dizzy|😵‍💫 spiral dizzy|🤠 cowboy|🥸 disguise|😇 halo angel innocent|🤡 clown|👻 ghost|💀 skull dead|☠️ skull crossbones|👽 alien|🤖 robot|💩 poop|🙈 see no evil monkey|🙉 hear no evil|🙊 speak no evil|👋 wave hello bye|🤚 raised back hand|✋ raised hand stop|🖐️ hand fingers|🖖 vulcan spock|👌 ok perfect|🤌 pinched fingers italian|🤏 pinch small|✌️ peace victory|🤞 fingers crossed luck|🤟 love you gesture|🤘 rock horns|🤙 call me shaka|👈 point left|👉 point right|👆 point up|👇 point down|☝️ index up|👊 fist punch|✊ raised fist|🤛 left fist|🤜 right fist|👏 clap applause|🙌 raised hands hooray|🤲 palms up|🤝 handshake deal|🙏 pray thanks please|💪 muscle strong flex|🫡 salute|🫶 heart hands|🧠 brain smart|👑 crown king|🎩 top hat|🔥 fire lit hot|✨ sparkles|⭐ star|🌟 glowing star|💫 dizzy star|⚡ lightning zap bolt|💥 boom collision|💢 anger|💦 sweat drops|💨 dash wind|🎉 party popper tada|🎊 confetti|🎈 balloon|🎁 gift present|🏆 trophy win|🥇 gold medal first|🎯 bullseye target|🚀 rocket launch moon|🛸 ufo|🌙 moon|☀️ sun|🌈 rainbow|☕ coffee|🍺 beer|🍻 cheers beers|🥂 clink champagne|🍾 champagne bottle|🍕 pizza|🍔 burger|🍿 popcorn|🎂 cake birthday|🍰 cake slice|🍩 donut|🍪 cookie|🍎 apple|🥑 avocado|🌶️ hot pepper spicy|🧂 salt|🐐 goat|🐶 dog|🐱 cat|🐸 frog pepe|🐵 monkey|🦄 unicorn|🐝 bee|🦋 butterfly|🐢 turtle slow|🐍 snake|🦀 crab|🐋 whale|🦈 shark|🦅 eagle|🐔 chicken|🐷 pig|🐮 cow|🐻 bear|🐼 panda|🐨 koala|🦁 lion|🐯 tiger|🦊 fox|🐺 wolf|🐉 dragon|🌹 rose|🌻 sunflower|🌱 seedling grow|🌲 tree|🍀 clover luck|🍄 mushroom|💎 gem diamond|💰 money bag|💸 money wings|💵 dollar cash|🪙 coin|₿ bitcoin btc|🏦 bank|📈 chart up stonks|📉 chart down|🔑 key|🔒 lock|🔓 unlock|🛡️ shield|⚔️ swords|🗡️ dagger|🔨 hammer|🔧 wrench|⚙️ gear settings|🧲 magnet|💡 idea bulb|🔦 flashlight|🔋 battery|📱 phone|💻 laptop|🖥️ desktop|⌨️ keyboard|🖨️ printer|📷 camera|📸 flash camera|🎥 movie camera|🎬 clapper|🎵 music note|🎶 notes music|🎤 microphone|🎧 headphones|🎸 guitar|🎮 game controller|🎲 dice|🧩 puzzle|♟️ chess|🏀 basketball|⚽ soccer football|🏈 football|⚾ baseball|🎾 tennis|🏐 volleyball|🏓 ping pong|🥊 boxing|🏄 surf|🚴 bike|🏃 run|🧘 yoga meditate|🛌 bed sleep|🚗 car|🚕 taxi|🚌 bus|🚂 train|✈️ plane travel|⛵ sailboat|🚢 ship|🏠 house home|🏢 office|🏗️ construction crane|🗽 statue liberty|🗼 tower|🏔️ mountain|🏖️ beach|🌍 earth globe world|🗺️ map|🧭 compass|⏰ alarm clock|⏳ hourglass|⌛ hourglass done|📅 calendar|📌 pin|📎 paperclip|✂️ scissors|📝 memo note|📚 books|📖 book|📰 newspaper|✉️ envelope mail|📬 mailbox|📦 package box|🏷️ label tag|🔔 bell notification|🔕 bell off mute|📣 megaphone|📢 loudspeaker|💬 speech bubble|💭 thought bubble|🗯️ anger bubble|✅ check yes done|❌ cross no wrong|❓ question|❗ exclamation|‼️ double exclamation|⁉️ interrobang|⚠️ warning|🚫 prohibited|♻️ recycle|✔️ check mark|➕ plus|➖ minus|➗ divide|✖️ multiply|🔁 repeat|🔀 shuffle|▶️ play|⏸️ pause|⏹️ stop|⏩ fast forward|⏪ rewind|🔝 top|🆕 new|🆒 cool|🆓 free|🆗 ok|🔞 18 adult|🅰️ a|🅱️ b|🆎 ab|🅾️ o|🔴 red circle|🟠 orange circle|🟡 yellow circle|🟢 green circle|🔵 blue circle|🟣 purple circle|⚫ black circle|⚪ white circle|🟥 red square|🟧 orange square|🟨 yellow square|🟩 green square|🟦 blue square|🟪 purple square|⬛ black square|⬜ white square|🏁 checkered flag finish|🚩 red flag|🏳️ white flag|🏴‍☠️ pirate flag|🇨🇦 canada|🇺🇸 usa america|🇬🇧 uk britain|🇪🇺 eu europe|🇯🇵 japan|🇧🇷 brazil|🇩🇪 germany|🇫🇷 france|🇮🇹 italy|🇪🇸 spain|🇲🇽 mexico|🇦🇺 australia|🇸🇻 el salvador|🇦🇷 argentina|🇳🇬 nigeria|🇮🇳 india|🇨🇳 china|🇰🇷 korea|🇷🇺 russia|🇺🇦 ukraine|🇵🇹 portugal|🇳🇱 netherlands|🇸🇪 sweden|🇨🇭 switzerland`
    .split('|').map((x) => { const i = x.indexOf(' '); return { e: x.slice(0, i), k: x.slice(i + 1) }; });
  const RECENT_KEY = 'btc-wallet-recent-emoji';
  const recentEmojis = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; } };
  const noteRecent = (e) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([e, ...recentEmojis().filter((x) => x !== e)].slice(0, 24))); } catch {} };
  // The reaction row for a sheet: recents lead the quick row, and the last
  // button opens the full picker in place — a search box and the grid.
  // A picker entry: `e` is what gets sent (a character, or `:code:` for a
  // custom emoji, which then carries `url`), `k` what search matches.
  const emojiEntry = (e) => {
    const code = shortcodeOf(e);
    if (!code) return { e, k: '' };
    const url = emojiUrl(code);
    return url ? { e, k: code.toLowerCase(), url } : null; // a recent whose pack is gone
  };
  const emojiFace = (x) => (x.url ? emojiImg(shortcodeOf(x.e), x.url) : x.e);
  function reactRow(myReact, onPick) {
    const pick = (e) => { ui.emojiPick = null; noteRecent(e); onPick(e); };
    if (ui.emojiPick) {
      const q = (ui.emojiPick.q || '').trim().toLowerCase();
      // custom emoji lead — packs you hold, then ones you've seen — and the
      // standard set follows; a search matches shortcodes and keywords alike
      const custom = customEmojis().map((x) => ({ e: ':' + x.code + ':', k: x.code.toLowerCase(), url: x.url }));
      const std = EMOJI_LIB;
      let hits;
      if (q) hits = [...custom.filter((x) => x.k.includes(q)), ...std.filter((x) => x.k.includes(q) || x.e === q)];
      else hits = [...recentEmojis().map(emojiEntry).filter(Boolean), ...custom, ...std];
      const seen = new Set();
      hits = hits.filter((x) => !seen.has(x.e) && seen.add(x.e));
      const s = emojiSt();
      const packs = s.order.map((addr) => ({ addr, ...s.packs[addr] })).filter((p) => p.title !== undefined);
      return h('div', { class: 'col', style: 'gap:8px' },
        h('input', {
          type: 'text', placeholder: t('msgEmojiSearch'), value: ui.emojiPick.q || '', autofocus: true,
          onInput: (e) => { ui.emojiPick.q = e.target.value; render(); },
          onKeydown: (e) => { if (e.key === 'Enter' && hits.length) pick(hits[0].e); if (e.key === 'Escape') { ui.emojiPick = null; render(); } },
        }),
        h('div', { class: 'emoji-grid' },
          hits.slice(0, 200).map((x) => h('button', { class: x.e === myReact ? 'on' : '', title: x.url ? x.e : x.k, onClick: () => pick(x.e) }, emojiFace(x))),
          !hits.length ? h('div', { class: 'small muted', style: 'padding:8px' }, t('msgEmojiNone')) : null),
        // the packs behind the custom ones, and the way to add another —
        // Vector's share link or a bare naddr, both land the same set
        h('div', { class: 'emoji-packs' },
          packs.map((p) => h('span', { class: 'chat-react emoji-pack', title: p.addr },
            p.image ? h('img', { class: 'cemoji', src: p.image, alt: '' }) : null, ' ', p.title || '…',
            // its share link, ours: a tap on a phone opens the coinos app
            h('button', {
              type: 'button', class: 'linklike', title: t('msgEmojiPackShare'),
              onClick: async () => { try { await navigator.clipboard.writeText(packShareLink(p.addr)); toast(t('copied')); } catch {} },
            }, '⧉'),
            h('button', { type: 'button', class: 'linklike', title: t('msgEmojiPackRemove'), onClick: () => removePack(p.addr) }, '×'))),
          ui.emojiPick.addPack
            ? h('form', {
                class: 'row gap6', style: 'width:100%',
                onSubmit: async (e) => {
                  e.preventDefault();
                  const inp = e.target.querySelector('input');
                  if (await addPack(inp.value)) { ui.emojiPick.addPack = false; render(); }
                },
              },
                h('input', { type: 'text', class: 'grow', placeholder: t('msgEmojiPackHint'), autofocus: true, autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false' }),
                h('button', { class: 'btn-sm', type: 'submit', disabled: !!ui.emojiBusy }, ui.emojiBusy ? h('span', { class: 'spinner sm' }) : t('msgEmojiPackAdd')))
            : h('button', { type: 'button', class: 'linklike small', onClick: () => { ui.emojiPick.addPack = true; render(); } }, '+ ' + t('msgEmojiAddPack'))));
    }
    const quick = [...new Set([...recentEmojis(), ...REACT_EMOJIS])].map(emojiEntry).filter(Boolean).slice(0, 6);
    return h('div', { class: 'msg-sheet-emojis' },
      quick.map((x) => h('button', { class: x.e === myReact ? 'on' : '', onClick: () => pick(x.e) }, emojiFace(x))),
      h('button', { class: 'more', title: t('msgEmojiMore'), onClick: () => { ui.emojiPick = { q: '' }; render(); } }, '＋'));
  }
  async function sendReaction(room, chId, m, emoji) {
    const id = await identity();
    if (!id) { noIdToast(); return; }
    ui.msgSheet = null;
    const { created_at, ms } = msTags(Date.now());
    const rumor = rumorWithId({
      kind: 7, pubkey: id.pubkey, content: emoji,
      // NIP-25 shape per CORD examples §2.3: e = the message, p = ITS AUTHOR,
      // k = its kind. Vector refuses a reaction without the p tag, so ours
      // never showed there until it was added.
      tags: [['channel', chId], ['epoch', String(room.chEpoch(chId))], ['e', m.rumor.id], ['p', m.author], ['k', '9'], ...reactEmojiTags(emoji), ms], created_at,
    });
    const r = room.reactions.get(m.rumor.id) || room.reactions.set(m.rumor.id, new Map()).get(m.rumor.id);
    const prev = r.get(id.pubkey);
    r.set(id.pubkey, emoji);
    room.reactAt.set(m.rumor.id + '|' + id.pubkey, eventMs(rumor)); // older ones arriving later stay out
    render();
    try {
      const wrap = await wrapRumor(rumor, id.signer, room.chStream(chId));
      seenWraps.add(wrap.id); // our own echo has nothing to add
      const ok = await publishOn(room.relays, wrap);
      if (!ok) toast(t('msgSendFailed'));
    } catch (e) {
      // never went out — put back whatever stood before
      if (prev) r.set(id.pubkey, prev); else r.delete(id.pubkey);
      toast(e.message || String(e));
      render();
    }
  }

  // The displayed text of a message after its edit fold, trimmed to one line.
  const foldedRumor = (room, m) => {
    const edit = room.edits.get(m.rumor.id);
    return edit && edit.author === m.author ? edit.rumor : m.rumor;
  };
  const oneLine = (text, max = 90) => {
    const one = String(text || '').replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max - 1) + '…' : one;
  };
  function msgSnippet(room, m, max = 90) {
    return oneLine(foldedRumor(room, m).content, max);
  }
  // The snippet as nodes: its custom emoji (NIP-30 tags on the rumor) show
  // as small pictures, as they do in the bubble being quoted. The cut lands
  // on the text first, so a shortcode is never sliced in half.
  function snippetNodes(rumor, max = 90) {
    const em = emojiTagMap(rumor && rumor.tags);
    const text = oneLine(rumor && rumor.content, max + 40);
    if (!em.size) return [oneLine(text, max)];
    const out = [];
    let left = max;
    for (const p of splitEmoji(text, (c) => em.get(c))) {
      if (left <= 0) { out.push('…'); break; }
      if (typeof p === 'string') {
        if (p.length > left) { out.push(p.slice(0, Math.max(0, left - 1)) + '…'); break; }
        out.push(p); left -= p.length;
      } else { out.push(emojiImg(p.code, p.url)); left -= 2; }
    }
    return out;
  }
  const msgSnippetNodes = (room, m, max = 90) => snippetNodes(foldedRumor(room, m), max);

  // A kind-9 that e-tags another message is a REPLY — render the quoted
  // context above its text, Telegram-style. Quotes of deleted (or not-yet-
  // loaded) messages stay silent rather than resurrect them.
  function replyQuote(room, chId, m) {
    const replyId = (m.rumor.tags || []).find((x) => x[0] === 'e')?.[1];
    if (!replyId || room.deletes.has(replyId)) return null;
    const src = room.byChannel.get(chId)?.get(replyId);
    if (!src) return null;
    return h('div', { class: 'chat-quote' },
      h('span', { class: 'chat-quote-name' }, displayName(src.author)),
      h('span', { class: 'chat-quote-text' }, ...msgSnippetNodes(room, src)));
  }

  // Telegram-style message action sheet: quick reactions on top, then the
  // actions this message supports. Opened by a tap on the bubble.
  function messageSheet(room, chId) {
    const m = room.byChannel.get(chId)?.get(ui.msgSheet);
    if (!m) { ui.msgSheet = null; return null; }
    const my = myPubkeys();
    const mine = my.includes(m.author);
    const reacts = room.reactions.get(m.rumor.id);
    const myReact = reacts && my.map((pk) => reacts.get(pk)).find(Boolean);
    const close = () => { ui.msgSheet = null; ui.emojiPick = null; render(); };
    const item = (icon, label, onClick) => h('button', { class: 'msg-sheet-item', onClick },
      h('span', { class: 'msg-sheet-ico' }, icon), label);
    return h('div', {
      class: 'confirm-pop-backdrop',
      onClick: (e) => { if (e.target === e.currentTarget) close(); },
    },
      h('div', { class: 'card col msg-sheet' },
        reactRow(myReact, (e2) => { close(); sendReaction(room, chId, m, e2); }),
        ui.emojiPick ? null : item('↩', t('msgReply'), () => {
          ui.msgReplyTo = m.rumor.id;
          close();
          setTimeout(() => document.getElementById('msg-draft')?.focus(), 50);
        }),
        !ui.emojiPick && canZapPk(m.author) ? item('⚡', t('msgZap'), () => { close(); zapMessage(m.author, m.rumor.id); }) : null,
        ui.emojiPick ? null : item('⧉', t('copy'), async () => {
          try { await navigator.clipboard.writeText(msgSnippet(room, m, 100000)); toast(t('copied')); } catch {}
          close();
        }),
        !ui.emojiPick && mine ? item('✕', t('msgDelete'), () => { close(); deleteMessage(room, chId, m); }) : null));
  }

  // The composer's "replying to" context bar, with its way out.
  function replyBar(room, chId) {
    const m = ui.msgReplyTo && room.byChannel.get(chId)?.get(ui.msgReplyTo);
    if (!m) { ui.msgReplyTo = null; return null; }
    return h('div', { class: 'reply-bar' },
      h('div', { class: 'col grow', style: 'gap:1px;min-width:0' },
        h('span', { class: 'small', style: 'font-weight:650' }, '↩ ', displayName(m.author)),
        h('span', { class: 'small muted chat-quote-text' }, ...msgSnippetNodes(room, m))),
      h('button', { class: 'chat-del', style: 'position:static;display:flex;flex-shrink:0', onClick: () => { ui.msgReplyTo = null; render(); } }, '×'));
  }

  async function deleteMessage(room, chId, m) {
    const id = await identity();
    if (!id || id.pubkey !== m.author) return;
    const { created_at, ms } = msTags(Date.now());
    const rumor = {
      kind: 5, pubkey: id.pubkey, content: '',
      tags: [['channel', chId], ['epoch', String(room.chEpoch(chId))], ['e', m.rumor.id], ['k', '9'], ms], created_at,
    };
    const wrap = await wrapRumor(rumor, id.signer, room.chStream(chId));
    room.deletes.add(m.rumor.id);
    render();
    publishOn(room.relays, wrap);
    persistCache(room);
  }

  // ---- founding a community (CORD-02 genesis) -----------------------------

  async function createCommunity(name) {
    const id = await identity();
    if (!id) { noIdToast(); return; }
    name = name.trim().slice(0, 64);
    if (!name) return;
    const ownerSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const rootBytes = crypto.getRandomValues(new Uint8Array(32));
    const cid = communityId(id.pubkey, ownerSalt);
    const generalId = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const control = controlKey(rootBytes, cid, 0);
    const guestbook = guestbookKey(rootBytes, cid, 0);
    const now = Date.now();
    const relays = DM_RELAYS;
    const meta = { ...makeEdition({ vsk: 0, eid: cid, version: 1, content: JSON.stringify({ name, relays }) }, now), pubkey: id.pubkey };
    const general = { ...makeEdition({ vsk: 2, eid: generalId, version: 1, content: JSON.stringify({ name: 'general', private: false }) }, now + 1), pubkey: id.pubkey };
    const { created_at, ms } = msTags(now + 2);
    const join = { kind: 3306, pubkey: id.pubkey, content: 'join', tags: [ms], created_at };
    const events = [
      await wrapRumor(meta, id.signer, control, { plaintext: true }),
      await wrapRumor(general, id.signer, control, { plaintext: true }),
      await wrapRumor(join, id.signer, guestbook),
    ];
    for (const e of events) await publishOn(relays, e);
    const jm = {
      community_id: cid, owner: id.pubkey, owner_salt: ownerSalt,
      community_root: bytesToHex(rootBytes), root_epoch: 0,
      channels: [{ id: generalId, name: 'general' }], relays, name,
      added_at: Date.now(),
    };
    const s = st();
    s.communities.push(jm);
    (s.joined[cid] ||= {})[id.pubkey] = true;
    save(s);
    publishLists();
    registerPush().catch(() => {});
    ensureRoom(jm);
    ui.msgView = 'room';
    ui.msgCommunity = cid;
    ui.msgChannel = null;
    ui.msgNewName = '';
    ui.msgHomePanel = null;
    render();
  }

  // A new channel is one owner-signed ChannelMetadata edition (CORD-03 §2);
  // the control-plane fold picks it up and every member's switcher grows.
  async function createChannel(room, name) {
    name = (name || '').trim().slice(0, 64);
    if (!name) return;
    const id = await identity();
    if (!id || id.pubkey !== room.jm.owner) { toast(t('msgOwnerOnly')); return; }
    const chId = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    const edition = {
      ...makeEdition({ vsk: 2, eid: chId, version: 1, content: JSON.stringify({ name: name.replace(/^#/, ''), private: false }) }, Date.now()),
      pubkey: id.pubkey,
    };
    const wrap = await wrapRumor(edition, id.signer, room.control, { plaintext: true });
    const ok = await publishOn(room.relays, wrap);
    if (!ok) { toast(t('msgSendFailed')); return; }
    ui.msgNewChannel = '';
    ui.msgChannelPanel = false; // the field has done its job — put it away
    toast('#' + name.replace(/^#/, ''));
  }

  // ---- invites ------------------------------------------------------------

  function bundleFor(room, creatorPk) {
    return {
      community_id: room.jm.community_id, owner: room.jm.owner, owner_salt: room.jm.owner_salt,
      community_root: room.jm.community_root, root_epoch: room.jm.root_epoch || 0,
      ...(room.jm.control_pk ? { control_pk: room.jm.control_pk } : {}),
      channels: channelList({ ...room.jm, channels: roomChannels(room).map((c) => (room.jm.channels || []).find((h) => h.id === c.id) || c) }),
      relays: room.relays, name: (room.folded?.metadata?.name) || room.jm.name,
      creator_npub: creatorPk,
    };
  }

  // Bundles minted before channel entries carried key + epoch never opened in
  // Vector. The link itself is fine (signer + token), so re-sign the bundle at
  // the same coordinate with the current shape; the relay replaces it. Once
  // per invite per device, and again whenever the shape changes.
  const BUNDLE_REV = 2;
  async function healInviteBundles() {
    const s = st();
    for (const [cid, inv] of Object.entries(s.invites || {})) {
      if (inv.rev === BUNDLE_REV || !inv.sk || !inv.token) continue;
      const jm = communityById(cid);
      if (!jm) continue;
      try {
        const room = ensureRoom(jm, { subscribe: false });
        const creator = inv.creator || (await identity())?.pubkey;
        const evt = makeInviteBundleEvent(hexToBytes(inv.sk), bundleFor(room, creator), hexToBytes(inv.token));
        if (await publishOn(room.relays, evt)) { inv.rev = BUNDLE_REV; save(s); }
      } catch {}
    }
  }

  async function mintInviteLink(room) {
    const id = await identity();
    if (!id) { noIdToast(); return null; }
    const s = st();
    const existing = s.invites[room.jm.community_id];
    if (existing) { if (existing.rev !== BUNDLE_REV) healInviteBundles().catch(() => {}); return existing.url; }
    const linkSk = generateSecretKey();
    const token = crypto.getRandomValues(new Uint8Array(16));
    const evt = makeInviteBundleEvent(linkSk, bundleFor(room, id.pubkey), token);
    const ok = await publishOn(room.relays, evt);
    if (!ok) { toast(t('msgSendFailed')); return null; }
    const url = makeInviteLink(APP_BASE, getPublicKey(linkSk), room.relays, token);
    s.invites[room.jm.community_id] = { sk: bytesToHex(linkSk), token: bytesToHex(token), url, created_at: Math.floor(Date.now() / 1000), rev: BUNDLE_REV, creator: id.pubkey };
    save(s);
    publishLists();
    return url;
  }

  async function sendDirectInvite(room, input) {
    const peer = parseNostrPubkey(input);
    if (!peer) { toast(t('msgBadNpub')); return; }
    const id = await identity();
    if (!id) { noIdToast(); return; }
    if (!(id.signer instanceof Uint8Array) && !id.signer.encryptTo) { toast(t('msgSignerNoDm')); return; }
    const rumor = {
      kind: 3313, pubkey: id.pubkey,
      content: JSON.stringify(bundleFor(room, id.pubkey)),
      tags: [], created_at: Math.floor(Date.now() / 1000),
    };
    const wrap = await wrapDM(id.signer, peer, rumor, [['k', '3313']]);
    const inbox = (await fetchInboxRelays(peer)).slice(0, 4);
    const ok = await publishOn([...new Set([...inbox, ...DM_RELAYS])], wrap);
    toast(ok ? t('msgInviteSent') : t('msgSendFailed'));
  }

  function acceptBundle(b, { invitedBy, inviteLabel } = {}) {
    const s = st();
    if (!communityById(b.community_id)) {
      const jm = {
        community_id: b.community_id, owner: b.owner, owner_salt: b.owner_salt,
        community_root: b.community_root, root_epoch: b.root_epoch || 0,
        control_pk: b.control_pk, channels: channelList(b),
        relays: (b.relays || []).slice(0, 5), name: b.name || 'community',
        invitedBy, inviteLabel, added_at: Date.now(),
      };
      s.communities.push(jm);
      save(s);
      publishLists();
    }
    const room = ensureRoom(communityById(b.community_id));
    identity().then((id) => id && ensureJoined(room, id)).catch(() => {});
    registerPush().catch(() => {});
    ui.msgView = 'room';
    ui.msgCommunity = b.community_id;
    ui.msgChannel = null;
    ui.msgHomePanel = null;
    pendingLink = null;
    render();
  }

  // A link invite being previewed (pasted or arrived via /invite/<naddr>#…).
  let pendingLink = null; // { parsed, state: 'loading'|'ready'|'error', bundle?, error? }

  async function loadLinkInvite(parsed, { where = 'top' } = {}) {
    pendingLink = { parsed, state: 'loading', where };
    scheduleRepaint();
    const relays = [...new Set([...(parsed.relays || []), ...DM_RELAYS])];
    const evts = await queryOn(relays, { kinds: [33301], authors: [parsed.signerPk] }, 4000);
    const newest = evts.sort((a, b) => b.created_at - a.created_at)[0];
    const b = newest && openInviteBundle(newest, parsed.token);
    if (!b) pendingLink = { parsed, state: 'error', error: t('msgInviteNotFound'), where };
    else if (b.revoked) pendingLink = { parsed, state: 'error', error: t('msgInviteRevoked'), where };
    else if (b.expired) pendingLink = { parsed, state: 'error', error: t('msgInviteExpired'), where };
    else pendingLink = { parsed, state: 'ready', bundle: b, where };
    scheduleRepaint();
  }

  // ---- community discovery: the Vector Hub's public listing as suggestions
  // under Join. Fetched on demand (it's a megabyte, mostly icons) and kept
  // for the session; every listing is a CORD-05 link, which is exactly what
  // the paste box takes, so a tap previews it like a pasted invite.
  const HUB_URL = 'https://vectorapp.io/api/hub';
  const hub = { state: 'idle', list: [] };
  async function loadHub() {
    if (hub.state === 'loading' || hub.state === 'ready') return;
    hub.state = 'loading'; scheduleRepaint();
    try {
      const res = await fetch(HUB_URL, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error('http ' + res.status);
      const list = await res.json();
      hub.list = (Array.isArray(list) ? list : [])
        .filter((c) => c && c.name && parseInviteLink(c.invite_url || ''))
        .map((c) => ({
          name: String(c.name).slice(0, 64), description: String(c.description || '').slice(0, 200),
          category: String(c.category || ''), invite: c.invite_url, members: Number(c.member_count) || 0,
          icon: /^data:image\//.test(c.icon_url || '') ? c.icon_url : null, official: !!c.official,
        }))
        .sort((a, b) => b.members - a.members);
      hub.state = 'ready';
    } catch { hub.state = 'error'; }
    scheduleRepaint();
  }
  function hubRows() {
    const q = (ui.msgJoinText || '').trim().toLowerCase();
    const have = new Set(communities().map((jm) => (rooms.get(jm.community_id)?.folded?.metadata?.name || jm.name || '').toLowerCase()));
    const rows = hub.list.filter((c) => !q || [c.name, c.description, c.category].some((x) => x.toLowerCase().includes(q)));
    return rows.map((c) => h('div', {
      class: 'item chat-thread-row clickable', onClick: () => joinFromText(c.invite),
    },
      c.icon ? h('img', { class: 'chat-avatar hub-icon', src: c.icon, alt: '' }) : h('div', { class: 'chat-avatar fallback' }, c.name.slice(0, 2)),
      h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
        h('div', { class: 'row gap6', style: 'align-items:center' },
          h('span', { class: 'chat-name', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, c.name),
          have.has(c.name.toLowerCase()) ? h('span', { class: 'tag conf' }, t('msgJoined')) : null),
        h('div', { class: 'small muted', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
          (c.members ? t('msgMembers', { n: c.members }) + ' · ' : '') + c.category + (c.description ? ' · ' + c.description : '')))));
  }

  function joinFromText(text) {
    const parsed = parseInviteLink(text);
    if (!parsed) { toast(t('msgBadInvite')); return; }
    ui.msgJoinText = '';
    ui.msgHomePanel = null;
    // the answer belongs where the question was asked: the preview replaces
    // the paste box under Communities, not a card at the top of a page the
    // user may have scrolled past
    loadLinkInvite(parsed, { where: 'communities' });
  }

  // An invite link opened in the browser lands here before the wallet exists.
  const urlInvite = typeof location !== 'undefined' ? parseInviteLink(location.href) : null;
  if (urlInvite) { try { history.replaceState(null, '', '/'); } catch {} }
  // coinos's own pack share link, /emojis/pack/<naddr> — the Android app
  // owns every v3.coinos.io path, so one tapped on a phone lands here, not
  // in a browser; added once a wallet is open (init below).
  const urlPack = (() => {
    if (typeof location === 'undefined') return null;
    const m = location.pathname.match(/^\/emojis\/pack\/(naddr1[a-z0-9]+)\/?$/i);
    return m && parsePackRef(m[1]) ? m[1] : null;
  })();
  if (urlPack) { try { history.replaceState(null, '', '/'); } catch {} }

  // coinos.io/<username> parity: a claimed name (or a raw npub / hex key) as
  // the whole URL path deep-links to that profile. Real files never reach the
  // app — the server tries them first — and gift/invite links carry their own
  // multi-segment paths, which this single-segment shape can't match. The
  // path is consumed immediately so a reload lands on the wallet as usual.
  const urlProfile = (() => {
    if (typeof location === 'undefined' || urlInvite) return null;
    const m = location.pathname.match(/^\/([A-Za-z0-9._-]{1,64})\/?$/);
    // reserved app routes are never usernames — /chat is the public
    // community page (app.js routes it), and eating it here rewrote the URL
    // to / before that route ever saw it; a note reference is its own link
    if (m && (['chat', 'pos'].includes(m[1]) || /^(note|nevent|naddr)1/i.test(m[1]))) return null;
    return m ? m[1] : null;
  })();
  if (urlProfile) { try { history.replaceState(null, '', '/'); } catch {} }
  // /note1… and /nevent1… open the thread the same way — the NIP-89 handler
  // event for coinos points njump and friends here for notes, /<npub> for
  // people. Public content: shown over the front door without a wallet.
  const urlNote = (() => {
    if (typeof location === 'undefined' || urlInvite || urlProfile) return null;
    const m = location.pathname.match(/^\/((?:note|nevent)1[a-z0-9]+)\/?$/i);
    const ref = m ? parseNostrRef(m[1].toLowerCase()) : null;
    return ref && ref.type === 'event' ? ref : null;
  })();
  // The app's history already holds this exact thread on a reload. Leave its
  // state and URL intact so wallet restore can paint the header and thread
  // together; the public deep-link path is only for a NEW visit.
  const restoringUrlThread = (() => {
    try { return !!urlNote && history.state?.nav?.noteThread?.focusId === urlNote.id; } catch { return false; }
  })();
  if (urlNote && !restoringUrlThread) {
    try { history.replaceState(null, '', '/'); } catch {}
    ui.pubProf = true;
    // a reload of a thread the history restores by itself needs no fetch
    setTimeout(() => { if (ui.noteThread && ui.noteThread.focusId === urlNote.id) return; openNoteRef(urlNote).catch(() => {}); }, 0);
  }

  // Resolve and open right away — not in init(), which only runs once a
  // wallet opens (and would replay on every wallet born in this tab). For a
  // visitor with no wallet the profile renders as a truly public page over
  // the unlock screen (ui.pubProf gates that surface) — nostr profiles are
  // public data, and Back lands on the app's own front door.
  if (urlProfile) {
    // Claim the first paint synchronously: these are set before the boot
    // render, so the visitor sees a profile shell from the first frame —
    // never a flash of the front door while the registrar lookup runs.
    ui.pubProf = true;
    ui.pubProfPending = urlProfile;
    (async () => {
      await new Promise((r) => setTimeout(r, 0)); // never render mid-boot
      let pk = parseNostrPubkey(urlProfile);
      if (!pk && /^[a-z0-9._-]{1,30}$/i.test(urlProfile)) {
        // same registrar + domain rule the names feature uses
        const domain = getNetwork() === 'mutinynet' ? 'staging.coinos.io' : 'coinos.io';
        const name = urlProfile.toLowerCase();
        try {
          const j = await fetch(`https://names.coinos.io/.well-known/nostr.json?name=${encodeURIComponent(name)}&domain=${domain}`)
            .then((r) => r.json());
          pk = (j.names || {})[name] || null;
        } catch {}
        // The username is real display material: seed the light cache (stale,
        // t:0, so the kind 0 still gets fetched) and the page paints the name
        // immediately instead of an npub prefix. `loading` keeps the avatar a
        // quiet circle meanwhile — punk art must mean "has no picture", never
        // "picture not here yet", or the wrong face flashes before the real
        // one loads.
        if (pk && /^[0-9a-f]{64}$/.test(pk)) {
          warmProfiles();
          if (!profiles.has(pk)) profiles.set(pk, { name, addr: `${name}@${domain}`, t: 0, loading: true });
        }
      }
      if (pk && /^[0-9a-f]{64}$/.test(pk)) {
        // hold the pinned nav key across this render: the profile replaces
        // the shell in place, with no page-slide re-animation
        ui.pubProfHold = true;
        ui.pubProfPending = null;
        if (ui.screen === 'wallet') ui.pubProf = null; // wallet chrome owns it
        openProfile(pk);
        ui.pubProfHold = null;
      } else {
        ui.pubProfPending = null;
        ui.pubProf = null; // unknown name: fall through to the front door
        render();
      }
    })();
  }

  // ---- push notifications -------------------------------------------------
  // The nwcpush notifier watches relays for what it can see without keys:
  // kind-1059 wraps p-tagged at us (DMs, direct invites), zap receipts
  // (payments), and wraps authored by our communities' channel keys (chat).
  // It pushes a typed nudge; the service worker shows a generic notification
  // unless a window is visible. Payment pushes also arrive server-to-server
  // from the names registrar when a lightning-address receive settles.

  const b64ToBytes = (b64) => {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };

  // What the notifier is allowed to wake us for. Communities are opt-in and
  // off by default: a busy room would otherwise buzz a phone all day for
  // conversations that aren't addressed to anyone in particular.
  function pushWatch() {
    const s = st();
    const on = s.notify;
    const authors = [];
    for (const jm of communities()) {
      if (!on[jm.community_id]) continue;
      const root = hexToBytes(jm.community_root);
      for (const c of (jm.channels || []).slice(0, 8)) authors.push(channelStream(jm, c).pk);
    }
    // per-category opt-outs travel with the registration so the notifier
    // never sends what the user turned off (a suppressed-but-delivered push
    // would earn Chrome's generic "updated in background" nag instead)
    const reasons = { payment: s.reasons?.payment !== false, dm: s.reasons?.dm !== false, mention: s.reasons?.mention !== false };
    // Stamp the network: the same seed makes the same nostr pubkey on mainnet
    // AND staging, so without this the notifier fans a mainnet payment push
    // out to the staging PWA's subscription too — and tapping it opened
    // staging. The notifier now delivers a payment only to registrations on
    // the payment's own network.
    return { ptags: myPubkeys(), authors, reasons, net: getNetwork() };
  }

  const roomNotify = (cid) => !!st().notify[cid];
  async function toggleRoomNotify(cid) {
    const s = st();
    if (s.notify[cid]) delete s.notify[cid]; else s.notify[cid] = true;
    save(s);
    render();
    // The server keeps the watch list, so the change only lands once we
    // re-register. Asking for permission is fair here — they just opted in.
    const ok = await registerPush({ interactive: !!s.notify[cid] });
    if (!ok && s.notify[cid]) {
      const s2 = st();
      delete s2.notify[cid];
      save(s2);
      toast(t('msgPushFailed'));
      render();
    }
  }

  // Settings → Notifications: the master switch for this device plus the
  // per-category choices the registration carries to the notifier.
  function notifyCard() {
    const supported = typeof Notification !== 'undefined'
      && typeof navigator !== 'undefined' && 'serviceWorker' in navigator
      && typeof window !== 'undefined' && 'PushManager' in window;
    const perm = supported ? Notification.permission : 'unsupported';
    const s = st();
    const on = (k) => s.reasons?.[k] !== false;
    const flip = async (k) => {
      const s2 = st();
      s2.reasons = { ...(s2.reasons || {}), [k]: !on(k) };
      save(s2); render();
      const ok = await registerPush({ interactive: true });
      if (!ok) toast(t('msgPushFailed'));
    };
    const rowT = (label, k) => h('div', { class: 'row between' },
      h('span', { class: 'small' }, label),
      h('button', { class: 'btn-sm', onClick: () => flip(k) }, on(k) ? t('nwcOn') : t('nwcOff')));
    return h('div', { class: 'card col', style: 'gap:10px' },
      h('h3', { style: 'margin:0' }, t('notifTitle')),
      !supported
        ? h('div', { class: 'small faint' }, t('nwcNoPush'))
        : perm === 'denied'
          ? h('div', { class: 'notice err' }, t('nwcNotifBlocked'))
          : perm !== 'granted' || !s.push
            ? h('button', { class: 'btn-primary btn-block', onClick: async () => {
                const ok = await registerPush({ interactive: true });
                toast(ok ? t('notifEnabled') : t('msgPushFailed'));
                render();
              } }, t('notifEnable'))
            : h('div', { class: 'small faint' }, t('notifOnDevice')),
      rowT(t('notifPayRecv'), 'payment'),
      rowT(t('notifDm'), 'dm'),
      rowT(t('notifMention'), 'mention'),
      h('div', { class: 'small faint' }, t('notifChatHint')));
  }

  // Hand the service worker what it needs to tell a friend's DM from a
  // stranger's: our key (only if we actually hold one), who we follow, and the
  // names we already know. See dm-inbox.js for the threat model — a remote
  // signer stores no key here and simply gets unfiltered notifications.
  let inboxAt = 0;
  async function syncInbox({ force = false } = {}) {
    if (!force && Date.now() - inboxAt < 5 * 60_000) return;
    inboxAt = Date.now();
    try {
      const id = await identity();
      if (!id) return;
      const evs = await queryOn([...new Set([...PROFILE_RELAYS, ...DM_RELAYS])],
        { kinds: [3], authors: [id.pubkey] }, 4000);
      const newest = evs.sort((a, b) => b.created_at - a.created_at)[0];
      const follows = newest
        ? [...new Set(newest.tags.filter((x) => x[0] === 'p' && /^[0-9a-f]{64}$/.test(x[1] || '')).map((x) => x[1]))]
        : [];
      const known = [...threads.keys()];
      const names = {};
      for (const pk of [...follows, ...known]) {
        const p = profiles.get(pk);
        if (p && p.name) names[pk] = p.name;
      }
      await saveInbox(wallet._cacheKey(), {
        pubkey: id.pubkey,
        sk: id.signer instanceof Uint8Array ? bytesToHex(id.signer) : null,
        follows, known, names, hasList: !!newest, updated: Date.now(),
        muted: [...mutesNow().set], // no buzz from a muted sender either
      });
    } catch { inboxAt = 0; }
  }

  // The Android wrapper hands us a UnifiedPush endpoint on its launch URL
  // (?up=), because the distributor talks to the app and only the web app
  // knows which pubkeys are worth watching. On a phone without Google Play
  // Services this is the ONLY way to be reached while closed, so it takes
  // precedence over the browser's own push — which there doesn't work at all.
  const UP_KEY = 'coinos-unifiedpush';
  const upEndpoint = () => { try { return localStorage.getItem(UP_KEY) || null; } catch { return null; } };
  (() => {
    try {
      const u = new URLSearchParams(location.search).get('up');
      if (!u) return;
      localStorage.setItem(UP_KEY, u);
      // tidy the URL the way the payment intent does
      history.replaceState(null, '', location.pathname || '/');
    } catch {}
  })();

  // What to tell someone whose phone can't be woken. In a browser that's
  // "your browser has no push service"; inside the UnifiedPush build of the
  // Android app it's about the distributor, because that build IS the push —
  // telling a WebView to go and use Firefox would be nonsense.
  function pushAdvice() {
    const env = hostEnv();
    if (!env || env.app !== 'graphene') return t('nwcNoPushService');
    if (!env.distributors) return t('upNoDistributor');
    if (!env.endpoint) return t('upWaiting', { app: (env.distributor || '').split('.').pop() });
    return t('nwcNoPushService');
  }
  function hostEnv() {
    try {
      const h2 = typeof window !== 'undefined' && window.CoinosHost;
      if (!h2 || typeof h2.env !== 'function') return null;
      return JSON.parse(h2.env());
    } catch { return null; }
  }

  async function registerPush({ interactive = false } = {}) {
    try {
      // A UnifiedPush endpoint needs no permission and no push service: it's
      // a URL the distributor gave the wrapper, and the notifier POSTs to it.
      const up = upEndpoint();
      if (up) {
        const r = await fetch(`${NOTIFIER}/register`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ subscription: { endpoint: up, unifiedpush: true }, notify: pushWatch() }),
        });
        if (!r.ok) return false;
        const s2 = st();
        if (!s2.push || s2.noPushService) { s2.push = true; delete s2.noPushService; save(s2); }
        return true;
      }
      if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
      if (Notification.permission !== 'granted') {
        if (!interactive) return false;
        if ((await Notification.requestPermission()) !== 'granted') return false;
      }
      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await (await fetch(`${NOTIFIER}/vapid`)).json();
      const wantKey = b64ToBytes(publicKey);
      let sub = await reg.pushManager.getSubscription();
      // see nwc.js: a Chromium without Google Play Services (GrapheneOS, and
      // any de-Googled Android) has no push service at all, and says so in a
      // way nobody can act on. Remember it so the offer can explain itself.
      const noPushService = (e) => /push service|Registration failed|AbortError|NotSupportedError/i.test((e && (e.message || e.name)) || '');
      // A subscription made against a DIFFERENT VAPID key can never receive a
      // push — the notifier's sends fail with a permanent 403 and it keeps
      // reusing the dead sub, so the device goes silent forever (this is what
      // stranded notifications after the key last rotated). Re-subscribe when
      // the existing sub's server key doesn't match the current one.
      const keyMatches = (s) => {
        try {
          const cur = new Uint8Array(s.options.applicationServerKey || []);
          return cur.length === wantKey.length && cur.every((b, i) => b === wantKey[i]);
        } catch { return false; }
      };
      if (sub && !keyMatches(sub)) { try { await sub.unsubscribe(); } catch {} sub = null; }
      if (!sub) {
        try {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: wantKey });
        } catch (e) {
          if (noPushService(e)) { const s2 = st(); s2.noPushService = true; save(s2); render(); }
          return false;
        }
      }
      { const s2 = st(); if (s2.noPushService) { delete s2.noPushService; save(s2); } }
      const r = await fetch(`${NOTIFIER}/register`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), notify: pushWatch() }),
      });
      if (!r.ok) return false;
      const s = st();
      if (!s.push) { s.push = true; save(s); }
      return true;
    } catch {
      return false;
    }
  }

  // ---- device sync: Community List (13302) + Invite List (13303) ----------
  // Self-encrypted replaceables (CORD-02 §8 / CORD-05 §4) so memberships and
  // minted link keys follow the user to any device or client. Published under
  // every identity we can encrypt for: the wallet key is the cross-device
  // constant (same seed on every device), the login npub makes the list
  // readable by other Concord clients serving the same identity.

  async function selfCryptors() {
    const out = [];
    if (wallet.nostr && wallet.nostr.sk && wallet.nostr.ck) out.push({
      pk: wallet.nostr.pk,
      sign: async (e) => finalizeEvent(e, wallet.nostr.sk),
      enc: async (txt) => nip44.encrypt(txt, wallet.nostr.ck),
      dec: async (ct) => nip44.decrypt(ct, wallet.nostr.ck),
    });
    const login = hook('nostrLoginIdentity');
    if (login && login.signer && login.signer.encryptSelf) out.push({
      pk: login.pubkey,
      sign: (e) => login.signer.signEvent(e),
      enc: (txt) => login.signer.encryptSelf(txt),
      dec: (ct) => login.signer.decryptSelf(ct),
    });
    return out;
  }

  // The channel entries of join material: id + name, plus key + epoch for a
  // private channel (a public one derives from the root, so nothing to carry).
  // Every entry carries key + epoch on the wire (CORD-05 §1 `{id, key, epoch,
  // name}`): a public channel's key IS the community_root at the base epoch.
  // Vector's parser has no default for either field, so an entry without them
  // fails its whole bundle — which is why our invite links never opened there.
  const channelList = (b) => (b.channels || []).slice(0, 256).map((c) =>
    channelIsPrivate(b, c) ? { id: c.id, name: c.name, key: c.key, epoch: c.epoch || 0 }
      : { id: c.id, name: c.name, key: b.community_root, epoch: b.root_epoch || 0 });

  // Join material subset (never the icon, never link fields). We don't
  // Refound ourselves, so seed and current coincide.
  const jmSubset = (jm) => ({
    community_id: jm.community_id, owner: jm.owner, owner_salt: jm.owner_salt,
    community_root: jm.community_root, root_epoch: jm.root_epoch || 0,
    ...(jm.control_pk ? { control_pk: jm.control_pk } : {}),
    channels: channelList(jm),
    relays: jm.relays, name: jm.name,
  });

  const buildCommunityList = (s) => JSON.stringify({
    entries: s.communities.slice(0, 50).map((jm) => ({
      community_id: jm.community_id, seed: jmSubset(jm), current: jmSubset(jm), added_at: jm.added_at || 0,
    })),
    tombstones: Object.entries(s.tombstones).map(([community_id, removed_at]) => ({ community_id, removed_at })),
  });

  const buildInviteList = (s) => JSON.stringify({
    entries: Object.entries(s.invites).map(([community_id, inv]) => ({
      token: inv.token, signer_sk: inv.sk, community_id, url: inv.url, created_at: inv.created_at || 0,
    })),
    tombstones: [],
  });

  function mergeCommunityList(doc) {
    const s = st();
    let changed = false;
    for (const tb of doc.tombstones || []) {
      if ((tb.removed_at || 0) > (s.tombstones[tb.community_id] || 0)) {
        s.tombstones[tb.community_id] = tb.removed_at;
        changed = true;
      }
    }
    for (const e of (doc.entries || []).slice(0, 50)) {
      const jm = e.current || e.seed;
      if (!jm || jm.community_id !== e.community_id) continue;
      if (jm.community_id === COMMUNITY.community_id) continue; // built-in
      if ((e.added_at || 0) <= (s.tombstones[e.community_id] || 0)) continue; // tombstone wins
      if (communityId(jm.owner, jm.owner_salt) !== jm.community_id) continue; // self-certify before adopting keys
      if (!/^[0-9a-f]{64}$/.test(jm.community_root || '')) continue;
      const have = s.communities.find((c) => c.community_id === e.community_id);
      if (have) {
        // Same community, fresher keys: a device that saw a Refounding holds
        // a higher root epoch; one that joined via a newer invite holds the
        // control_pk and channel keys this entry predates. Adopt, keep ours
        // otherwise — never step an epoch backwards.
        const newer = (jm.root_epoch || 0) > (have.root_epoch || 0);
        const fill = !newer && jm.community_root === have.community_root
          && ((jm.control_pk && !have.control_pk) || channelList(jm).some((c) => c.key && !(have.channels || []).some((h) => h.id === c.id && h.key)));
        if (!newer && !fill) continue;
        Object.assign(have, jmSubset(jm), { name: have.name || jm.name, relays: have.relays && have.relays.length ? have.relays : jm.relays });
        const stale = rooms.get(have.community_id); // rebuilt with the new keys on next open
        if (stale) { for (const u of stale.unsubs || []) { try { u(); } catch {} } rooms.delete(have.community_id); }
        changed = true;
        continue;
      }
      s.communities.push({ ...jmSubset(jm), added_at: e.added_at || Date.now() });
      changed = true;
    }
    // a tombstone newer than an entry's added_at removes it locally too
    const keep = s.communities.filter((c) => (s.tombstones[c.community_id] || 0) <= (c.added_at || 0));
    if (keep.length !== s.communities.length) { s.communities = keep; changed = true; }
    if (changed) save(s);
    return changed;
  }

  function mergeInviteList(doc) {
    const s = st();
    let changed = false;
    for (const e of doc.entries || []) {
      if (!e.token || !e.community_id || !e.signer_sk) continue;
      if (!s.invites[e.community_id]) {
        s.invites[e.community_id] = { sk: e.signer_sk, token: e.token, url: e.url, created_at: e.created_at };
        changed = true;
      }
    }
    if (changed) save(s);
    return changed;
  }

  // The list writers remember what they last sent and when. A relay that
  // refuses a copy (rate limit, ban) leaves the remote copy stale, and the
  // next sync would ask for the same write again — and again, every couple
  // of seconds, forever: that storm filled relay.coinos.io's per-IP budget
  // for a whole household, and a phone behind the same IP could no longer
  // reach its remote signer (every NIP-46 request refused as rate-limited),
  // so its DMs stopped decrypting. An unchanged document is re-sent at most
  // once per LIST_REPUBLISH_MS; a real local change is a new document and
  // goes out at once. Our own writes echoing back on the live subscription
  // are not news either.
  const LIST_REPUBLISH_MS = 5 * 60_000;
  const lastListWrite = new Map(); // 'lists' | 'frags' -> { key, at }
  const ownListIds = new Set();
  function listWriteDue(what, key) {
    const prev = lastListWrite.get(what);
    if (prev && prev.key === key && Date.now() - prev.at < LIST_REPUBLISH_MS) return false;
    lastListWrite.set(what, { key, at: Date.now() });
    return true;
  }
  async function publishLists() {
    const ids = await selfCryptors();
    const s = st();
    publishFragments(ids, fragAt).catch(() => {});
    const docs = [[13302, buildCommunityList(s)], [13303, buildInviteList(s)]];
    if (!listWriteDue('lists', ids.map((i) => i.pk).join() + '|' + docs.map(([k, d]) => k + ':' + d).join('|'))) return;
    for (const id of ids)
      for (const [kind, doc] of docs) {
        try {
          const evt = await id.sign({
            kind, content: await id.enc(doc), tags: [], created_at: Math.floor(Date.now() / 1000),
          });
          ownListIds.add(evt.id);
          publishOn(DM_RELAYS, evt);
        } catch {}
      }
  }

  // ---- CORD-02 §8 fragmented Community List (kind 33302) ----
  // The form Vector and the other Concord clients write: addressable, one
  // event per fragment (d = index, every fragment declares the total), the
  // content NIP-44-encrypted to self, every 32-byte value unpadded base64url,
  // an entry's embedded join material carrying no community_id (it inherits
  // the entry's) and no seed when it equals current. Reading it is what lets
  // a community joined in Vector under the same key show up here; writing it
  // is what lets Vector see one joined here. The retired single-event 13302
  // is still read and written for older coinos devices.
  const LIST_FRAG_KIND = 33302;
  const STOCK_RELAYS = ['wss://jskitty.com/nostr', 'wss://asia.vectorapp.io/nostr', 'wss://relay.ditto.pub', 'wss://relay.dreamith.to'];
  const LIST_FRAG_BYTES = 48 * 1024;
  const b64of = (v) => (/^[0-9a-f]{64}$/i.test(v || '') ? base64urlnopad.encode(hexToBytes(v.toLowerCase())) : v);
  const hexOf = (v) => {
    if (typeof v !== 'string' || v.length !== 43) return v;
    try { const b = base64urlnopad.decode(v); return b.length === 32 ? bytesToHex(b) : v; } catch { return v; }
  };
  // where a list can live: our relays, the stock CORD set (where Vector's
  // lands when its own relays refuse the kind), and every held community's
  const listRelays = () => [...new Set([...DM_RELAYS, ...STOCK_RELAYS, ...communities().flatMap((jm) => jm.relays || [])])].slice(0, 12);
  const fragMaterial = (jm) => {
    const m = jmSubset(jm);
    return {
      owner: b64of(m.owner), owner_salt: b64of(m.owner_salt), community_root: b64of(m.community_root), root_epoch: m.root_epoch || 0,
      ...(m.control_pk ? { control_pk: b64of(m.control_pk) } : {}),
      channels: (m.channels || []).map((c) => ({ id: b64of(c.id), key: b64of(c.key || m.community_root), epoch: c.epoch || 0, name: c.name })),
      relays: m.relays || [], name: m.name,
    };
  };
  const buildFragments = (s) => {
    const entries = s.communities.filter((jm) => (s.tombstones[jm.community_id] || 0) <= (jm.added_at || 0))
      .map((jm) => ({ community_id: b64of(jm.community_id), current: fragMaterial(jm), added_at: jm.added_at || 0 }));
    const tombstones = Object.entries(s.tombstones).map(([community_id, removed_at]) => ({ community_id: b64of(community_id), removed_at }));
    const frags = [{ frags: 1, entries: [], tombstones: [] }];
    const size = (f) => JSON.stringify(f).length;
    for (const e of entries) {
      const last = frags[frags.length - 1];
      if (!last.entries.length || size(last) + JSON.stringify(e).length < LIST_FRAG_BYTES) last.entries.push(e);
      else frags.push({ frags: 1, entries: [e], tombstones: [] });
    }
    for (const t of tombstones) {
      const last = frags[frags.length - 1];
      if (!last.tombstones.length || size(last) + JSON.stringify(t).length < LIST_FRAG_BYTES) last.tombstones.push(t);
      else frags.push({ frags: 1, entries: [], tombstones: [t] });
    }
    for (const f of frags) f.frags = frags.length;
    return frags;
  };
  const unmaterial = (m, cid) => ({
    community_id: cid, owner: hexOf(m.owner), owner_salt: hexOf(m.owner_salt), community_root: hexOf(m.community_root),
    root_epoch: Number(m.root_epoch) || 0, ...(m.control_pk ? { control_pk: hexOf(m.control_pk) } : {}),
    channels: (m.channels || []).map((c) => ({ id: hexOf(c.id), ...(c.key ? { key: hexOf(c.key) } : {}), epoch: Number(c.epoch) || 0, name: c.name })),
    relays: Array.isArray(m.relays) ? m.relays : [], name: m.name || '',
  });
  // the fragments a reader holds, unioned into the 13302-shaped document
  const defragment = (frags) => {
    const doc = { entries: [], tombstones: [] };
    for (const f of frags) {
      for (const e of f.entries || []) {
        if (!e || !e.current) continue;
        const cid = hexOf(e.community_id);
        const current = unmaterial(e.current, cid);
        doc.entries.push({ community_id: cid, seed: e.seed ? unmaterial(e.seed, cid) : current, current, added_at: Number(e.added_at) || 0 });
      }
      for (const t of f.tombstones || []) doc.tombstones.push({ community_id: hexOf(t.community_id), removed_at: Number(t.removed_at) || 0 });
    }
    return doc;
  };
  // Fetch one identity's fragments: newest per index wins (an age tie falls to
  // the lower id), the newest fragment's declared total governs, and each
  // index's created_at is kept so a rewrite can exceed it.
  async function readFragments(id, evs) {
    const newest = new Map();
    for (const e of evs) {
      if (e.kind !== LIST_FRAG_KIND || e.pubkey !== id.pk) continue;
      const idx = parseInt(e.tags.find((t) => t[0] === 'd')?.[1], 10);
      if (!(idx >= 0)) continue;
      const cur = newest.get(idx);
      if (!cur || e.created_at > cur.created_at || (e.created_at === cur.created_at && e.id < cur.id)) newest.set(idx, e);
    }
    const frags = new Map(); const createdAt = {};
    for (const [idx, e] of newest) {
      try { const f = JSON.parse(await id.dec(e.content)); if (f && typeof f === 'object') { frags.set(idx, f); createdAt[idx] = e.created_at; } } catch {}
    }
    if (!frags.size) return null;
    let top = null; for (const [idx, f] of frags) if (!top || createdAt[idx] > createdAt[top] || (createdAt[idx] === createdAt[top] && (f.frags || 1) > (frags.get(top).frags || 1))) top = idx;
    const declared = Math.max(1, Number(frags.get(top).frags) || 1);
    const live = [...frags.entries()].filter(([idx]) => idx < declared).map(([, f]) => f);
    return { doc: defragment(live), createdAt, declared, complete: live.length === declared };
  }
  async function publishFragments(ids, prevAt = {}) {
    const s = st();
    const frags = buildFragments(s);
    if (!listWriteDue('frags', ids.map((i) => i.pk).join() + '|' + JSON.stringify(frags))) return;
    const now = Math.floor(Date.now() / 1000);
    for (const id of ids)
      for (let i = 0; i < frags.length; i++) {
        try {
          const created_at = Math.max(now, ((prevAt[id.pk] || {})[i] || 0) + 1);
          const evt = await id.sign({ kind: LIST_FRAG_KIND, tags: [['d', String(i)]], content: await id.enc(JSON.stringify(frags[i])), created_at });
          ownListIds.add(evt.id);
          publishOn(listRelays(), evt);
        } catch {}
      }
  }

  let listsSynced = false;
  let listsSyncedAt = 0;
  let listLiveSub = null;
  const fragAt = {}; // pk -> { index: created_at } as last read
  // Re-sync is cheap and a join made in another client should show up soon
  // after: the home view asks again after a minute, and a live subscription
  // on the fragment kind brings a fresh write straight in.
  async function syncLists({ force = false } = {}) {
    if (listsSynced && !force) return;
    const ids = await selfCryptors();
    if (!ids.length) return;
    listsSynced = true; listsSyncedAt = Date.now();
    const authors = ids.map((i) => i.pk);
    const [evs, fragEvs] = await Promise.all([
      queryOn(DM_RELAYS, { kinds: [13302, 13303], authors }, 3500),
      queryOn(listRelays(), { kinds: [LIST_FRAG_KIND], authors }, 4500),
    ]);
    if (!listLiveSub) {
      listLiveSub = subscribeOn(listRelays(), { kinds: [LIST_FRAG_KIND], authors, since: Math.floor(Date.now() / 1000) }, (e) => {
        if (ownListIds.has(e.id)) return; // our own write coming back is not news
        // another device writing: read it soon, but never faster than once
        // every ten seconds — a device stuck rewriting must not drag every
        // other one into a query storm alongside it
        const wait = Math.max(1500, 10_000 - (Date.now() - listsSyncedAt));
        clearTimeout(listLiveSub.t); listLiveSub.t = setTimeout(() => syncLists({ force: true }).catch(() => {}), wait);
      });
      allUnsubs.push(() => { try { listLiveSub(); } catch {} listLiveSub = null; });
    }
    let changed = false;
    const remoteDocs = new Set();
    const remoteLive = new Set(); let anyFrag = false;
    for (const id of ids) {
      const got = await readFragments(id, fragEvs);
      if (!got) continue;
      anyFrag = true; fragAt[id.pk] = got.createdAt;
      for (const e of got.doc.entries) if (!(got.doc.tombstones.find((t) => t.community_id === e.community_id)?.removed_at > e.added_at)) remoteLive.add(e.community_id);
      changed = mergeCommunityList(got.doc) || changed;
    }
    for (const kind of [13302, 13303])
      for (const id of ids) {
        const newest = evs.filter((e) => e.kind === kind && e.pubkey === id.pk).sort((a, b) => b.created_at - a.created_at)[0];
        if (!newest) continue;
        try {
          const raw = await id.dec(newest.content);
          remoteDocs.add(kind + ':' + raw);
          const doc = JSON.parse(raw);
          if (kind === 13302) changed = mergeCommunityList(doc) || changed;
          else changed = mergeInviteList(doc) || changed;
        } catch {}
      }
    healInviteBundles().catch(() => {});
    if (changed) {
      // cache-only here too — subscription waits for the user to open Chat
      for (const jm of communities()) ensureRoom(jm, { subscribe: ui.chatOpen });
      scheduleRepaint();
    }
    // republish when any identity's copy is missing or stale
    const s = st();
    const current = [[13302, buildCommunityList(s)], [13303, buildInviteList(s)]];
    const anyMissing = ids.length * 2 > remoteDocs.size
      || current.some(([kind, doc]) => !remoteDocs.has(kind + ':' + doc));
    if (anyMissing && (s.communities.length || Object.keys(s.invites).length || Object.keys(s.tombstones).length))
      publishLists();
    // the fragmented form: write it when no copy exists, or ours knows a
    // membership (or a leave) the relay copy doesn't
    const localLive = s.communities.filter((jm) => (s.tombstones[jm.community_id] || 0) <= (jm.added_at || 0)).map((jm) => jm.community_id);
    const fragStale = !anyFrag || localLive.some((cid) => !remoteLive.has(cid)) || [...remoteLive].some((cid) => !localLive.includes(cid) && s.tombstones[cid]);
    if (fragStale && (localLive.length || Object.keys(s.tombstones).length)) publishFragments(ids, fragAt);
  }

  async function leaveCommunity(room) {
    const cid = room.jm.community_id;
    const id = await identity();
    const s = st();
    s.tombstones[cid] = Date.now();
    s.communities = s.communities.filter((c) => c.community_id !== cid);
    delete s.joined[cid];
    save(s);
    if (id) {
      const { created_at, ms } = msTags(Date.now());
      wrapRumor({ kind: 3306, pubkey: id.pubkey, content: 'leave', tags: [ms], created_at }, id.signer, room.guestbook)
        .then((w) => publishOn(room.relays, w)).catch(() => {});
    }
    rooms.delete(cid);
    publishLists();
    ui.msgView = 'home';
    ui.msgLeaveArm = false;
    ui.msgInvitePanel = false;
    render();
  }

  // ---- DMs ----------------------------------------------------------------

  const threadOf = (peer) => threads.get(peer) || threads.set(peer, new Map()).get(peer);

  function noteDM(peer, rumor, mine) {
    if (!peer || !rumor.id) return;
    threadOf(peer).set(rumor.id, { rumor, mine });
    bumpMsgRev();
    scheduleRepaint();
  }

  // Wraps nothing could open are NOT consumed. The usual reason is the
  // remote signer losing the race with the relay backfill on a fresh load
  // (the login signer resumes lazily, the stored wraps arrive first), or a
  // single bunker round-trip failing — and dropping the wrap there was how
  // whole stretches of DM history quietly went missing, differently on every
  // device. Keep them and retry as the decryptor set improves; a wrap that
  // never opens (a stranger's wrap that merely p-tags us) falls out after a
  // few full-strength passes.
  const pendingWraps = new Map(); // wrap.id -> { wrap, tries }
  const PENDING_MAX = 800;
  // Full-strength attempts before giving a wrap up. Kept low on purpose: a
  // bunker signer pays two relay round-trips per attempt, and a wrap that a
  // complete decryptor set failed to open twice is essentially never ours.
  const PENDING_TRIES = 3;
  let drainTimer = 0;
  let draining = false;

  function dmDecryptors() {
    const out = [];
    if (wallet.nostr && wallet.nostr.sk) out.push(wallet.nostr.sk);
    const login = hook('nostrLoginIdentity');
    if (login && login.signer && login.signer.decryptFrom) out.push(login.signer);
    return out;
  }
  // A "full-strength" attempt has every key this wallet expects: retries
  // only count against a wrap once the login signer (if one is linked) has
  // actually had its chance — the wallet key alone can never open a wrap
  // sealed to the login npub.
  function decryptorsComplete() {
    const login = hook('nostrLoginIdentity');
    return !login || !!(login.signer && login.signer.decryptFrom);
  }

  // Raw-key unwraps (seed-derived / pasted nsec — the common case) run in
  // the crypto worker: two ECDH ops + a seal verify per wrap is the boot
  // secp256k1 that used to run here. Remote signers can't export their key,
  // so their decryptFrom stays on the main thread, exactly as before.
  async function unwrapDMAny(wrap, d) {
    if (d instanceof Uint8Array) {
      const job = unwrapDMsOffthread([wrap], d);
      if (job) {
        const r = await job;
        if (r) return r[0]; // null here means "not ours", not "worker failed"
      }
    }
    return unwrapDM(wrap, d).catch((e) => { if (SIGNER_SILENT.test(e?.message || '')) throw e; return null; });
  }

  // true: opened. false: not ours. 'later': a remote signer never answered,
  // so nothing is known yet — the wrap must be tried again, uncounted.
  async function openInboxWrap(wrap) {
    for (const d of dmDecryptors()) {
      let got;
      try { got = await unwrapDMAny(wrap, d); } catch { return 'later'; }
      if (!got) continue;
      if (got.rumor.kind === 14 || got.rumor.kind === 15) {
        // unwrapDM judges "mine" against the key that DECRYPTED, but this
        // wallet can hold several identities (wallet key + nostr login). A
        // sent-copy authored by any of them must thread under the RECIPIENT,
        // or every welcome DM the registrar sends lands in a self-thread.
        const mine = isMe(got.author);
        const to = got.rumor.tags?.find((x) => x[0] === 'p')?.[1];
        const peer = mine ? (to || got.peer || got.author) : got.author;
        noteEmoji(got.rumor);
        noteDM(peer, got.rumor, mine);
        persistDms();
      } else if (got.rumor.kind === 7) {
        // a DM reaction (ours echoed back, or the peer's — 0xchat's shape)
        const target = got.rumor.tags?.find((x) => x[0] === 'e')?.[1];
        noteEmoji(got.rumor);
        if (target) {
          const key = target + '|' + got.author;
          const at = got.rumor.created_at * 1000;
          if (at >= (dmReactAt.get(key) || 0)) {
            dmReactAt.set(key, at);
            (dmReacts.get(target) || dmReacts.set(target, new Map()).get(target)).set(got.author, got.rumor.content);
          }
          scheduleRepaint();
        }
      } else if (got.rumor.kind === 3313 && !isMe(got.author)) {
        try {
          const b = openDirectBundle(got.rumor.content);
          if (b && !st().declined[got.rumor.id] && !communityById(b.community_id))
            pendingDirect.set(got.rumor.id, { bundle: b, from: got.author, rid: got.rumor.id });
          scheduleRepaint();
        } catch {}
      }
      return true;
    }
    return false;
  }

  async function handleInboxWrap(wrap) {
    if (seenWraps.has(wrap.id) || seenWraps.has(wrapKey(wrap.id))) return;
    seenWraps.add(wrap.id);
    const r = await openInboxWrap(wrap);
    if (r === true) { rememberWrap(wrap.id); return; }
    if (pendingWraps.size >= PENDING_MAX) pendingWraps.delete(pendingWraps.keys().next().value);
    pendingWraps.set(wrap.id, { wrap, tries: r !== 'later' && decryptorsComplete() ? 1 : 0 });
    scheduleDrain(8000);
  }

  function scheduleDrain(ms) {
    if (!pendingWraps.size) return;
    clearTimeout(drainTimer);
    drainTimer = setTimeout(() => { drainPendingWraps().catch(() => {}); }, ms);
  }

  async function drainPendingWraps() {
    if (draining || !pendingWraps.size) return;
    draining = true;
    try {
      // Wraps sealed to the login npub can't open without its signer. Wake it
      // up ourselves — the boot-time resume is a single attempt, and if it
      // loses to cold-start churn nothing else asks until the user happens to
      // touch a screen that calls identity(). Resume single-flights and
      // rate-limits itself, so asking here is cheap.
      if (!decryptorsComplete()) await Promise.resolve(hook('nostrLoginResume')).catch(() => null);
      if (!dmDecryptors().length) return;
      const complete = decryptorsComplete();
      // Each openInboxWrap decrypts a gift wrap — NIP-44 ECDH, real
      // secp256k1 work. A backlog decrypted in one tight loop blocks the main
      // thread for the whole burst (the boot-time jank that made a carousel
      // drag lurch). Cap each synchronous run to a frame's budget and yield so
      // input and paint get a turn; the backfill just takes a few extra frames.
      let chunkStart = performance.now();
      for (const [id, p] of [...pendingWraps]) {
        // A remote signer can die mid-pass; counting the remaining wraps as
        // full-strength failures would evict messages that were never really
        // tried. Stop here — the slow retry picks the rest up.
        if (complete && !decryptorsComplete()) break;
        const r = await openInboxWrap(p.wrap);
        if (r === true) { pendingWraps.delete(id); rememberWrap(id); }
        else if (r === 'later') break; // the signer went quiet — nothing learned, try the rest later
        else if (complete && ++p.tries >= PENDING_TRIES) { pendingWraps.delete(id); rememberWrap(id); }
        if (performance.now() - chunkStart > 8) {
          await new Promise((r) => setTimeout(r));
          chunkStart = performance.now();
        }
      }
    } finally { draining = false; }
    // still holding wraps: the signer may connect later — keep a slow retry
    if (pendingWraps.size) scheduleDrain(decryptorsComplete() ? 30_000 : 60_000);
  }

  function openDirectBundle(json) {
    const b = JSON.parse(json);
    if (communityId(b.owner, b.owner_salt) !== b.community_id) return null;
    if (!/^[0-9a-f]{64}$/.test(b.community_root || '')) return null;
    if (!Array.isArray(b.channels) || b.channels.length > 256) return null;
    if (b.expires_at && Date.now() > b.expires_at) return null;
    return b;
  }

  function startDMs() {
    if (dmStarted) return;
    // Poll/advertise only the single DM identity (see dmSubKeys) — not the seed
    // key as a phantom second inbox.
    const pks = dmSubKeys();
    if (!pks.length) return;
    dmStarted = true;
    loadSeenWraps();
    // warm threads from the local cache. A self-thread of our own messages is
    // the residue of the old sent-copy misthreading (each welcome DM landed
    // under our own key) — sweep it rather than resurrect it; the cached
    // rows carry no tags, so they cannot be re-threaded to their recipients.
    const s = st();
    let swept = false;
    for (const [peer, list] of Object.entries(s.dms)) {
      if (isMe(peer) && list.every((m) => isMe(m.from))) {
        delete s.dms[peer];
        swept = true;
        continue;
      }
      for (const m of list)
        threadOf(peer).set(m.id, {
          rumor: { id: m.id, pubkey: m.from, content: m.text, created_at: m.t, kind: 14, tags: (m.em || []).map(([c, u]) => ['emoji', c, u]) },
          mine: isMe(m.from),
        });
    }
    bumpMsgRev();
    if (swept) save(s);
    const dmSub = (relays) => {
      const u = subscribeOn(relays, { kinds: [1059], '#p': pks, limit: 400 }, (wrap) => {
        handleInboxWrap(wrap).catch(() => {});
      }, { onclose: noteSubClosed });
      allUnsubs.push(u); dmUnsubs.push(u);
    };
    dmSub(DM_RELAYS);
    // Senders deliver to the relays our kind-10050 advertises — a list other
    // clients may have published with relays beyond our defaults. Read those
    // too, or a compliant sender's DM lands somewhere we never look (a reply
    // went only to damus/primal and no device ever showed it).
    (async () => {
      try {
        const lists = await Promise.all(pks.map((pk) => fetchInboxRelays(pk).catch(() => [])));
        const extras = [...new Set(lists.flat().map((r) => String(r || '').trim().replace(/\/$/, '')))]
          .filter((r) => /^wss:\/\//i.test(r) && !DM_RELAYS.includes(r))
          .slice(0, 3);
        if (extras.length && dmStarted) dmSub(extras);
      } catch {}
    })();
    ensureDmRelayList().catch(() => {});
  }

  // Publish a kind 10050 DM-relay list for the wallet key if none exists, so
  // other NIP-17 clients can find our inbox. Never touch a login npub's list
  // — the user's other clients own that. And when a login identity IS active,
  // don't advertise the seed key at all: it's internal, not a second inbox
  // (advertising it is what let DMs land on a phantom identity).
  async function ensureDmRelayList() {
    if (!wallet.nostr || !wallet.nostr.sk) return;
    if (hook('nostrLoginIdentity')) return;
    const pk = wallet.nostr.pk;
    const existing = await queryOn(DM_RELAYS, { kinds: [10050], authors: [pk] }, 2500);
    if (existing.length) return;
    const evt = finalizeEvent({
      kind: 10050,
      content: '',
      tags: DM_RELAYS.map((r) => ['relay', r]),
      created_at: Math.floor(Date.now() / 1000),
    }, wallet.nostr.sk);
    publishOn(DM_RELAYS, evt);
  }

  async function sendDM(peer) {
    const text = draftFor('dm:' + peer).trim();
    if (!text) return;
    const id = await identity();
    if (!id) { noIdToast(); return; }
    if (!(id.signer instanceof Uint8Array) && !id.signer.encryptTo) { toast(t('msgSignerNoDm')); return; }
    // Same optimistic shape as channel sends: the rumor is synchronous and on
    // screen at once. Wrapping the same rumor keeps the id, so the sent-copy
    // echo folds into this entry instead of duplicating it.
    const replyTo = ui.msgReplyTo && threadOf(peer).has(ui.msgReplyTo) ? ui.msgReplyTo : null;
    ui.msgReplyTo = null;
    ui.emojiAc = null;
    const rumor = makeDMRumor(id.pubkey, peer, text, [...(replyTo ? [['e', replyTo]] : []), ...outboundEmojiTags(text, emojiUrl)]);
    const entry = { rumor, mine: true, pending: true };
    threadOf(peer).set(rumor.id, entry);
    clearDraft('dm:' + peer);
    ui.msgStick = true;
    render();
    try {
      // Sequential on purpose — a remote signer is happier signing one at a time.
      const toPeer = await wrapDM(id.signer, peer, rumor);
      const toSelf = await wrapDM(id.signer, id.pubkey, rumor);
      // Our own relays take the wrap immediately; the peer's declared inbox
      // (a lookup that can take seconds) is chased off the critical path.
      // Publishing the same wrap twice is harmless — relays dedupe on id.
      const ok = await publishOn(DM_RELAYS, toPeer);
      publishOn(DM_RELAYS, toSelf);
      fetchInboxRelays(peer).then((inbox) => {
        const extra = inbox.slice(0, 4).filter((r) => !DM_RELAYS.includes(r));
        if (extra.length) publishOn(extra, toPeer);
      }).catch(() => {});
      if (!ok) { toast(t('msgSendFailed')); return; }
      delete entry.pending;
      persistDms();
    } catch (e) {
      threadOf(peer).delete(rumor.id);
      toast(e.message || String(e));
      render();
    }
  }

  // React to a DM: the same kind-7-in-a-gift-wrap shape 0xchat uses, sent to
  // the peer and to our own inbox (the echo is what other devices fold in).
  // Optimistic like sendDM; one reaction per author, latest wins.
  async function sendDmReaction(peer, m, emoji) {
    const id = await identity();
    if (!id) { noIdToast(); return; }
    if (!(id.signer instanceof Uint8Array) && !id.signer.encryptTo) { toast(t('msgSignerNoDm')); return; }
    ui.msgSheet = null;
    const rumor = makeDMReaction(id.pubkey, peer, m.rumor.id, emoji, reactEmojiTags(emoji));
    const r = dmReacts.get(m.rumor.id) || dmReacts.set(m.rumor.id, new Map()).get(m.rumor.id);
    const prev = r.get(id.pubkey);
    r.set(id.pubkey, emoji);
    dmReactAt.set(m.rumor.id + '|' + id.pubkey, rumor.created_at * 1000);
    render();
    try {
      const toPeer = await wrapDM(id.signer, peer, rumor);
      const toSelf = await wrapDM(id.signer, id.pubkey, rumor);
      seenWraps.add(toPeer.id); seenWraps.add(toSelf.id);
      const ok = await publishOn(DM_RELAYS, toPeer);
      publishOn(DM_RELAYS, toSelf);
      fetchInboxRelays(peer).then((inbox) => {
        const extra = inbox.slice(0, 4).filter((x) => !DM_RELAYS.includes(x));
        if (extra.length) publishOn(extra, toPeer);
      }).catch(() => {});
      if (!ok) toast(t('msgSendFailed'));
    } catch (e) {
      if (prev) r.set(id.pubkey, prev); else r.delete(id.pubkey);
      toast(e.message || String(e));
      render();
    }
  }

  function persistDms() {
    const s = st();
    const byRecent = [...threads.entries()]
      .map(([peer, m]) => [peer, [...m.values()].sort((a, b) => a.rumor.created_at - b.rumor.created_at)])
      .sort((a, b) => (b[1].at(-1)?.rumor.created_at || 0) - (a[1].at(-1)?.rumor.created_at || 0))
      .slice(0, 30);
    s.dms = {};
    for (const [peer, list] of byRecent)
      s.dms[peer] = list.filter((m) => !m.pending).slice(-CACHE_MAX)
        .map((m) => {
          const row = { id: m.rumor.id, from: m.rumor.pubkey, text: m.rumor.content, t: m.rumor.created_at };
          // a message's custom emoji ride along, or they'd be text after a reload
          const em = [...emojiTagMap(m.rumor.tags)];
          if (em.length) row.em = em;
          return row;
        });
    save(s);
  }

  // ---- views --------------------------------------------------------------

  const timeLabel = (tms) => {
    if (feedPaint?.time.has(tms)) return feedPaint.time.get(tms);
    const d = new Date(tms);
    const today = new Date().toDateString() === d.toDateString();
    const label = today
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    feedPaint?.time.set(tms, label);
    return label;
  };

  // Which bytes a face paints from, in order of preference:
  //   our own punk art, straight off disk at the size being drawn;
  //   the thumbnail we keep locally, which needs no network at all;
  //   the original, when we have nothing else yet.
  // The 64px profile avatar layers the original OVER the local copy: CSS
  // paints the first layer that has arrived, so the face is there instantly
  // and sharpens when the full-size one lands.
  function avatarBg(p, big) {
    const punk = localPunk(p.picture, big);
    if (punk) return `url(${JSON.stringify(punk)})`;
    const local = p.thumb && p.thumbFor === p.picture ? p.thumb : null;
    if (!local) return `url(${JSON.stringify(p.picture)})`;
    return (big ? `url(${JSON.stringify(p.picture)}),` : '') + `url(${JSON.stringify(local)})`;
  }

  const avatar = (pk, cls = 'chat-avatar', clickable = true) => {
    const p = profileOf(pk);
    // Someone we've never cached used to get an empty circle until a relay
    // answered — seconds of blankness on every boot, and for anyone whose
    // kind 0 carries no picture (or none at all, which never gets cached)
    // that repeated forever. The punk is derived from the pubkey alone, so
    // it can be drawn in the first frame: it's already the right answer for
    // everyone without a picture, and for a coinos user who kept the default
    // it IS their published picture. A real photo replaces it when it lands.
    //
    // `loading` is different and still gets the quiet circle: a name lookup
    // is in flight for that specific person, so a picture is expected and
    // punk art must not flash in front of it.
    const node = feedPaint && !p.picture
      ? h('div', { class: cls + ' fallback' }, (p.name || npubOf(pk) || '??').slice(0, 2))
      : p && p.loading && !p.picture
      ? h('div', { class: cls + ' fallback loading' })
      : p === null && ui.noteThread
        ? h('div', { class: cls + ' fallback loading' })
      : p === null
        ? fallbackAvatar(h, pk, null, cls)
      : p.picture 
        // A background paints synchronously from cache; a fresh <img> decodes
        // async, so recreating one per render made avatars visibly flash.
        //
        // The thumbnail we keep locally is the whole picture at this size, so
        // a 30px circle never asks the network for the original again. The
        // 64px profile avatar layers them: CSS paints the first layer that
        // has arrived, so the thumbnail shows instantly and the full-size
        // original takes over on top when it lands.
        ? h('div', { class: cls + ' ava-img', style: 'background-image:' + avatarBg(p, cls.includes('profile-avatar')) })
        : fallbackAvatar(h, pk, p.name, cls);
    // A face we keep painting is one worth keeping a thumbnail of.
    if (!feedPaint && p && p.picture) makeThumb(pk, p);
    if (clickable) {
      node.classList.add('clickable');
      // Start the profile's own fetches on touch-DOWN, not on click. The gap
      // between the two is a hundred-odd milliseconds of free head start,
      // and unlike prefetching every row on paint (which cost sixty requests
      // for twenty rows and starved the profile batch) this only ever asks
      // about the person actually being tapped.
      node.addEventListener('pointerdown', () => { try { prefetchProfilePage(pk); } catch {} }, { passive: true });
      node.addEventListener('click', (e) => { e.stopPropagation(); openProfile(pk); });
    }
    return hook('wrapAvatar', pk, node) || hatStamp(pk, node) || node;
  };

  // The hats feature is a deferred chunk — until it lands, replay last
  // session's boot stamps (hat art + geometry it persisted) so a hat sits on
  // the head from the FIRST frame instead of popping in a beat later. Once
  // hatsReady answers, the stamps stand down: a null from wrapAvatar then
  // genuinely means "bare head".
  let _hatStamps = null;
  function hatStamp(pk, node) {
    if (hook('hatsReady')) return null;
    if (_hatStamps === null) {
      try { _hatStamps = JSON.parse(localStorage.getItem('hat-stamps') || '{}'); } catch { _hatStamps = {}; }
    }
    const s = _hatStamps[pk];
    if (!s || !s.a) return null;
    return h('span', { class: 'hat-wrap' }, node, h('span', { class: 'ava-hat', style: s.s, html: s.a }));
  }

  // ---- profiles: view + own kind-0 editor ---------------------------------

  const fullProfiles = new Map(); // pk -> { raw kind0 content object, fetched_at }
  const fullFetched = new Set();  // fetched from relays this session
  const fullInFlight = new Map();
  const fullMisses = new Set();

  // The profile-page cache SURVIVES refreshes: bios and recent posts serve
  // instantly from storage while a background fetch freshens them. Bounded:
  // the last handful of viewed/warmed pages, notes trimmed to what the rows
  // render.
  const PROF_PAGE_CACHE = 'profPages';
  const pageCache = () => {
    try {
      const c = wallet.loadFeatureState(PROF_PAGE_CACHE, {}) || {};
      return { full: c.full || {}, notes: c.notes || {} };
    } catch { return { full: {}, notes: {} }; }
  };
  function persistPage(kind, pk, value) {
    try {
      const c = pageCache();
      c[kind][pk] = { t: Date.now(), v: value };
      for (const k of ['full', 'notes']) {
        const keys = Object.keys(c[k]).sort((a, b) => c[k][b].t - c[k][a].t);
        for (const drop of keys.slice(10)) delete c[k][drop];
      }
      wallet.saveFeatureState(PROF_PAGE_CACHE, c);
    } catch {}
  }
  const slimNote = (ev) => ({
    id: ev.id, pubkey: ev.pubkey, kind: 1, created_at: ev.created_at,
    content: String(ev.content || '').slice(0, 3000),
    tags: (ev.tags || []).filter((x) => x[0] === 'e' || x[0] === 'p'),
  });

  function fetchFullProfile(pk) {
    if (!fullProfiles.has(pk)) {
      const cached = pageCache().full[pk];
      if (cached) fullProfiles.set(pk, cached.v);
    }
    if (fullFetched.has(pk)) return Promise.resolve();
    if (fullInFlight.has(pk)) return fullInFlight.get(pk);
    fullMisses.delete(pk);
    // Use the same index-relay + author's-relay fallbacks as feed avatars.
    // Only a real kind-0 response marks a page fetched; relay silence is
    // retryable and leaves cached profile details intact.
    const pending = fetchProfiles([pk]).catch(() => {}).finally(() => {
      fullInFlight.delete(pk);
      if (!fullFetched.has(pk)) fullMisses.add(pk);
      if (ui.profilePk === pk) render();
      else scheduleRepaint();
    });
    fullInFlight.set(pk, pending);
    return pending;
  }

  // Warm a profile PAGE (full kind-0 + latest notes + relay list) before
  // anyone taps it, so the page opens complete instead of behind spinners.
  // Queued with a small concurrency cap: likely tap-targets only, never a
  // whole room's member list at once.
  const prefetched = new Set();
  const prefetchQueue = [];
  let prefetching = 0;
  function prefetchProfilePage(pk) {
    if (!pk || prefetched.has(pk)) return;
    prefetched.add(pk);
    prefetchQueue.push(pk);
    drainPrefetch();
  }
  function drainPrefetch() {
    while (prefetching < 2 && prefetchQueue.length) {
      const pk = prefetchQueue.shift();
      prefetching++;
      Promise.allSettled([
        Promise.resolve(fetchFullProfile(pk)),
        Promise.resolve(notesFor(pk)),
      ]).finally(() => { prefetching--; drainPrefetch(); });
    }
  }

  function openProfile(pk) {
    ui.profilePk = pk;
    // Opened from inside a thread (an author's avatar/name), the profile
    // stacks ON TOP of it — back returns to the conversation. The screen
    // router otherwise keeps a thread above the profile, which is the order
    // for the other direction (a note row tapped on a profile page).
    ui.profOverThread = !!ui.noteThread;
    ui.profEdit = null; ui.profEditFilled = false; ui.logoutConfirm = null; ui.profCompose = null;
    render();
    fetchFullProfile(pk);
    notesFor(pk);
  }

  // ---- profile notes: latest public posts & replies -----------------------

  const NOTE_RELAYS = [...new Set([...PROFILE_RELAYS, ...DM_RELAYS])];

  // ---- zap tallies ---------------------------------------------------------
  // How much a post or chat message has been zapped: the public receipts
  // that e-tag it — NIP-57 kind 9735 (the recipient's LNURL server signs one
  // once the invoice is paid) and coinos' own Ark zap receipt (kind 9737,
  // the zapper publishes it beside the mailbox delivery). Summed per id,
  // deduped by receipt, painted as a little bolt + sats. A chat message is a
  // rumor with an id like any event, so a zap aimed at it e-tags that id —
  // the receipt reveals nothing but the id itself.
  const ZAP_KINDS = [9735, 9737];
  // ...and, in the same REQ, what else happened to a note: likes (kind 7)
  // and boosts (kind 6). One round trip for all three.
  const NOTE_KINDS = [9735, 9737, 7, 6];
  const reacts = new Map();  // note id -> Map([emoji, url] -> { emoji, url, who: Set<pubkey> })
  // Resolve from this reaction's own tag: packs can reuse the same shortcode
  // for different pictures, and an unrelated event must not change its face.
  const postReactNode = ({ emoji, url }) => url ? emojiImg(shortcodeOf(emoji), url) : emoji;
  const boosts = new Map();  // note id -> Set<pubkey>
  const noteCountsReady = new Set(); // a relay batch is complete for this note
  const seenNoteEv = new Set(); // event ids already counted
  const myReactEv = new Map();  // note id -> the id of OUR reaction, so it can be withdrawn
  const zapTotals = new Map(); // id -> { sats, seen: Set<receipt id>, mine }
  const zapWho = new Map();    // id -> Map(receipt id -> { pk, sats, ts, text }) — the tally, by person
  const zapAsked = new Set();
  let zapQueue = new Set(), zapTimer = null, zapLiveUnsub = null, zapRecent = [];
  const zapRelays = () => [...new Set([...NOTE_RELAYS, ...((wallet.nostrRelays && wallet.nostrRelays()) || [])])];
  function noteCountSnapshot(id) {
    const rm = reacts.get(id);
    return { likes: rm ? [...rm.values()].reduce((n, { who }) => n + visiblePks(who).length, 0) : 0,
      boosts: visiblePks(boosts.get(id) || new Set()).length,
      sats: zapTotals.get(id)?.sats || 0 };
  }
  function refreshThreadCount(id, persist = true) {
    if (!noteCountsReady.has(id)) return;
    const c = ui.noteThread && threadCache.get(ui.noteThread.rootId);
    if (!c?.root || !(c.root.id === id || c.replies.some((e) => e.id === id))) return;
    const live = noteCountSnapshot(id), old = c.counts[id];
    // Relay answers can be incomplete. A short/empty answer must not erase
    // numbers that were already visible when this conversation opened.
    c.counts[id] = old ? { likes: Math.max(old.likes, live.likes), boosts: Math.max(old.boosts, live.boosts),
      sats: Math.max(old.sats, live.sats) } : live;
    if (persist) persistThread(c);
  }
  const tagOf = (ev, k) => (ev.tags.find((x) => x[0] === k) || [])[1];
  function receiptSats(ev) {
    if (ev.kind === 9737) {
      const net = tagOf(ev, 'network');
      if (net && net !== getNetwork()) return 0;
      return Math.max(0, parseInt(tagOf(ev, 'amount'), 10) || 0);
    }
    const b11 = tagOf(ev, 'bolt11');
    if (b11) { try { const d = decodeBolt11(b11); if (d && d.amountSat) return d.amountSat; } catch {} }
    // no readable invoice: the zap request inside says what was asked for
    try {
      const req = JSON.parse(tagOf(ev, 'description') || 'null');
      return Math.floor((parseInt(tagOf(req, 'amount'), 10) || 0) / 1000);
    } catch { return 0; }
  }
  // The note the zapper typed with it, if any (it rides inside the zap
  // request the receipt carries).
  function zapText(ev) {
    if (ev.kind === 9737) return String(ev.content || '').slice(0, 200);
    try { return String((JSON.parse(tagOf(ev, 'description') || 'null') || {}).content || '').slice(0, 200); } catch { return ''; }
  }
  function zapperOf(ev) {
    if (ev.kind === 9737) {
      // Signed by the wallet key; the sender tag names the person behind it.
      // Older receipts of ours have no such tag — read them as us all the same.
      const sender = tagOf(ev, 'P') || ev.pubkey;
      const id = hook('nostrLoginIdentity');
      return id && wallet.nostr && sender === wallet.nostr.pk ? id.pubkey : sender;
    }
    if (tagOf(ev, 'P')) return tagOf(ev, 'P');
    try { return (JSON.parse(tagOf(ev, 'description') || 'null') || {}).pubkey || null; } catch { return null; }
  }
  // Where an event about a note goes. A zap receipt is money and has its own
  // bookkeeping (see below); a like and a boost are just tallies of who.
  function noteEvent(ev) {
    if (ev.kind === 7 || ev.kind === 6) {
      if (seenNoteEv.has(ev.id)) return;
      seenNoteEv.add(ev.id);
      // the LAST e tag is the note being reacted to (NIP-25)
      const ids = (ev.tags || []).filter((x) => x[0] === 'e' && x[1]).map((x) => x[1]);
      const id = ids[ids.length - 1];
      if (!id) return;
      if (ev.kind === 6) {
        if (!boosts.has(id)) boosts.set(id, new Set());
        boosts.get(id).add(ev.pubkey);
      } else {
        // '+' and an empty content both mean a plain like
        const code = shortcodeOf(ev.content);
        const emoji = !ev.content || ev.content === '+' ? '\u2764\ufe0f' : code ? ev.content : ev.content.slice(0, 12);
        const url = code ? emojiTagMap(ev.tags).get(code) || null : null;
        const key = JSON.stringify([emoji, url]);
        noteEmoji(ev);
        if (!reacts.has(id)) reacts.set(id, new Map());
        const m = reacts.get(id);
        if (!m.has(key)) m.set(key, { emoji, url, who: new Set() });
        m.get(key).who.add(ev.pubkey);
        // ours, wherever it was sent from — so it can be taken back here
        if (myPubkeys().includes(ev.pubkey)) myReactEv.set(id, ev.id);
      }
      refreshThreadCount(id);
      scheduleRepaint();
      return;
    }
    noteReceipt(ev);
  }

  function noteReceipt(ev) {
    const sats = receiptSats(ev);
    if (!sats) return;
    const my = myPubkeys();
    const from = zapperOf(ev);
    let changed = false;
    for (const x of ev.tags) {
      if (x[0] !== 'e' || !x[1]) continue;
      const cur = zapTotals.get(x[1]) || zapTotals.set(x[1], { sats: 0, seen: new Set(), mine: false }).get(x[1]);
      if (cur.seen.has(ev.id)) continue;
      cur.seen.add(ev.id);
      cur.sats += sats;
      if (from) {
        if (!zapWho.has(x[1])) zapWho.set(x[1], new Map());
        zapWho.get(x[1]).set(ev.id, { pk: from, sats, ts: ev.created_at, text: zapText(ev) });
      }
      // our own zap's receipt: the real thing has landed, so the optimistic
      // amount the chip has been carrying since the tap steps aside
      if (from && my.includes(from)) { cur.mine = true; voidPending(x[1], ev.created_at * 1000, sats); }
      changed = true;
      refreshThreadCount(x[1]);
    }
    if (changed) { saveZapTotals(); scheduleRepaint(); }
  }
  // Ask once per id (batched per paint), and keep ONE live subscription on
  // the ids most recently on screen, so a zap landing while you watch —
  // yours included — shows up without a reload.
  function watchZaps(ids) {
    let fresh = false;
    for (const id of ids) if (id && !zapAsked.has(id)) { zapAsked.add(id); zapQueue.add(id); fresh = true; }
    if (!fresh || zapTimer) return;
    zapTimer = setTimeout(() => {
      zapTimer = null;
      const batch = [...zapQueue]; zapQueue = new Set();
      const relays = zapRelays();
      for (let i = 0; i < batch.length; i += 150) {
        const slice = batch.slice(i, i + 150);
        queryOn(relays, { kinds: NOTE_KINDS, '#e': slice }, 4000)
          .then((evs) => {
            evs.forEach(noteEvent);
            // the relays have spoken for these ids: their live tally is the
            // truth now, remembered or not (a zap that was deleted has to be
            // able to disappear)
            for (const id of slice) zapSeeds().delete(id);
            const c = ui.noteThread && threadCache.get(ui.noteThread.rootId);
            for (const id of slice) {
              noteCountsReady.add(id);
              if (c && (c.root?.id === id || c.replies.some((e) => e.id === id))) refreshThreadCount(id, false);
            }
            if (c?.root) persistThread(c);
            saveZapTotals();
            scheduleRepaint();
          }).catch(() => {});
      }
      zapRecent = [...batch.reverse(), ...zapRecent.filter((x) => !batch.includes(x))].slice(0, 200);
      if (zapLiveUnsub) { try { zapLiveUnsub(); } catch {} }
      zapLiveUnsub = subscribeOn(relays, { kinds: NOTE_KINDS, '#e': zapRecent, since: Math.floor(Date.now() / 1000) - 60 }, noteEvent);
    }, 250);
  }
  // Tallies are asked of the relays again on every boot, and that takes
  // seconds — long enough that a room full of zapped messages paints bare and
  // fills in afterwards. So the totals themselves are remembered (just the
  // numbers, never the receipts) and painted straight away; the moment the
  // relays answer for a message, their word replaces it.
  const ZAP_REMEMBER = 400; // tallies kept between sessions
  let zapSeed = null;
  function zapSeeds() {
    if (!zapSeed) {
      zapSeed = new Map();
      try {
        for (const [id, v] of Object.entries(st().zaps || {})) if (v && v.s) zapSeed.set(id, { sats: v.s, mine: !!v.m });
      } catch {}
    }
    return zapSeed;
  }
  let zapSaveT = null;
  function saveZapTotals() {
    clearTimeout(zapSaveT);
    zapSaveT = setTimeout(() => {
      try {
        const s2 = st();
        // Update what's recently been on screen, and KEEP the rest: opening a
        // DM thread must not forget what the community chat had learned.
        const out = { ...(s2.zaps || {}) };
        for (const id of zapRecent) {
          const z = zapTotals.get(id) || zapSeeds().get(id);
          if (z && z.sats) out[id] = z.mine ? { s: z.sats, m: 1 } : { s: z.sats };
          else delete out[id]; // the relays answered, and it's zero
        }
        let n = Object.keys(out).length;
        if (n > ZAP_REMEMBER) {
          const recent = new Set(zapRecent);
          for (const k of Object.keys(out)) { // insertion order: oldest first
            if (n <= ZAP_REMEMBER) break;
            if (!recent.has(k)) { delete out[k]; n--; }
          }
        }
        s2.zaps = out;
        save(s2);
      } catch {}
    }, 1500);
  }

  // After OUR zap the receipt trails the payment by seconds — ask again.
  function recheckZap(id) {
    for (const ms of [4000, 12000, 30000]) setTimeout(() => { zapAsked.delete(id); watchZaps([id]); }, ms);
  }
  const fmtSats = (n) => n < 1000 ? String(n)
    : n < 10000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
      : n < 1e6 ? Math.round(n / 1000) + 'k'
        : (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  const BOLT_SVG = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" stroke="none" style="display:block"><path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/></svg>';

  // A tapped zap takes a few seconds to pay, and its public receipt trails
  // the payment by seconds more — long enough that the tap looked ignored.
  // So the chip appears the instant you tap, carrying your amount and
  // pulsing while the payment is in flight; it goes solid when the payment
  // lands and hands over to the real receipt when that arrives. A failure
  // takes it straight back off.
  const ZAP_FLIGHT_MS = 45_000; // nothing reported back: assume it's gone
  const ZAP_PAID_MS = 5 * 60_000; // paid, but the receipt never showed
  // id -> [{ sats, at, state }], oldest first: one entry per zap of ours on
  // that id, so tapping again while the first is still in the air stacks a
  // second zap on top instead of being refused. state is:
  //   flying — tapped, payment in the air: counted on top, chip pulses
  //   paid   — the flow reported success: counted on top, chip solid
  //   void   — one of OUR receipts has been counted into the real total for
  //            this zap, so its optimistic amount must not be added again.
  //            Kept rather than deleted, because the receipt usually beats
  //            the flow's own report: an ark zap publishes that receipt
  //            itself, and it returns over the live subscription before the
  //            send call resolves. Deleting would let the later settle
  //            resurrect the amount — which is how a 21-sat zap displayed 42.
  // Reports and receipts name the id, never the tap, so each is matched to
  // the oldest entry it can describe (same amount first). Two default-amount
  // zaps are told apart by order alone, which is all the chip needs: it shows
  // the sum, and pulses while any is in the air.
  const zapPending = new Map();
  const pendTtl = (p) => (p.state === 'flying' ? ZAP_FLIGHT_MS : ZAP_PAID_MS);
  // Everything still alive for this id, and what the chip makes of it.
  function pendingOf(id) {
    const all = zapPending.get(id);
    if (!all) return null;
    const now = Date.now();
    const list = all.filter((p) => now - p.at <= pendTtl(p));
    if (!list.length) { zapPending.delete(id); return null; }
    zapPending.set(id, list); // the array handed back is the one stored: splices land
    let sats = 0, flying = false;
    for (const p of list) if (p.state !== 'void') { sats += p.sats; flying = flying || p.state === 'flying'; }
    return { sats, flying, list };
  }
  const pickPending = (list, sats, pred) =>
    (sats && list.find((p) => pred(p) && p.sats === sats)) || list.find(pred) || null;
  const dropPending = (id, list, p) => {
    list.splice(list.indexOf(p), 1);
    if (!list.length) zapPending.delete(id);
  };
  function markZapPending(id, sats, origin) {
    if (!id || !sats) return;
    const list = pendingOf(id)?.list || [];
    zapPending.set(id, [...list, { sats, at: Date.now(), state: 'flying' }]);
    animateZap(sats, origin, id, zapSoundOn());
    render();
    // repaint when the in-flight chip would expire, so a zap nobody ever
    // reported on doesn't pulse forever
    setTimeout(scheduleRepaint, ZAP_FLIGHT_MS + 200);
  }
  // A zap flow reporting back: paid (keep the amount, stop pulsing) or
  // failed (the chip was never real — take it off).
  function settleZap(id, ok, sats) {
    if (!id) return;
    const list = pendingOf(id)?.list || [];
    if (!ok) {
      const p = pickPending(list, sats, (x) => x.state === 'flying') || pickPending(list, sats, (x) => x.state === 'paid');
      if (p) { dropPending(id, list, p); scheduleRepaint(); }
      return;
    }
    const p = pickPending(list, sats, (x) => x.state === 'flying');
    if (p) { p.state = 'paid'; p.at = Date.now(); scheduleRepaint(); return; }
    // nothing in the air: the receipt already beat this report (its marker
    // stays, so a repeated confirmation can't count it either), or a form
    // zap paid without a tap — count that one until its receipt lands
    if (pickPending(list, sats, (x) => x.state === 'void')) return;
    zapPending.set(id, [...list, { sats: sats || 0, at: Date.now(), state: 'paid' }]);
    scheduleRepaint();
  }
  // One of our own receipts has been counted for this id: the real total
  // speaks for that zap now, so its optimistic amount stands down.
  function voidPending(id, evMs, sats) {
    const list = pendingOf(id)?.list || [];
    // ...unless it's the receipt of an OLDER zap of ours arriving (the first
    // paint fetches every receipt a message has). That one is already in the
    // total and says nothing about the zaps currently in the air.
    const fresh = (p) => p.state !== 'void' && !(evMs && evMs < p.at - 120_000);
    const p = pickPending(list, sats, fresh);
    if (p) { p.state = 'void'; p.at = Date.now(); return; }
    if (evMs && evMs < Date.now() - 120_000) return; // old: no report is coming for it
    zapPending.set(id, [...list, { sats: sats || 0, at: Date.now(), state: 'void' }]);
  }
  // The chip: a little bolt + the sats total. Absent until the first receipt
  // — or until you zap it yourself, which is its own kind of receipt.
  const zapSoundOn = () => (ctx.zapSound ? ctx.zapSound() : true);
  function zapChip(id, { onClick, onHold, cls = '' } = {}) {
    if (onClick && zapSoundOn()) warmZapSound();
    const z = zapTotals.get(id) || zapSeeds().get(id);
    const p = pendingOf(id);
    const optimistic = p ? p.sats : 0;
    const sats = (z ? z.sats : 0) + optimistic;
    if (!sats) return null;
    const flying = !!p && p.flying;
    return h('span', {
      class: 'zap-tally' + ((z && z.mine) || optimistic ? ' on' : '') + (flying ? ' flying' : '')
        + (onClick ? ' clickable' : '') + (cls ? ' ' + cls : ''),
      title: flying ? t('zapSending') : t('zapTallyTitle', { n: sats.toLocaleString() }),
      ...(onClick ? holdable(onHold, (e) => { e.stopPropagation(); onClick(); }) : {}),
    }, h('span', { style: 'display:flex', html: BOLT_SVG }), fmtSats(sats));
  }
  // Hold the ⚡ to change the one-tap amount instead of paying it. The
  // press's state lives on the element, not in this closure: a background
  // repaint swaps handlers mid-press, and the lift must still find the timer
  // the press set, or a finger already gone would count as a hold.
  const HOLD_MS = 500;
  function holdable(onHold, onTap) {
    const clear = (e) => { const el = e.currentTarget; if (el._hold) { clearTimeout(el._hold); el._hold = 0; } };
    if (!onHold) return { onClick: onTap };
    return {
      onPointerdown: (e) => {
        const el = e.currentTarget;
        clear(e); el._held = false;
        if (e.button) return; // right button has its own menu
        el._hold = setTimeout(() => {
          el._hold = 0; el._held = true;
          try { navigator.vibrate?.(12); } catch {}
          onHold(el);
        }, HOLD_MS);
      },
      onPointerup: clear, onPointercancel: clear, onPointerleave: clear,
      onContextmenu: (e) => { e.preventDefault(); },
      onClick: (e) => { const el = e.currentTarget; if (el._held) { el._held = false; e.stopPropagation(); return; } onTap(e); },
    };
  }
  // Zap a chat message or DM: same one-tap flow as a post (ark first,
  // Lightning fallback, the amount remembered from the first time).
  function zapMessage(pk, id) {
    zapNote(pk, { id });
    recheckZap(id);
  }
  const notesCache = new Map(); // pk -> { status: 'loading'|'ready', notes: [kind-1 events] }
  // NIP-65: where this author actually writes. Their notes and threads live
  // there first — our default relays are just the common ground.
  const relayListCache = new Map(); // pk -> Promise<string[]>
  function relaysOf(pk) {
    let p = relayListCache.get(pk);
    if (p) return p;
    // the feed's batched fetch has probably already asked for this one
    const known = relayListsNow().get(pk);
    if (known) { p = Promise.resolve(known.r || []); relayListCache.set(pk, p); return p; }
    p = queryOn([...new Set([...PROFILE_RELAYS, ...NOTE_RELAYS])], { kinds: [10002], authors: [pk] }, 3500)
      .then((evs) => {
        const newest = (evs || []).sort((a, b) => b.created_at - a.created_at)[0];
        if (!newest) return [];
        return [...new Set(newest.tags
          .filter((x) => x[0] === 'r' && x[1] && x[2] !== 'read' && /^wss:\/\//.test(x[1]))
          .map((x) => x[1].replace(/\/$/, '')))].slice(0, 4);
      })
      .catch(() => []);
    relayListCache.set(pk, p);
    return p;
  }
  const notesRelays = async (pk) => [...new Set([...NOTE_RELAYS, ...(await relaysOf(pk))])];

  // Posts of theirs we already hold. Tapping a face in the feed is the
  // common way onto a profile, and the feed we just came from is full of
  // that person's posts — an open thread holds their replies too. Painting
  // those first means the page opens with real content instead of an empty
  // column that fills in a beat later, and the relay fetch below replaces
  // them the moment it answers.
  function notesInHand(pk) {
    const out = new Map();
    for (const e of (feed && feed.notes) || []) if (e.pubkey === pk) out.set(e.id, e);
    for (const c of threadCache.values()) {
      if (c.root && c.root.pubkey === pk) out.set(c.root.id, c.root);
      for (const e of c.replies || []) if (e.pubkey === pk) out.set(e.id, e);
    }
    return [...out.values()].sort((a, b) => b.created_at - a.created_at);
  }

  function notesFor(pk) {
    let c = notesCache.get(pk);
    if (c) return c;
    // stored posts paint the page instantly; the relay fetch below freshens
    const stored = pageCache().notes[pk];
    const seed = stored ? stored.v : notesInHand(pk);
    // Seeded from memory the status stays 'loading': these are posts we
    // happen to have, not their page, so the real answer still replaces
    // them — but there is something to read while it comes.
    c = stored
      ? { status: 'ready', notes: stored.v }
      : { status: 'loading', notes: seed };
    notesCache.set(pk, c);
    (async () => {
      const evs = await queryOn(await notesRelays(pk), { kinds: [1], authors: [pk], limit: 30 }, 4500);
      const seen = new Set();
      const fresh = (evs || [])
        .filter((e) => !seen.has(e.id) && seen.add(e.id))
        .sort((a, b) => b.created_at - a.created_at);
      if (fresh.length || !c.notes.length) {
        await notesReady(fresh.slice(0, FEED_PAGE)); // the first screen arrives whole
        c.notes = fresh;
        persistPage('notes', pk, fresh.slice(0, 20).map(slimNote)); // cache stays bounded
      }
    })().catch(() => {}).finally(() => {
      c.status = 'ready';
      if (ui.profilePk === pk) render();
    });
    return c;
  }

  // Infinite scroll: pull the next page of OLDER notes (until = oldest seen)
  // when the profile page nears its bottom. Guarded so scroll spam costs
  // nothing: one fetch in flight, and a short answer marks the end.
  // Registered at CONSTRUCTION, not init(): the public no-wallet profile
  // (a /username deep link over the unlock screen) scrolls too, and init
  // only runs once a wallet opens.
  if (typeof window !== 'undefined') {
    window.addEventListener('scroll', () => {
      if (!ui.profilePk && (!(ui.chatOpen && ui.msgView === 'feed') || ui.noteThread)) return;
      // back at the top by yourself: the new posts are under your eyes, so
      // the notice has done its job (only the pill repaints — the rows are
      // keyed and stay put, so nothing moves under a finger)
      if (!ui.profilePk && feed && feed.unseen && atFeedTop()) { feed.unseen = 0; render(); }
      if (!ui.profilePk && feed?.deferred?.length) admitFeed(feed.deferred, feed);
      if (window.innerHeight + window.scrollY < (document.documentElement.scrollHeight || 0) - (ui.profilePk ? 600 : Math.max(2400, window.innerHeight * 3))) return;
      if (ui.profilePk) loadOlderNotes(ui.profilePk).catch(() => {});
      else loadOlderFeed().catch(() => {});
    }, { passive: true });
  }
  async function loadOlderNotes(pk) {
    const c = notesCache.get(pk);
    if (!c || c.status !== 'ready' || c.loadingMore || c.end) return;
    const oldest = c.notes[c.notes.length - 1];
    if (!oldest) { c.end = true; return; }
    c.loadingMore = true;
    render();
    try {
      const evs = await queryOn(await notesRelays(pk),
        { kinds: [1], authors: [pk], limit: 30, until: oldest.created_at - 1 }, 4500);
      const seen = new Set(c.notes.map((e) => e.id));
      const older = (evs || [])
        .filter((e) => !seen.has(e.id) && seen.add(e.id))
        .sort((a, b) => b.created_at - a.created_at);
      if (older.length) { await notesReady(older); c.notes = [...c.notes, ...older]; }
      else c.end = true; // the relays have nothing older
    } catch {} finally {
      c.loadingMore = false;
      if (ui.profilePk === pk) render();
    }
  }


  // ---- follows: the kind-3 contact list -------------------------------------
  // Who you follow. Kept locally so the Follow button and the feed are right
  // in the first frame, and refreshed from relays behind that. A contact list
  // is a shared document — other clients keep relay hints in its content and
  // petnames in its tags — so publishing preserves everything we didn't write
  // and only ever adds or removes one p tag.
  const FOLLOWS = 'follows';
  let follows = null;      // { set: Set<pk>, tags, content, at }
  let followsAt = 0;       // when we last asked the relays
  let followsPub = false;  // a publish is in flight

  const mePk = () => (hook('nostrLoginIdentity') || {}).pubkey || (wallet.nostr && wallet.nostr.pk) || null;
  const pTags = (tags) => (tags || []).filter((x) => x[0] === 'p' && /^[0-9a-f]{64}$/.test(x[1] || ''));

  function followsNow() {
    if (!follows) {
      let s = null;
      try { s = wallet.loadFeatureState(FOLLOWS, null); } catch {}
      const tags = (s && s.tags) || [];
      follows = { set: new Set(pTags(tags).map((x) => x[1])), tags, content: (s && s.c) || '', at: (s && s.at) || 0 };
    }
    return follows;
  }
  function saveFollows(f) {
    follows = f;
    try { wallet.saveFeatureState(FOLLOWS, { tags: f.tags, c: f.content, at: f.at }); } catch {}
  }
  const isFollowing = (pk) => followsNow().set.has(pk);

  // Fetch the newest list from the relays. Older than what we hold is
  // ignored: a relay that missed our last publish must not un-follow people.
  async function syncFollows({ force = false } = {}) {
    const me = mePk();
    if (!me) return followsNow();
    if (!force && Date.now() - followsAt < 10 * 60_000) return followsNow();
    followsAt = Date.now();
    try {
      const evs = await queryOn(zapRelays(), { kinds: [3], authors: [me] }, 5000);
      const newest = (evs || []).sort((a, b) => b.created_at - a.created_at)[0];
      const cur = followsNow();
      if (newest && newest.created_at > cur.at) {
        saveFollows({
          set: new Set(pTags(newest.tags).map((x) => x[1])),
          tags: newest.tags || [], content: newest.content || '', at: newest.created_at,
        });
        feedAuthorsChanged();
        scheduleRepaint();
      }
    } catch { followsAt = 0; }
    return followsNow();
  }

  // Follow or unfollow, on the freshest list the relays will give us — the
  // local copy alone would quietly drop anyone another client added since.
  // The button flips immediately and goes back if the publish fails.
  // A brand-new identity starts with something to read: the people behind
  // coinos, a Bitcoin feed, and one topic as an example of what a feed can
  // be. Once per identity; a person who unfollows stays unfollowed.
  const STARTER_FOLLOWS = [
    '98ae4da926c471c23fd12d1ebdd5839ba82917baa618e184e0c9916d93dcf4f7', // Adam
    '72bdbc57bdd6dfc4e62685051de8041d148c3c68fe42bf301f71aa6cf53e52fb', // coinos
  ];
  // The Bitcoin feed's follow pack (NIP-51 kind 39089): { pk, d, relays, title }.
  // Until one is chosen there is no Bitcoin feed — a #bitcoin topic feed was
  // too noisy to hand a newcomer.
  const STARTER_BITCOIN_PACK = null;
  async function seedNewIdentity({ onlyIfNoFollows = false } = {}) {
    const s = st();
    if (s.seeded) return;
    s.seeded = Date.now();
    const at = Date.now();
    const feeds = [
      STARTER_BITCOIN_PACK ? { id: 'starter-bitcoin', name: 'Bitcoin', follows: false, authors: [], packs: [STARTER_BITCOIN_PACK], topics: [], at } : null,
      { id: 'starter-gardenstr', name: '#gardenstr', follows: false, authors: [], packs: [], topics: ['gardenstr'], at },
    ].filter(Boolean);
    for (const f of feeds) if (!s.feeds.some((x) => x.id === f.id)) s.feeds.push(f);
    save(s);
    if (onlyIfNoFollows) {
      await syncFollows({ force: true }).catch(() => {});
      if (followsNow().set.size) return;
    }
    followMany(STARTER_FOLLOWS).catch(() => {});
  }
  // Follow several people in one kind-3 update (toggleFollow is one at a time
  // and locks while it publishes).
  async function followMany(pks) {
    if (followsPub) return;
    const id = await requireIdentity();
    const want = pks.filter((pk) => pk && pk !== id.pubkey);
    if (!want.length) return;
    followsPub = true;
    const before = followsNow();
    try {
      await syncFollows({ force: true }).catch(() => {});
      const fetched = followsNow();
      const base = fetched.at > before.at ? fetched : before;
      const add = want.filter((pk) => !base.set.has(pk));
      if (!add.length) return;
      const tags = [...base.tags, ...add.map((pk) => ['p', pk])];
      const created_at = Math.max(Math.floor(Date.now() / 1000), base.at + 1);
      const partial = { kind: 3, content: base.content || '', created_at, tags };
      const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
      saveFollows({ set: new Set(pTags(tags).map((x) => x[1])), tags, content: base.content || '', at: created_at });
      feedAuthorsChanged();
      publishOn(zapRelays(), evt).catch(() => {});
      syncInbox({ force: true }).catch(() => {});
    } finally {
      followsPub = false;
      render();
    }
  }
  async function toggleFollow(pk) {
    if (!pk || followsPub) return;
    const id = await requireIdentity();
    if (pk === id.pubkey) return;
    followsPub = true;
    const before = followsNow();
    // paint the answer now, decide the real list a beat later
    saveFollows({ ...before, set: new Set(before.set.has(pk) ? [...before.set].filter((x) => x !== pk) : [...before.set, pk]) });
    render();
    try {
      await syncFollows({ force: true });
      // The list to publish is the relays' copy if it's genuinely newer than
      // what we held, and otherwise what we held BEFORE the optimistic paint
      // — reading our own paint back as fact made a follow publish a list
      // without it, and a mute publish a list without the mute.
      const fetched = followsNow();
      const base = fetched.at > before.at ? fetched : before;
      const had = base.set.has(pk);
      const tags = had
        ? base.tags.filter((x) => !(x[0] === 'p' && x[1] === pk))
        : [...base.tags, ['p', pk]];
      const created_at = Math.max(Math.floor(Date.now() / 1000), base.at + 1);
      const partial = { kind: 3, content: base.content || '', created_at, tags };
      const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
      const ok = await publishOn(zapRelays(), evt);
      if (!ok) throw new Error(t('msgSendFailed'));
      saveFollows({ set: new Set(pTags(tags).map((x) => x[1])), tags, content: base.content || '', at: created_at });
      feedAuthorsChanged();
      syncInbox({ force: true }).catch(() => {}); // the SW's friend filter reads this list
      toast(had ? t('feedUnfollowed') : t('feedFollowed'));
    } catch (e) {
      saveFollows(before);
      if (!(e instanceof NoIdentity)) toast(e.message || String(e));
    } finally {
      followsPub = false;
      render();
    }
  }

  // ---- outbox: where each person actually publishes -------------------------
  // NIP-65. Asking our own three relays for everyone's posts only ever finds
  // the people who happen to use them — the rest are invisible, and it looks
  // like they stopped posting. So each author's own WRITE relays are read
  // instead. Lists are fetched in batches and kept for a week; the authors are
  // then covered greedily, so a feed of hundreds of people is a handful of
  // sockets that between them reach everyone rather than one socket each.
  const RELAY_LISTS = 'relayLists';
  const RELAY_LIST_TTL = 7 * 24 * 3600_000;
  // Sockets we'll open for one pass. Ten covered all but 66 of a real
  // 862-follow list; twenty-five covered all but 26. Amethyst runs near a
  // hundred — this is the same idea, kept to a number a phone can hold.
  const OUTBOX_MAX = 24;
  // Write relays taken from any one list. Three looks sufficient — everyone
  // ends up covered — but covered is not the same as read: people publish to
  // several relays and each holds a different slice. Measured over 250 real
  // authors, of the 60 with a write list, 45 declared MORE than three, and
  // seven of twenty-five sampled had posts living only on their fourth or
  // later relay.
  const PER_AUTHOR = 6;
  let relayLists = null;  // pk -> { r: [url], t }

  function relayListsNow() {
    if (!relayLists) {
      relayLists = new Map();
      try {
        for (const [pk, v] of Object.entries(wallet.loadFeatureState(RELAY_LISTS, {}) || {}))
          if (v && Date.now() - (v.t || 0) < RELAY_LIST_TTL) relayLists.set(pk, v);
      } catch {}
    }
    return relayLists;
  }
  function saveRelayLists() {
    try {
      const out = {};
      // the people we follow are the ones worth remembering; a page visit
      // shouldn't push them out
      const keep = new Set([...followsNow().set]);
      let spare = 200 - keep.size;
      for (const [pk, v] of relayListsNow()) {
        if (keep.has(pk)) out[pk] = v;
        else if (spare-- > 0) out[pk] = v;
      }
      wallet.saveFeatureState(RELAY_LISTS, out);
    } catch {}
  }
  // A relay list is written by whoever owns it, and some of them are wrong:
  // one in this wallet's follows has three URLs crammed into a single r tag,
  // space-separated. Fed to the pool that throws, and every author covered by
  // that relay quietly returns nothing. So each one has to parse as a URL,
  // and anything else is dropped rather than trusted.
  const okRelay = (u) => {
    if (typeof u !== 'string' || /\s/.test(u) || u.length > 200) return false;
    try { const p2 = new URL(u); return p2.protocol === 'wss:' && !!p2.host; } catch { return false; }
  };
  const writeRelaysIn = (ev) => [...new Set((ev.tags || [])
    .filter((x) => x[0] === 'r' && x[2] !== 'read' && okRelay(x[1]))
    .map((x) => String(x[1]).replace(/\/+$/, '')))].slice(0, PER_AUTHOR);

  // One REQ per hundred authors, against our own relays — a relay list is
  // small, widely mirrored, and worth having before anything else is asked.
  // Authors with no list at all are remembered as such, so we don't ask again
  // every time the feed refreshes.
  async function fetchRelayLists(pks) {
    const want = [...new Set(pks)].filter((pk) => !relayListsNow().has(pk));
    if (!want.length) return;
    for (let i = 0; i < want.length; i += 100) {
      const batch = want.slice(i, i + 100);
      const evs = await queryOn(NOTE_RELAYS, { kinds: [10002], authors: batch }, 4500).catch(() => []);
      const newest = new Map();
      for (const ev of evs || []) {
        const cur = newest.get(ev.pubkey);
        if (!cur || ev.created_at > cur.created_at) newest.set(ev.pubkey, ev);
      }
      for (const pk of batch) {
        const ev = newest.get(pk);
        relayListsNow().set(pk, { r: ev ? writeRelaysIn(ev) : [], t: Date.now() });
      }
    }
    saveRelayLists();
  }

  // The fewest relays that between them carry every author: take the relay
  // covering the most people not yet covered, repeat.
  //
  // Our own relays are then asked about EVERYONE as well, not just the people
  // with no list. Measured over eight busy accounts, each source holds posts
  // the other misses — reading only the author's own relays found 7 to 40
  // notes ours had never seen, and ours held plenty theirs didn't. The feed
  // wants the union, so the outbox adds reach rather than replacing it.
  function outboxPlan(authors) {
    const lists = relayListsNow();
    const byRelay = new Map();
    const orphans = [];
    for (const pk of authors) {
      const r = (lists.get(pk) || {}).r || [];
      if (!r.length) { orphans.push(pk); continue; }
      for (const url of r) {
        if (!byRelay.has(url)) byRelay.set(url, new Set());
        byRelay.get(url).add(pk);
      }
    }
    const orphaned = new Set(orphans);
    const covered = authors.filter((pk) => !orphaned.has(pk)); // the rest are on our relays below
    let left = new Set(covered);
    const plan = [];
    // Covering every author ONCE was the old stopping rule, and it was the
    // wrong goal: it finished in nineteen sockets of a twenty-four socket
    // budget and left posts unread on the relays it never opened. So the
    // greedy runs again over whoever the unused relays still reach, until
    // the budget is actually spent. Measured on the same 250 authors: 1303
    // notes before, 1624 after — a quarter more, for sockets we were already
    // willing to open.
    for (;;) {
      while (left.size && plan.length < OUTBOX_MAX) {
        let best = null, bestN = 0;
        for (const [url, set] of byRelay) {
          let n = 0;
          for (const pk of set) if (left.has(pk)) n++;
          if (n > bestN) { bestN = n; best = url; }
        }
        if (!best) break;
        const take = [...byRelay.get(best)].filter((pk) => left.has(pk));
        plan.push({ relays: [best], authors: take });
        for (const pk of take) left.delete(pk);
        byRelay.delete(best);
      }
      if (plan.length >= OUTBOX_MAX || !byRelay.size) break;
      // everyone the relays we HAVEN'T opened can still reach
      const again = new Set();
      for (const set of byRelay.values()) for (const pk of set) again.add(pk);
      if (!again.size) break;
      left = again;
    }
    plan.push({ relays: zapRelays(), authors });
    return plan;
  }

  // ---- the feed: posts from the people you follow ---------------------------
  // Their kind-1 notes, newest first, replies left out — a reply belongs to
  // its thread, and a timeline of half-conversations reads like eavesdropping.
  // Cached events avoid waiting for relays; their presentation is prepared
  // before the reading surface is shown.
  const FEED_CACHE = 'feedNotes';
  const FEED_LIMIT = 30;
  const FEED_PAGE = 10;    // posts on screen at once, grown as you scroll
  const FEED_KEEP = 80;   // memory target; retain rows already being read
  const FEED_STORE = FEED_CACHE_POSTS;   // ...and on disk
  let feed = null;         // the feed on screen: { id, status, notes, shown, end, loadingMore, at }
  let feedUnsubs = [];
  // ---- many feeds ----------------------------------------------------------
  // "Following" is one feed among any number the user defines: a set of
  // people (or everyone they follow), a set of topics (hashtags, any of
  // them), or both at once — people AND topics, the way a nostr filter
  // composes them. Definitions live in the synced messages state, so a feed
  // made on the phone is on the laptop too; each feed keeps its own notes,
  // clock and disk cache. A topic opened from search or a #tag in a post is
  // a feed too, until saved just a session one.
  const FOLLOWING = 'following';
  const FEED_LS = 'btc-wallet-feed'; // the feed last on screen, remembered per device
  const feedStates = new Map(); // id -> state
  const adhocFeeds = new Map(); // id -> definition, this session only
  let curFeedId = (() => { try { return localStorage.getItem(FEED_LS) || FOLLOWING; } catch { return FOLLOWING; } })();
  const feedList = () => [{ id: FOLLOWING, name: t('feedFollowingName'), follows: true, builtin: true }, ...st().feeds];
  function feedDef(id = curFeedId) {
    if (id === FOLLOWING) return feedList()[0];
    return st().feeds.find((f) => f.id === id) || adhocFeeds.get(id) || null;
  }
  const normTopic = (x) => String(x || '').trim().replace(/^#/, '').toLowerCase();
  // ---- follow packs (NIP-51 kind 39089, what following.space publishes) ---
  // A feed can name packs instead of (or as well as) people: the pack's
  // current members are its authors, read from the pack event itself, so
  // a curator adding someone reaches your feed without you doing anything.
  // Members are cached on disk so a cold boot paints the feed at once, and
  // refreshed from the relays when a feed that uses them is opened.
  const PACK_KIND = 39089;
  const PACK_CACHE = 'followPacks';
  const PACK_RELAYS = [...new Set([...PROFILE_RELAYS, 'wss://relay.nostr.band'])];
  const packKey = (p) => p.pk + ':' + p.d + (p.kind && p.kind !== PACK_KIND ? ':' + p.kind : '');
  let packMembers = null; // key -> { pks, title, at }
  const packsNow = () => {
    if (!packMembers) { try { packMembers = wallet.loadFeatureState(PACK_CACHE, {}) || {}; } catch { packMembers = {}; } }
    return packMembers;
  };
  const packOf = (p) => packsNow()[packKey(p)] || null;
  // A pasted following.space link (/d/<id>?p=<pubkey>), a bare naddr, or
  // nostr:naddr — the pack it names.
  function parsePackLink(input) {
    const s = String(input || '').trim();
    const link = /\/d\/([^/?#\s]+)[^?\s]*\?(?:[^#\s]*&)?p=([0-9a-f]{64})/i.exec(s);
    if (link) return { pk: link[2].toLowerCase(), d: decodeURIComponent(link[1]), relays: [] };
    const m = /naddr1[a-z0-9]+/i.exec(s);
    if (!m) return null;
    const ref = parseNostrRef(m[0].toLowerCase());
    if (!ref || ref.type !== 'addr') return null;
    if (ref.kind === PACK_KIND) return { pk: ref.pk, d: ref.d, relays: ref.relays || [] };
    // someone's follow set (kind 30000) is a pack by another name
    if (ref.kind === LIST_KIND) return { pk: ref.pk, d: ref.d, relays: ref.relays || [], kind: LIST_KIND };
    return null;
  }
  // Every pack the wide relays hold, once per session: the way to find one
  // by a few letters of its title — NIP-50 search only knows the packs the
  // search relay happens to carry, and most live on damus / nos.lol.
  let packIndex = null;
  function loadPackIndex() {
    if (packIndex) return packIndex;
    packIndex = (async () => {
      const relays = [...new Set([...PACK_RELAYS, 'wss://relay.damus.io', 'wss://nos.lol'])];
      const all = await Promise.all(relays.map((r) => queryOn([r], { kinds: [PACK_KIND], limit: 500 }, 6000).catch(() => [])));
      const newest = new Map();
      for (const ev of all.flat()) {
        const p = packFromEvent(ev);
        if (!p.pks.length) continue;
        const cur = newest.get(packKey(p));
        if (!cur || p.at > cur.at) newest.set(packKey(p), { ...p, desc: (ev.tags.find((x) => x[0] === 'description') || [])[1] || '' });
      }
      return [...newest.values()];
    })();
    packIndex.catch(() => { packIndex = null; });
    return packIndex;
  }
  const packFromEvent = (ev) => ({
    pk: ev.pubkey, d: (ev.tags.find((x) => x[0] === 'd') || [])[1] || '',
    title: (ev.tags.find((x) => x[0] === 'title') || [])[1] || '',
    pks: [...new Set(ev.tags.filter((x) => x[0] === 'p' && /^[0-9a-f]{64}$/i.test(x[1] || '')).map((x) => x[1].toLowerCase()))],
    at: ev.created_at,
  });
  const packFetching = new Map();
  async function fetchPack(p) {
    const key = packKey(p);
    if (packFetching.has(key)) return packFetching.get(key);
    const job = (async () => {
      const relays = [...new Set([...(p.relays || []), ...PACK_RELAYS])];
      const evs = await queryOn(relays, { kinds: [p.kind || PACK_KIND], authors: [p.pk], '#d': [p.d] }, 4500).catch(() => []);
      const newest = (evs || []).sort((a, b) => b.created_at - a.created_at)[0];
      if (!newest) return packOf(p);
      const got = packFromEvent(newest);
      const cur = packOf(p);
      if (cur && cur.at >= got.at) return cur;
      packsNow()[key] = { pks: got.pks, title: got.title, at: got.at };
      try { wallet.saveFeatureState(PACK_CACHE, packsNow()); } catch {}
      return packsNow()[key];
    })().finally(() => packFetching.delete(key));
    packFetching.set(key, job);
    return job;
  }
  // Make sure a feed's packs are read (or re-read: once an hour is plenty
  // for a curated list), and rebuild the feed when its authors grew.
  const PACK_TTL = 60 * 60_000;
  const packRefreshed = new Map(); // key -> ms
  function resolvePacks(def) {
    const packs = (def && def.packs) || [];
    if (!packs.length) return;
    const due = packs.filter((p) => !packOf(p) || Date.now() - (packRefreshed.get(packKey(p)) || 0) > PACK_TTL);
    if (!due.length) return;
    for (const p of due) packRefreshed.set(packKey(p), Date.now());
    Promise.all(due.map((p) => fetchPack(p).catch(() => null))).then(() => {
      const c = feedStates.get(def.id);
      if (!c) return;
      c.at = 0;
      if (c === feed) refreshFeed({ live: false }, c); else feedStates.delete(def.id);
      scheduleRepaint();
    });
  }
  // The packs' members, from cache; asks the relays on the side when stale.
  function packAuthors(def) {
    const out = new Set();
    for (const p of (def && def.packs) || []) for (const pk of (packOf(p) || {}).pks || []) out.add(pk);
    resolvePacks(def);
    return out;
  }
  const feedTopics = (def = feedDef()) => [...new Set(((def && def.topics) || []).map(normTopic).filter(Boolean))].slice(0, 20);
  const feedHasQuery = (def = feedDef()) => !!def && (feedAuthors(def).length > 0 || feedTopics(def).length > 0);
  const feedCacheKey = (id) => (id === FOLLOWING ? FEED_CACHE : FEED_CACHE + ':' + id);
  const feedDisk = () => typeof wallet.featureStateKey === 'function'
    ? createFeedCache(localStorage, wallet.featureStateKey(FEED_CACHE)) : null;
  const saveFeedCache = (c) => {
    if (adhocFeeds.has(c.id)) return; // a session feed leaves nothing behind
    try {
      const notes = c.notes.slice(0, FEED_STORE);
      const disk = feedDisk();
      if (disk) disk.save(c.id, notes);
      else wallet.saveFeatureState(feedCacheKey(c.id), notes);
    } catch {}
  };
  // posts on a topic come from the big public relays as well as ours: a
  // hashtag has no author whose outbox we could read
  const TOPIC_RELAYS = [...new Set([...NOTE_RELAYS, 'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://nos.lol'])];

  // ---- lists (NIP-51 follow sets, kind 30000) ------------------------------
  // A feed of hand-picked people IS a nostr list. Saved here it is published
  // under your key as a follow set, so Coracle, Nostria, Amethyst and the
  // rest show the same list; a list made in one of them turns up here as a
  // feed. The relays' copy wins when it is newer than ours (edited over
  // there); ours goes out on top of whatever they hold, carrying the
  // encrypted content other clients keep their private members in — those
  // are read (nip44 to yourself) and followed, never rewritten.
  const LIST_KIND = 30000;
  const LIST_SYNC_MS = 10 * 60_000;
  let listsAt = 0;
  let listsJob = null;
  const dTagOf = (ev) => (ev.tags.find((x) => x[0] === 'd') || [])[1];
  const listTopics = (ev) => [...new Set(ev.tags.filter((x) => x[0] === 't' && x[1]).map((x) => normTopic(x[1])).filter(Boolean))].slice(0, 20);
  async function privateMembers(ev) {
    if (!ev.content) return [];
    const c = (await selfCryptors()).find((x) => x.pk === ev.pubkey);
    if (!c) return [];
    try {
      const tags = JSON.parse(await c.dec(ev.content));
      return Array.isArray(tags) ? [...new Set(pTags(tags).map((x) => x[1].toLowerCase()))] : [];
    } catch { return []; } // nip04 from an older client, or not ours to read
  }
  // Your lists as the relays hold them, folded into the feeds: a new list
  // becomes a feed, a newer copy of a known one brings its members over.
  function syncFollowSets({ force = false } = {}) {
    const me = mePk();
    if (!me) return Promise.resolve();
    if (listsJob) return listsJob;
    if (!force && Date.now() - listsAt < LIST_SYNC_MS) return Promise.resolve();
    listsAt = Date.now();
    listsJob = (async () => {
      const mine = await Promise.resolve(relaysOf(me)).catch(() => []);
      const relays = [...new Set([...zapRelays(), ...(mine || []), ...PACK_RELAYS])];
      let evs;
      try { evs = await queryOn(relays, { kinds: [LIST_KIND], authors: [me] }, 5000); } catch { listsAt = 0; return; }
      const newest = new Map();
      for (const ev of evs || []) {
        const d = dTagOf(ev);
        if (d == null) continue;
        const cur = newest.get(d);
        if (!cur || ev.created_at > cur.created_at) newest.set(d, ev);
      }
      const s = st();
      let changed = false;
      for (const [d, ev] of newest) {
        const gone = (s.listsGone || {})[d];
        if (gone && ev.created_at <= gone) continue; // deleted here; a relay still serving it
        const cur = s.feeds.find((f) => f.d === d);
        if (cur && (cur.listAt || 0) >= ev.created_at) continue;
        const got = packFromEvent(ev);
        const priv = await privateMembers(ev);
        const pub = got.pks.filter((pk) => !priv.includes(pk));
        const topics = listTopics(ev);
        if (!cur && !pub.length && !priv.length && !topics.length) continue; // an empty list is not a feed
        const patch = { name: got.title || (cur && cur.name) || d, authors: pub.slice(0, FEED_AUTHORS_MAX), priv, topics, d, listAt: ev.created_at, listContent: ev.content || '', at: Date.now() };
        if (cur) Object.assign(cur, patch);
        else s.feeds.push({ id: 'list:' + d, follows: false, packs: [], ...patch });
        feedStates.delete(cur ? cur.id : 'list:' + d); // its query changed
        changed = true;
      }
      if (changed) { save(s); scheduleRepaint(); }
    })().finally(() => { listsJob = null; });
    return listsJob;
  }
  // Publish a feed as a follow set: its people as public p tags (a list's
  // private members stay in the content, untouched), its topics as t tags.
  async function publishFollowSet(def) {
    const id = await requireIdentity();
    const d = def.d || def.id;
    const tags = [['d', d], ['title', def.name || d],
      ...(def.authors || []).map((pk) => ['p', pk]),
      ...feedTopics(def).map((x) => ['t', x])];
    const created_at = Math.max(Math.floor(Date.now() / 1000), (def.listAt || 0) + 1);
    const partial = { kind: LIST_KIND, content: def.listContent || '', created_at, tags };
    const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
    const ok = await publishOn(zapRelays(), evt);
    if (!ok) throw new Error(t('msgSendFailed'));
    const s = st();
    const cur = s.feeds.find((f) => f.id === def.id);
    if (cur) { cur.d = d; cur.listAt = created_at; save(s); }
    return d;
  }
  // NIP-09: ask the relays to drop the list — and remember that we did, so
  // a relay that keeps it anyway doesn't bring it back as a feed.
  async function deleteFollowSet(def) {
    if (!def || !def.d) return;
    const s = st();
    const created_at = Math.floor(Date.now() / 1000);
    const gone = Object.entries(s.listsGone || {}).sort((a, b) => b[1] - a[1]).slice(0, 99);
    s.listsGone = Object.fromEntries([[def.d, created_at], ...gone]);
    save(s);
    const id = await requireIdentity();
    const partial = { kind: 5, content: '', created_at, tags: [['a', LIST_KIND + ':' + id.pubkey + ':' + def.d], ['k', String(LIST_KIND)]] };
    const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
    await publishOn(zapRelays(), evt);
  }
  // Someone's lists — follow sets and packs — for their profile page; the
  // members are cached as packs, so a tapped list opens as a feed at once.
  const profileLists = new Map(); // pk -> { at, status, items: [{ pk, d, kind, title, n }] }
  const LISTS_TTL = 60 * 60_000;
  function listsFor(pk) {
    let c = profileLists.get(pk);
    if (c && Date.now() - c.at < LISTS_TTL) return c;
    c = { at: Date.now(), status: 'loading', items: c ? c.items : [] };
    profileLists.set(pk, c);
    (async () => {
      const own = await Promise.resolve(relaysOf(pk)).catch(() => []);
      const relays = [...new Set([...PACK_RELAYS, ...(own || [])])];
      const evs = await queryOn(relays, { kinds: [LIST_KIND, PACK_KIND], authors: [pk] }, 5000).catch(() => []);
      const newest = new Map();
      for (const ev of evs || []) {
        const p = { ...packFromEvent(ev), kind: ev.kind };
        const key = packKey(p);
        const cur = newest.get(key);
        if (!cur || p.at > cur.at) newest.set(key, p);
      }
      const items = [...newest.values()].filter((p) => p.pks.length).sort((a, b) => b.at - a.at);
      for (const p of items) {
        const cur = packOf(p);
        if (!cur || cur.at < p.at) packsNow()[packKey(p)] = { pks: p.pks, title: p.title, at: p.at };
      }
      if (items.length) { try { wallet.saveFeatureState(PACK_CACHE, packsNow()); } catch {} }
      c.items = items.map((p) => ({ pk: p.pk, d: p.d, kind: p.kind, title: p.title || p.d, n: p.pks.length }));
      c.status = 'ready';
      scheduleRepaint();
    })().catch(() => { c.status = 'ready'; });
    return c;
  }
  // Open someone's list as a feed: yours is the saved feed it already is;
  // anyone else's a session feed built on it as a pack, savable from there.
  function openListFeed(p) {
    const own = p.pk === mePk() ? st().feeds.find((f) => f.d === p.d) : null;
    const id = own ? own.id : 'list:' + packKey(p);
    if (!own) adhocFeeds.set(id, { id, name: p.title || p.d, packs: [{ pk: p.pk, d: p.d, kind: p.kind === PACK_KIND ? undefined : p.kind, relays: [], title: p.title || '' }] });
    ui.userSearch = null; ui.profilePk = null; ui.noteThread = null; ui.feedEdit = null; ui.profOverThread = false;
    ui.chatOpen = true; ui.msgView = 'feed';
    switchFeed(id);
  }
  // Which of your feeds someone is in — and a tap to put them in another.
  function listPickSheet() {
    if (!ui.listPick) return null;
    const pk = ui.listPick;
    const close = () => { ui.listPick = null; render(); };
    const feeds = st().feeds;
    const toggle = (f) => {
      const s = st();
      const def = s.feeds.find((x) => x.id === f.id);
      if (!def || (def.priv || []).includes(pk)) return;
      const had = (def.authors || []).includes(pk);
      def.authors = had ? def.authors.filter((x) => x !== pk) : [...(def.authors || []), pk].slice(0, FEED_AUTHORS_MAX);
      def.at = Date.now();
      save(s);
      feedStates.delete(def.id);
      render();
      if (def.d) publishFollowSet(def).catch((e) => { if (!(e instanceof NoIdentity)) toast(e.message || String(e)); });
    };
    return h('div', {
      class: 'confirm-pop-backdrop',
      onClick: (e) => { if (e.target === e.currentTarget) close(); },
    },
      h('div', { class: 'card col confirm-pop list-pick', style: 'gap:8px' },
        h('div', { class: 'row gap6', style: 'align-items:center' },
          avatar(pk, 'chat-avatar', false),
          h('div', { class: 'col', style: 'min-width:0' },
            h('div', { class: 'chat-name' }, displayName(pk)),
            h('div', { class: 'small muted' }, t('listPickTitle')))),
        feeds.length ? null : h('div', { class: 'small faint' }, t('listPickEmpty')),
        ...feeds.map((f) => {
          const on = (f.authors || []).includes(pk) || (f.priv || []).includes(pk);
          return h('button', {
            class: 'btn-block list-pick-row' + (on ? ' on' : ''), style: 'text-align:left', type: 'button',
            'aria-pressed': on ? 'true' : 'false',
            onClick: () => toggle(f),
          }, (on ? '\u2611' : '\u2610') + '  ' + f.name);
        }),
        h('button', {
          class: 'btn-block', style: 'text-align:left', type: 'button',
          onClick: () => {
            ui.listPick = null;
            // the editor lives on the feed screen; the profile gives way to it
            ui.profilePk = null; ui.profOverThread = false; ui.noteThread = null; ui.userSearch = null;
            ui.chatOpen = true; ui.msgView = 'feed';
            openFeedEditor(null);
            ui.feedEdit.authors = [pk];
            render();
          },
        }, '+  ' + t('listNew')),
        h('button', { class: 'btn-ghost btn-block', onClick: close }, t('back'))));
  }

  // A reply, as against a post that merely POINTS at another one. NIP-10
  // marks a reply's e tags 'root' or 'reply'; a quote's are 'mention', and
  // NIP-18 quotes carry a q tag instead. Treating every e tag as a reply hid
  // quote-posts from the feed — the thing Amethyst shows as a card with the
  // quoted note inside it.
  const isReply = (ev) => {
    const es = (ev.tags || []).filter((x) => x[0] === 'e');
    if (!es.length) return false;
    if (es.some((x) => x[3] === 'root' || x[3] === 'reply')) return true;
    if (es.every((x) => x[3] === 'mention')) return false;
    // unmarked (the deprecated positional form): a q tag means it's a quote,
    // otherwise assume the older convention, where e meant reply
    return !(ev.tags || []).some((x) => x[0] === 'q');
  };
  // Everyone you follow. This was capped at 500, which on an 862-follow list
  // meant 362 people were silently missing from the feed — 164 of the 166
  // posts a wider net found in one six-hour window were theirs.
  const FEED_AUTHORS_MAX = 2000;
  const REQ_AUTHORS = 400; // authors per REQ, so one filter stays a sane size
  const feedAuthors = (def = feedDef()) => {
    if (!def) return [];
    const set = new Set(def.follows ? followsNow().set : []);
    for (const pk of def.authors || []) if (pk) set.add(pk);
    for (const pk of def.priv || []) if (pk) set.add(pk); // a list's private members
    for (const pk of packAuthors(def)) set.add(pk);
    return [...set].slice(0, FEED_AUTHORS_MAX);
  };

  function feedNow() {
    if (!feedDef(curFeedId)) curFeedId = FOLLOWING; // a feed deleted on another device
    let c = feedStates.get(curFeedId);
    if (!c) {
      let stored = [];
      try { stored = feedDisk()?.read(curFeedId) || wallet.loadFeatureState(feedCacheKey(curFeedId), []) || []; } catch {}
      if (!Array.isArray(stored)) stored = [];
      stored = stored.slice(0, FEED_STORE);
      c = { id: curFeedId, status: 'loading', notes: stored, shown: FEED_PAGE, at: 0, booting: true, presentations: new Map() };
      feedStates.set(curFeedId, c);
      while (feedStates.size > 4) {
        const oldest = feedStates.keys().next().value;
        feedStates.get(oldest).stopped = true;
        feedStates.delete(oldest);
      }
      feed = c;
      // Only the opening page gates first paint. The next page warms on the
      // side, so an offscreen image cannot delay the whole feed.
      c.boot = notesReady(stored.slice(0, FEED_PAGE)).finally(() => {
        c.booting = false;
        if (!c.stopped && ui.chatOpen && ui.msgView === 'feed' && c === feed) scheduleRepaint();
      });
      c.boot.then(() => {
        if (c.stopped) return;
        notesReady(stored.slice(FEED_PAGE, FEED_PAGE * 2));
      });
      prefetchFeed(c);
    }
    feed = c;
    return c;
  }
  let feedWarmTimer = null, feedWarmSession = 0;
  async function prefetchFeed(c) {
    const def = feedDef(c.id);
    const authors = feedAuthors(def).slice(0, REQ_AUTHORS), topics = feedTopics(def);
    if (!authors.length && !topics.length) { c.status = 'ready'; return; }
    c.at = Date.now();
    try {
      const events = await queryOn(NOTE_RELAYS, { kinds: [1], limit: FEED_PAGE,
        ...(authors.length ? { authors } : {}), ...(topics.length ? { '#t': topics } : {}) }, 3000);
      if (c.stopped) return;
      await mergeFeed(events.filter((e) => e.kind === 1 && !isReply(e) && !hidden(e))
        .sort((a, b) => b.created_at - a.created_at).slice(0, FEED_PAGE), {}, c);
    } catch {} finally {
      if (!c.stopped) {
        c.status = 'ready';
        if (c === feed && ui.chatOpen && ui.msgView === 'feed') { scheduleRepaint(); watchFeed(); }
      }
    }
  }
  function switchFeed(id) {
    if (!feedDef(id)) return;
    if (id !== curFeedId) {
      curFeedId = id;
      if (!adhocFeeds.has(id)) { try { localStorage.setItem(FEED_LS, id); } catch {} }
    }
    stopFeedWatch();
    const c = feedNow();
    c.unseen = 0; c.shown = FEED_PAGE;
    admitFeed(c.deferred || [], c, true);
    // An already warmed feed can paint synchronously on entry.
    if (!c.booting) c.presentations.clear();
    watchFeed();
    refreshFeed({}, c);
    try { window.scrollTo({ top: 0 }); } catch {}
    render();
  }
  // A follow list that changed means every feed built on it has the wrong
  // authors — the one on screen is rebuilt in place, not offered behind the
  // pill; the others are simply forgotten and rebuilt when next opened.
  function feedAuthorsChanged() {
    for (const c of [...feedStates.values()]) {
      const def = feedDef(c.id);
      if (!def || !def.follows) continue;
      if (c === feed) { c.at = 0; refreshFeed({ live: false }, c); } else feedStates.delete(c.id);
    }
  }
  // A topic straight from search or a #tag in a post: a feed for this
  // session (a saved single-topic feed with the same tag is reused).
  function openTopicFeed(tag) {
    tag = normTopic(tag);
    if (!tag) return;
    const saved = st().feeds.find((f) => !f.follows && !(f.authors || []).length && feedTopics(f).length === 1 && feedTopics(f)[0] === tag);
    const id = saved ? saved.id : 'topic:' + tag;
    if (!saved) adhocFeeds.set(id, { id, name: '#' + tag, topics: [tag] });
    ui.userSearch = null; ui.profilePk = null; ui.noteThread = null; ui.feedEdit = null;
    ui.chatOpen = true; ui.msgView = 'feed';
    switchFeed(id);
  }
  // Reaching the top manually clears the new-post notice.
  const FEED_TOP_PX = 120;
  const atFeedTop = () => {
    try { return (window.scrollY || 0) < FEED_TOP_PX; } catch { return true; }
  };

  // Resolve the whole first presentation before admitting a row. The
  // deadline leaves unavailable resources as stable, clickable fallbacks;
  // a late response is useful on the next visit, not a mid-read replacement.
  const READY_MS = 8000;
  const mediaReady = new Map(); // URL -> decoded dimensions
  const mediaWarming = new Map();
  const warmMedia = (url) => {
    if (!url || mediaReady.has(url) || typeof Image === 'undefined') return Promise.resolve();
    if (mediaWarming.has(url)) return mediaWarming.get(url);
    const task = new Promise((resolve) => {
      const img = new Image();
      const timer = setTimeout(() => done(false), READY_MS);
      const done = (ok) => {
        clearTimeout(timer);
        img.onload = img.onerror = null;
        if (ok) mediaReady.set(url, { width: img.naturalWidth, height: img.naturalHeight });
        resolve();
      };
      img.onload = () => { (img.decode ? img.decode() : Promise.resolve()).then(() => done(true), () => done(false)); };
      img.onerror = () => done(false);
      img.src = url;
    }).finally(() => mediaWarming.delete(url));
    mediaWarming.set(url, task);
    return task;
  };
  function noteMediaUrls(content) {
    const urls = [];
    for (const part of String(content || '').split(NOTE_SPLIT)) {
      if (!part) continue;
      const md = MD_PARTS.exec(part);
      const url = md ? md[3] : (/^https?:\/\//i.test(part) ? part : null);
      if (!url) continue;
      if ((md && md[1]) || /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i.test(url)) urls.push(url);
      else if (youtubeId(url)) urls.push('https://i.ytimg.com/vi/' + youtubeId(url) + '/hqdefault.jpg');
    }
    return urls;
  }
  const avatarUrl = (p, pk) => p?.picture
    ? localPunk(p.picture) || (p.thumbFor === p.picture && p.thumb) || p.picture
    : punkSmallUrl(pk);
  async function warmAvatar(pk, deadline) {
    let p = liveProfileOf(pk);
    while ((p === null || (p && p.loading && !p.picture)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      p = profiles.get(pk);
    }
    await warmMedia(avatarUrl(p, pk));
    if (p?.picture) makeThumb(pk, p);
  }
  async function noteReady(ev, deadline = Date.now() + READY_MS, depth = 0) {
    const tasks = [warmAvatar(ev.pubkey, deadline), ...noteMediaUrls(ev.content).map(warmMedia),
      ...[...emojiTagMap(ev.tags).values()].map(warmMedia)];
    for (const part of String(ev.content || '').split(NOTE_SPLIT)) {
      if (/^(nostr:|@?)(npub|nprofile)1/i.test(part)) {
        const ref = parseNostrRef(part.replace(/^(nostr:|@)/i, ''));
        if (ref?.pk) tasks.push(warmAvatar(ref.pk, deadline));
      } else if (!depth && /^nostr:(note|nevent)1/i.test(part)) {
        const ref = parseNostrRef(part.slice(6));
        if (ref?.type === 'event') {
          const quote = quotedNote(ref);
          tasks.push(Promise.resolve(quote.promise).then(() => quote.ev && noteReady(quote.ev, deadline, depth + 1)));
        }
      }
    }
    let timer;
    try {
      await Promise.race([Promise.all(tasks), new Promise((r) => { timer = setTimeout(r, Math.max(0, deadline - Date.now())); })]);
    } catch {} finally { clearTimeout(timer); }
  }
  const notesReady = (evs) => { const deadline = Date.now() + READY_MS; return Promise.all(evs.map((e) => noteReady(e, deadline))); };
  const keyed = (node, key) => { node.setAttribute('data-key', key); return node; };
  // Keep only the resources this row actually uses. Copying the entire
  // session media cache into every row grows quadratically as you scroll.
  function feedMedia(url) {
    if (!feedPaint) return mediaReady.get(url);
    if (!feedPaint.media.has(url)) feedPaint.media.set(url, mediaReady.get(url) || null);
    return feedPaint.media.get(url);
  }
  function feedRow(c, ev) {
    let presentation = c.presentations.get(ev.id);
    if (!presentation) {
      presentation = { profiles: new Map(), media: new Map(), quotes: new Map(), time: new Map() };
      c.presentations.set(ev.id, presentation);
    }
    const prev = feedPaint;
    feedPaint = presentation;
    try { return keyed(noteRow(ev.pubkey, ev, displayName(ev.pubkey)), ev.id); }
    finally { feedPaint = prev; }
  }

  // Posts at the door: filtered in synchronously, so the same note from a
  // second relay is dropped while the first copy is still warming.
  const feedStaged = new WeakMap();
  async function mergeFeed(evs, opts = {}, c = feedNow()) {
    let staged = feedStaged.get(c);
    if (!staged) feedStaged.set(c, staged = new Set());
    const known = new Set([...c.notes, ...(c.catchup || []), ...(c.deferred || [])].map((e) => e.id));
    for (const e of evs || []) noteForSpam(e);
    const add = (evs || []).filter((e) => e.kind === 1 && !isReply(e) && !hidden(e)
      && !known.has(e.id) && !staged.has(e.id) && known.add(e.id) && staged.add(e.id));
    if (!add.length) return false;
    if (c.booting) await c.boot;
    if (c.stopped) return false;
    await notesReady(add);
    if (c.stopped) return false;
    for (const e of add) staged.delete(e.id);
    // A catch-up is settled once, after every relay has answered (see
    // settleCatchup) — not chunk by chunk, which is what made the pill count
    // up in steps and land on the same round number every time.
    if (opts.catchup) {
      c.catchup = [...(c.catchup || []), ...add];
      return true;
    }
    admitFeed([...(c.deferred || []), ...add], c);
    return true;
  }

  // Never insert between the rows currently under the reader's eyes. Gap
  // fills wait until that part of the feed is offscreen; new posts above
  // the reading position can be inserted immediately with an anchor.
  function admitFeed(add, c, explicit = false) {
    const onScreen = c === feed && ui.chatOpen && ui.msgView === 'feed' && !ui.profilePk && !ui.noteThread;
    const rows = onScreen && !explicit ? [...document.querySelectorAll('.notes-feed > .row[data-key]')] : [];
    const topBefore = c.notes[0]?.created_at || 0;
    const result = mergeFeedWindow(c.notes, c.shown, add, {
      rows: rows.map((r) => ({ id: r.getAttribute('data-key'), top: r.getBoundingClientRect().top, bottom: r.getBoundingClientRect().bottom })),
      height: typeof window === 'undefined' ? 0 : window.innerHeight, keep: FEED_KEEP, page: FEED_PAGE,
    });
    c.deferred = result.deferred;
    if (!result.added.length) return;
    c.shown = c.opened ? result.shown : FEED_PAGE;
    c.notes = result.notes;
    const retained = new Set(c.notes.map((e) => e.id));
    for (const id of c.presentations.keys()) if (!retained.has(id)) c.presentations.delete(id);
    saveFeedCache(c);
    if (rows.length) {
      c.unseen = (c.unseen || 0) + result.added.filter((e) => e.created_at > topBefore).length;
      holdScroll(render);
    }
  }

  // The pill's tap: the posts are already in, so this just goes up to them.
  // Reaching the top by yourself clears it too (see the scroll listener).
  function jumpToNew() {
    const c = feed;
    if (!c) return;
    admitFeed(c.deferred || [], c, true);
    c.unseen = 0;
    try { window.scrollTo({ top: 0 }); } catch {}
    render();
  }
  // One pass over the plan: each relay is asked only for the authors it
  // actually carries. The slowest relay doesn't hold up the rest — every
  // answer merges as it lands.
  // `merge` rides along to mergeFeed: a catch-up after being away is exactly
  // as disruptive as a live arrival if you were reading halfway down, so it
  // goes behind the pill too. A first load, or paging older posts onto the
  // bottom, does not.
  async function feedPass(extra = {}, merge = {}, c = feedNow()) {
    const def = feedDef(c.id);
    if (!def) return false;
    const authors = feedAuthors(def), topics = feedTopics(def);
    const tag = topics.length ? { '#t': topics } : {};
    let got = false;
    if (!authors.length) {
      // topics alone: nobody's outbox to read, so the wide relays, one ask
      if (!topics.length) return false;
      const evs = await queryOn(TOPIC_RELAYS, { kinds: [1], ...tag, limit: FEED_LIMIT, ...extra }, 5000).catch(() => []);
      if (await mergeFeed(evs, merge, c)) { got = true; scheduleRepaint(); }
      return got;
    }
    await fetchRelayLists(authors);
    const plan = outboxPlan(authors);
    await Promise.all(plan.flatMap(({ relays, authors: a }) => {
      const chunks = [];
      for (let i = 0; i < a.length; i += REQ_AUTHORS) chunks.push(a.slice(i, i + REQ_AUTHORS));
      return chunks.map(async (chunk) => {
        const evs = await queryOn(relays, { kinds: [1], authors: chunk, ...tag, limit: FEED_LIMIT, ...extra }, 5000).catch(() => []);
        if (await mergeFeed(evs, merge, c)) { got = true; scheduleRepaint(); }
      });
    }));
    return got;
  }
  // Whatever a refresh finds goes behind the pill whenever posts are already
  // on screen — the cached page at boot included. Posts used to slide in a
  // beat after the page painted, moving what you had started reading. Only
  // a first load (nothing to disturb) or a rebuilt follow list goes straight in.
  async function refreshFeed(opts = {}, c = feedNow()) {
    // the relays are asked at once; what they answer waits for the warm-up
    // at the door (mergeFeed), not the asking
    if (!feedHasQuery(feedDef(c.id))) { c.status = 'ready'; return; }
    if (!opts.force && Date.now() - c.at < 30_000) return;
    c.at = Date.now();
    const catchup = opts.live != null ? !!opts.live : !!c.notes.length;
    try { await feedPass({}, { catchup }, c); } catch {} finally {
      c.status = 'ready';
      if (catchup) settleCatchup(c); else scheduleRepaint();
    }
    if (c === feed) watchFeed();
  }
  // Catch-up uses the same anchor even after a long absence. Only an
  // explicit tap on the new-post notice takes the reader to the top.
  function settleCatchup(c = feed) {
    if (!c) return;
    const add = c.catchup || [];
    c.catchup = [];
    admitFeed([...(c.deferred || []), ...add], c);
    scheduleRepaint();
  }
  // Repaint with the page held still: the post at the top of the viewport
  // stays where it was, however much was inserted above it. Measured after
  // the paint, so a browser that anchored the scroll itself isn't corrected
  // twice.
  function holdScroll(paint) {
    let key = null, top = 0;
    try {
      for (const r of document.querySelectorAll('.notes-feed > .row[data-key]')) {
        const b = r.getBoundingClientRect();
        if (b.bottom > 0 && b.top < window.innerHeight) { key = r.getAttribute('data-key'); top = b.top; break; }
      }
    } catch {}
    paint();
    if (!key) return;
    try {
      const r = document.querySelector('.notes-feed > [data-key="' + CSS.escape(key) + '"]');
      const d = r ? r.getBoundingClientRect().top - top : 0;
      if (Math.abs(d) > 1) window.scrollBy(0, d);
    } catch {}
  }
  // While the feed is what's on screen, new posts arrive by themselves — on
  // the same relays the pass above reads, one subscription each.
  function watchFeed() {
    stopFeedWatch();
    const def = feedDef();
    if (!feedHasQuery(def) || !ui.chatOpen || ui.msgView !== 'feed') return;
    const c = feedNow();
    const since = Math.floor(Date.now() / 1000) - 60;
    const topics = feedTopics(def), tag = topics.length ? { '#t': topics } : {};
    const on = (ev) => { mergeFeed([ev], { live: true }, c).then((ok) => { if (ok) scheduleRepaint(); }).catch(() => {}); };
    const authors = feedAuthors(def);
    if (!authors.length) { feedUnsubs.push(subscribeOn(TOPIC_RELAYS, { kinds: [1], ...tag, since }, on)); return; }
    for (const { relays, authors: a } of outboxPlan(authors))
      for (let i = 0; i < a.length; i += REQ_AUTHORS)
        feedUnsubs.push(subscribeOn(relays, { kinds: [1], authors: a.slice(i, i + REQ_AUTHORS), ...tag, since }, on));
  }
  function stopFeedWatch() {
    for (const u of feedUnsubs) { try { u(); } catch {} }
    feedUnsubs = [];
  }
  // Prepare older pages several screens ahead of the reader. A scroll while
  // preparation is underway shares the same work instead of exposing it early.
  let feedAheadTimer = null;
  function prepareFeedAhead(c) {
    if (feedAheadTimer || c.booting || c.loadingMore || (c.shown >= c.notes.length && (c.end || c.status !== 'ready'))) return;
    feedAheadTimer = setTimeout(() => {
      feedAheadTimer = null;
      if (c !== feed || !ui.chatOpen || ui.msgView !== 'feed' || ui.profilePk || ui.noteThread) return;
      const last = document.querySelector('.notes-feed > .row[data-key]:last-child');
      if (last && last.getBoundingClientRect().bottom < window.innerHeight * 4) loadOlderFeed().catch(() => {});
    }, 100);
  }
  async function loadOlderFeed() {
    const c = feedNow();
    if (c.booting || c.loadingMore || (c.shown >= c.notes.length && (c.end || c.status !== 'ready'))) return;
    c.loadingMore = true;
    try {
      if (c.shown < c.notes.length) {
        const end = Math.min(c.shown + FEED_PAGE, c.notes.length);
        const boundary = c.notes[end - 1].id;
        await notesReady(c.notes.slice(c.shown, Math.min(end + FEED_PAGE, c.notes.length)));
        c.shown = Math.max(c.shown, c.notes.findIndex((e) => e.id === boundary) + 1);
        return;
      }
      if (c.status !== 'ready' || c.end) return;
      const oldest = c.notes.at(-1);
      if (!oldest || !feedHasQuery(feedDef(c.id))) { c.end = true; return; }
      if (await feedPass({ until: oldest.created_at - 1 }, {}, c)) c.shown = Math.min(c.shown + FEED_PAGE, c.notes.length);
      else c.end = true;
    } finally {
      c.loadingMore = false;
      if (c === feed) render();
    }
  }

  // Note content, safely: text stays text nodes — relay content must never
  // reach innerHTML. URLs become links (image URLs inline), npub mentions a
  // clickable @name, other nostr: refs a dim stub.
  // Markdown, narrowly. A kind 1 is specified as plain text — NIP-10 says
  // markup SHOULD NOT be used — but bridges and cross-posters emit it anyway,
  // and what we did with it was the worst of the three options: the URL
  // inside ![cover](…) rendered as a picture while the ![cover]( was left
  // sitting above it as litter. So the whole construct is one token now.
  //
  // Images and links ONLY. Not headings, not bold, not italics: # opens a
  // hashtag and * turns up in ordinary prose, so honouring those would
  // mangle normal posts to pretty up the rare bridged one.
  const MD_LINK = '!?\\[[^\\]\\n]{0,300}\\]\\(\\s*<?https?:\\/\\/[^\\s>)]+>?[^)\\n]{0,300}\\)';
  // A bare @handle ("Founder of @MusiKnow") names a person without a key.
  // Nothing can resolve it for certain, so it becomes a tap that opens the
  // people search with that name filled in. Not the @ inside an email or a
  // nip05 (a word character sits before those), and never inside a URL
  // (the URL token starts earlier and swallows it).
  const MENTION = '(?<![\\w.@/])@[A-Za-z0-9_]{2,32}(?![\\w@])';
  const HASHTAG = '(?<![\\w#/&])#[A-Za-z0-9_\\u00C0-\\uFFFF]{2,64}(?![\\w])';
  // A bare npub/nprofile — with or without an @ in front, no nostr: prefix —
  // is how Vector (and people) write a mention; it resolves to the name too.
  const BARE_KEY = '(?<![\\w/])@?(?:npub|nprofile)1[a-z0-9]{20,}(?![\\w])';
  const NOTE_SPLIT = new RegExp('(' + MD_LINK + '|https?:\\/\\/[^\\s]+|nostr:(?:npub|nprofile|note|nevent|naddr)1[a-z0-9]+|' + BARE_KEY + '|' + MENTION + '|' + HASHTAG + ')', 'gi');
  const MD_PARTS = new RegExp('^(!?)\\[([^\\]\\n]{0,300})\\]\\(\\s*<?(https?:\\/\\/[^\\s>)]+)>?[^)\\n]{0,300}\\)$', 'i');

  // A YouTube link is a video, so show the video. All three shapes it comes
  // in: the long one, the short one, and a Shorts link.
  const YT = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=([\w-]{6,})|shorts\/([\w-]{6,})|live\/([\w-]{6,}))|youtu\.be\/([\w-]{6,}))/i;
  const youtubeId = (url) => { const m = YT.exec(url || ''); return m ? (m[1] || m[2] || m[3] || m[4]) : null; };
  const ytStart = (url) => {
    const m = /[?&](?:t|start)=(\d+)/.exec(url || '') || /[?&]t=(\d+)s/.exec(url || '');
    return m ? Math.max(0, parseInt(m[1], 10) || 0) : 0;
  };

  // ---- autoplay: a video plays, muted, while it is on screen --------------
  // The way a timeline does it: a video starts by itself as it scrolls into
  // view — muted, the only way a browser lets a page start one — pauses as
  // it leaves, and a corner button turns the sound on. YouTube gets the same
  // treatment: the player loads muted once its box is in view, and the
  // button asks it to unmute over the iframe API. Data Saver keeps the old
  // tap-to-play. One observer watches every player.
  const autoplayOk = () => { try { return !(navigator.connection && navigator.connection.saveData); } catch { return true; } };
  let playerWatch = null;
  function watchPlayer(el, onIn, onOut) {
    if (typeof IntersectionObserver === 'undefined' || !autoplayOk()) return;
    if (!playerWatch) playerWatch = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const el2 = en.target;
        if (!el2.isConnected) { playerWatch.unobserve(el2); continue; }
        if (en.isIntersecting && en.intersectionRatio >= 0.5) { if (el2._onIn) el2._onIn(); } else if (el2._onOut) el2._onOut();
      }
    }, { threshold: [0, 0.5] });
    el._onIn = onIn; el._onOut = onOut;
    playerWatch.observe(el);
  }
  // The corner button: what it says is the state it would switch to.
  function soundBtn(onClick) {
    const btn = h('button', { class: 'vid-sound', type: 'button', onClick: (e) => { e.stopPropagation(); e.preventDefault(); onClick(); } });
    btn.setSound = (on) => {
      btn.classList.toggle('on', !!on);
      btn.textContent = (on ? '\u{1F50A} ' : '\u{1F507} ') + (on ? t('videoMute') : t('videoUnmute'));
      btn.setAttribute('aria-label', on ? t('videoMute') : t('videoUnmute'));
      btn.title = on ? t('videoMute') : t('videoUnmute');
    };
    btn.setSound(false);
    return btn;
  }
  // An inline video, in a box with the sound button; plays on its own while
  // on screen. Once it has played, the box is the viewer's (no morph).
  function videoNode(url, { stable = false } = {}) {
    const v = h('video', { src: url, class: 'note-video', controls: true,
      preload: autoplayOk() ? 'auto' : 'metadata', playsinline: true, muted: true,
      style: stable ? 'width:100%;aspect-ratio:16/9;object-fit:contain' : undefined,
      onError: (e) => { if (!stable) { const b = e.target.parentElement; if (b) b.style.display = 'none'; } } });
    v.muted = true; // the property, not just the attribute: a script-made element autoplays only muted
    const box = h('div', { class: 'note-video-box' }, v);
    const btn = soundBtn(() => {
      v.muted = !v.muted;
      btn.setSound(!v.muted);
      if (!v.muted) { box._skipMorph = true; if (v.paused) v.play().catch(() => {}); }
    });
    v.onvolumechange = () => btn.setSound(!v.muted); // the native control's own mute keeps the button honest
    box.append(btn);
    watchPlayer(v,
      () => { if (v.paused) v.play().then(() => { box._skipMorph = true; }).catch(() => {}); },
      () => { if (!v.paused) v.pause(); });
    return box;
  }

  // The still, with a play button over it, and the player itself only once
  // it's tapped — or, with autoplay, once the box scrolls into view, muted.
  // A feed of ten videos would otherwise load ten YouTube players at once,
  // every one of them telling Google what you're scrolling past; loading on
  // view (and never with sound uninvited) keeps that to what you look at.
  function youtubeEmbed(url, vid) {
    const start = ytStart(url);
    const embedSrc = (muted) => 'https://www.youtube-nocookie.com/embed/' + vid
      + '?autoplay=1&rel=0&playsinline=1&enablejsapi=1' + (muted ? '&mute=1' : '') + (start ? '&start=' + start : '')
      + (typeof location !== 'undefined' ? '&origin=' + encodeURIComponent(location.origin) : '');
    const src = embedSrc(false);
    // the iframe API listens for commands once told someone is listening
    const post = (box, func) => {
      const f = box.querySelector('iframe');
      try { if (f && f.contentWindow) f.contentWindow.postMessage(JSON.stringify({ event: 'command', func, args: [] }), '*'); } catch {}
    };
    const load = (box, muted) => {
      if (!box || box.dataset.playing) return;
      box.dataset.playing = '1';
      // The page repaints in the background all the time (a zap count,
      // a profile landing, the thirty-second sync), and every repaint
      // rebuilds this box as poster + play button and patches the live
      // one into that shape — which threw the playing iframe out a few
      // seconds into every video. Once playing, the box is the viewer's
      // and the morph leaves it exactly as it stands.
      box._skipMorph = true;
      box.textContent = '';
      const f = document.createElement('iframe');
      f.src = muted ? embedSrc(true) : src;
      f.title = 'YouTube';
      f.allow = 'accelerometer; autoplay; encrypted-media; picture-in-picture; web-share';
      f.referrerPolicy = 'strict-origin-when-cross-origin';
      f.allowFullscreen = true;
      f.onload = () => { try { f.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: vid }), '*'); } catch {} };
      box.append(f);
      if (muted) {
        let on = false;
        const btn = soundBtn(() => { on = !on; btn.setSound(on); post(box, on ? 'unMute' : 'mute'); if (on) post(box, 'playVideo'); });
        box.append(btn);
      }
    };
    const frame = h('div', { class: 'yt-embed' },
      h('img', {
        class: 'yt-poster', loading: 'lazy', alt: '',
        src: !feedPaint || feedMedia('https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg')
          ? 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg' : undefined,
        onError: (e) => { e.target.style.display = 'none'; },
      }),
      h('button', {
        class: 'yt-play', 'aria-label': t('playVideo'), title: t('playVideo'),
        onClick: (e) => {
          e.stopPropagation();
          const box = e.currentTarget.parentElement;
          if (!box || box.dataset.playing) return;
          load(box, false); // a tap means sound
        },
      }, h('span', { style: 'display:flex', html: '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" style="display:block"><path d="M8 5v14l11-7z"/></svg>' })),
      h('a', {
        class: 'yt-open', href: url, target: '_blank', rel: 'noopener noreferrer',
        title: t('openInYouTube'), onClick: (e) => e.stopPropagation(),
      }, '\u2197'));
    // in view: load muted the first time, resume after; out of view: pause
    watchPlayer(frame,
      () => { if (!frame.dataset.playing) load(frame, true); else if (frame._pausedByUs) { frame._pausedByUs = false; post(frame, 'playVideo'); } },
      () => { if (frame.dataset.playing) { frame._pausedByUs = true; post(frame, 'pauseVideo'); } });
    return frame;
  }

  // ---- quoted notes ---------------------------------------------------------
  // A nostr:note1/nevent1 in someone's post IS a post, so show it: the thing
  // they're talking about, inside what they said about it. Fetched once per
  // id and remembered, so a feed that quotes the same note ten times asks for
  // it once.
  // A miss is not final: a relay that was down when we asked (ours was, for
  // an evening) answered nothing, and the note sat "not on your relays"
  // until a reload. A missing note is asked for again the next time it is
  // wanted, half a minute on, with any relay hints the reference carried.
  const QUOTE_RETRY_MS = 30_000;
  const quoted = new Map(); // id -> { status, ev, at }
  function quotedNote(ref) {
    let c = quoted.get(ref.id);
    if (c && (c.status !== 'missing' || Date.now() - (c.at || 0) < QUOTE_RETRY_MS)) return c;
    if (!c) { c = { status: 'loading', ev: null, at: 0 }; quoted.set(ref.id, c); }
    c.at = Date.now();
    c.promise = (async () => {
      const relays = [...new Set([...(ref.relays || []), ...zapRelays()])];
      const evs = await queryOn(relays, { ids: [ref.id] }, 4500).catch(() => []);
      c.ev = (evs || [])[0] || c.ev || null;
      c.status = c.ev ? 'ready' : 'missing';
      scheduleRepaint();
    })();
    return c;
  }

  // The card. Deliberately not a noteRow: a quote is context, not another
  // post to act on — no reply, no boost, no zap of its own. Tapping it opens
  // the note properly, which is where those live.
  function quoteCard(ref, depth) {
    if (feedPaint && !feedPaint.quotes.has(ref.id)) feedPaint.quotes.set(ref.id, { ...quoted.get(ref.id) });
    const c = feedPaint ? feedPaint.quotes.get(ref.id) : quotedNote(ref);
    if (feedPaint && !c?.ev) return h('a', {
      href: '#', onClick: (e) => { e.preventDefault(); e.stopPropagation(); openNoteRef(ref); },
    }, t('noteRefLink'));
    if (c.status === 'loading') {
      return h('div', { class: 'quote-card quote-loading' },
        h('span', { class: 'spinner sm' }), h('span', { class: 'small faint' }, t('noteRefLoading')));
    }
    if (!c.ev) {
      return h('div', { class: 'quote-card' },
        h('span', { class: 'small faint' }, t('noteRefNotFound')));
    }
    const ev = c.ev;
    if (hidden(ev)) return h('div', { class: 'quote-card' }, h('span', { class: 'small faint' }, t('quoteHidden')));
    return h('div', {
      class: 'quote-card clickable',
      onClick: (e) => { e.stopPropagation(); openNoteThread(ev); },
    },
      h('div', { class: 'row gap6', style: 'align-items:center;min-width:0' },
        avatar(ev.pubkey, 'chat-avatar mini', false),
        h('span', { class: 'quote-name' }, displayName(ev.pubkey)),
        h('span', { class: 'small faint', style: 'white-space:nowrap' }, timeLabel(ev.created_at * 1000))),
      h('div', { class: 'note-text', style: 'white-space:pre-wrap;overflow-wrap:anywhere' },
        // one level deep only: a quote of a quote of a quote is a rabbit
        // hole, and the inner one stays a link you can follow
        ...noteBody(ev.content, depth + 1, emojiTagMap(ev.tags))));
  }

  // One URL, rendered as whatever it points at. `isImage` is markdown saying
  // so outright — plenty of perfectly good picture URLs carry no extension
  // (a CDN path, a /media/ route), and ![…] is the author telling us what it
  // is, which beats guessing from the filename.
  function urlNode(url, { label = null, isImage = false } = {}) {
    if (/\.(mp4|webm|mov|m4v)(\?[^\s]*)?$/i.test(url)) {
      return videoNode(url, { stable: !!feedPaint });
    }
    if (isImage || /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i.test(url)) {
      const size = feedPaint ? feedMedia(url) : null;
      if (feedPaint && !size) return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label || url);
      // tap it to see it properly — a 320px-tall crop of someone's
      // photograph is a thumbnail, not the picture they posted
      return h('img', {
        src: url, class: 'note-img clickable', loading: feedPaint ? 'eager' : 'lazy', alt: label || '',
        width: size?.width, height: size?.height,
        style: size ? 'height:auto;aspect-ratio:' + size.width + '/' + size.height : undefined,
        onClick: (e) => { e.stopPropagation(); ctx.openImage && ctx.openImage(url); },
        // a picture we were TOLD was a picture and which won't load leaves
        // nothing behind — the alt text is already in the sentence above it
        onError: (e) => { if (!size) e.target.style.display = 'none'; },
      });
    }
    if (youtubeId(url)) return youtubeEmbed(url, youtubeId(url));
    const shown = label || (url.length > 64 ? url.slice(0, 61) + '…' : url);
    return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, shown);
  }

  // ---- encrypted attachments (NIP-92 imeta + NIP-17 file fields) ----
  // A picture in a Concord channel never reaches the media server in the
  // clear: the sender encrypts it under a one-off key, uploads the blob to
  // Blossom, and puts the pointer in an imeta tag — url, mime, aes-gcm key
  // and nonce, the plaintext's sha256 (ox), a size and dimensions. The bubble
  // used to show nothing for such a message (its content is empty). Now the
  // blob is fetched, decrypted here, checked against the hash, and shown
  // from an object URL. A blob that fails the check fails closed.
  const ATTACH_MAX = 25 * 1024 * 1024;
  const attachCache = new Map(); // url -> { state: 'loading'|'ready'|'error', src, blob }
  const parseImeta = (tag) => {
    const a = { fallback: [] };
    for (const f of tag.slice(1)) {
      const i = f.indexOf(' ');
      if (i < 0) continue;
      const k = f.slice(0, i), v = f.slice(i + 1);
      if (k === 'fallback') a.fallback.push(v); else a[k] = v;
    }
    return a.url ? a : null;
  };
  const attachmentsOf = (rumor) => {
    const out = (rumor.tags || []).filter((t) => t[0] === 'imeta').map(parseImeta).filter(Boolean);
    // a NIP-17 file message: the same fields as flat tags, the url as content
    if (rumor.kind === 15 && /^https?:\/\//.test(rumor.content || '')) {
      const a = { url: rumor.content.trim(), fallback: [] };
      for (const [k, v] of rumor.tags || []) {
        if (k === 'file-type') a.m = v;
        else if (k === 'fallback') a.fallback.push(v);
        else if (['encryption-algorithm', 'decryption-key', 'decryption-nonce', 'ox', 'x', 'size', 'dim', 'name'].includes(k)) a[k] = v;
      }
      out.push(a);
    }
    return out;
  };
  async function loadAttachment(a) {
    const entry = { state: 'loading' };
    attachCache.set(a.url, entry);
    try {
      if (+a.size > ATTACH_MAX) throw new Error('too big');
      let buf = null;
      for (const url of [a.url, ...a.fallback]) {
        try {
          const res = await fetch(url, { mode: 'cors', signal: AbortSignal.timeout(30_000) });
          if (!res.ok) continue;
          buf = await res.arrayBuffer();
          if (buf.byteLength > ATTACH_MAX) throw new Error('too big');
          break;
        } catch (e) { if (String(e.message).includes('too big')) throw e; }
      }
      if (!buf) throw new Error('unreachable');
      let bytes = new Uint8Array(buf);
      const alg = (a['encryption-algorithm'] || '').toLowerCase();
      if (alg) {
        if (alg !== 'aes-gcm' || !a['decryption-key'] || !a['decryption-nonce']) throw new Error('unsupported');
        const key = await crypto.subtle.importKey('raw', hexToBytes(a['decryption-key']), 'AES-GCM', false, ['decrypt']);
        bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(a['decryption-nonce']) }, key, bytes));
      }
      if (a.ox) {
        const digest = bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
        if (digest !== a.ox.toLowerCase()) throw new Error('hash mismatch');
      }
      const blob = new Blob([bytes], { type: a.m || 'application/octet-stream' });
      Object.assign(entry, { state: 'ready', blob, src: URL.createObjectURL(blob) });
    } catch (e) {
      entry.state = 'error';
      console.warn('attachment:', a.url, e.message);
    }
    scheduleRepaint();
  }
  // The nodes for a rumor's attachments: a picture inline (tap to view),
  // any other file as a download by name, a grey box the picture's shape
  // while it loads, and a quiet note when it can't be had.
  function attachmentNodes(rumor) {
    return attachmentsOf(rumor).map((a) => {
      const isImg = /^image\//i.test(a.m || '') || /\.(png|jpe?g|gif|webp|avif)$/i.test(a.name || a.url.split('?')[0]);
      const encrypted = !!a['encryption-algorithm'];
      if (!encrypted && isImg) return urlNode(a.url, { isImage: true });
      let entry = attachCache.get(a.url);
      if (!entry && isImg) { loadAttachment(a); entry = attachCache.get(a.url); }
      const [w, hgt] = String(a.dim || '').split('x').map(Number);
      const ratio = w > 0 && hgt > 0 ? `${w}/${hgt}` : '4/3';
      if (entry && entry.state === 'ready') {
        if (isImg) return h('img', {
          src: entry.src, class: 'note-img clickable', alt: a.name || '',
          onClick: (e) => { e.stopPropagation(); ctx.openImage && ctx.openImage(entry.src); },
        });
        return h('a', { class: 'chat-attach', href: entry.src, download: a.name || 'file', onClick: (e) => e.stopPropagation() },
          '📎 ' + (a.name || 'file') + (a.size ? ` · ${Math.round(+a.size / 1024)} KB` : ''));
      }
      if (entry && entry.state === 'error') return h('div', { class: 'small muted' }, t('msgAttachFailed'));
      if (!isImg) return h('button', {
        class: 'chat-attach linklike', onClick: (e) => { e.stopPropagation(); if (!attachCache.has(a.url)) loadAttachment(a); },
      }, '📎 ' + (a.name || 'file') + (a.size ? ` · ${Math.round(+a.size / 1024)} KB` : ''));
      return h('div', { class: 'chat-attach-ph', style: `aspect-ratio:${ratio}` });
    });
  }

  // ---- sending a picture: encrypt it, put the blob on Blossom, post the
  // pointer. Vector's shape exactly, so its users see it: a fresh AES-GCM
  // key and 16-byte nonce per file, the ciphertext uploaded as an opaque
  // blob, the key riding inside the (already encrypted) message. The media
  // host never sees a picture. coinos's own Blossom server stores only sync
  // envelopes, so these go to public hosts that take anonymous blobs.
  const MEDIA_SERVERS = ['https://blossom.ditto.pub', 'https://nostr.download'];
  const MEDIA_MAX = 20 * 1024 * 1024;
  async function encryptFile(file) {
    if (file.size > MEDIA_MAX) throw new Error(t('msgAttachTooBig'));
    const plain = new Uint8Array(await file.arrayBuffer());
    const key = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
    const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, k, plain));
    let dim = '';
    if (/^image\//.test(file.type)) {
      try { const bmp = await createImageBitmap(file); dim = `${bmp.width}x${bmp.height}`; bmp.close(); } catch {}
    }
    return {
      cipher, key: bytesToHex(key), nonce: bytesToHex(nonce), ox: bytesToHex(sha256(plain)), x: bytesToHex(sha256(cipher)),
      m: file.type || 'application/octet-stream', name: file.name || 'file', size: String(cipher.length), dim,
    };
  }
  // BUD-01 upload with a kind-24242 auth signed by whoever is sending.
  async function uploadEncrypted(id, enc) {
    const now = Math.floor(Date.now() / 1000);
    const evt = { kind: 24242, pubkey: id.pubkey, created_at: now - 5, content: 'upload',
      tags: [['t', 'upload'], ['x', enc.x], ['expiration', String(now + 600)]] };
    const auth = id.signer instanceof Uint8Array ? finalizeEvent(evt, id.signer) : await id.signer.signEvent(evt);
    const header = 'Nostr ' + btoa(JSON.stringify(auth));
    const urls = [];
    for (const server of MEDIA_SERVERS) {
      try {
        const r = await fetch(server + '/upload', {
          method: 'PUT', body: enc.cipher, signal: AbortSignal.timeout(60_000),
          headers: { authorization: header, 'content-type': 'application/octet-stream', 'x-sha-256': enc.x },
        });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.url) urls.push(j.url);
      } catch {}
      if (urls.length && enc.cipher.length > 4 * 1024 * 1024) break; // one copy is enough for a big file
    }
    if (!urls.length) throw new Error(t('msgUploadFailed'));
    return urls;
  }
  const imetaTag = (enc, urls) => ['imeta',
    'url ' + urls[0], 'm ' + enc.m, 'encryption-algorithm aes-gcm', 'decryption-key ' + enc.key, 'decryption-nonce ' + enc.nonce,
    'size ' + enc.size, 'ox ' + enc.ox, 'x ' + enc.x, 'name ' + enc.name, ...(enc.dim ? ['dim ' + enc.dim] : []),
    ...urls.slice(1).map((u) => 'fallback ' + u)];
  // the local copy shows at once, from the plaintext we still hold
  const cacheLocal = (enc, urls, file) => {
    const blob = new Blob([file], { type: enc.m });
    for (const u of urls) attachCache.set(u, { state: 'ready', blob, src: URL.createObjectURL(blob) });
  };
  async function sendAttachment(room, chId, file) {
    const id = await identity();
    if (!id) { noIdToast(); return; }
    ui.msgUploading = true; render();
    try {
      const enc = await encryptFile(file);
      const urls = await uploadEncrypted(id, enc);
      cacheLocal(enc, urls, file);
      const { created_at, ms } = msTags(Date.now());
      const replyTo = ui.msgReplyTo && room.byChannel.get(chId)?.has(ui.msgReplyTo) ? ui.msgReplyTo : null;
      ui.msgReplyTo = null;
      const rumor = rumorWithId({
        kind: 9, pubkey: id.pubkey, content: '',
        tags: [['channel', chId], ['epoch', String(room.chEpoch(chId))], imetaTag(enc, urls), ...(replyTo ? [['e', replyTo]] : []), ms], created_at,
      });
      const msgs = room.byChannel.get(chId) || room.byChannel.set(chId, new Map()).get(chId);
      const entry = { rumor, author: id.pubkey, pending: true };
      msgs.set(rumor.id, entry);
      ui.msgStick = true; ui.msgUploading = false; render();
      const wrap = await wrapRumor(rumor, id.signer, room.chStream(chId));
      seenWraps.add(wrap.id);
      const ok = await publishOn(room.relays, wrap);
      if (!ok) { msgs.delete(rumor.id); toast(t('msgSendFailed')); render(); return; }
      delete entry.pending;
      ensureJoined(room, id).catch(() => {});
      persistCache(room);
    } catch (e) { toast(e.message || String(e)); }
    ui.msgUploading = false; render();
  }
  // A DM picture is a NIP-17 kind-15 file message: url as content, the
  // same fields as flat tags, wrapped to the peer and to ourselves.
  async function sendDMFile(peer, file) {
    const id = await identity();
    if (!id) { noIdToast(); return; }
    if (!(id.signer instanceof Uint8Array) && !id.signer.encryptTo) { toast(t('msgSignerNoDm')); return; }
    ui.msgUploading = true; render();
    try {
      const enc = await encryptFile(file);
      const urls = await uploadEncrypted(id, enc);
      cacheLocal(enc, urls, file);
      const replyTo = ui.msgReplyTo && threadOf(peer).has(ui.msgReplyTo) ? ui.msgReplyTo : null;
      ui.msgReplyTo = null;
      const rumor = rumorWithId({
        kind: 15, pubkey: id.pubkey, content: urls[0], created_at: Math.floor(Date.now() / 1000),
        tags: [['p', peer], ...(replyTo ? [['e', replyTo]] : []),
          ['file-type', enc.m], ['encryption-algorithm', 'aes-gcm'], ['decryption-key', enc.key], ['decryption-nonce', enc.nonce],
          ['x', enc.x], ['ox', enc.ox], ['size', enc.size], ['name', enc.name], ...(enc.dim ? [['dim', enc.dim]] : []),
          ...urls.slice(1).map((u) => ['fallback', u])],
      });
      const entry = { rumor, mine: true, pending: true };
      threadOf(peer).set(rumor.id, entry);
      ui.msgStick = true; ui.msgUploading = false; render();
      const toPeer = await wrapDM(id.signer, peer, rumor);
      const toSelf = await wrapDM(id.signer, id.pubkey, rumor);
      const ok = await publishOn(DM_RELAYS, toPeer);
      publishOn(DM_RELAYS, toSelf);
      fetchInboxRelays(peer).then((inbox) => {
        const extra = inbox.slice(0, 4).filter((r) => !DM_RELAYS.includes(r));
        if (extra.length) publishOn(extra, toPeer);
      }).catch(() => {});
      if (!ok) { threadOf(peer).delete(rumor.id); toast(t('msgSendFailed')); render(); return; }
      delete entry.pending;
      persistDms();
    } catch (e) { toast(e.message || String(e)); }
    ui.msgUploading = false; render();
  }

  // `em` is the event's own ["emoji", code, url] map (NIP-30): a :code: it
  // names becomes its picture, any other :code: stays text — a message
  // never borrows pictures from packs the READER happens to hold.
  function noteBody(text, depth = 0, em = null) {
    const out = [];
    const emojiAt = em && em.size ? (c) => em.get(c) : null;
    for (const part of String(text || '').split(NOTE_SPLIT)) {
      if (!part) continue;
      const md = MD_PARTS.exec(part);
      if (md) {
        const [, bang, label, url] = md;
        out.push(urlNode(url, { label: label || null, isImage: !!bang }));
      } else if (/^https?:\/\//i.test(part)) {
        const pack = PACK_LINK_RE.exec(part);
        out.push(pack ? packLinkNode(part, pack[1]) : urlNode(part));
      } else if (/^(nostr:|@?)(npub|nprofile)1/i.test(part)) {
        const bare = part.replace(/^(nostr:|@)/i, '');
        const ref = parseNostrRef(bare);
        if (ref && ref.type === 'pubkey') out.push(h('a', { href: '#', onClick: (e) => { e.preventDefault(); openProfile(ref.pk); } }, '@' + displayName(ref.pk)));
        else out.push(h('span', { class: 'faint' }, bare.slice(0, 12) + '…'));
      } else if (/^nostr:(note|nevent)1/i.test(part)) {
        const ref = parseNostrRef(part.slice(6));
        if (ref && ref.type === 'event') {
          // the note they're quoting, shown inside what they said about it —
          // except one level down, where it goes back to being a link
          out.push(depth ? h('a', {
            href: '#', onClick: (e) => { e.preventDefault(); e.stopPropagation(); openNoteRef(ref); },
          }, t('noteRefLink')) : quoteCard(ref, depth));
        } else out.push(h('span', { class: 'faint' }, part.slice(6, 18) + '…'));
      } else if (/^nostr:/i.test(part)) {
        out.push(h('span', { class: 'faint' }, part.slice(6, 18) + '…'));
      } else if (/^@[A-Za-z0-9_]{2,32}$/.test(part)) {
        out.push(h('a', {
          href: '#', title: t('searchPeopleFor', { q: part.slice(1) }),
          onClick: (e) => { e.preventDefault(); e.stopPropagation(); openPeopleSearch(part.slice(1)); },
        }, part));
      } else if (/^#[A-Za-z0-9_\u00C0-\uFFFF]{2,64}$/.test(part)) {
        out.push(h('a', {
          href: '#', title: t('searchTopicFor', { q: part.slice(1) }),
          onClick: (e) => { e.preventDefault(); e.stopPropagation(); openTopicFeed(part.slice(1)); },
        }, part));
      } else if (emojiAt && part.includes(':')) {
        for (const p of splitEmoji(part, emojiAt)) out.push(typeof p === 'string' ? p : emojiImg(p.code, p.url));
      } else out.push(part);
    }
    return out;
  }

  // The header magnifier's search, opened with a name already typed.
  function openPeopleSearch(q) {
    ui.chatOpen = false; ui.profilePk = null; ui.noteThread = null;
    ui.userSearch = { q, rows: null };
    warmSearch();
    userSearcher.update(q);
    render();
  }

  // Zap a specific note. With a default amount configured this is ONE TAP:
  // the zap fires instantly (ark first, Lightning fallback) and reports by
  // toast, no form, no leaving the page. Without one, a small setup screen
  // asks once and remembers.
  // Whether a ⚡ makes sense for this author from this wallet: not
  // ourselves, and an instant path (Ark) or a Lightning fallback exists.
  // Your own posts and messages too: a zap to yourself is a harmless
  // round-trip, and one bar that behaves the same everywhere beats a special case.
  const canZapPk = (pk) => !!pk && !!(hook('arkReady') || hook('canLnZap'));
  function zapNote(pk, ev, origin) {
    const npubStr = npubOf(pk);
    const def = ctx.zapDefaultSat ? ctx.zapDefaultSat() : 0;
    if (!def) { ui.zapSetup = { pk, npub: npubStr, eventId: ev.id, amount: '21', origin }; render(); return; }
    markZapPending(ev.id, def, origin); // strike now; settlement only corrects the tally
    if (!hook('zapNpub', pk, npubStr, ev.id, def) && !hook('lnZapNpub', pk, npubStr, ev.id, def)) {
      settleZap(ev.id, false);
      toast('⚡ ' + t('lnZapFailed'), 4000);
    }
  }

  // Held ⚡: the same screen, opened to change the amount — saving alone is
  // the main action, zapping this note with the new amount the second.
  function openZapSettings(pk, id, origin) {
    const cur = ctx.zapDefaultSat ? ctx.zapDefaultSat() : 0;
    ui.zapSetup = { pk, npub: npubOf(pk), eventId: id, amount: String(cur || 21), origin, edit: true, sound: zapSoundOn() };
    render();
  }

  // First ⚡ tap ever: pick the amount one time, then every zap is one tap.
  function zapSetupScreen() {
    const s = ui.zapSetup;
    const saved = () => {
      const n = parseInt(s.amount, 10);
      if (!n || n <= 0) { toast(t('enterValidAmtForN', { n: 1 })); return 0; }
      ctx.setZapDefaultSat(n);
      if (s.edit && ctx.setZapSound && s.sound !== zapSoundOn()) ctx.setZapSound(s.sound);
      return n;
    };
    const saveAndZap = () => {
      const n = saved();
      if (!n) return;
      const { pk, npub, eventId } = s;
      ui.zapSetup = null;
      render();
      markZapPending(eventId, n, s.origin);
      if (!hook('zapNpub', pk, npub, eventId, n) && !hook('lnZapNpub', pk, npub, eventId, n)) {
        settleZap(eventId, false);
        toast('⚡ ' + t('lnZapFailed'), 4000);
      }
      recheckZap(eventId);
    };
    const saveOnly = () => {
      const n = saved();
      if (!n) return;
      ui.zapSetup = null;
      toast('⚡ ' + t('zapAmountSaved', { n: n.toLocaleString() }));
      render();
    };
    return h('div', { class: 'col', style: 'gap:16px' },
      ctx.brandHeader(false),
      h('div', { class: 'card col', style: 'gap:10px' },
        h('h3', { style: 'margin:0' }, '⚡ ' + t('zapSetupTitle')),
        h('div', { class: 'small muted' }, t(s.edit ? 'zapSettingsDesc' : 'zapSetupDesc')),
        h('div', { class: 'input-group' },
          h('input', { type: 'number', min: '1', value: s.amount, onInput: (e) => { s.amount = e.target.value; } }),
          h('span', { class: 'small muted', style: 'align-self:center;padding:0 8px' }, 'sats')),
        s.edit ? h('label', { class: 'row gap6', style: 'align-items:center;cursor:pointer' },
          h('input', { type: 'checkbox', checked: s.sound, style: 'width:18px;height:18px;accent-color:var(--accent);margin:0', onChange: (e) => { s.sound = e.target.checked; } }),
          h('span', { class: 'small' }, t('zapSoundToggle'))) : null,
        s.edit
          ? [h('button', { class: 'btn-primary btn-block', onClick: saveOnly }, t('save')),
            h('button', { class: 'btn-ghost btn-block', onClick: saveAndZap }, t('zapSetupSave'))]
          : h('button', { class: 'btn-primary btn-block', onClick: saveAndZap }, t('zapSetupSave'))),
      h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.zapSetup = null; render(); } }, t('back')));
  }

  // One post as a feed row (avatar · name · time · body), twitter/jumble
  // style: rows share a scrollable container and are split by hairlines
  // rather than floating in their own cards. Tapping a row opens its thread.
  // ---- what you can do to a post -------------------------------------------
  // Like, boost, quote, and — behind the ellipsis — mute or block its author.
  // Each publishes to the author's own relays as well as ours, so the person
  // being answered actually sees it.
  const myReactOn = (id) => {
    const m = reacts.get(id);
    if (!m) return null;
    const mine = myPubkeys();
    for (const reaction of m.values()) for (const pk of mine) if (reaction.who.has(pk)) return reaction;
    return null;
  };
  const iBoosted = (id) => {
    const set = boosts.get(id);
    return !!set && myPubkeys().some((pk) => set.has(pk));
  };
  const noteRelaysFor = async (ev) =>
    [...new Set([...zapRelays(), ...(await relaysOf(ev.pubkey))])];

  // A like is kind 7 on the note (NIP-25). Tapping it again withdraws it the
  // only way nostr has: a deletion request for the reaction we sent.
  // Reply: open (or re-aim) the thread and put the cursor in the box.
  function replyToNote(ev) {
    if (ui.noteThread && ui.noteThread.rootId === rootIdOf(ev)) {
      ui.noteThread.focusId = ev.id;
      ui.noteThread.seed = ev;
    } else ui.noteThread = { rootId: rootIdOf(ev), focusId: ev.id, seed: ev };
    const s = ui.noteThread;
    ui.profOverThread = false;
    s.scrollPending = false; // focus the composer, without a competing note scroll
    s.refocus = true;
    render();
    // Focus in the tap handler so mobile browsers can open the keyboard.
    focusThreadReply(s);
  }
  function focusThreadReply(s) {
    if (ui.noteThread !== s || ui.profOverThread) return;
    const input = document.querySelector('.thread-reply-input');
    if (!input) return;
    input.focus({ preventScroll: true });
    input.scrollIntoView({ block: 'nearest' });
  }

  async function unreact(ev) {
    const id = await requireIdentity();
    const relays = await noteRelaysFor(ev);
    {
      // Taking a like back is the only withdrawal nostr has: a deletion
      // request naming the reaction. Relays that honour it drop it; the ones
      // that don't go on showing it to other people — worth knowing, not
      // worth refusing to try.
      const m = reacts.get(ev.id);
      if (m) for (const [key, { who }] of [...m]) { for (const pk of myPubkeys()) who.delete(pk); if (!who.size) m.delete(key); }
      render();
      const mineEv = myReactEv.get(ev.id);
      if (!mineEv) return;
      myReactEv.delete(ev.id);
      const gone = { kind: 5, content: '', created_at: Math.floor(Date.now() / 1000), tags: [['e', mineEv], ['k', '7']] };
      const del = id.signer instanceof Uint8Array ? finalizeEvent(gone, id.signer) : await id.signer.signEvent(gone);
      publishOn(relays, del).catch(() => {});
      return;
    }
  }

  // React with whichever emoji was picked (NIP-25 takes any content).
  async function reactTo(ev, emoji) {
    const id = await requireIdentity();
    const relays = await noteRelaysFor(ev);
    const partial = {
      kind: 7, content: emoji || '❤️', created_at: Math.floor(Date.now() / 1000),
      tags: [['e', ev.id], ['p', ev.pubkey], ...reactEmojiTags(emoji), CLIENT_TAG],
    };
    const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
    myReactEv.set(ev.id, evt.id);
    noteEvent(evt); // on screen before the relays answer
    render();
    publishOn(relays, evt).catch(() => {});
  }

  // A boost is kind 6 carrying the note it repeats (NIP-18).
  async function boostNote(ev) {
    if (iBoosted(ev.id)) { toast(t('postBoostedAlready')); return; }
    const id = await requireIdentity();
    const relays = await noteRelaysFor(ev);
    const partial = {
      kind: 6, content: JSON.stringify(ev), created_at: Math.floor(Date.now() / 1000),
      tags: [['e', ev.id, relays[0] || '', 'mention'], ['p', ev.pubkey], CLIENT_TAG],
    };
    const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
    noteEvent(evt);
    render();
    const ok = await publishOn(relays, evt);
    toast(ok ? t('postBoosted') : t('msgSendFailed'));
  }

  // A quote is your own post with theirs referenced inside it: the composer
  // opens with the reference already in the text, and the q tag goes on at
  // publish time so clients can render the embed.
  function quoteNote(ev) {
    ui.quoteOf = { id: ev.id, pubkey: ev.pubkey };
    const ref = 'nostr:' + (neventOf(ev.id, ev.pubkey) || ev.id);
    const cur = composeText().replace(/\s+$/, '');
    const next = (cur ? cur + '\n\n' : '') + ref;
    ui.profCompose = next;
    setDraft(POST_DRAFT, next);
    ui.noteThread = null;
    ui.profilePk = null;
    ui.chatOpen = true;
    ui.msgView = 'feed';
    feedNow();
    render();
    setTimeout(() => { const el = document.querySelector('.chat-page textarea'); if (el) { el.focus(); el.setSelectionRange(0, 0); } }, 80);
  }

  // ---- mute list (NIP-51 kind 10000) ---------------------------------------
  // Muting hides someone's posts everywhere in this app and publishes the
  // list, so it follows you to other clients. Blocking is the same list plus
  // an unfollow — the stronger, more deliberate door.
  const MUTES = 'mutes';
  let mutes = null; // { set, words, hashtags, threads, tags, priv, content, at }
  let mutesAt = 0;
  // Everything a mute list holds (NIP-51): people, words, hashtags, whole
  // threads — public tags and the private half (nip44 to yourself) alike.
  const muteSets = (tags) => ({
    set: new Set(pTags(tags).map((x) => x[1])),
    words: [...new Set(tags.filter((x) => x[0] === 'word' && x[1]).map((x) => String(x[1]).toLowerCase().trim()).filter(Boolean))],
    hashtags: new Set(tags.filter((x) => x[0] === 't' && x[1]).map((x) => normTopic(x[1])).filter(Boolean)),
    threads: new Set(tags.filter((x) => x[0] === 'e' && /^[0-9a-f]{64}$/.test(x[1] || '')).map((x) => x[1])),
  });
  const withSets = (m) => ({ ...m, priv: m.priv || [], ...muteSets([...(m.tags || []), ...(m.priv || [])]) });
  function mutesNow() {
    if (!mutes) {
      let st2 = null;
      try { st2 = wallet.loadFeatureState(MUTES, null); } catch {}
      mutes = withSets({ tags: (st2 && st2.tags) || [], priv: (st2 && st2.priv) || [], content: (st2 && st2.c) || '', at: (st2 && st2.at) || 0 });
    }
    return mutes;
  }
  const isMuted = (pk) => mutesNow().set.has(pk);
  function saveMutes(m) {
    mutes = withSets(m);
    try { wallet.saveFeatureState(MUTES, { tags: mutes.tags, priv: mutes.priv, c: mutes.content, at: mutes.at }); } catch {}
  }
  // The private half of a list: nip44 to yourself, a JSON array of tags.
  async function privateTagsOf(ev) {
    if (!ev || !ev.content) return [];
    const c = (await selfCryptors()).find((x) => x.pk === ev.pubkey);
    if (!c) return [];
    try {
      const tags = JSON.parse(await c.dec(ev.content));
      return Array.isArray(tags) ? tags.filter((x) => Array.isArray(x) && x[0] && x[1]) : [];
    } catch { return []; } // nip04 from an older client, or not ours to read
  }
  async function syncMutes({ force = false } = {}) {
    const me = mePk();
    if (!me) return mutesNow();
    if (!force && Date.now() - mutesAt < 10 * 60_000) return mutesNow();
    mutesAt = Date.now();
    try {
      const evs = await queryOn(zapRelays(), { kinds: [10000], authors: [me] }, 5000);
      const newest = (evs || []).sort((a, b) => b.created_at - a.created_at)[0];
      const cur = mutesNow();
      if (newest && newest.created_at > cur.at) {
        saveMutes({ tags: newest.tags || [], priv: await privateTagsOf(newest), content: newest.content || '', at: newest.created_at });
        scheduleRepaint();
      }
    } catch { mutesAt = 0; }
    return mutesNow();
  }
  // Same care as the follow list: a change is applied to the freshest copy
  // the relays will give us (the note in toggleFollow), never to our own
  // optimistic paint. The private half is re-encrypted only when the change
  // touched it and we hold the key; otherwise it rides along untouched.
  async function updateMutes(change) {
    const id = await requireIdentity();
    const before = mutesNow();
    const paint = change(before);
    if (!paint) return;
    saveMutes({ ...before, ...paint });
    render();
    try {
      await syncMutes({ force: true });
      const fetched = mutesNow();
      const base = fetched.at > before.at ? fetched : before;
      const next = change(base) || {};
      const tags = next.tags || base.tags;
      const priv = next.priv || base.priv || [];
      let content = base.content || '';
      if (next.priv && JSON.stringify(next.priv) !== JSON.stringify(base.priv || [])) {
        const c = (await selfCryptors()).find((x) => x.pk === id.pubkey);
        if (c) content = priv.length ? await c.enc(JSON.stringify(priv)) : '';
      }
      const created_at = Math.max(Math.floor(Date.now() / 1000), base.at + 1);
      const partial = { kind: 10000, content, created_at, tags };
      const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
      const ok = await publishOn(zapRelays(), evt);
      if (!ok) throw new Error(t('msgSendFailed'));
      saveMutes({ tags, priv, content, at: created_at });
      render();
    } catch (e) {
      saveMutes(before);
      if (!(e instanceof NoIdentity)) toast(e.message || String(e));
      render();
      throw e;
    }
  }
  const tagIn = (tags, k, v) => (tags || []).some((x) => x[0] === k && x[1] === v);
  const tagOut = (tags, k, v) => (tags || []).filter((x) => !(x[0] === k && x[1] === v));
  // One entry in or out (want: true/false, or null to flip), both halves.
  const muteToggle = (k, v, want = null) => (m) => {
    const has = tagIn(m.tags, k, v) || tagIn(m.priv, k, v);
    const on = want == null ? !has : want;
    if (on === has) return null;
    return on ? { tags: [...m.tags, [k, v]] } : { tags: tagOut(m.tags, k, v), priv: tagOut(m.priv, k, v) };
  };
  async function toggleMute(pk, { block = false } = {}) {
    const id = await requireIdentity();
    if (pk === id.pubkey) return;
    const had = isMuted(pk);
    try {
      await updateMutes(muteToggle('p', pk));
      if (block && !had && isFollowing(pk)) await toggleFollow(pk);
      toast(had ? t('postUnmuted') : block ? t('postBlocked') : t('postMuted'));
    } catch {}
  }
  const toggleMuteThread = (rootId) => updateMutes(muteToggle('e', rootId)).catch(() => {});
  const toggleMuteWord = (word, want = null) => updateMutes(muteToggle('word', String(word || '').trim().toLowerCase(), want)).catch(() => {});
  const toggleMuteTag = (tag, want = null) => updateMutes(muteToggle('t', normTopic(tag), want)).catch(() => {});

  // ---- moderation: one door for everything that shows a post --------------
  // hiddenWhy(ev) says why a post is not shown (or null); hiddenPk(pk) the
  // same for a person (their zaps, reactions, DMs, chat). Every list in this
  // file asks here: the feed, threads, notifications, the who-reacted panel,
  // rooms, DMs, quote cards. Two rules are Amethyst's, and are what makes
  // its feeds feel clean: repeated content from strangers is spam, and a
  // post your follows reported is folded (not hidden) behind who said so.
  const modOn = (k) => (st().mod || {})[k] !== false;
  const setMod = (k, v) => { const s = st(); (s.mod ||= {})[k] = v; save(s); render(); };
  // A post of 60+ characters seen again under another id is a duplicate;
  // five duplicates and the author is hidden for the session. Short posts
  // ("GM") and nostr:-mention commands are exempt. Session memory only.
  const spamSeen = new Map(); // content+tags -> first id
  const spamDup = new Set(); // ids that were repeats
  const spamBy = new Map(); // pk -> Set of repeated ids
  function noteForSpam(ev) {
    if (!ev || ev.kind !== 1 || !ev.id || ev.pending) return;
    const c = String(ev.content || '');
    if (c.length < 60) return;
    if (c.length < 180 && c.startsWith('nostr:')) return;
    const key = c + '\u0000' + JSON.stringify(ev.tags || []);
    const first = spamSeen.get(key);
    if (!first) {
      spamSeen.set(key, ev.id);
      if (spamSeen.size > 3000) spamSeen.delete(spamSeen.keys().next().value);
      return;
    }
    if (first === ev.id) return;
    spamDup.add(ev.id);
    const s = spamBy.get(ev.pubkey) || spamBy.set(ev.pubkey, new Set()).get(ev.pubkey);
    s.add(first); s.add(ev.id);
  }
  const SPAM_DUPES = 5;
  const isSpammer = (pk) => modOn('spam') && (spamBy.get(pk) || { size: 0 }).size >= SPAM_DUPES && !isFollowing(pk) && !isMe(pk);
  const HASHTAG_MAX = 10;
  const hashtagSpam = (ev) => ev.kind === 1 && modOn('spam') && !isFollowing(ev.pubkey)
    && ((ev.tags || []).filter((x) => x[0] === 't').length > HASHTAG_MAX
      || (String(ev.content || '').match(/(^|\s)#[\p{L}\p{N}_]{2,}/gu) || []).length > HASHTAG_MAX);
  function hiddenWhy(ev) {
    if (!ev || !ev.pubkey || isMe(ev.pubkey)) return null;
    const m = mutesNow();
    if (m.set.has(ev.pubkey)) return 'muted';
    if (ev.kind === 1) {
      if (m.threads.size && m.threads.has(rootIdOf(ev))) return 'thread';
      const text = String(ev.content || '').toLowerCase();
      if (m.words.length && m.words.some((w) => text.includes(w))) return 'word';
      if (m.hashtags.size) {
        if ((ev.tags || []).some((x) => x[0] === 't' && m.hashtags.has(normTopic(x[1])))) return 'hashtag';
        for (const mm of text.matchAll(/#([\p{L}\p{N}_]+)/gu)) if (m.hashtags.has(normTopic(mm[1]))) return 'hashtag';
      }
    }
    if (reportsNow().mine.has(ev.id)) return 'reported';
    if (!isFollowing(ev.pubkey)) {
      if (isSpammer(ev.pubkey) || (modOn('spam') && spamDup.has(ev.id))) return 'spam';
      if (hashtagSpam(ev)) return 'hashtags';
    }
    return null;
  }
  const hidden = (ev) => !!hiddenWhy(ev);
  const hiddenPk = (pk) => !!pk && !isMe(pk) && (isMuted(pk) || isSpammer(pk) || reportsNow().mine.has(pk));
  const visiblePks = (pks) => [...(pks || [])].filter((pk) => !hiddenPk(pk));

  // ---- reports (NIP-56 kind 1984) from the people you follow --------------
  // The web-of-trust piece — not a score from a provider, just your follows'
  // own flags, read from their outbox relays and ours once every half hour,
  // indexed by post and by person. A post (or its author) flagged by anyone
  // you follow is folded; anything you flagged yourself is hidden.
  const REPORTS = 'reports';
  let reportsCache = null; // { ev: Map id -> Set reporter, pk: Map pk -> Set reporter, mine: Set, at }
  let reportsAt = 0;
  function reportsNow() {
    if (!reportsCache) {
      let s = null;
      try { s = wallet.loadFeatureState(REPORTS, null); } catch {}
      const toMap = (o) => new Map(Object.entries(o || {}).map(([k, v]) => [k, new Set(v)]));
      reportsCache = { ev: toMap(s && s.ev), pk: toMap(s && s.pk), mine: new Set((s && s.mine) || []), at: (s && s.at) || 0 };
    }
    return reportsCache;
  }
  function saveReports() {
    const r = reportsNow();
    const toObj = (m) => Object.fromEntries([...m.entries()].slice(-1500).map(([k, v]) => [k, [...v].slice(0, 50)]));
    try { wallet.saveFeatureState(REPORTS, { ev: toObj(r.ev), pk: toObj(r.pk), mine: [...r.mine].slice(-500), at: r.at }); } catch {}
  }
  function noteReport(ev) {
    const r = reportsNow();
    const mine = myPubkeys().includes(ev.pubkey);
    const hex = (v) => /^[0-9a-f]{64}$/.test(v || '');
    let es = 0;
    for (const x of ev.tags || []) {
      if (x[0] !== 'e' || !hex(x[1])) continue;
      es++;
      (r.ev.get(x[1]) || r.ev.set(x[1], new Set()).get(x[1])).add(ev.pubkey);
      if (mine) r.mine.add(x[1]);
    }
    for (const x of ev.tags || []) {
      // a PERSON is reported when the p tag carries a reason, or when the
      // report names no post at all; a post report's p tag merely credits
      // the author and is not held against them
      if (x[0] !== 'p' || !hex(x[1]) || x[1] === ev.pubkey || (es && !x[2])) continue;
      (r.pk.get(x[1]) || r.pk.set(x[1], new Set()).get(x[1])).add(ev.pubkey);
      if (mine) r.mine.add(x[1]);
    }
  }
  const REPORTS_MS = 30 * 60_000;
  async function syncReports({ force = false } = {}) {
    if (!modOn('reports') || !myPubkeys().length) return;
    if (!force && Date.now() - reportsAt < REPORTS_MS) return;
    reportsAt = Date.now();
    const authors = [...new Set([...myPubkeys(), ...followsNow().set])].slice(0, FEED_AUTHORS_MAX);
    const from = new Set(authors);
    try {
      await fetchRelayLists(authors);
      const plan = outboxPlan(authors);
      const got = await Promise.all(plan.flatMap(({ relays, authors: a }) => {
        const chunks = [];
        for (let i = 0; i < a.length; i += REQ_AUTHORS) chunks.push(a.slice(i, i + REQ_AUTHORS));
        return chunks.map((chunk) => queryOn(relays, { kinds: [1984], authors: chunk, limit: 500 }, 5000).catch(() => []));
      }));
      for (const ev of got.flat()) if (ev && ev.kind === 1984 && from.has(ev.pubkey)) noteReport(ev);
      reportsNow().at = Date.now();
      saveReports();
      scheduleRepaint();
    } catch { reportsAt = 0; }
  }
  // Who among your follows flagged this post or its author.
  function reportsOn(ev) {
    if (!ev || !ev.id || !modOn('reports') || isMe(ev.pubkey)) return null;
    const r = reportsNow();
    const f = followsNow().set;
    const by = new Set();
    for (const pk of r.ev.get(ev.id) || []) if (f.has(pk) && pk !== ev.pubkey) by.add(pk);
    for (const pk of r.pk.get(ev.pubkey) || []) if (f.has(pk) && pk !== ev.pubkey) by.add(pk);
    return by.size ? [...by] : null;
  }
  // A flagged post, folded: who flagged it, and a tap to see it anyway.
  function foldedRow(ev, by) {
    for (const pk of by.slice(0, 3)) profileOf(pk);
    const who = by.length === 1 ? t('foldReported1', { name: displayName(by[0]) }) : t('foldReportedN', { n: by.length });
    return h('div', { class: 'row note-folded', style: 'gap:10px;align-items:center;padding:10px 0;opacity:.75' },
      avatar(ev.pubkey, 'chat-avatar note-avatar', false),
      h('div', { class: 'grow small muted', style: 'min-width:0' }, '\u26a0 ' + who),
      h('button', {
        class: 'btn-sm', type: 'button', style: 'flex-shrink:0',
        onClick: (e) => { e.stopPropagation(); (ui.revealed ||= new Set()).add(ev.id); render(); },
      }, t('foldShow')));
  }
  // Publish a report (NIP-56): the post with a reason, its author credited.
  async function reportNote(ev, type) {
    const id = await requireIdentity();
    const partial = { kind: 1984, content: '', created_at: Math.floor(Date.now() / 1000), tags: [['e', ev.id, type], ['p', ev.pubkey]] };
    const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
    const ok = await publishOn(zapRelays(), evt);
    if (!ok) throw new Error(t('msgSendFailed'));
    noteReport(evt);
    saveReports();
    toast(t('reportSent'));
    render();
  }
  function reportSheet() {
    if (!ui.reportPick) return null;
    const ev = ui.reportPick;
    const close = () => { ui.reportPick = null; render(); };
    const reason = (type, label) => h('button', {
      class: 'btn-block report-reason', style: 'text-align:left', type: 'button', 'data-reason': type,
      onClick: () => { close(); reportNote(ev, type).catch((e) => { if (!(e instanceof NoIdentity)) toast(e.message || String(e)); }); },
    }, label);
    return h('div', { class: 'confirm-pop-backdrop', onClick: (e) => { if (e.target === e.currentTarget) close(); } },
      h('div', { class: 'card col confirm-pop report-pick', style: 'gap:8px' },
        h('div', { class: 'chat-name' }, t('reportTitle')),
        h('div', { class: 'small muted' }, t('reportHelp')),
        reason('spam', t('reportSpam')),
        reason('impersonation', t('reportImpersonation')),
        reason('nudity', t('reportNudity')),
        reason('profanity', t('reportProfanity')),
        reason('illegal', t('reportIllegal')),
        reason('malware', t('reportMalware')),
        reason('other', t('reportOther')),
        h('button', { class: 'btn-ghost btn-block', onClick: close }, t('back'))));
  }
  // Settings → Nostr: the mute list laid out, and the two spam rules.
  function moderationCard() {
    const m = mutesNow();
    const e = ui.modEdit || (ui.modEdit = { word: '' });
    const people = [...m.set];
    for (const pk of people.slice(0, 30)) profileOf(pk);
    const add = () => {
      const w = e.word.trim();
      if (!w) return;
      e.word = '';
      if (w.startsWith('#')) toggleMuteTag(w, true); else toggleMuteWord(w, true);
    };
    const chip = (label, onX) => h('span', { class: 'feed-chip on mod-chip', style: 'display:inline-flex;align-items:center;gap:6px' },
      label, h('button', { class: 'linklike', type: 'button', 'aria-label': t('remove'), style: 'padding:0 2px', onClick: onX }, '\u00d7'));
    const toggle = (k, label, help) => h('div', { class: 'col', style: 'gap:4px' },
      h('label', { class: 'row gap6', style: 'align-items:center;cursor:pointer' },
        h('input', { type: 'checkbox', class: 'mod-' + k, checked: modOn(k), style: 'width:18px;height:18px;accent-color:var(--accent);margin:0', onChange: (ev) => setMod(k, ev.target.checked) }),
        h('span', {}, label)),
      h('div', { class: 'small faint' }, help));
    return h('div', { class: 'card col mod-card', style: 'gap:10px' },
      h('h3', {}, t('modTitle')),
      h('p', { class: 'small muted', style: 'margin:0' }, t('modDesc')),
      h('div', { class: 'small muted' }, t('modPeople')),
      people.length
        ? h('div', { class: 'col', style: 'gap:6px' }, ...people.slice(0, 50).map((pk) => h('div', { class: 'row gap6 mod-person', style: 'align-items:center' },
            avatar(pk, 'chat-avatar mini', false),
            h('span', { class: 'grow', style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, displayName(pk)),
            h('button', { class: 'btn-sm', type: 'button', onClick: () => toggleMute(pk) }, t('postUnmute')))))
        : h('div', { class: 'small faint' }, t('modNoPeople')),
      h('div', { class: 'small muted' }, t('modWords')),
      m.words.length || m.hashtags.size
        ? h('div', { class: 'row wrap', style: 'gap:6px' },
            ...m.words.map((w) => chip(w, () => toggleMuteWord(w, false))),
            ...[...m.hashtags].map((x) => chip('#' + x, () => toggleMuteTag(x, false))))
        : null,
      h('div', { class: 'row gap6' },
        h('input', {
          type: 'text', class: 'grow mod-word', placeholder: t('modWordHint'), value: e.word,
          autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
          onInput: (ev) => { e.word = ev.target.value; },
          onKeydown: (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); add(); } },
        }),
        h('button', { class: 'btn-sm', type: 'button', onClick: add }, t('modAdd'))),
      m.threads.size ? h('div', { class: 'small faint' }, t('modThreads', { n: m.threads.size })) : null,
      toggle('spam', t('modSpamToggle'), t('modSpamHelp')),
      toggle('reports', t('modReportsToggle'), t('modReportsHelp')));
  }

  const noteLink = (ev) => location.origin + '/' + (neventOf(ev.id, ev.pubkey) || ev.id);
  // The ellipsis sheet: the actions that don't earn a button of their own.
  function noteSheet() {
    if (!ui.noteSheet) return null;
    const ev = ui.noteSheet;
    const close = () => { ui.noteSheet = null; ui.emojiPick = null; render(); };
    const mine = isMe(ev.pubkey);
    const item = (icon, label, onClick, danger) => h('button', {
      class: 'btn-block', style: 'text-align:left' + (danger ? ';color:var(--red,#c0392b)' : ''),
      onClick: () => { close(); onClick(); },
    }, icon + '  ' + label);
    return h('div', {
      class: 'confirm-pop-backdrop',
      onClick: (e) => { if (e.target === e.currentTarget) close(); },
    },
      h('div', { class: 'card col confirm-pop', style: 'gap:8px' },
        h('div', { class: 'row gap6', style: 'align-items:center' },
          avatar(ev.pubkey, 'chat-avatar', false),
          h('div', { class: 'chat-name' }, displayName(ev.pubkey))),
        item('❝', t('postQuote'), () => quoteNote(ev)),
        item('↻', t('postBoost'), () => boostNote(ev).catch(() => {})),
        item('⧉', t('copy'), async () => {
          try { await navigator.clipboard.writeText('nostr:' + (neventOf(ev.id, ev.pubkey) || ev.id)); toast(t('copied')); } catch {}
        }),
        // the post's own address here — the same path the bar shows while
        // its thread is open, and what njump-style links resolve to
        item('\u{1F517}', t('postCopyLink'), async () => {
          try { await navigator.clipboard.writeText(noteLink(ev)); toast(t('copied')); } catch {}
        }),
        typeof navigator !== 'undefined' && navigator.share
          ? item('\u2197', t('postShare'), () => { navigator.share({ url: noteLink(ev) }).catch(() => {}); })
          : null,
        mine || !myPubkeys().length ? null : item('\u2630', t('listAddTo'), () => { ui.listPick = ev.pubkey; render(); }),
        mine ? null : item('\u{1F6A9}', t('postReport'), () => { ui.reportPick = ev; render(); }),
        item('\u{1F515}', mutesNow().threads.has(rootIdOf(ev)) ? t('postUnmuteThread') : t('postMuteThread'), () => toggleMuteThread(rootIdOf(ev))),
        mine ? null : item('\u{1F507}', isMuted(ev.pubkey) ? t('postUnmute') : t('postMute'), () => toggleMute(ev.pubkey).catch(() => {})),
        mine || isMuted(ev.pubkey) ? null : item('⛔', t('postBlock'), () => toggleMute(ev.pubkey, { block: true }).catch(() => {}), true),
        h('button', { class: 'btn-ghost btn-block', onClick: close }, t('back'))));
  }

  // The things you can do to a post, in a row of their own across the bottom
  // of it: reply, boost, quote, react, zap. Counts sit beside their own icon,
  // because a count belongs to the thing it counts. Spread across the full
  // width so each is a comfortable target rather than five buttons huddled in
  // a corner.
  const ICON = (d, fill) => '<svg width="19" height="19" viewBox="0 0 24 24" fill="' + (fill ? 'currentColor' : 'none')
    + '" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block">' + d + '</svg>';
  const I_REPLY = ICON('<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>');
  const I_BOOST = ICON('<path d="M17 2.5l3.5 3.5-3.5 3.5"/><path d="M3.5 11.5v-1a4 4 0 0 1 4-4h13"/><path d="M7 21.5L3.5 18 7 14.5"/><path d="M20.5 12.5v1a4 4 0 0 1-4 4h-13"/>');
  const I_QUOTE = ICON('<path stroke="none" d="M7.2 17c.5 0 1-.3 1.2-.7l1.4-2.9c.1-.3.2-.6.2-.9V8c0-.6-.4-1-1-1H6c-.6 0-1 .4-1 1v4c0 .6.4 1 1 1h2l-1 2.1c-.5.9.2 1.9 1.2 1.9zm10 0c.5 0 1-.3 1.2-.7l1.4-2.9c.1-.3.2-.6.2-.9V8c0-.6-.4-1-1-1H16c-.6 0-1 .4-1 1v4c0 .6.4 1 1 1h2l-1 2.1c-.5.9.2 1.9 1.2 1.9z"/>', true);
  const I_HEART = (on) => ICON('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 1 0-7.8 7.8l1.1 1L12 21l7.7-7.7 1.1-1a5.5 5.5 0 0 0 0-7.7z"/>', on);
  const I_ZAP = ICON('<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>', true);

  function noteActions(pk, ev, { canZap }) {
    if (canZap && zapSoundOn()) warmZapSound(); // the clip is decoded before the first tap
    const mineReact = myReactOn(ev.id);
    const rm = reacts.get(ev.id);
    const cached = ui.noteThread
      ? threadCache.get(ui.noteThread.rootId)?.counts?.[ev.id] : null;
    const likeN = cached ? cached.likes : rm ? [...rm.values()].reduce((n, { who }) => n + visiblePks(who).length, 0) : 0;
    const boostN = cached ? cached.boosts : visiblePks(boosts.get(ev.id) || new Set()).length;
    const btn = (icon, label, count, on, onClick, cls = '', extra = null) => h('button', {
      class: 'note-act' + (on ? ' on' : '') + (cls ? ' ' + cls : ''), title: label, 'aria-label': label,
      'aria-disabled': onClick ? undefined : 'true',
      ...(extra || {}),
      onClick: (e) => { e.stopPropagation(); if (onClick) onClick(e); },
    },
      typeof icon === 'string' && icon.startsWith('<svg')
        ? h('span', { style: 'display:flex', html: icon })
        : h('span', { class: 'note-act-emoji' }, icon),
      count ? h('span', { class: 'note-act-n' }, String(count)) : null);
    // the sats tally rides on the zap button, like the like and boost counts
    // do on theirs — amber once anyone has zapped, breathing while ours flies
    const z = zapTotals.get(ev.id) || zapSeeds().get(ev.id);
    const zp = pendingOf(ev.id);
    const optimistic = zp ? zp.sats : 0;
    const zapSats = (cached ? cached.sats : z ? z.sats : 0) + optimistic;
    const zapFlying = !!zp && zp.flying;
    // tap pays the default amount; hold opens the screen that sets it
    const zapHold = canZap ? holdable((el) => openZapSettings(pk, ev.id, el.getBoundingClientRect()),
      (e) => { zapNote(pk, ev, e.currentTarget.getBoundingClientRect()); recheckZap(ev.id); }) : null;
    const zapMine = !!((z && z.mine) || optimistic);
    const zapLabel = zapFlying ? t('zapSending') : zapSats ? t('zapTallyTitle', { n: zapSats.toLocaleString() }) : t('zapTitle');
    return h('div', { class: 'row note-acts' },
      btn(I_REPLY, t('msgReply'), 0, false, () => replyToNote(ev)),
      btn(I_BOOST, t('postBoost'), boostN, iBoosted(ev.id), () => boostNote(ev).catch(() => {})),
      btn(I_QUOTE, t('postQuote'), 0, false, () => quoteNote(ev)),
      // tap to choose how you feel about it; tap again to take it back
      btn(mineReact ? postReactNode(mineReact) : I_HEART(false), t('postLike'), likeN, !!mineReact,
        () => { if (mineReact) unreact(ev).catch(() => {}); else { ui.reactPick = ev; render(); } }),
      // always in the bar — the same row of buttons on every post, so nothing
      // shifts when a wallet comes online; without one it is just the number
      btn(I_ZAP, zapLabel, zapSats ? fmtSats(zapSats) : 0, zapMine,
        zapHold && zapHold.onClick,
        'note-zap' + (zapMine ? ' zapped' : '') + (zapFlying ? ' flying' : ''),
        zapHold && { ...zapHold, onClick: undefined }),
      // who did all that: a small chevron, always in place — dimmed until
      // there is someone to show, so the first reaction doesn't reflow the bar
      (() => {
        const n = whoCount(ev.id), open = n && whoOpen(ev.id);
        return h('button', {
          class: 'note-act note-who-toggle' + (open ? ' on' : ''),
          title: t('postWho'), 'aria-label': t('postWho'), 'aria-expanded': open ? 'true' : 'false',
          'aria-disabled': n ? undefined : 'true',
          onClick: (e) => { e.stopPropagation(); if (n) toggleWho(ev.id); },
        }, h('span', { class: 'note-who-chev' + (open ? ' open' : ''), html: I_CHEV }));
      })());
  }

  // ---- who reacted, boosted and zapped ------------------------------------
  // The counts on the bar say how many; this says who, and with what. Opened
  // per post by the chevron, the way Amethyst does it, and remembered for
  // the session so a repaint doesn't fold it back up.
  const I_CHEV = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M6 9l6 6 6-6"/></svg>';
  const whoOpenIds = new Set();
  const whoOpen = (id) => whoOpenIds.has(id);
  const toggleWho = (id) => { if (whoOpenIds.has(id)) whoOpenIds.delete(id); else whoOpenIds.add(id); render(); };
  function whoCount(id) {
    const rm = reacts.get(id);
    let n = rm ? [...rm.values()].reduce((k, { who }) => k + visiblePks(who).length, 0) : 0;
    n += visiblePks(boosts.get(id) || new Set()).length;
    n += [...(zapWho.get(id) || new Map()).values()].filter((z) => !hiddenPk(z.pk)).length;
    return n;
  }
  function whoPanel(ev) {
    const rm = new Map([...(reacts.get(ev.id) || new Map())].map(([k, r]) => [k, { ...r, who: new Set(visiblePks(r.who)) }]).filter(([, r]) => r.who.size));
    const bs = new Set(visiblePks(boosts.get(ev.id) || new Set()));
    const zs = [...(zapWho.get(ev.id) || new Map()).values()].filter((z) => !hiddenPk(z.pk)).sort((a, b) => b.sats - a.sats || b.ts - a.ts);
    const person = (pk, extra) => h('button', {
      class: 'note-who-person',
      onClick: (e) => { e.stopPropagation(); openProfile(pk); },
    }, avatar(pk, 'chat-avatar mini', false), h('span', { class: 'note-who-name' }, displayName(pk)), extra || null);
    const people = (pks) => {
      for (const pk of pks) profileOf(pk); // names and faces, one batch
      return h('div', { class: 'row wrap note-who-people' },
        ...pks.slice(0, 24).map((pk) => person(pk)),
        pks.length > 24 ? h('span', { class: 'small faint' }, '+' + (pks.length - 24)) : null);
    };
    const line = (lead, body) => h('div', { class: 'row note-who-line' }, h('span', { class: 'note-who-lead' }, lead), body);
    const lines = [];
    // biggest zaps first, each with its own line (the amount is the point)
    if (zs.length) {
      for (const z of zs) profileOf(z.pk);
      lines.push(line(h('span', { style: 'display:flex', html: I_ZAP }),
        h('div', { class: 'col', style: 'gap:4px;min-width:0' }, ...zs.slice(0, 24).map((z) =>
          person(z.pk, h('span', { class: 'note-who-sats' }, fmtSats(z.sats) + ' sats'
            + (z.text ? ' · ' + z.text : '')))))));
    }
    for (const reaction of [...rm.values()].sort((a, b) => b.who.size - a.who.size)) {
      lines.push(line(h('span', { class: 'note-act-emoji' }, postReactNode(reaction)), people([...reaction.who])));
    }
    if (bs.size) lines.push(line(h('span', { style: 'display:flex', html: I_BOOST }), people([...bs])));
    if (!lines.length) return null;
    return h('div', { class: 'col note-who', onClick: (e) => e.stopPropagation() }, ...lines);
  }

  // The emoji row, same set the chat sheet offers.
  function reactPicker() {
    if (!ui.reactPick) return null;
    const ev = ui.reactPick;
    const close = () => { ui.reactPick = null; render(); };
    return h('div', {
      class: 'confirm-pop-backdrop',
      onClick: (e) => { if (e.target === e.currentTarget) close(); },
    },
      h('div', { class: 'card col msg-sheet' },
        reactRow(null, (e2) => { close(); reactTo(ev, e2).catch(() => {}); }),
        h('button', { class: 'btn-ghost btn-block', onClick: close }, t('back'))));
  }

  function noteRow(pk, ev, name, { open = true, focus = false } = {}) {
    // NOT prefetchProfilePage: that fetches the author's whole page — their
    // kind 0, their relay list, their last thirty notes — and a feed row is
    // not a profile tap. Twenty rows meant sixty requests, which is how the
    // batched profile fetch below ended up starved and the rows settled as
    // punks. The name and face come from the batch; the page loads when the
    // profile is actually opened.
    profileOf(pk);
    const isReply = ev.tags.some((x) => x[0] === 'e');
    const canZap = canZapPk(pk);
    // an optimistic post mid-publish: visible but not yet a real event —
    // dimmed, and no thread/reply/zap until its signed self takes over
    const pending = !!ev.pending;
    // flagged by people you follow: folded behind a line that says who
    const flagged = !pending && !(ui.revealed && ui.revealed.has(ev.id)) ? reportsOn(ev) : null;
    if (flagged) return foldedRow(ev, flagged);
    const openable = open && !pending;
    if (!pending) watchZaps([ev.id]);
    return h('div', {
      class: 'row',
      'data-zap-post': ev.id,
      'data-focus-note': focus ? '1' : undefined,
      style: 'gap:10px;align-items:flex-start;padding:10px 0'
        + (openable ? ';cursor:pointer' : '')
        + (pending ? ';opacity:.55' : '')
        + (focus ? ';background:var(--accent-soft,rgba(128,128,128,.08));border-radius:8px;padding-left:8px;padding-right:8px;margin:0 -8px' : ''),
      // closest('button') guard: on touch, a ⚡ tap must never double as a
      // row tap even if propagation quirks let the click reach us
      onClick: openable ? (e) => { if (e.target && e.target.closest && e.target.closest('button')) return; openNoteThread(ev); } : undefined,
    },
      // the avatar is its own tap-target (profile), even inside an openable
      // row — its handler stops propagation, so the row still opens the thread
      avatar(pk, 'chat-avatar note-avatar'),
      h('div', { class: 'col grow', style: 'min-width:0;gap:3px' },
        h('div', { class: 'row between', style: 'align-items:center;gap:8px' },
          h('div', { class: 'row', style: 'gap:7px;align-items:baseline;min-width:0' },
            h('span', {
              // the name, like the avatar, is its own tap-target (profile)
              style: 'font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer',
              onPointerdown: () => { try { prefetchProfilePage(pk); } catch {} },
              onClick: (e) => { e.stopPropagation(); openProfile(pk); },
            }, name),
            h('span', { class: 'small faint', style: 'white-space:nowrap' },
              (isReply ? '↩ ' + t('profReplyTag') + ' · ' : '') + timeLabel(ev.created_at * 1000))),
          pending ? null : h('button', {
            // the overflow stays up here; reply, boost, quote, react and zap
            // are a row of their own under the post
            class: 'btn-sm', title: t('postMore'), 'aria-label': t('postMore'),
            style: 'flex-shrink:0',
            onClick: (e) => { e.stopPropagation(); ui.noteSheet = ev; render(); },
          }, '\u22ef')),
        h('div', { class: 'note-text', style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, ...noteBody(ev.content, 0, emojiTagMap(ev.tags))),
        pending ? null : noteActions(pk, ev, { canZap }),
        !pending && whoOpen(ev.id) ? whoPanel(ev) : null));
  }

  // ---- thread view: a note in its conversation ----------------------------
  const threadCache = new Map(); // root id -> { status, root, replies }
  const threadStore = createThreadStore();
  const persistThread = (c) => {
    if (!c.root) return;
    const faces = {};
    for (const ev of [c.root, ...c.replies]) {
      const p = profiles.get(ev.pubkey);
      if (p && (p.name || p.picture)) faces[ev.pubkey] = p;
    }
    threadStore.save(c, c.focusId, faces, c.counts);
  };
  function persistThreadProfile(pk) {
    const c = ui.noteThread && threadCache.get(ui.noteThread.rootId);
    if (c?.root && [c.root, ...c.replies].some((ev) => ev.pubkey === pk)) persistThread(c);
  }
  const noteSep = () => h('div', { style: 'height:1px;background:var(--border,rgba(128,128,128,.18));margin:0 -14px' });
  function renderThreadStable() {
    if (!ui.noteThread || ui.noteThread.scrollPending || typeof document === 'undefined') { render(); return; }
    // At the very top the HEADER is the anchor. Pinning the first post instead
    // turns a late header/control row into an unwanted downward scroll.
    if (window.scrollY <= 1) {
      render();
      if (window.scrollY) window.scrollTo(0, 0);
      requestAnimationFrame(() => {
        if (ui.noteThread && window.scrollY <= 80) window.scrollTo(0, 0);
      });
      return;
    }
    const rows = [...document.querySelectorAll('.thread-page [data-zap-post]')];
    const anchor = rows.find((el) => el.getAttribute('data-focus-note') === '1'
      && el.getBoundingClientRect().top >= 0 && el.getBoundingClientRect().top < innerHeight)
      || rows.find((el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; });
    if (!anchor) { render(); return; }
    const id = anchor.getAttribute('data-zap-post');
    const top = anchor.getBoundingClientRect().top;
    render();
    const settle = () => {
      if (!ui.noteThread || ui.noteThread.scrollPending) return;
      const next = [...document.querySelectorAll('.thread-page [data-zap-post]')]
        .find((el) => el.getAttribute('data-zap-post') === id);
      if (next) window.scrollBy(0, next.getBoundingClientRect().top - top);
    };
    settle();
    requestAnimationFrame(settle);
  }
  function rootIdOf(ev) {
    const es = ev.tags.filter((x) => x[0] === 'e');
    const marked = es.find((x) => x[3] === 'root');
    return (marked || es[0] || [])[1] || ev.id;
  }
  function threadFor(seed) {
    const requestedRootId = rootIdOf(seed);
    let c = threadCache.get(requestedRootId) || [...new Set(threadCache.values())]
      .find((c) => c.replies.some((e) => e.id === seed.id || e.id === requestedRootId));
    if (c) {
      threadCache.set(requestedRootId, c);
      c.focusId = seed.id;
      if (seed.id === c.rootId) c.root ||= seed;
      else if (!c.replies.some((ev) => ev.id === seed.id)) {
        c.replies = [...c.replies, seed].sort((a, b) => a.created_at - b.created_at);
        persistThread(c);
      }
      if (ui.noteThread?.focusId === seed.id) ui.noteThread.rootId = c.rootId;
      return c;
    }
    // Browser history restores only the selected event. Recover the full
    // conversation synchronously, including the canonical root discovered
    // by climbing a reply-only chain on the previous visit.
    const stored = threadStore.find(seed.id) || threadStore.find(requestedRootId);
    // The event cache is public and survives profile-cache eviction. Restore
    // its author faces before the first thread row is painted on refresh.
    if (stored?.profiles) {
      warmProfiles();
      for (const [pk, face] of Object.entries(stored.profiles)) {
        const current = profiles.get(pk);
        if (!current || (current.eventAt || 0) < (face.eventAt || 0)
          || (current.eventAt === face.eventAt && !current.thumb && face.thumb)) {
          profiles.set(pk, { ...current, ...face });
        }
      }
    }
    const rootId = stored?.rootId || requestedRootId;
    c = { status: stored ? 'ready' : 'loading', rootId, focusId: seed.id,
      root: stored?.root || (seed.id === rootId ? seed : null), replies: stored?.replies || [], counts: stored?.counts || {} };
    if (seed.id !== rootId && !c.replies.some((e) => e.id === seed.id)) c.replies.push(seed);
    c.replies.sort((a, b) => a.created_at - b.created_at);
    threadCache.set(requestedRootId, c);
    threadCache.set(rootId, c);
    if (ui.noteThread?.focusId === seed.id) ui.noteThread.rootId = rootId;
    (async () => {
      // Where a thread lives: the reply's author, the people it tags (the
      // root's author is usually first among them), the relay hints on its
      // e tags, and ours. The reply author's relays alone missed roots
      // written elsewhere — the thread then opened without its first post.
      const relaysFor = async (ev) => {
        const hints = ev.tags.filter((x) => x[0] === 'e' && /^wss?:\/\//i.test(x[2] || '')).map((x) => x[2]);
        const people = [ev.pubkey, ...ev.tags.filter((x) => x[0] === 'p').map((x) => x[1]).slice(0, 3)];
        const sets = await Promise.all(people.map((pk) => notesRelays(pk).catch(() => [])));
        return [...new Set([...hints, ...sets.flat(), ...NOTE_RELAYS])].slice(0, 12);
      };
      let relays = await relaysFor(c.root || seed);
      const [roots, replies] = await Promise.all([
        c.root ? Promise.resolve([]) : queryOn(relays, { kinds: [1], ids: [rootId] }, 4000),
        queryOn(relays, { kinds: [1], '#e': [rootId], limit: 80 }, 4500),
      ]);
      if (!c.root) c.root = (roots || [])[0] || null;
      let all = [...c.replies, ...(replies || [])];
      // A client that tags only the note it answered leaves the root
      // unnamed: what we resolved as the root is itself a reply. Climb —
      // fetch ITS root and re-root the thread there — a few hops at most.
      let top = c.root, topId = rootId;
      for (let hop = 0; top && hop < 4; hop++) {
        const up = rootIdOf(top);
        if (up === top.id) break;
        relays = [...new Set([...relays, ...(await relaysFor(top))])].slice(0, 14);
        const [ups, more] = await Promise.all([
          queryOn(relays, { kinds: [1], ids: [up] }, 4000),
          queryOn(relays, { kinds: [1], '#e': [up], limit: 80 }, 4500),
        ]);
        const upNote = (ups || [])[0];
        if (!upNote) break;
        all = [...all, top, ...(more || [])];
        top = upNote; topId = up;
      }
      if (topId !== rootId) {
        c.root = top; c.rootId = topId;
        threadCache.set(topId, c);
        if (ui.noteThread && ui.noteThread.rootId === rootId) ui.noteThread.rootId = topId;
      }
      for (const e of all) noteForSpam(e);
      const seen = new Set([c.rootId]);
      c.replies = all
        .filter((e) => e && e.id !== c.rootId && !seen.has(e.id) && seen.add(e.id))
        .sort((a, b) => a.created_at - b.created_at);
      c.status = 'ready';
      persistThread(c);
      if (ui.noteThread && ui.noteThread.rootId === c.rootId) {
        renderThreadStable();
        // The inline reply box may have MOVED on this render (it slots under
        // the focused note once that note exists) — a focus taken before the
        // load finished died with the old position. Re-take it if the reply
        // button asked for it.
        if (ui.noteThread.refocus) {
          ui.noteThread.refocus = false;
          const s = ui.noteThread;
          setTimeout(() => focusThreadReply(s), 30);
        }
      }
    })().catch(() => {
      c.status = 'ready';
      if (ui.noteThread && ui.noteThread.rootId === c.rootId) renderThreadStable();
    });
    return c;
  }
  function openNoteThread(ev) {
    ui.noteThread = { rootId: rootIdOf(ev), focusId: ev.id, seed: ev, scrollPending: true };
    ui.profOverThread = false; // a freshly opened thread goes on top
    render();
  }
  // A nostr:nevent / nostr:note reference: the thread loader needs the real
  // event (its tags name the root, its author names the home relays), so
  // fetch it by id — the reference's relay hints first — then open.
  async function openNoteRef(ref) {
    const saved = threadStore.find(ref.id);
    const cached = saved && (saved.root.id === ref.id ? saved.root : saved.replies.find((e) => e.id === ref.id));
    if (cached) { openNoteThread(cached); return; }
    toast(t('noteRefLoading'));
    const relays = [...new Set([...(ref.relays || []), ...NOTE_RELAYS])];
    const evs = await queryOn(relays, { ids: [ref.id] }, 4000).catch(() => []);
    const ev = (evs || [])[0];
    if (ev) openNoteThread(ev);
    else toast(t('noteRefNotFound'));
  }
  // Publish a kind-1 reply to the focused note (NIP-10 markers), addressed to
  // the conversation's own relays plus ours, and shown optimistically.
  // A new top-level kind-1 note, published to the identity's own relays —
  // the profile page's compose button. OPTIMISTIC: a provisional copy sits
  // at the top of the feed before any signing or relay round-trip (a remote
  // signer alone can take seconds), swapped for the signed event on success
  // and withdrawn on failure.
  async function publishPost(text, media = []) {
    const id = await requireIdentity();
    const temp = {
      id: 'pending:' + Math.random().toString(36).slice(2),
      pubkey: id.pubkey, content: text, created_at: Math.floor(Date.now() / 1000),
      tags: [], pending: true,
    };
    const caches = [...new Set([id.pubkey, ui.profilePk].filter(Boolean))]
      .map((pk) => notesCache.get(pk)).filter(Boolean);
    for (const c of caches) c.notes = [temp, ...c.notes];
    // your own post belongs at the top of your own feed too, before any
    // relay has heard of it
    if (feed) { feed.notes = [temp, ...feed.notes]; }
    render();
    try {
      // NIP-92: what we uploaded, described, so clients needn't sniff the URL
      const imeta = media.filter((m) => m && m.url)
        .map((m) => ['imeta', 'url ' + m.url, ...(m.m ? ['m ' + m.m] : [])]);
      // NIP-18 quote: the reference is already in the text; the tags let a
      // client render the quoted post inline and tell its author
      const q = ui.quoteOf && text.includes(ui.quoteOf.id.slice(0, 8))
        ? [] : ui.quoteOf ? [['q', ui.quoteOf.id], ['p', ui.quoteOf.pubkey]] : [];
      const partial = { kind: 1, content: text, created_at: temp.created_at, tags: [...imeta, ...q, CLIENT_TAG] };
      const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
      const relays = [...new Set([...(await notesRelays(id.pubkey)), ...wallet.nostrRelays()])];
      const ok = await publishOn(relays, evt);
      if (!ok) throw new Error(t('msgSendFailed'));
      ui.quoteOf = null;
      for (const c of caches) c.notes = c.notes.map((e) => (e.id === temp.id ? evt : e));
      if (feed) feed.notes = feed.notes.map((e) => (e.id === temp.id ? evt : e));
      render();
      return evt;
    } catch (e) {
      for (const c of caches) c.notes = c.notes.filter((e) => e.id !== temp.id);
      if (feed) feed.notes = feed.notes.filter((e) => e.id !== temp.id);
      render();
      throw e;
    }
  }

  async function publishReply(c, s, text) {
    const id = await requireIdentity();
    const target = c.replies.find((e) => e.id === s.focusId) || c.root || s.seed;
    const rootId = c.rootId;
    const pTags = [...new Set([
      target.pubkey,
      ...(c.root ? [c.root.pubkey] : []),
      ...target.tags.filter((x) => x[0] === 'p' && /^[0-9a-f]{64}$/.test(x[1] || '')).map((x) => x[1]),
    ])].filter((pk) => pk !== id.pubkey).slice(0, 8);
    const imeta = (ui.postMedia || []).filter((m) => m && m.url && text.includes(m.url))
      .map((m) => ['imeta', 'url ' + m.url, ...(m.m ? ['m ' + m.m] : [])]);
    const partial = {
      kind: 1,
      content: text,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['e', rootId, '', 'root'],
        ...(target.id !== rootId ? [['e', target.id, '', 'reply']] : []),
        ...pTags.map((pk) => ['p', pk]),
        ...imeta,
        CLIENT_TAG,
      ],
    };
    const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
    const relays = [...new Set([...(await notesRelays(target.pubkey)), ...wallet.nostrRelays()])];
    const ok = await publishOn(relays, evt);
    if (!ok) throw new Error(t('msgSendFailed'));
    c.replies = [...c.replies, evt];
    persistThread(c);
    return evt;
  }

  function threadScreen() {
    const s = ui.noteThread;
    const c = threadFor(s.seed);
    const row = (ev) => noteRow(ev.pubkey, ev, displayName(ev.pubkey), { open: false, focus: ev.id === s.focusId && ev.id !== c.rootId });
    // The reply box sits INLINE, right under the note it answers — it used
    // to live at the bottom of the thread, where nobody scrolled to find it.
    const replyBox = () => h('div', { class: 'col', style: 'gap:8px;padding:2px 0 10px' },
      s.preview ? draftPreview(s.draft) : null,
      h('div', { class: 'row', style: 'gap:8px;align-items:flex-end' },
      // A textarea that grows with the reply, like the chat composer: Enter
      // sends, Shift+Enter (or Ctrl+J) breaks the line — a reply used to be
      // a one-line field with no way to write a paragraph.
      h('textarea', {
        class: 'grow thread-reply-input', placeholder: t('threadReplyHint'),
        rows: String(Math.min(5, (s.draft || '').split('\n').length)),
        style: 'font-family:var(--sans);resize:none;max-height:120px;overflow-y:auto;line-height:1.4',
        value: s.draft || '',
        // a render per keystroke only while the preview is open; the morph
        // leaves a focused field alone, so this can't fight the typing
        onInput: (e) => { s.draft = e.target.value; growComposer(e.target); if (s.preview) render(); },
        onKeydown: (e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.target.closest('.col').querySelector('.thread-reply-send')?.click(); return; }
          if (e.ctrlKey && (e.key === 'j' || e.key === 'J')) {
            e.preventDefault();
            const el = e.target;
            const { selectionStart: s0, selectionEnd: s1, value } = el;
            el.value = value.slice(0, s0) + '\n' + value.slice(s1);
            el.selectionStart = el.selectionEnd = s0 + 1;
            s.draft = el.value;
            growComposer(el);
          }
        },
      }),
      // A reply can carry a picture too — same upload, same imeta tag, same
      // paperclip. The URL lands in the draft, which is what every client
      // reads as the media.
      ctx.uploadImage ? h('button', {
        class: 'attach-btn', title: t('feedAttach'), 'aria-label': t('feedAttach'), disabled: !!ui.postUploading,
        onClick: () => document.getElementById('reply-file')?.click(),
      }, ui.postUploading ? h('span', { class: 'spinner sm' }) : h('span', { style: 'display:flex', html: CLIP })) : null,
      h('input', {
        type: 'file', id: 'reply-file', accept: 'image/*,video/*', style: 'display:none',
        onChange: async (e) => {
          const f = e.target.files && e.target.files[0];
          e.target.value = '';
          await attachTo(f, (url) => {
            s.draft = ((s.draft || '').replace(/\s+$/, '') + ' ' + url).trim();
            const inp = document.querySelector('.thread-reply-input');
            if (inp) inp.value = s.draft;
            s.preview = true; // same as the composer: show what was attached
          });
        },
      }),
      previewBtn(!!s.preview, () => { s.preview = !s.preview; render(); }),
      h('button', {
        class: 'btn-primary thread-reply-send', disabled: !!s.sending || !!ui.postUploading,
        onClick: async () => {
          const text = (s.draft || '').trim();
          if (!text) return;
          s.sending = true; render();
          try {
            await publishReply(c, s, text);
            s.draft = '';
            ui.postMedia = (ui.postMedia || []).filter((m) => !text.includes(m.url));
            // the input may still be focused, and the morph won't touch a
            // focused field's value — clear it by hand
            const inp = document.querySelector('.thread-reply-input');
            if (inp) inp.value = '';
            toast(t('threadReplied'));
          } catch (e) { if (!e.silent) toast(e.message); }
          s.sending = false; render();
        },
      }, s.sending ? h('span', { class: 'spinner sm' }) : t('threadReplySend'))));
    // rows with the reply box slotted under the focused note (the root when
    // nothing narrower is focused; appended at the end if the focused note
    // hasn't loaded yet, so the box never disappears entirely)
    const kids = [];
    let boxPlaced = false;
    const place = (ev) => {
      if (boxPlaced) return;
      if (ev.id === s.focusId || (!s.focusId && c.root && ev.id === c.root.id)) {
        kids.push(replyBox());
        boxPlaced = true;
      }
    };
    if (c.root) { kids.push(row(c.root)); place(c.root); }
    else {
      kids.push(h('div', { class: 'small faint', style: 'padding:10px 0' },
        c.status === 'loading' ? '…' : t('threadRootMissing')));
    }
    // Replies as a tree, not one flat line by time: each note's answers sit
    // under it, a little indented, oldest first — except your own, which go
    // first among a note's answers, so what you just wrote shows right
    // under the post instead of at the bottom of a long thread.
    const parentOf = (ev) => {
      const es = ev.tags.filter((x) => x[0] === 'e');
      const marked = es.find((x) => x[3] === 'reply');
      return (marked || es[es.length - 1] || [])[1] || c.rootId;
    };
    const ids = new Set([c.rootId, ...c.replies.map((e) => e.id)]);
    const children = new Map();
    for (const ev of c.replies) {
      const pid = ids.has(parentOf(ev)) ? parentOf(ev) : c.rootId; // an orphan hangs off the root
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(ev);
    }
    const walk = (pid, depth) => {
      const list = (children.get(pid) || []).sort((a, b) => (isMe(b.pubkey) - isMe(a.pubkey)) || (a.created_at - b.created_at));
      for (const ev of list) {
        if (hidden(ev)) { walk(ev.id, depth); continue; } // its answers keep their place
        const indent = Math.min(depth, 3) * 14;
        kids.push(noteSep(), indent ? h('div', { style: 'margin-left:' + indent + 'px' }, row(ev)) : row(ev));
        place(ev);
        walk(ev.id, depth + 1);
      }
    };
    walk(c.rootId, 0);
    if (c.status === 'loading') kids.push(h('div', { class: 'row', style: 'justify-content:center;padding:12px' }, h('span', { class: 'spinner sm' })));
    else if (!c.replies.length) kids.push(h('div', { class: 'small faint', style: 'text-align:center;padding:10px 0' }, t('threadNoReplies')));
    if (!boxPlaced) kids.push(replyBox());
    // A tapped reply deep in a long thread has to be ON SCREEN when the
    // thread opens — highlighting it somewhere below the fold reads as the
    // thread having missed it. Scroll to it after this paint; if the replies
    // are still loading the row isn't there yet, so the request stays armed
    // for the render that brings it. The root itself means the top.
    if (s.scrollPending) {
      const isRoot = !!c.root && s.focusId === c.root.id;
      setTimeout(() => {
        if (ui.noteThread !== s || !s.scrollPending) return;
        if (isRoot) { s.scrollPending = false; try { window.scrollTo({ top: 0 }); } catch {} return; }
        const el = document.querySelector('[data-focus-note]');
        if (!el) return;
        s.scrollPending = false;
        try { el.scrollIntoView({ block: 'center' }); } catch {}
      }, 60);
    }
    return h('div', { class: 'col thread-page', style: 'gap:16px' },
      // full header: search/chat/settings stay reachable mid-thread (only
      // the public no-wallet surface drops the action row)
      ctx.brandHeader(!ui.pubProf && wallet.loaded),
      h('div', { class: 'card col', style: 'gap:0;padding:2px 14px' }, ...kids),
      h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.noteThread = null; render(); } }, t('back')),
      ...noteOverlays());
  }

  async function publishProfileFields(fields, opts = {}) {
      const id = await requireIdentity();
      const evs = await queryOn([...new Set([...PROFILE_RELAYS, ...DM_RELAYS])], { kinds: [0], authors: [id.pubkey] }, 3000);
      const newest = evs.sort((a, b) => b.created_at - a.created_at)[0];
      let base = {};
      try { base = newest ? JSON.parse(newest.content) : {}; } catch {}
      if (opts.onlyWhen && !opts.onlyWhen(base)) return true; // condition says leave it be
      const merged = { ...base };
      // fillOnly fields are offers, not orders: the onboarding wizard suggests
      // a name and a punk for profiles that have none — it must never RENAME
      // (or re-face) an identity that already has one.
      const fill = new Set(opts.fillOnly || []);
      const taken = (k) => (k === 'name' ? !!(base.name || base.display_name) : !!base[k]);
      for (const [k, v] of Object.entries(fields || {})) {
        if (!v) continue;
        if (fill.has(k) && taken(k)) continue;
        if (opts.fieldWhen && opts.fieldWhen[k] && !opts.fieldWhen[k](base)) continue;
        merged[k] = v;
      }
      if (merged.name && !(fill.has('name') && taken('name'))) merged.display_name = merged.name;
      if (JSON.stringify(merged) === JSON.stringify(base)) return true; // nothing to say
      const partial = { kind: 0, content: JSON.stringify(merged), tags: [], created_at: Math.floor(Date.now() / 1000) };
      const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
      const ok = await publishOn([...new Set([...PROFILE_RELAYS, ...DM_RELAYS])], evt);
      if (!ok) throw new Error(t('msgSendFailed'));
      fullProfiles.set(id.pubkey, merged);
      profiles.set(id.pubkey, { name: merged.name || null, picture: merged.picture || null, t: Date.now() });
      return true;
    }

  async function saveProfile() {
    const id = await identity();
    if (!id) { noIdToast(); return; }
    const e = ui.profEdit;
    e.migrationName = null;
    ui.profSaving = true;
    render();
    try {
      // merge over the newest published kind 0 so unknown fields round-trip
      const evs = await queryOn([...new Set([...PROFILE_RELAYS, ...DM_RELAYS])], { kinds: [0], authors: [id.pubkey] }, 3000);
      const newest = evs.sort((a, b) => b.created_at - a.created_at)[0];
      let base = {};
      try { base = newest ? JSON.parse(newest.content) : {}; } catch {}
      // A changed username claims first — if the name is taken (or invalid)
      // the save stops here and the editor stays open to fix it.
      const oldAddr = hook('namesAddress');
      let addr = oldAddr;
      const want = (e.uname || '').trim().toLowerCase();
      if (oldAddr && want && want !== oldAddr.split('@')[0]) {
        if (!/^[a-z0-9][a-z0-9._-]{0,29}$/.test(want)) throw new Error(t('profUnameInvalid'));
        await hook('namesClaimName', want, { quietProfile: true });
        addr = want + '@' + oldAddr.split('@')[1];
      }
      const merged = { ...base };
      for (const [k, v] of [['name', e.name], ['about', e.about], ['picture', e.picture], ['banner', e.banner]]) {
        if (v.trim()) merged[k] = v.trim();
        else delete merged[k];
      }
      // The address doubles as the lightning address and NIP-05. Fill them
      // when empty; move them when they pointed at our (old) address. A
      // deliberately foreign lud16/nip05 is the user's business.
      if (addr) {
        for (const k of ['lud16', 'nip05'])
          if (!merged[k] || merged[k] === oldAddr) merged[k] = addr;
      }
      if (merged.name) merged.display_name = merged.name;
      const partial = { kind: 0, content: JSON.stringify(merged), tags: [], created_at: Math.floor(Date.now() / 1000) };
      const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
      const ok = await publishOn([...new Set([...PROFILE_RELAYS, ...DM_RELAYS])], evt);
      if (!ok) throw new Error(t('msgSendFailed'));
      fullProfiles.set(id.pubkey, merged);
      profiles.set(id.pubkey, { name: merged.name || null, picture: merged.picture || null });
      ui.profEdit = null; ui.profEditFilled = false;
      toast(t('profSaved'));
    } catch (err) {
      if (ui.profEdit === e && e.uname === err.migrationName) e.migrationName = err.migrationName;
      toast(err.message || String(err));
    } finally {
      ui.profSaving = false;
      render();
    }
  }

  function profileScreen() {
    const pk = ui.profilePk;
    const mine = isMe(pk) || (ctx.shownPubkey && pk === ctx.shownPubkey());
    // History can outlive an account switch; only restore our own editor.
    if (!mine && ui.profEdit) { ui.profEdit = null; ui.profEditFilled = false; }
    const logoutBtn = () => h('button', {
      class: 'btn-block', style: 'color:var(--red,#c0392b);display:flex;align-items:center;justify-content:center;gap:8px',
      onClick: () => { ui.logoutConfirm = true; render(); },
    },
      h('span', { style: 'display:flex', html: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>' }),
      t('logout'));
    // One Log out button; the popup offers the two exits — leave (wallets
    // stay saved, one unlock away) or leave and take everything with you.
    // The full wipe still routes through the Delete-all warning after this.
    // Two stages in one popup: the plain logout choices, then — if "forget
    // all data" is picked — the delete-everything warning right here. The old
    // flow detoured to the Accounts page for that confirmation, which read
    // as broken navigation (and left people thinking data was wiped when
    // only a confirm screen had opened).
    const logoutPop = () => !ui.logoutConfirm ? null : h('div', {
      class: 'confirm-pop-backdrop',
      onClick: (e) => { if (e.target === e.currentTarget) { ui.logoutConfirm = null; render(); } },
    },
      ui.logoutConfirm === 'forget'
        ? h('div', { class: 'card col confirm-pop', style: 'gap:10px' },
            h('h3', { style: 'margin:0' }, t('logoutForget') + '?'),
            h('div', { class: 'notice err small' }, t('clearAllWarn')),
            h('button', {
              class: 'btn-block', style: 'color:var(--red,#c0392b)',
              onClick: () => { ui.logoutConfirm = null; ctx.logoutForget(); },
            }, t('clearAll')),
            h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.logoutConfirm = true; render(); } }, t('back')))
        : (() => {
            // With other identities signed in, logging out means THIS one
            // leaves and the rest stay put; logging out of everything is
            // the second, explicit choice. Alone on the device, it's the
            // plain log-out it always was.
            const others = ctx.identities ? ctx.identities().filter((x) => !x.active) : [];
            const one = others.length > 0 && !!ctx.signOutIdentity;
            const leave = (fn) => () => {
              ui.logoutConfirm = null;
              ui.profilePk = null; ui.profEdit = null; ui.profEditFilled = false;
              fn && fn();
            };
            return h('div', { class: 'card col confirm-pop', style: 'gap:10px' },
            h('h3', { style: 'margin:0' }, (one ? t('logoutOne', { name: displayName(pk) }) : t('logout')) + '?'),
            h('p', { class: 'small muted', style: 'margin:0' },
              one ? t(ctx.identityRecoverable && ctx.identityRecoverable() ? 'logoutOneBlurbLogin' : 'logoutOneBlurbSeed') : t('logoutPopBlurb')),
            h('button', { class: 'btn-primary btn-block', onClick: leave(one ? ctx.signOutIdentity : ctx.logout) }, t('logout')),
            one ? h('button', { class: 'btn-block', onClick: leave(ctx.logout) }, t('logoutAll')) : null,
            ctx.logoutForget ? h('button', {
              class: 'btn-block', style: 'color:var(--red,#c0392b)',
              onClick: () => { ui.logoutConfirm = 'forget'; render(); },
            }, t('logoutForget')) : null,
            h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.logoutConfirm = null; render(); } }, t('back')));
          })());
    // The identity switcher: every account signed in on this device as an
    // avatar + name row (tap = switch, nothing logged out), and the door to
    // add a new one.
    const switchPop = () => {
      if (!ui.switchIdPop) return null;
      const close = () => { ui.switchIdPop = null; render(); };
      const others = (ctx.identities ? ctx.identities() : []).filter((x) => !x.active);
      return h('div', {
        class: 'confirm-pop-backdrop',
        onClick: (e) => { if (e.target === e.currentTarget) close(); },
      },
        h('div', { class: 'card col confirm-pop', style: 'gap:10px' },
          h('h3', { style: 'margin:0' }, t('switchIdentityTitle')),
          h('p', { class: 'small muted', style: 'margin:0' }, t('switchIdentityDesc')),
          h('div', { class: 'col', style: 'gap:0' },
            others.map((x) => h('div', {
              class: 'row gap6 clickable', style: 'align-items:center;padding:8px 0;border-bottom:1px solid var(--line)',
              onClick: () => { ui.switchIdPop = null; ctx.switchIdentity(x.id); },
            },
              x.pk ? avatar(x.pk, 'chat-avatar', false) : h('div', { class: 'chat-avatar fallback' }),
              h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
                h('div', { class: 'chat-name', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, x.pk ? displayName(x.pk) : x.label),
                h('div', { class: 'small muted', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
                  (x.pk ? x.label : t('identityNoKey'))
                  + (x.network && x.network !== 'mainnet' ? ' · ' + x.network : '')
                  + (x.watch ? ' · ' + t('watchOnlyTag') : '')))))),
          h('button', { class: 'btn-primary btn-block', onClick: () => { ui.switchIdPop = null; ctx.signInAnother(); } }, t('signInNew')),
          h('button', { class: 'btn-ghost btn-block', onClick: close }, t('back'))));
    };
    const full = fullProfiles.get(pk);
    // Your own profile reads like anyone else's — npub, bio, latest posts —
    // with the editor behind an explicit Edit button (it used to BE the
    // page, which made looking at your own profile feel like a form). The
    // seed comes from the local name/picture cache so the form opens
    // instantly; saveProfile re-fetches the newest kind 0 before merging,
    // so a stale seed can't clobber anything.
    const myAddr = mine ? hook('namesAddress') : null;
    const openEditor = () => {
      const p = (full === undefined ? profileOf(pk) : full) || {};
      ui.profEdit = {
        uname: myAddr ? myAddr.split('@')[0] : '',
        name: (full || {}).display_name || p.name || '',
        about: p.about || '',
        picture: p.picture || '',
        banner: (full || {}).banner || '',
      };
      ui.profEditFilled = full !== undefined;
      render();
    };
    // Once the real kind 0 lands, top up fields still sitting empty — never
    // ones the user (or the cache) already filled.
    if (mine && ui.profEdit && !ui.profEditFilled && full !== undefined) {
      ui.profEditFilled = true;
      const e = ui.profEdit;
      if (!e.name && !e.touched?.name) e.name = full.display_name || full.name || '';
      for (const key of ['about', 'picture', 'banner'])
        if (!e[key] && !e.touched?.[key]) e[key] = full[key] || '';
    }
    const name = displayName(pk);
    const npub = npubOf(pk) || pk;
    const field = (label, key, ph = '', multi = false) => h('label', { class: 'field' },
      h('span', { class: 'lab' }, label),
      h(multi ? 'textarea' : 'input', {
        ...(multi ? { rows: '4', style: 'font-family:var(--sans);min-height:72px' } : { type: 'text' }),
        placeholder: ph, value: ui.profEdit[key],
        // render per keystroke so the page-top preview (name/picture/banner)
        // tracks the draft live — the morph never rewrites a focused field,
        // so this can't fight the typing
        onInput: (ev) => {
          ui.profEdit[key] = ev.target.value;
          (ui.profEdit.touched ||= {})[key] = true;
          render();
        },
      }));
    // A lightning address worth showing: not an npub-shaped machine address
    // (npub1…@some.relay duplicates the npub below) and not the same string
    // as the nip05 already on screen.
    // The address must not wait for the kind 0: our own claimed name is
    // authoritative locally, a deep link carries the address in the URL
    // (seeded as `addr`), and the light cache remembers it from last time.
    const lp = profileOf(pk) || {};
    const rawNip05 = (full && full.nip05) || (mine && myAddr) || lp.nip05 || lp.addr || null;
    const nip05 = rawNip05 ? String(rawNip05).replace(/^_@/, '') : null;
    const lud16 = (full && full.lud16 ? String(full.lud16) : null) || lp.lud16 || null;
    const showLud = lud16 && !/^npub1/i.test(lud16) && lud16 !== nip05;
    // an about of "~" or a lone character is noise, not a bio.
    // Until the full kind 0 lands, the light profile cache answers — it was
    // filled by the same batched fetch that named this person in the feed,
    // so the bio is already in hand and the page doesn't grow a paragraph
    // half a second after it opens. Once `full` is known it is the truth,
    // including when it says there is no bio.
    const about = full !== undefined
      ? (typeof full.about === 'string' ? full.about.trim() : '')
      : (typeof lp.about === 'string' ? lp.about.trim() : '');
    const showAbout = about.length > 1;
    // The cover photo: nostr's standard kind-0 `banner`. Legacy coinos.io
    // wore these proudly — migrated accounts bring theirs along, and anyone
    // can set one in the editor below. WHILE EDITING, the draft is the
    // truth: an uploaded (or pasted) picture/banner previews immediately at
    // the top of the page instead of waiting for Save — and clearing a field
    // previews the removal too.
    const draft = mine && ui.profEdit ? ui.profEdit : null;
    const urlish = (s) => (typeof s === 'string' && /^https?:\/\//i.test(s.trim()) ? s.trim() : null);
    const bannerUrl = draft ? urlish(draft.banner)
      : full !== undefined ? urlish(full.banner)
      // same as the bio: the cached copy holds the space so the whole page
      // doesn't drop by the height of a cover photo when it arrives
      : urlish(lp.banner);
    const draftPic = draft && urlish(draft.picture);
    return h('div', { class: 'col', style: 'gap:16px' },
      // full header on profiles too — losing the search button here made
      // finding the NEXT person a trek back home
      ctx.brandHeader(!ui.pubProf && wallet.loaded),
      fullMisses.has(pk) ? h('div', { class: 'row between gap6 small muted' },
        t(full || lp.eventAt || lp.name || lp.picture ? 'profFetchFailed' : 'profNotFound'),
        h('button', { class: 'btn-sm', onClick: () => { fetchFullProfile(pk); render(); } }, t('retry'))) : null,
      h('div', { class: 'card col', style: 'gap:12px' },
        bannerUrl ? h('div', { class: 'profile-banner', style: `background-image:url(${JSON.stringify(bannerUrl)})` }) : null,
        h('div', { class: 'row gap6', style: 'align-items:center' },
          draftPic
            ? h('div', { class: 'chat-avatar profile-avatar ava-img', style: `background-image:url(${JSON.stringify(draftPic)})` })
            : avatar(pk, 'chat-avatar profile-avatar', false),
          h('div', { class: 'col grow', style: 'min-width:0;gap:2px' },
            h('div', { class: 'chat-title' }, draft && draft.name.trim() ? draft.name.trim() : name),
            nip05 ? h('div', { class: 'muted small break' }, nip05) : null,
            showLud ? h('div', { class: 'muted small break' }, '⚡ ' + lud16) : null,
            // the hat pitch lives beside the avatar it decorates
            mine ? hook('hatShopEntry') : null)),
        // no spinner while the kind 0 loads — prefetch keeps this rare, and
        // an empty beat reads calmer than a spinner
        // The bio rides the same renderer as notes: npub mentions become
        // @names, other nostr: refs truncate to stubs, URLs linkify — and
        // overflow-wrap catches any remaining unbreakable token (a raw npub
        // in a bio was punching clean through the card).
        showAbout && !ui.profEdit
          ? h('p', { class: 'small', style: 'margin:0;white-space:pre-wrap;overflow-wrap:anywhere' },
              ...noteBody(about.slice(0, 1000)))
          : null,
        // the npub, tap to copy — on every profile including your own; it
        // only steps aside while the (long) edit form is open
        ui.profEdit ? null : h('button', {
          class: 'addr-box break npub-box', title: t('copy'),
          style: 'font-size:11px;cursor:pointer;text-align:left;width:100%',
          onClick: async () => { try { await navigator.clipboard.writeText(npub); toast(t('copied')); } catch {} },
        }, npub),
        ui.profEdit
          ? h('div', { class: 'col', style: 'gap:8px' },
              // the username IS the payment address and NIP-05 — the frozen
              // @domain suffix is there so people make that connection
              myAddr ? h('label', { class: 'field' },
                h('span', { class: 'lab' }, t('profUsername')),
                h('div', { class: 'row', style: 'align-items:center;gap:0' },
                  h('input', {
                    type: 'text', style: 'flex:1;min-width:0',
                    autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
                    value: ui.profEdit.uname,
                    onInput: (ev) => {
                      ui.profEdit.uname = ev.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '');
                      ev.target.value = ui.profEdit.uname;
                      ui.profEdit.migrationName = null;
                      render();
                    },
                  }),
                  h('span', { class: 'muted', style: 'white-space:nowrap;padding:0 8px' }, '@' + myAddr.split('@')[1]))) : null,
              // Offered only for a submitted name confirmed as legacy-only.
              ui.profEdit.migrationName && ui.profEdit.migrationName === ui.profEdit.uname
                && myAddr && myAddr.split('@')[1] === 'coinos.io' ? h('button', {
                type: 'button', class: 'linklike small', style: 'align-self:flex-start',
                onClick: () => {
                  location.href = `https://coinos.io/migrate?to=${encodeURIComponent(myAddr)}&back=${encodeURIComponent(location.origin + '/')}`;
                },
              }, t('onbHaveCoinos')) : null,
              field(t('profDisplayName'), 'name'),
              field(t('profAbout'), 'about', '', true),
              field(t('profPicture'), 'picture', 'https://…'),
              // or skip the URL entirely: pick a photo, we upload and fill it
              h('div', { class: 'row gap6' },
                h('button', {
                  class: 'btn-sm', type: 'button', disabled: !!ui.profUploading,
                  onClick: () => document.getElementById('prof-pic-file')?.click(),
                }, ui.profUploading ? h('span', { class: 'spinner sm' }) : t('profUploadPic')),
                h('input', {
                  id: 'prof-pic-file', type: 'file', accept: 'image/*', style: 'display:none',
                  onChange: async (e) => {
                    const f = e.target.files && e.target.files[0];
                    e.target.value = '';
                    if (!f || !ctx.uploadImage) return;
                    ui.profUploading = true; render();
                    try { if (ui.profEdit) ui.profEdit.picture = await ctx.uploadImage(f); }
                    catch (err) { toast(err.message); }
                    ui.profUploading = false; render();
                  },
                })),
              field(t('profBanner'), 'banner', 'https://…'),
              h('div', { class: 'row gap6' },
                h('button', {
                  class: 'btn-sm', type: 'button', disabled: !!ui.profUploading,
                  onClick: () => document.getElementById('prof-banner-file')?.click(),
                }, ui.profUploading ? h('span', { class: 'spinner sm' }) : t('profUploadBanner')),
                h('input', {
                  id: 'prof-banner-file', type: 'file', accept: 'image/*', style: 'display:none',
                  onChange: async (e) => {
                    const f = e.target.files && e.target.files[0];
                    e.target.value = '';
                    if (!f || !ctx.uploadImage) return;
                    ui.profUploading = true; render();
                    try { if (ui.profEdit) ui.profEdit.banner = await ctx.uploadImage(f); }
                    catch (err) { toast(err.message); }
                    ui.profUploading = false; render();
                  },
                })),
              h('button', { class: 'btn-primary btn-block', disabled: ui.profSaving, onClick: saveProfile },
                ui.profSaving ? h('span', { class: 'spinner sm' }) : t('save')),
              h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.profEdit = null; ui.profEditFilled = false; render(); } }, t('cancel')))
          : mine
            ? h('div', { class: 'col', style: 'gap:8px' },
                h('div', { class: 'row gap6 wrap' },
                  h('button', { class: 'btn-primary grow', onClick: openEditor }, t('profEdit')),
                  h('button', { class: 'grow', onClick: () => { ui.profCompose = ui.profCompose == null ? draftFor(POST_DRAFT) : null; render(); } }, t('profNewPost'))),
                // The post draft rides the same persisted draft store as DMs
                // and channels: a reload (say, to reconnect a signer) brings
                // the half-written post back, composer open. Posting clears
                // it; Cancel just closes the composer and keeps the text.
                postComposer(),
                // the non-destructive way out: add another identity (Nostr,
                // passkey, Google) next to this one and switch between them
                // on the Accounts screen — logout stays for actually leaving
                ctx.signInAnother ? h('button', {
                  class: 'btn-block', style: 'display:flex;align-items:center;justify-content:center;gap:8px',
                  onClick: () => {
                    // other identities on this device → pick from a list;
                    // none yet → straight to the sign-in doors
                    const others = ctx.identities ? ctx.identities().filter((x) => !x.active) : [];
                    if (others.length) { ui.switchIdPop = true; render(); } else ctx.signInAnother();
                  },
                },
                  h('span', { style: 'display:flex', html: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>' }),
                  t('signInAnother')) : null,
                logoutBtn())
            : ui.pubProf
              ? null // no wallet open: messaging and paying both need one
              : h('div', { class: 'row gap6 wrap' },
                h('button', { class: 'btn-primary grow', onClick: () => {
                  const peer = pk;
                  // leave the thread this profile may sit over too: the
                  // screen router shows an open thread before the chat, so
                  // a reply half-typed under their post used to win here
                  ui.profilePk = null; ui.profOverThread = false;
                  ui.noteThread = null; ui.userSearch = null; ui.feedEdit = null;
                  ui.chatOpen = true;
                  ui.msgView = 'dm';
                  ui.msgPeer = peer;
                  ui.msgStick = true;
                  render();
                } }, t('msgDmsTitle')),
                h('button', { class: 'grow', onClick: () => {
                  const npubStr = npubOf(pk);
                  // leave the whole messaging surface, not just the profile —
                  // a lingering search or thread would win the screen router
                  // and the Send tab would never appear
                  ui.profilePk = null;
                  ui.profOverThread = false;
                  ui.noteThread = null;
                  ui.userSearch = null;
                  ui.chatOpen = false;
                  ctx.showSend(); // and never a lingering payment detail
                  render();
                  hook('matchSendText', npubStr);
                } }, t('profPay')),
                // Follow: their posts join your feed, and the service worker
                // learns to treat their DMs as a friend's rather than a
                // stranger's.
                h('button', {
                  class: (isFollowing(pk) ? 'btn-ghost ' : '') + 'grow', disabled: followsPub,
                  onClick: () => toggleFollow(pk),
                }, isFollowing(pk) ? t('feedFollowing') : t('feedFollow')),
                // ...or into one of your lists (a feed of people)
                myPubkeys().length ? h('button', {
                  class: 'btn-ghost', style: 'flex-shrink:0', title: t('listAddTo'), 'aria-label': t('listAddTo'),
                  onClick: () => { ui.listPick = pk; render(); },
                }, '\u2630') : null)),
      // The lists they curate (follow sets and packs): each opens as a feed.
      (() => {
        const c = listsFor(pk);
        if (!c.items.length) return null;
        return h('div', { class: 'col', style: 'gap:6px' },
          h('div', { class: 'small muted', style: 'padding:0 2px' }, t('profLists')),
          h('div', { class: 'row feed-chips prof-lists' },
            ...c.items.map((p) => h('button', {
              class: 'feed-chip', type: 'button', title: t('feedListPeople', { n: p.n }),
              onClick: () => openListFeed(p),
            }, p.title, ' ', h('span', { class: 'faint' }, String(p.n))))));
      })(),
      // muted: say so, with the way back, where their posts still show
      !mine && isMuted(pk)
        ? h('div', { class: 'row gap6 small muted prof-muted', style: 'align-items:center' },
            h('span', { class: 'grow' }, t('profMutedBanner')),
            h('button', { class: 'btn-sm', type: 'button', onClick: () => toggleMute(pk) }, t('postUnmute')))
        : null,
      // Their public notes: the PAGE scrolls (no inner scrollbox), older
      // pages stream in as you near the bottom (the init() scroll listener →
      // loadOlderNotes), and on phones the feed goes full-bleed — edge to
      // edge, no card walls (see .notes-feed).
      (() => {
        const c = notesFor(pk);
        // while loading with nothing to show: an invisible copy of the
        // empty-state line holds the height, so the page doesn't jump when
        // the answer lands (no spinner). With posts already in hand — from
        // the feed we came from — those are shown instead of the blank.
        if (c.status === 'loading' && !c.notes.length)
          return h('div', { class: 'small faint', style: 'text-align:center;visibility:hidden' }, t('profNotesNone'));
        if (!c.notes.length)
          return h('div', { class: 'small faint', style: 'text-align:center' }, t('profNotesNone'));
        return h('div', { class: 'col', style: 'gap:8px' },
          h('div', { class: 'small muted', style: 'padding:0 2px' }, t('profNotesTitle')),
          h('div', { class: 'card col notes-feed', style: 'gap:0' },
            ...c.notes.flatMap((ev, i) => [
              i ? h('div', { style: 'height:1px;background:var(--border,rgba(128,128,128,.18));margin:0 -14px' }) : null,
              noteRow(pk, ev, name),
            ])),
          c.loadingMore
            ? h('div', { class: 'row gap6', style: 'justify-content:center;padding:4px 0' },
                h('span', { class: 'spinner sm' }))
            : null);
      })(),
      h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.profilePk = null; ui.profOverThread = false; ui.pubProf = null; ui.profEdit = null; ui.profEditFilled = false; ui.profCompose = null; render(); } }, t('back')),
      mine ? logoutPop() : null,
      mine ? switchPop() : null,
      ...noteOverlays());
  }

  const backBtn = (onClick) => h('button', { class: 'iconbtn chat-back', onClick }, '‹');

  // ---- the post composer ----------------------------------------------------
  // Shared by the profile page and the feed. A picture is uploaded the moment
  // it's picked and its URL appended to the text — which is how every nostr
  // client reads media — with a NIP-92 imeta tag published beside it for the
  // ones that would rather have the metadata than sniff the URL.
  const composeText = () => (ui.profCompose == null ? draftFor(POST_DRAFT) : ui.profCompose || '');
  // Upload, then hand the URL to whichever draft asked for it.
  async function attachTo(file, place) {
    if (!file || !ctx.uploadImage) return;
    ui.postUploading = true; render();
    try {
      const url = await ctx.uploadImage(file);
      (ui.postMedia ||= []).push({ url, m: file.type || '' });
      place(url);
    } catch (e) { toast(e.message || String(e)); }
    ui.postUploading = false; render();
  }
  const attachMedia = (file) => attachTo(file, (url) => {
    const cur = composeText().replace(/\s+$/, '');
    const next = (cur ? cur + '\n' : '') + url;
    ui.profCompose = next;
    setDraft(POST_DRAFT, next);
    // you just attached a picture; showing it IS the answer to the question
    // attaching one raises
    ui.postPreview = true;
  });
  const CLIP = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>';
  const EYE = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

  // ---- draft preview --------------------------------------------------------
  // A post is written as plain text, but it doesn't ARRIVE as plain text: a
  // URL ending in .jpg becomes a picture, a youtu.be link becomes a player, a
  // nostr: reference becomes the note it points at, an npub becomes a name.
  // You could only find out by posting. This runs the draft through noteBody
  // — the very renderer the feed uses — so the preview is not a lookalike of
  // the real thing, it IS the real thing.
  function draftPreview(text) {
    const body = String(text || '').trim();
    return h('div', { class: 'draft-preview' },
      h('div', { class: 'draft-preview-tag' }, t('composePreviewTag')),
      body
        ? h('div', { class: 'note-text', style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, ...noteBody(body))
        : h('div', { class: 'small faint' }, t('composePreviewEmpty')));
  }
  const previewBtn = (on, toggle) => h('button', {
    class: 'attach-btn' + (on ? ' on' : ''),
    title: on ? t('composePreviewHide') : t('composePreview'),
    'aria-label': on ? t('composePreviewHide') : t('composePreview'),
    onClick: toggle,
  }, h('span', { style: 'display:flex', html: EYE }));
  function postComposer() {
    if (ui.profCompose == null && !draftFor(POST_DRAFT)) return null;
    const text = composeText();
    return h('div', { class: 'col', style: 'gap:8px' },
      h('textarea', {
        rows: '3', placeholder: t('profComposePh'),
        style: 'font-family:var(--sans);min-height:64px',
        value: text,
        onInput: (ev) => {
          ui.profCompose = ev.target.value;
          setDraft(POST_DRAFT, ev.target.value);
          // only while the preview is open — otherwise typing costs a render
          // per keystroke for nothing. The morph never rewrites a focused
          // field, so this can't fight the typing.
          if (ui.postPreview) render();
        },
      }),
      ui.postPreview ? draftPreview(text) : null,
      h('div', { class: 'row gap6' },
        h('button', { class: 'btn-primary grow', disabled: !!ui.postUploading, onClick: async () => {
          const body = composeText().trim();
          if (!body) return;
          const media = (ui.postMedia || []).filter((m) => body.includes(m.url));
          // the post is on screen instantly (publishPost is optimistic) —
          // close the composer now; a failure reopens it with the text intact
          ui.profCompose = null;
          ui.postMedia = [];
          setDraft(POST_DRAFT, '');
          try { await publishPost(body, media); toast(t('profPosted')); }
          catch (e) {
            ui.profCompose = body;
            ui.postMedia = media;
            setDraft(POST_DRAFT, body);
            if (!e.silent) toast(e.message || String(e));
            render();
          }
        } }, t('profPostBtn')),
        ctx.uploadImage ? h('button', {
          class: 'attach-btn', title: t('feedAttach'), 'aria-label': t('feedAttach'), disabled: !!ui.postUploading,
          onClick: () => document.getElementById('post-file')?.click(),
        }, ui.postUploading ? h('span', { class: 'spinner sm' }) : h('span', { style: 'display:flex', html: CLIP })) : null,
        previewBtn(!!ui.postPreview, () => { ui.postPreview = !ui.postPreview; render(); }),
        h('input', {
          type: 'file', id: 'post-file', accept: 'image/*,video/*', style: 'display:none',
          onChange: async (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; await attachMedia(f); },
        }),
        h('button', { class: 'btn-ghost', onClick: () => { ui.profCompose = null; render(); } }, t('cancel'))));
  }

  // ---- the feed view --------------------------------------------------------
  // One line saying what a feed is made of: who, and on what.
  function feedSummary(f) {
    const n = (f.authors || []).length + (f.priv || []).length;
    const people = f.follows
      ? (n ? t('feedSumFollowsPlus', { n }) : t('feedSumFollows'))
      : n === 1 ? displayName((f.authors || [])[0] || f.priv[0])
        : n ? t('feedSumPeople', { n }) : '';
    const packs = ((f.packs || []).map((p) => (packOf(p) || {}).title || p.title).filter(Boolean)).join(', ');
    const topics = feedTopics(f).map((x) => '#' + x).join(' ');
    return [people, packs, topics].filter(Boolean).join(' \u00b7 ') || t('feedNoQuery');
  }
  // The row of feeds under the title: Following, then yours, then + for
  // a new one. A topic opened for the session sits at the end until saved.
  function feedChips() {
    const items = feedList();
    const cur = feedDef();
    if (cur && adhocFeeds.has(cur.id)) items.push(cur);
    return h('div', { class: 'row feed-chips', 'data-key': 'feed-chips' },
      ...items.map((f) => h('button', {
        class: 'feed-chip' + (f.id === curFeedId ? ' on' : ''), type: 'button', 'data-key': 'chip:' + f.id,
        onClick: () => switchFeed(f.id),
      }, f.name)),
      h('button', { class: 'feed-chip add', type: 'button', title: t('feedNew'), 'aria-label': t('feedNew'), onClick: () => openFeedEditor(null) }, '+'));
  }
  // The sheets a post (or a person) can open: the ⋯ menu, the reaction
  // picker, the list picker. Every screen that shows a post draws them —
  // the thread and profile pages once left the ⋯ tap doing nothing.
  const noteOverlays = () => [noteSheet(), reactPicker(), listPickSheet(), reportSheet()];
  function feedView() {
    syncFollowSets().catch(() => {}); // throttled inside
    syncReports().catch(() => {}); // likewise
    const c = feedNow();
    c.opened = true;
    const def = feedDef();
    const authors = feedAuthors(def);
    const hasQuery = feedHasQuery(def);
    prepareFeedAhead(c);
    // Never a bare spinner over posts we already hold: while the opening
    // page's faces and pictures are still being decoded, the cached rows
    // paint as they are (live profiles, pictures as they load) and take
    // their settled presentation once the warm-up lands. The spinner is
    // for a feed with nothing cached at all.
    const visible = c.notes.filter((ev) => !hidden(ev));
    // Every child keyed by its post, hairlines included, so the morph
    // reconciles the list by post: a new one at the top is inserted as its
    // own node; the rest keep theirs.
    const rows = visible.slice(0, c.shown || FEED_PAGE).flatMap((ev, i) => [
      i ? h('div', { 'data-key': 'hr:' + ev.id, style: 'height:1px;background:var(--border,rgba(128,128,128,.18));margin:0 -14px' }) : null,
      c.booting ? keyed(noteRow(ev.pubkey, ev, displayName(ev.pubkey)), ev.id) : feedRow(c, ev),
    ]);
    // Posts that went in above you while you were reading. A floating pill
    // that says how many are up there; the tap takes you up to them.
    // Keyed, so the morph keeps this very node while the count changes —
    // the count itself is a fresh node each time, which is what replays its
    // bump. The tap is the pill's alone (no bubbling into the page).
    const waiting = c.unseen || 0;
    const pill = waiting
      ? h('button', {
          class: 'feed-new-pill', 'data-key': 'feed-pill', type: 'button',
          onClick: (e) => { e.preventDefault(); e.stopPropagation(); jumpToNew(); },
        }, '↑ ', h('span', { class: 'n', 'data-key': 'n:' + waiting }, String(waiting)), ' ',
          waiting === 1 ? t('feedOneNewWord') : t('feedNNewWord'))
      : null;
    // the chat shell draws the brand header; this is just the page under it
    return h('div', { class: 'card col chat-page', style: 'gap:10px' },
        h('div', { 'data-key': 'feed-notice', style: 'display:contents' }, pill),
        h('div', { class: 'row gap6', style: 'align-items:center' },
          backBtn(() => { ui.msgView = 'home'; stopFeedWatch(); render(); }),
          h('h3', { style: 'margin:0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, def.builtin ? t('feedTitle') : def.name),
          def.builtin ? null
            : adhocFeeds.has(def.id)
              ? h('button', { class: 'btn-sm', onClick: () => openFeedEditor(def) }, t('feedSaveAdhoc'))
              : h('button', { class: 'btn-sm', title: t('feedEdit'), 'aria-label': t('feedEdit'), onClick: () => openFeedEditor(def) }, '\u270e'),
          h('button', {
            class: 'btn-sm', style: 'margin-left:auto;flex-shrink:0',
            onClick: () => { ui.profCompose = ui.profCompose == null ? (draftFor(POST_DRAFT) || '') : null; render(); },
          }, t('profNewPost'))),
        feedChips(),
        postComposer(),
        !hasQuery
          ? def.builtin
            ? h('div', { class: 'col', style: 'gap:8px' },
                h('div', { class: 'small muted' }, t('feedNoFollows')),
                h('button', { class: 'btn-sm', onClick: () => { stopFeedWatch(); hook('openUserSearch'); render(); } }, t('feedFindPeople')))
            : h('div', { class: 'col', style: 'gap:8px' },
                h('div', { class: 'small muted' }, t('feedNoQuery')),
                h('button', { class: 'btn-sm', onClick: () => openFeedEditor(def) }, t('feedEdit')))
          : (c.booting || c.status === 'loading') && !visible.length
            ? h('div', { class: 'row gap6', style: 'justify-content:center;padding:12px 0' }, h('span', { class: 'spinner sm' }))
            : !visible.length
              ? h('div', { class: 'small faint', style: 'text-align:center;padding:12px 0' }, t('feedEmpty'))
              : h('div', { class: 'card col notes-feed', style: 'gap:0', 'data-booting': c.booting ? '1' : undefined }, ...rows),
        // Older posts prepare offscreen; a background fetch should not add
        // a spinner to an already readable feed.

        ...noteOverlays());
  }


  // ---- defining a feed ----------------------------------------------------
  // Name, the people (everyone you follow and/or a hand-picked few) and the
  // topics. People AND topics narrows to their posts on those topics; either
  // alone is the whole of it. Saved into the synced state, so every device
  // has the same feeds.
  function openFeedEditor(def) {
    syncFollowSets().catch(() => {});
    // a new feed of people is a list from the start; a feed made before
    // lists existed stays private until its owner says otherwise
    const isNew = !def || adhocFeeds.has(def.id);
    ui.feedEdit = def
      ? { id: def.id, name: def.name || '', follows: !!def.follows, authors: [...(def.authors || [])], priv: [...(def.priv || [])], packs: [...(def.packs || [])],
          topics: feedTopics(def).map((x) => '#' + x).join(' '), q: '', rows: null, pq: '', packRows: null, isNew, d: def.d || null, publish: isNew || !!def.d }
      : { id: null, name: '', follows: false, authors: [], priv: [], packs: [], topics: '', q: '', rows: null, pq: '', packRows: null, isNew: true, d: null, publish: true };
    render();
  }
  const feedPeopleSearcher = makeSearcher((q, rows) => {
    const e = ui.feedEdit;
    if (e && e.q === q) { e.rows = rows; render(); }
    for (const r of rows || []) if (r.pk) prefetchProfilePage(r.pk);
  });
  function saveFeedEditor() {
    const e = ui.feedEdit;
    if (!e) return;
    const topics = [...new Set(e.topics.split(/[\s,]+/).map(normTopic).filter(Boolean))].slice(0, 20);
    if (!e.follows && !e.authors.length && !e.packs.length && !topics.length) { toast(t('feedNoQuery')); return; }
    const name = e.name.trim().slice(0, 40) || (topics.length ? '#' + topics[0] : t('feedNewName'));
    const s = st();
    const keep = e.id && !adhocFeeds.has(e.id) && s.feeds.some((f) => f.id === e.id);
    const id = keep ? e.id : 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const def = { id, name, follows: e.follows, authors: e.authors.slice(0, FEED_AUTHORS_MAX), packs: e.packs.slice(0, 20), topics, at: Date.now() };
    const prev = keep ? s.feeds.find((f) => f.id === id) : null;
    // d, listAt, listContent and priv ride along from the previous copy
    if (keep) s.feeds = s.feeds.map((f) => (f.id === id ? { ...f, ...def } : f)); else s.feeds.push(def);
    save(s);
    if (e.id && adhocFeeds.has(e.id)) adhocFeeds.delete(e.id);
    feedStates.delete(id); // its query changed: rebuild from scratch
    ui.feedEdit = null;
    switchFeed(id);
    // the list side: a feed of people goes out as a follow set (or, unticked,
    // comes off the relays)
    const saved = s.feeds.find((f) => f.id === id);
    const isList = !!e.publish && (def.authors.length > 0 || (saved.priv || []).length > 0);
    if (isList) publishFollowSet(saved).then(() => render()).catch((err) => { if (!(err instanceof NoIdentity)) toast(err.message || String(err)); });
    else if (prev && prev.d) {
      // ours first: the deletion re-reads the state to note the list as gone
      delete saved.d; delete saved.listAt; delete saved.listContent; saved.priv = [];
      save(s);
      deleteFollowSet(prev).catch(() => {});
    }
  }
  function deleteFeed(id) {
    const s = st();
    const def = s.feeds.find((f) => f.id === id);
    s.feeds = s.feeds.filter((f) => f.id !== id);
    save(s);
    if (def && def.d) deleteFollowSet(def).catch(() => {}); // after ours: it re-reads the state
    feedStates.delete(id);
    try { wallet.saveFeatureState(feedCacheKey(id), []); } catch {}
    ui.feedEdit = null;
    if (curFeedId === id) switchFeed(FOLLOWING); else render();
  }
  // Packs by title, NIP-50 search on a relay that indexes them; a pasted
  // link or naddr is looked up directly.
  let packSearchSeq = 0;
  async function searchPacks(q) {
    const e = ui.feedEdit;
    const seq = ++packSearchSeq;
    q = String(q || '').trim();
    if (!e || q.length < 2) { if (e) e.packRows = null; render(); return; }
    const link = parsePackLink(q);
    let rows = [];
    if (link) {
      const got = await fetchPack(link).catch(() => null);
      rows = got ? [{ ...link, title: got.title, n: got.pks.length }] : [];
    } else {
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const index = await loadPackIndex().catch(() => []);
      const hits = index.filter((p) => { const hay = (p.title + ' ' + p.desc).toLowerCase(); return words.every((w) => hay.includes(w)); })
        .sort((a, b) => b.pks.length - a.pks.length).slice(0, 12);
      for (const p of hits) {
        packsNow()[packKey(p)] ||= { pks: p.pks, title: p.title, at: p.at };
        rows.push({ pk: p.pk, d: p.d, relays: [], title: p.title, n: p.pks.length });
      }
      if (hits.length) { try { wallet.saveFeatureState(PACK_CACHE, packsNow()); } catch {} }
    }
    if (seq !== packSearchSeq || !ui.feedEdit) return;
    ui.feedEdit.packRows = rows;
    render();
  }
  function feedEditView() {
    const e = ui.feedEdit;
    const packRow = (p, onTap, extra) => h('div', { class: 'row gap6', style: 'align-items:center' + (onTap ? ';cursor:pointer' : ''), onClick: onTap },
      h('div', { class: 'chat-avatar fallback mini' }, '\u2605'),
      h('div', { class: 'col grow', style: 'min-width:0' },
        h('span', { style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, (packOf(p) || {}).title || p.title || t('feedPackUntitled')),
        h('span', { class: 'small muted' }, t('feedPackMembers', { n: (packOf(p) || {}).pks?.length ?? p.n ?? 0 }))),
      extra || null);
    const person = (pk) => h('div', { class: 'row gap6', style: 'align-items:center' },
      avatar(pk, 'chat-avatar mini', false),
      h('span', { class: 'grow', style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, displayName(pk)),
      h('button', { class: 'btn-sm', type: 'button', 'aria-label': t('remove'), onClick: () => { e.authors = e.authors.filter((x) => x !== pk); render(); } }, '\u00d7'));
    const picks = (e.rows || []).filter((r) => r.pk && !e.authors.includes(r.pk)).slice(0, 8);
    return h('div', { class: 'card col chat-page', style: 'gap:14px' },
      h('div', { class: 'row gap6', style: 'align-items:center' },
        backBtn(() => { ui.feedEdit = null; render(); }),
        h('h3', { style: 'margin:0' }, e.isNew ? t('feedNew') : t('feedEdit'))),
      h('label', { class: 'col', style: 'gap:4px' },
        h('span', { class: 'small muted' }, t('feedName')),
        h('input', { type: 'text', value: e.name, placeholder: t('feedNameHint'), maxlength: '40', onInput: (ev) => { e.name = ev.target.value; } })),
      h('div', { class: 'col', style: 'gap:8px' },
        h('span', { class: 'small muted' }, t('feedPeople')),
        h('label', { class: 'row gap6', style: 'align-items:center;cursor:pointer' },
          h('input', { type: 'checkbox', checked: e.follows, style: 'width:18px;height:18px;accent-color:var(--accent);margin:0', onChange: (ev) => { e.follows = ev.target.checked; render(); } }),
          h('span', {}, t('feedFollowsToggle'))),
        ...e.authors.map(person),
        // a list's private members, kept where they were made
        ...(e.priv || []).map((pk) => h('div', { class: 'row gap6', style: 'align-items:center', title: t('feedPrivateMember') },
          avatar(pk, 'chat-avatar mini', false),
          h('span', { class: 'grow', style: 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, displayName(pk)),
          h('span', { class: 'faint', 'aria-label': t('feedPrivateMember') }, '\u{1F512}'))),
        h('input', {
          type: 'text', class: 'user-search-input', placeholder: t('feedAddPerson'), value: e.q,
          autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
          onInput: (ev) => { e.q = ev.target.value; feedPeopleSearcher.update(e.q); },
        }),
        picks.length
          ? h('div', { class: 'list' }, resultRows(h, picks, (r) => {
              if (!r.pk) return;
              e.authors.push(r.pk); e.q = ''; e.rows = null; render();
            }, (pk, node) => hook('wrapAvatar', pk, node)))
          : null),
      h('div', { class: 'col', style: 'gap:8px' },
        h('span', { class: 'small muted' }, t('feedPacks')),
        ...e.packs.map((p) => packRow(p, null,
          h('button', { class: 'btn-sm', type: 'button', 'aria-label': t('remove'), onClick: () => { e.packs = e.packs.filter((x) => packKey(x) !== packKey(p)); render(); } }, '\u00d7'))),
        h('input', {
          type: 'text', class: 'user-search-input', placeholder: t('feedAddPack'), value: e.pq,
          autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
          onInput: (ev) => { e.pq = ev.target.value; clearTimeout(e.pt); e.pt = setTimeout(() => searchPacks(e.pq), 350); },
        }),
        h('div', { class: 'small faint' }, t('feedPacksHelp')),
        ...(e.packRows || []).filter((r) => !e.packs.some((x) => packKey(x) === packKey(r))).map((r) => packRow(r, () => {
          e.packs.push({ pk: r.pk, d: r.d, relays: r.relays || [], title: r.title || '', ...(r.kind && r.kind !== PACK_KIND ? { kind: r.kind } : {}) });
          e.pq = ''; e.packRows = null; render();
        })),
        e.packRows && !e.packRows.length ? h('div', { class: 'small faint' }, t('searchNoResults')) : null),
      h('label', { class: 'col', style: 'gap:4px' },
        h('span', { class: 'small muted' }, t('feedTopics')),
        h('input', { type: 'text', value: e.topics, placeholder: t('feedTopicsHint'), autocapitalize: 'none', autocomplete: 'off', onInput: (ev) => { e.topics = ev.target.value; } }),
        h('div', { class: 'small faint' }, t('feedTopicsHelp'))),
      // a feed of people is a nostr list (NIP-51 follow set) unless told not to be
      e.authors.length || (e.priv || []).length || e.d
        ? h('div', { class: 'col', style: 'gap:4px' },
            h('label', { class: 'row gap6', style: 'align-items:center;cursor:pointer' },
              h('input', { type: 'checkbox', class: 'feed-list-toggle', checked: !!e.publish, style: 'width:18px;height:18px;accent-color:var(--accent);margin:0', onChange: (ev) => { e.publish = ev.target.checked; } }),
              h('span', {}, t('feedShareList'))),
            h('div', { class: 'small faint' }, t('feedShareListHelp')))
        : null,
      h('button', { class: 'btn-primary btn-block', onClick: saveFeedEditor }, t('save')),
      e.id && !e.isNew ? h('button', { class: 'btn-ghost btn-block', onClick: () => deleteFeed(e.id) }, t('feedDelete')) : null);
  }

  // ---- user search: the header magnifier ----------------------------------
  // Same engine the Send form and DMs use (registrar names + Primal cache +
  // NIP-50 relays); tapping a result opens their profile, and profile-Back
  // lands here again since the search state survives.
  const userSearcher = makeSearcher((q, rows) => {
    if (ui.userSearch && ui.userSearch.q === q) { ui.userSearch.rows = rows; render(); }
    for (const r of rows || []) if (r.pk) prefetchProfilePage(r.pk);
  });
  function userSearchScreen() {
    const s = ui.userSearch;
    return h('div', { class: 'col', style: 'gap:16px' },
      ctx.brandHeader(!ui.pubProf && wallet.loaded),
      h('div', { class: 'card col', style: 'gap:10px' },
        h('h3', { style: 'margin:0' }, t('searchUsers')),
        h('input', {
          type: 'text', class: 'user-search-input', placeholder: t('searchUsersHint'), value: s.q,
          autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
          onInput: (e) => { s.q = e.target.value; userSearcher.update(s.q); },
        }),
        // a word is a topic too: posts tagged with it, as a feed
        (() => {
          const m = /^#?([A-Za-z0-9_\u00C0-\uFFFF]{2,64})$/.exec(s.q.trim());
          if (!m) return null;
          const tag = normTopic(m[1]);
          return h('div', { class: 'list' }, h('div', { class: 'item chat-thread-row', onClick: () => openTopicFeed(tag) },
            h('div', { class: 'chat-avatar fallback' }, '#'),
            h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
              h('span', { class: 'chat-name' }, '#' + tag),
              h('div', { class: 'muted small' }, t('searchTopicRow')))));
        })(),
        s.rows && s.rows.length
          ? h('div', { class: 'list' }, resultRows(h, s.rows, (r) => {
              if (r.pk) { openProfile(r.pk); render(); }
            }, (pk, node) => hook('wrapAvatar', pk, node)))
          : s.rows && s.q.trim().length >= 2
            ? h('div', { class: 'small faint', style: 'text-align:center;padding:6px' }, t('searchNoResults'))
            : h('div', { class: 'small faint', style: 'text-align:center;padding:6px' }, t('searchUsersEmpty'))),
      h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.userSearch = null; render(); } }, t('back')));
  }

  // ---- presence & typing --------------------------------------------------
  // Both ride the channel stream as 21059 wraps, so they stay inside the
  // community's encryption — who's around is members-only, not a public
  // status broadcast. 21059 sits in NIP-01's ephemeral range, but measured
  // against the relays we actually use (relay.coinos.io, nos.lol) neither
  // drops them, so they carry a NIP-40 expiration and relay.coinos.io sweeps
  // the kind on a timer; nothing here may assume the relay forgets.
  // Presence only exists while someone is watching a room. A member nobody
  // saw beat is dated by their last message instead, the way an offline
  // contact still shows a last-seen.

  const PRESENCE = 20100;
  const TYPING = 20101;
  const BEAT_MS = 60_000; // how often we announce ourselves
  const ONLINE_MS = 100_000; // a beat older than this is no longer "online"
  const TYPING_MS = 7_000; // how long a typing ping stands
  const TYPE_THROTTLE = 5_000; // and how rarely we send one

  const lastPing = new Map(); // channelId + kind -> ms

  async function ping(room, chId, kind) {
    const key = chId + ':' + kind;
    const gap = kind === PRESENCE ? BEAT_MS : TYPE_THROTTLE;
    if (Date.now() - (lastPing.get(key) || 0) < gap) return;
    lastPing.set(key, Date.now());
    try {
      const id = await identity();
      if (!id) return;
      const { created_at, ms } = msTags(Date.now());
      const rumor = {
        kind, pubkey: id.pubkey, content: '',
        tags: [['channel', chId], ['epoch', String(room.chEpoch(chId))], ms], created_at,
      };
      // NIP-40: a beat is worthless once it's stale, so relays that honour
      // expiration may drop it instead of keeping it forever.
      const wrap = await wrapRumor(rumor, id.signer, room.chStream(chId),
        { ephemeral: true, expiration: created_at + 300 });
      await publishOn(room.relays, wrap);
    } catch { lastPing.delete(key); }
  }

  // Keep beating while a room is on screen — otherwise everyone would look
  // online for exactly one render and then go dark.
  let beatTimer = null;
  function keepBeating() {
    if (beatTimer) return;
    beatTimer = setInterval(() => {
      if (!ui.chatOpen || ui.msgView !== 'room') return;
      const jm = communityById(ui.msgCommunity) || COMMUNITY;
      const room = rooms.get(jm.community_id);
      if (!room) return;
      const chans = roomChannels(room);
      const ch = chans.find((c) => c.id === ui.msgChannel) || chans[0];
      if (ch) ping(room, ch.id, PRESENCE);
      scheduleRepaint(); // let "online" lapse into "last seen" on its own
    }, 30_000);
  }

  // When we last had any sign of someone: a beat, or failing that the newest
  // thing they said anywhere in the community.
  function lastSeenMs(room, pk) {
    let ts = room.presence.get(pk) || 0;
    for (const msgs of room.byChannel.values())
      for (const m of msgs.values())
        if (m.author === pk) ts = Math.max(ts, eventMs(m.rumor) || 0);
    return ts;
  }

  const isOnline = (room, pk) => Date.now() - (room.presence.get(pk) || 0) < ONLINE_MS;

  function typingNow(room, chId) {
    const my = myPubkeys();
    const out = [];
    for (const [pk, ts] of room.typing)
      if (ts.ch === chId && Date.now() - ts.t < TYPING_MS && !my.includes(pk)) out.push(pk);
    return out;
  }

  // Telegram's wording, and its kindness: exact minutes while it's fresh,
  // then a vague "recently" rather than advertising how long someone's been away.
  function seenLabel(room, pk) {
    if (isOnline(room, pk)) return t('msgOnline');
    const ts = lastSeenMs(room, pk);
    if (!ts) return t('msgSeenRecently');
    const mins = Math.floor((Date.now() - ts) / 60_000);
    if (mins < 1) return t('msgSeenJustNow');
    if (mins < 60) return t('msgSeenMins', { n: mins });
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return t('msgSeenHours', { n: hrs });
    const days = Math.floor(hrs / 24);
    if (days <= 7) return t('msgSeenDays', { n: days });
    return t('msgSeenRecently');
  }

  // Recipient search for New message: debounced, sequenced, cached upstream.
  const dmSearch = { rows: null, busy: false };
  const dmSearcher = makeSearcher((q, rows) => {
    dmSearch.rows = rows;
    dmSearch.busy = false;
    scheduleRepaint();
  });
  const dmSearcherUpdate = dmSearcher.update.bind(dmSearcher);
  dmSearcher.update = (q) => {
    const willSearch = q && q.trim().length >= 2;
    if (willSearch) { dmSearch.busy = dmSearch.rows === null || !dmSearch.rows.length; }
    dmSearcherUpdate(q);
  };

  const stickToBottom = () => {
    queueMicrotask(() => {
      const log = document.querySelector('.chat-log');
      if (log && ui.msgStick !== false) log.scrollTop = log.scrollHeight;
    });
  };

  // The chat card is sized to the viewport, so the mobile keyboard shrinks it:
  // the composer stays on screen, but the log keeps its old scroll offset and
  // the newest messages vanish under the fold. Follow the bottom edge through
  // every viewport change (keyboard, rotation, browser chrome) — unless the
  // user has deliberately scrolled up, which msgStick already remembers.
  const onViewportResize = () => {
    // Mobile keyboards can resize only the visual viewport, leaving dvh
    // unchanged. Size the conversation to the space above the keyboard.
    const viewport = window.visualViewport;
    const height = viewport && viewport.scale === 1 ? viewport.height : window.innerHeight;
    document.documentElement.style.setProperty('--chat-viewport-height', `${height}px`);
    if (ui.chatOpen) stickToBottom();
  };

  // A remote signer that a reload dropped: say so where the typing happens,
  // rather than letting someone write a message and only then be told. The
  // identity itself is still known — it's the ability to sign as it that's
  // missing — so this offers to fetch it back rather than to log in again.
  function signerNotice() {
    if (wallet.watchOnly) {
      return h('div', { class: 'row gap6 chat-signer-off', style: 'align-items:center' },
        h('span', { class: 'small muted grow' }, '\u{1F512} ' + t('msgLockedChat')),
        h('button', { class: 'btn-sm', onClick: () => { ui.justLocked = false; ui.screen = 'vault'; render(); } }, t('unlock')));
    }
    const id = hook('nostrLoginIdentity');
    if (!id || id.signer) return null;
    return h('div', { class: 'row gap6 chat-signer-off', style: 'align-items:center' },
      h('span', { class: 'small muted grow' }, t('msgSignerOff')),
      h('button', {
        class: 'btn-sm', disabled: !!ui.msgReconnecting,
        onClick: async () => {
          ui.msgReconnecting = true; render();
          const s = await hook('nostrLoginResume');
          ui.msgReconnecting = false;
          // Success needs no announcement — the notice itself goes away.
          if (!s) { ui.chatOpen = false; ui.screen = 'wallet'; ui.tab = 'settings'; ui.settingsPage = 'nostr'; }
          render();
        },
      }, ui.msgReconnecting ? h('span', { class: 'spinner sm' }) : t('msgReconnect')));
  }

  // Enter sends; Shift+Enter (the textarea's native edit) and Ctrl+J insert
  // a newline. Height follows the text as it's typed — imperatively, since
  // typing doesn't re-render — with rows as the re-render fallback.
  const growComposer = (el) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  };
  // ---- :shortcode: autocomplete in the composer -----------------------------
  // A colon and two letters at the caret open a strip of matches above the
  // box: custom emoji first (packs held, then ones seen here), a few
  // standard ones after. Tap, Tab or Enter takes the first; Escape closes.
  function updateEmojiAc(el, key) {
    const upto = el.value.slice(0, el.selectionEnd ?? el.value.length);
    const m = EMOJI_PARTIAL_RE.exec(upto);
    const next = m ? { key, q: m[1], start: upto.length - m[1].length - 1, end: upto.length } : null;
    const was = ui.emojiAc;
    ui.emojiAc = next;
    if (!!was !== !!next || (was && next && (was.q !== next.q || was.key !== next.key))) render();
  }
  function emojiAcHits(q) {
    const ql = q.toLowerCase();
    const custom = customEmojis().filter((x) => x.code.toLowerCase().includes(ql))
      .sort((a, b) => Number(b.code.toLowerCase().startsWith(ql)) - Number(a.code.toLowerCase().startsWith(ql)));
    const std = EMOJI_LIB.filter((x) => x.k.split(' ').some((w) => w.startsWith(ql)));
    return [...custom.slice(0, 8), ...std.slice(0, 4)].slice(0, 8);
  }
  function pickEmojiAc(hit) {
    const ac = ui.emojiAc;
    ui.emojiAc = null;
    const el = document.getElementById('msg-draft');
    if (!ac || !el) { render(); return; }
    const ins = hit.url ? ':' + hit.code + ': ' : hit.e + ' ';
    const v = el.value;
    el.value = v.slice(0, ac.start) + ins + v.slice(ac.end);
    el.selectionStart = el.selectionEnd = ac.start + ins.length;
    setDraft(ac.key, el.value);
    growComposer(el);
    if (hit.url) noteRecent(':' + hit.code + ':');
    render();
    el.focus();
  }
  // Always a node, empty when idle: the strip appearing must not shift the
  // composer's children, or the morph rebuilds the textarea under a
  // typing finger and the keystroke that opened it lands nowhere.
  function emojiAcStrip(draftKey) {
    const ac = ui.emojiAc;
    const hits = ac && ac.key === draftKey ? emojiAcHits(ac.q) : [];
    return h('div', { class: 'emoji-ac' },
      hits.map((x) => h('button', {
        type: 'button', title: x.url ? ':' + x.code + ':' : x.k,
        onMousedown: (e) => e.preventDefault(), // the box keeps focus and its caret
        onClick: () => pickEmojiAc(x),
      }, x.url ? emojiImg(x.code, x.url) : x.e, x.url ? h('span', { class: 'small' }, x.code) : null)));
  }

  const composer = (placeholder, onSend, onType, draftKey, onAttach = null) => {
    syncEmoji().catch(() => {}); // throttled inside: your packs, from wherever you added them
    return h('div', { class: 'col', style: 'gap:6px' },
      signerNotice(),
      emojiAcStrip(draftKey),
    h('div', { class: 'chat-compose' },
      onAttach ? h('button', {
        class: 'iconbtn chat-clip', title: t('msgAttach'), 'aria-label': t('msgAttach'),
        disabled: !!ui.msgUploading,
        onClick: () => document.getElementById('msg-file')?.click(),
      }, ui.msgUploading ? h('span', { class: 'spinner sm' }) : h('span', { style: 'display:flex', html: CLIP })) : null,
      onAttach ? h('input', {
        type: 'file', id: 'msg-file', accept: 'image/*,video/*', style: 'display:none',
        onChange: (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) onAttach(f); },
      }) : null,
      h('textarea', {
        class: 'grow', id: 'msg-draft', placeholder, rows: String(Math.min(5, draftFor(draftKey).split('\n').length)),
        value: draftFor(draftKey), maxlength: '2000',
        onInput: (e) => { setDraft(draftKey, e.target.value); growComposer(e.target); updateEmojiAc(e.target, draftKey); if (onType && e.target.value) onType(); },
        onClick: (e) => updateEmojiAc(e.target, draftKey), // the caret moved
        onBlur: () => { if (ui.emojiAc) { ui.emojiAc = null; render(); } },
        onKeydown: (e) => {
          const ac = ui.emojiAc && ui.emojiAc.key === draftKey ? ui.emojiAc : null;
          if (ac && (e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) {
            const hits = emojiAcHits(ac.q);
            if (hits.length) { e.preventDefault(); pickEmojiAc(hits[0]); return; }
          }
          if (ac && e.key === 'Escape') { e.preventDefault(); ui.emojiAc = null; render(); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); return; }
          if (e.ctrlKey && (e.key === 'j' || e.key === 'J')) {
            e.preventDefault();
            const el = e.target;
            const { selectionStart: s0, selectionEnd: s1, value } = el;
            el.value = value.slice(0, s0) + '\n' + value.slice(s1);
            el.selectionStart = el.selectionEnd = s0 + 1;
            setDraft(draftKey, el.value);
            growComposer(el);
          }
        },
        // Focus summons the keyboard; some browsers resize only after its
        // animation, so re-stick once now and once when it has settled.
        onFocus: () => { stickToBottom(); setTimeout(stickToBottom, 350); },
      }),
      h('button', { class: 'btn-primary btn-sm', onClick: onSend }, t('msgSend'))));
  };

  // ---- home ---------------------------------------------------------------

  function homeView() {
    if (myPubkeys().length) syncFollowSets().catch(() => {}); // lists made elsewhere join the feeds (throttled inside)
    // The feed is a tap away from here: have it warmed and asked for before
    // the tap, so it opens on the latest posts rather than a spinner.
    if (myPubkeys().length) { try { const c = feedNow(); if (!c.booting) refreshFeed({}, c); } catch {} }
    syncReports().catch(() => {}); // your follows' flags (throttled inside)
    startDMs();
    // Threads you've since replied to should stop being strangers to the
    // worker; throttled inside, so this is cheap on every render.
    syncInbox().catch(() => {});
    if (Date.now() - listsSyncedAt > 60_000) syncLists({ force: true }).catch(() => {});
    for (const jm of communities()) ensureRoom(jm);

    for (const peer of threads.keys()) profileOf(peer); // names and faces, in one batch
    const dmRows = [...threads.entries()]
      .map(([peer, m]) => {
        const last = [...m.values()].sort((a, b) => a.rumor.created_at - b.rumor.created_at).at(-1);
        return { peer, last, unread: dmUnread(peer, m) };
      })
      .filter((x) => x.last && !isMuted(x.peer))
      .sort((a, b) => b.last.rumor.created_at - a.last.rumor.created_at);

    // Being here answers the header dot — including anything that lands while
    // the list is open, since arrivals repaint it and the rows below say who.
    {
      const my = myPubkeys();
      let newest = 0;
      for (const msgs of threads.values())
        newest = Math.max(newest, newestFrom(msgs.values(), (m) => !m.mine));
      for (const room of rooms.values())
        for (const msgs of room.byChannel.values())
          newest = Math.max(newest, newestFrom(msgs.values(), (m) => !my.includes(m.author)));
      markRead(HOME_READ, newest);
    }

    const kids = [];

    // Chat takes the whole screen, so home carries the way back to the wallet.
    kids.push(h('div', { class: 'row gap6', style: 'align-items:center' },
      backBtn(() => { ui.chatOpen = false; render(); }),
      h('h3', { style: 'margin:0' }, t('tabMessages')),
      anyUnread()
        ? h('button', { class: 'linklike small', style: 'margin-left:auto', onClick: markAllRead }, t('msgMarkAllRead'))
        : null));

    // A locked wallet can't decrypt or sign — say so up top, where the rooms
    // that quietly won't open are listed.
    const lockedRow = signerNotice();
    if (lockedRow && wallet.watchOnly) kids.push(lockedRow);

    if (pendingLink && pendingLink.where !== 'communities') kids.push(linkInviteCard());
    for (const [rid, inv] of pendingDirect) kids.push(directInviteCard(rid, inv));

    // offer push once — it covers messages AND payments
    if (typeof Notification !== 'undefined' && Notification.permission === 'default' && !st().pushDismissed)
      kids.push(h('div', { class: 'notice info col', style: 'gap:8px' },
        h('div', {}, t('msgPushOffer')),
        h('div', { class: 'row gap6' },
          h('button', {
            class: 'btn-primary btn-sm',
            onClick: async () => { const ok = await registerPush({ interactive: true }); toast(ok ? t('msgPushOn') : t('msgPushFailed')); render(); },
          }, t('msgPushEnable')),
          h('button', {
            class: 'btn-ghost btn-sm',
            onClick: () => { const s = st(); s.pushDismissed = true; save(s); render(); },
          }, t('msgDismiss')))));
    // A browser with no push service at all: the offer above is beside the
    // point (permission may even be granted), so say what's actually wrong
    // wherever the user got to. Inside the Android build that carries its own
    // push, the answer is a different one — see pushAdvice.
    if (st().noPushService && !st().push)
      kids.push(h('div', { class: 'notice info small' }, pushAdvice()));

    // ---- the feed, above the conversations: it's the thing you read, they're
    // the things you answer
    kids.push(h('div', { class: 'list' },
      h('div', {
        class: 'item chat-thread-row',
        onClick: () => { ui.msgView = 'feed'; switchFeed(FOLLOWING); },
      },
      h('div', { class: 'chat-avatar fallback' }, '\u2605'),
      h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
        h('span', { class: 'chat-name' }, t('feedTitle')),
        h('div', { class: 'muted small' },
          followsNow().set.size === 1 ? t('feedFollowing1')
            : followsNow().set.size ? t('feedFollowingN', { n: followsNow().set.size })
            : t('feedNoFollowsShort')))),
      // ...the feeds you made, each its own row under it
      ...st().feeds.map((f) => h('div', {
        class: 'item chat-thread-row',
        onClick: () => { ui.msgView = 'feed'; switchFeed(f.id); },
      },
      h('div', { class: 'chat-avatar fallback' }, feedTopics(f).length && !f.follows && !(f.authors || []).length && !(f.packs || []).length ? '#' : '\u2605'),
      h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
        h('span', { class: 'chat-name' }, f.name),
        h('div', { class: 'muted small chat-preview' }, feedSummary(f))))),
      // ...and what happened to what you posted
      (() => {
        const n = myPubkeys().length ? notifUnread() : 0;
        if (myPubkeys().length) refreshNotifs(); // throttled inside; keeps the count honest
        return h('div', {
          class: 'item chat-thread-row' + (n ? ' unread' : ''),
          onClick: openNotifs,
        },
          h('div', { class: 'chat-avatar fallback' }, '\ud83d\udd14'),
          h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
            h('span', { class: 'chat-name' }, t('alertsTitle')),
            h('div', { class: 'muted small' }, n ? t('alertsNew', { n }) : t('alertsSub'))),
          // like a group row: the dot sits mid-height, padded off the edge
          n ? h('i', { class: 'thread-dot' }) : null);
      })()));

    // ---- DMs
    kids.push(h('div', { class: 'row between', style: 'align-items:baseline' },
      h('h3', { style: 'margin:0' }, t('msgDmsTitle')),
      h('button', { class: 'btn-sm', onClick: () => { ui.msgHomePanel = ui.msgHomePanel === 'newdm' ? null : 'newdm'; if (ui.msgHomePanel === 'newdm') warmSearch(); render(); } }, t('msgNewDm'))));
    if (ui.msgHomePanel === 'newdm') {
      const openThread = (pk) => {
        dmSearcher.clear();
        ui.msgNewDmTo = '';
        ui.msgHomePanel = null;
        ui.msgView = 'dm';
        ui.msgPeer = pk;
        ui.msgStick = true;
        render();
      };
      kids.push(h('div', { class: 'col gap6' },
        h('div', { class: 'row gap6' },
          h('input', {
            class: 'grow', type: 'text', placeholder: t('msgSearchPlaceholder'),
            value: ui.msgNewDmTo || '',
            onInput: (e) => { ui.msgNewDmTo = e.target.value; dmSearcher.update(e.target.value); },
          }),
          h('button', {
            class: 'btn-sm', onClick: () => {
              const pk = parseNostrPubkey(ui.msgNewDmTo);
              if (!pk) { toast(t('msgBadNpub')); return; }
              openThread(pk);
            },
          }, t('msgOpen'))),
        dmSearch.rows === null ? null
          : dmSearch.busy ? h('div', { class: 'row gap6', style: 'align-items:center;padding:4px 0' },
              h('span', { class: 'spinner sm' }), h('span', { class: 'small muted' }, t('msgSearching')))
          : dmSearch.rows.length
            ? h('div', { class: 'list' }, resultRows(h, dmSearch.rows, (r) => openThread(r.pk), (pk, node) => hook('wrapAvatar', pk, node)))
            : h('div', { class: 'small muted' }, t('msgNoMatches'))));
    }
    // A long DM history must not bury the communities below it: past a
    // handful, the rest waits behind "show all". (No cap for barely-over —
    // a "show 2 more" button costs more than the rows it hides.)
    const DM_PREVIEW = 5;
    const shownDms = (ui.msgAllDms || dmRows.length <= DM_PREVIEW + 2) ? dmRows : dmRows.slice(0, DM_PREVIEW);
    kids.push(
      dmRows.length
        ? h('div', { class: 'list' }, shownDms.map(({ peer, last, unread }) =>
            h('div', {
              class: 'item chat-thread-row' + (unread ? ' unread' : ''),
              onClick: () => { ui.msgView = 'dm'; ui.msgPeer = peer; ui.msgStick = true; render(); },
            },
            avatar(peer),
            h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
              h('div', { class: 'row between' },
                h('span', { class: 'chat-name' }, displayName(peer)),
                h('span', { class: 'chat-time thread-when' },
                  timeLabel(last.rumor.created_at * 1000),
                  unread ? h('i', { class: 'thread-dot' }) : null)),
              h('div', { class: 'muted small chat-preview' }, (last.mine ? t('msgYouPrefix') + ' ' : '') + (last.rumor.kind === 15 ? '📎 ' + t('msgPhoto') : last.rumor.content))))))
        : h('div', { class: 'muted small' }, t('msgNoDms')));
    if (shownDms.length < dmRows.length)
      kids.push(h('button', { class: 'linklike small', onClick: () => { ui.msgAllDms = true; render(); } },
        t('msgShowAllDms', { n: dmRows.length })));
    else if (ui.msgAllDms && dmRows.length > DM_PREVIEW + 2)
      kids.push(h('button', { class: 'linklike small', onClick: () => { ui.msgAllDms = false; render(); } },
        t('msgShowFewerDms')));

    // ---- communities
    kids.push(h('div', { class: 'row between mt16', style: 'align-items:baseline' },
      h('h3', { style: 'margin:0' }, t('msgCommunitiesTitle')),
      h('div', { class: 'row gap6' },
        h('button', { class: 'btn-sm', onClick: () => { ui.msgHomePanel = ui.msgHomePanel === 'join' ? null : 'join'; render(); } }, t('msgJoin')),
        h('button', { class: 'btn-sm', onClick: () => { ui.msgHomePanel = ui.msgHomePanel === 'create' ? null : 'create'; render(); } }, t('msgCreate')))));
    if (pendingLink && pendingLink.where === 'communities') kids.push(linkInviteCard());
    if (ui.msgHomePanel === 'join') {
      loadHub().catch(() => {});
      const isLink = !!parseInviteLink(ui.msgJoinText || '');
      kids.push(h('div', { class: 'col', style: 'gap:8px' },
        h('div', { class: 'row gap6' },
          h('input', {
            class: 'grow', type: 'text', placeholder: t('msgInvitePlaceholder'),
            value: ui.msgJoinText || '', onInput: (e) => { ui.msgJoinText = e.target.value; render(); },
            onKeydown: (e) => { if (e.key === 'Enter' && isLink) joinFromText(ui.msgJoinText); },
          }),
          isLink ? h('button', { class: 'btn-sm btn-primary', onClick: () => joinFromText(ui.msgJoinText) }, t('msgJoin')) : null),
        isLink ? null : h('div', { class: 'row between', style: 'align-items:baseline' },
          h('span', { class: 'small muted' }, t('msgDiscoverTitle')),
          h('a', { class: 'small muted', href: 'https://vectorapp.io/hub/', target: '_blank', rel: 'noopener noreferrer' }, t('msgHubCredit'))),
        isLink ? null
          : hub.state === 'error' ? h('div', { class: 'small muted' }, t('msgHubFailed'))
          : hub.state !== 'ready' ? h('div', { class: 'row gap6', style: 'align-items:center;padding:6px 0' }, h('span', { class: 'spinner sm' }), h('span', { class: 'small muted' }, t('msgHubLoading')))
          : h('div', { class: 'list hub-list' }, hubRows())));
    }
    if (ui.msgHomePanel === 'create')
      kids.push(h('div', { class: 'row gap6' },
        h('input', {
          class: 'grow', type: 'text', placeholder: t('msgNamePlaceholder'), maxlength: '64',
          value: ui.msgNewName || '', onInput: (e) => { ui.msgNewName = e.target.value; },
        }),
        h('button', { class: 'btn-sm', onClick: () => createCommunity(ui.msgNewName || '') }, t('msgCreate'))));
    kids.push(h('div', { class: 'list' }, communities().map((jm) => {
      const room = rooms.get(jm.community_id);
      const name = room?.folded?.metadata?.name || jm.name;
      // Last session's settled count anchors the number: while the guestbook
      // replay is still streaming in (multiple relays, bursts past the fold
      // debounce), the live tally climbs through intermediate values — take
      // the max so the count doesn't visibly tick upward on every refresh.
      // Once the replay settles, the cache is rewritten to the live figure,
      // so a genuine departure still shows (one quiet step down, not a climb).
      const live = room ? [...room.members.values()].filter((m) => m.state === 'join').length : 0;
      const memberCount = Math.max(live, (st().memberCounts || {})[jm.community_id] || 0);
      const unread = room ? roomUnread(room) : false;
      return h('div', {
        class: 'item chat-thread-row' + (unread ? ' unread' : ''),
        onClick: () => { ui.msgView = 'room'; ui.msgCommunity = jm.community_id; ui.msgChannel = null; ui.msgStick = true; render(); },
      },
      h('div', { class: 'chat-avatar fallback' }, name.slice(0, 2)),
      h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
        h('span', { class: 'chat-name' }, name),
        h('div', { class: 'muted small' },
          memberCount ? t('msgMembers', { n: memberCount }) : t('msgEncrypted'))),
      // the row's own centring puts the dot mid-height, off the edge
      unread ? h('i', { class: 'thread-dot' }) : null);
    })));

    return h('div', { class: 'card col chat-page', style: 'gap:10px' }, ...kids);
  }

  function linkInviteCard() {
    const pl = pendingLink;
    return h('div', { class: 'notice info col', style: 'gap:8px' },
      pl.state === 'loading' ? h('div', { class: 'row gap6' }, h('span', { class: 'spinner sm' }), t('msgInviteLoading'))
      : pl.state === 'error' ? h('div', { class: 'row between' },
          h('span', {}, pl.error),
          h('button', { class: 'linklike', onClick: () => { pendingLink = null; render(); } }, t('msgDismiss')))
      : h('div', { class: 'col', style: 'gap:8px' },
          h('div', {}, t('msgInviteTo', { name: pl.bundle.name || 'community' })),
          h('div', { class: 'muted small' }, t('msgInviteFounder', { npub: (npubOf(pl.bundle.owner) || '').slice(0, 16) + '…' })),
          h('div', { class: 'row gap6' },
            h('button', { class: 'btn-primary btn-sm', onClick: () => acceptBundle(pl.bundle, { invitedBy: pl.bundle.creator_npub }) }, t('msgJoin')),
            h('button', { class: 'btn-ghost btn-sm', onClick: () => { pendingLink = null; render(); } }, t('msgDismiss')))));
  }

  function directInviteCard(rid, inv) {
    return h('div', { class: 'notice info col', style: 'gap:8px' },
      h('div', {}, t('msgDirectInvite', { name: inv.bundle.name || 'community', from: displayName(inv.from) })),
      h('div', { class: 'row gap6' },
        h('button', {
          class: 'btn-primary btn-sm',
          onClick: () => { pendingDirect.delete(rid); acceptBundle(inv.bundle, { invitedBy: inv.from }); },
        }, t('msgJoin')),
        h('button', {
          class: 'btn-ghost btn-sm',
          onClick: () => { const s = st(); s.declined[rid] = 1; save(s); pendingDirect.delete(rid); render(); },
        }, t('msgDismiss'))));
  }

  // ---- room ---------------------------------------------------------------

  function messageRows(room, chId) {
    const my = myPubkeys();
    const msgs = [...(room.byChannel.get(chId)?.values() || [])]
      .filter((m) => !room.deletes.has(m.rumor.id))
      .filter((m) => !(room.folded && room.folded.banned.has(m.author)))
      .filter((m) => !hiddenPk(m.author)) // muted here, or a spammer
      .sort((a, b) => eventMs(a.rumor) - eventMs(b.rumor));
    markRead(chRead(chId), newestFrom(msgs, (m) => !my.includes(m.author)));
    if (!msgs.length)
      return [h('div', { class: 'muted small', style: 'text-align:center;padding:24px 0' }, t('msgEmpty'))];
    let lastAuthor = null, lastT = 0;
    watchZaps(msgs.slice(-150).map((m) => m.rumor.id));
    return msgs.map((m) => {
      const tms = eventMs(m.rumor);
      const mine = my.includes(m.author);
      const edit = room.edits.get(m.rumor.id);
      const text = edit && edit.author === m.author ? edit.rumor.content : m.rumor.content;
      const grouped = m.author === lastAuthor && tms - lastT < 5 * 60_000;
      lastAuthor = m.author; lastT = tms;
      const reacts = room.reactions.get(m.rumor.id);
      const counts = new Map();
      if (reacts) for (const emoji of reacts.values()) counts.set(emoji, (counts.get(emoji) || 0) + 1);
      // this wallet's own reaction (any of its identities) — highlighted, and
      // choosing another emoji replaces it (one reaction per author, the fold
      // keeps the latest)
      const myReact = reacts && my.map((pk) => reacts.get(pk)).find(Boolean);
      // the message's own custom emoji (an edit brings its own set)
      const em = emojiTagMap((edit && edit.author === m.author ? edit.rumor : m.rumor).tags);
      return h(
        'div', { class: 'chat-row' + (mine ? ' mine' : '') + (grouped ? ' grouped' : '') },
        grouped ? h('div', { class: 'chat-avatar spacer' }) : avatar(m.author),
        h('div', { class: 'chat-body' },
          grouped ? null : h('div', { class: 'chat-meta' },
            h('span', {
              class: 'chat-name clickable' + (m.author === room.jm.owner ? ' owner' : ''),
              onClick: () => openProfile(m.author),
            },
              displayName(m.author),
              m.author === room.jm.owner ? h('span', { class: 'chat-badge' }, t('msgAdmin')) : null),
            h('span', { class: 'chat-time' }, timeLabel(tms))),
          h('div', {
            class: 'chat-bubble clickable' + (emojiJumbo(text, em) ? ' jumbo' : ''),
            // Telegram-style: a tap on the message opens its action sheet
            // (quick reactions, reply, copy, delete). Links, images and the
            // hover × keep their own clicks; a desktop text-selection drag
            // ends in a click too, and must not pop the sheet over the copy.
            // A custom emoji is an <img> too, but tapping it should open the
            // sheet like tapping any other word.
            onClick: (e) => {
              if (e.target.closest && e.target.closest('a, button, img:not(.cemoji)')) return;
              const sel = window.getSelection && window.getSelection();
              if (sel && String(sel).length) return;
              ui.msgSheet = ui.msgSheet === m.rumor.id ? null : m.rumor.id;
              render();
            },
          },
            replyQuote(room, chId, m),
            ...noteBody(text, 0, em),
            ...attachmentNodes(m.rumor),
            edit ? h('span', { class: 'chat-edited' }, ' ', t('msgEdited')) : null,
            mine
              ? h('button', { class: 'chat-del', title: t('msgDelete'), onClick: () => deleteMessage(room, chId, m) }, '×')
              : null,
            // reactions tuck inside the bubble, under the text (Telegram-style);
            // the zap total leads the row, and tapping it zaps again
            ((zc) => counts.size || zc
              ? h('div', { class: 'chat-reacts' },
                  zc,
                  [...counts.entries()].map(([emoji, n]) =>
                    h('span', {
                      class: 'chat-react clickable' + (emoji === myReact ? ' on' : ''),
                      title: t('msgReact'),
                      onClick: (e) => { e.stopPropagation(); sendReaction(room, chId, m, emoji); },
                    }, reactNode(emoji), n > 1 ? ' ' + n : '')))
              : null)(zapChip(m.rumor.id, { cls: 'chat-react', onClick: canZapPk(m.author) ? () => zapMessage(m.author, m.rumor.id) : null, onHold: () => openZapSettings(m.author, m.rumor.id) }))))
      );
    });
  }

  function roomView() {
    const jm = communityById(ui.msgCommunity) || COMMUNITY;
    const room = ensureRoom(jm);
    const chans = roomChannels(room);
    const ch = chans.find((c) => c.id === ui.msgChannel) || chans[0];
    const name = room.folded?.metadata?.name || jm.name;
    const members = [...room.members.entries()].filter(([, m]) => m.state === 'join');
    const memberCount = members.length;
    const onlineCount = members.filter(([pk]) => isOnline(room, pk)).length;
    stickToBottom();
    keepBeating();
    if (ch) ping(room, ch.id, PRESENCE);

    return h('div', { class: 'card col chat-card chat-page' },
      h('div', { class: 'row between chat-head' },
        h('div', { class: 'row gap6', style: 'align-items:center;min-width:0' },
          backBtn(() => { ui.msgView = 'home'; ui.msgReplyTo = null; ui.msgSheet = null; render(); }),
          h('div', {
            class: 'col clickable', style: 'gap:2px;min-width:0',
            onClick: () => { ui.msgMembers = !ui.msgMembers; render(); },
          },
            h('div', { class: 'chat-title' }, name),
            h('div', { class: 'muted small' },
              memberCount ? t('msgMembers', { n: memberCount }) : t('msgEncrypted'),
              onlineCount ? h('span', { class: 'online-count' }, ' · ', t('msgNOnline', { n: onlineCount })) : null))),
        h('div', { class: 'row gap6', style: 'align-items:center' },
          // One channel needs no label — naming it only asks people to notice a
          // choice they don't have. Several become a picker.
          chans.length > 1
            ? h('select', {
                class: 'chan-pick',
                onChange: (e) => { ui.msgChannel = e.target.value; ui.msgStick = true; ui.msgReplyTo = null; ui.msgSheet = null; subChannel(room, e.target.value); render(); },
              }, chans.map((c) => h('option', { value: c.id, selected: c.id === ch?.id }, '#' + c.name)))
            : null,
          h('button', {
            class: 'iconbtn bell' + (roomNotify(jm.community_id) ? ' on' : ''),
            title: roomNotify(jm.community_id) ? t('msgNotifyOn') : t('msgNotifyOff'),
            onClick: () => toggleRoomNotify(jm.community_id),
            html: roomNotify(jm.community_id)
              ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0" fill="none"/></svg>'
              : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13.7 21a2 2 0 0 1-3.4 0"/><path d="M18 8a6 6 0 0 0-9.3-5"/><path d="M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h15"/><path d="m2 2 20 20"/></svg>',
          }),
          h('button', {
            class: 'btn-sm', title: t('msgInviteTitle'),
            onClick: () => { ui.msgInvitePanel = !ui.msgInvitePanel; render(); },
          }, t('msgAddPerson')),
          // the door out — in the header where anyone looks for it, not in
          // the invite panel; one tap arms it, the second leaves
          jm.community_id === COMMUNITY.community_id ? null : h('button', {
            class: 'btn-sm' + (ui.msgLeaveArm ? ' btn-danger' : ''), title: t('msgLeave'), 'aria-label': t('msgLeave'),
            onClick: () => { if (ui.msgLeaveArm) leaveCommunity(room); else { ui.msgLeaveArm = true; render(); } },
            html: ui.msgLeaveArm ? null : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>',
          }, ui.msgLeaveArm ? t('msgLeaveConfirmShort') : null))),
      ui.msgInvitePanel ? invitePanel(room) : null,
      ui.msgMembers ? memberPanel(room, members) : null,
      h('div', {
        class: 'chat-log',
        onScroll: (e) => {
          const el = e.target;
          ui.msgStick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        },
      }, ...(ch ? messageRows(room, ch.id) : [])),
      ch ? typingLine(room, ch.id) : null,
      ch ? replyBar(room, ch.id) : null,
      composer(
        chans.length > 1 ? t('msgPlaceholder', { channel: ch ? ch.name : '' }) : t('msgPlaceholderPlain'),
        () => ch && sendMessage(room, ch.id),
        () => ch && ping(room, ch.id, TYPING),
        ch ? 'ch:' + ch.id : 'ch:',
        ch ? (f) => sendAttachment(room, ch.id, f) : null),
      ch && ui.msgSheet ? messageSheet(room, ch.id) : null);
  }

  // "Alice is typing…" — named up to two, counted beyond that.
  function typingLine(room, chId) {
    const who = typingNow(room, chId);
    if (!who.length) return null;
    const label = who.length === 1 ? t('msgTyping', { name: displayName(who[0]) })
      : who.length === 2 ? t('msgTyping2', { a: displayName(who[0]), b: displayName(who[1]) })
      : t('msgTypingMany', { n: who.length });
    return h('div', { class: 'chat-typing' },
      h('span', { class: 'typing-dots' }, h('i'), h('i'), h('i')),
      h('span', { class: 'small muted' }, label));
  }

  function memberPanel(room, members) {
    const rows = members
      .map(([pk]) => ({ pk, online: isOnline(room, pk), seen: lastSeenMs(room, pk) }))
      .sort((a, b) => (b.online - a.online) || (b.seen - a.seen));
    return h('div', { class: 'col chat-members' },
      ...rows.map((r) => h('div', {
        class: 'item chat-thread-row',
        onClick: () => openProfile(r.pk),
      },
        h('span', { class: 'ava-wrap' + (r.online ? ' online' : '') }, avatar(r.pk)),
        h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
          h('div', { class: 'row gap6', style: 'align-items:center;min-width:0' },
            h('span', { class: 'chat-name' }, displayName(r.pk)),
            r.pk === room.jm.owner ? h('span', { class: 'chat-badge' }, t('msgAdmin')) : null),
          h('div', { class: 'muted small' + (r.online ? ' is-online' : '') }, seenLabel(room, r.pk))))));
  }

  function invitePanel(room) {
    const builtin = room.jm.community_id === COMMUNITY.community_id;
    return h('div', { class: 'col chat-invite', style: 'gap:8px' },
      h('div', { class: 'row gap6' },
        h('button', {
          class: 'btn-sm', disabled: ui.msgMinting,
          onClick: async () => {
            ui.msgMinting = true; render();
            try {
              const url = await mintInviteLink(room);
              if (url) { await navigator.clipboard.writeText(url); toast(t('msgLinkCopied')); }
            } finally { ui.msgMinting = false; render(); }
          },
        }, ui.msgMinting ? h('span', { class: 'spinner sm' }) : t('msgCopyInvite')),
        h('input', {
          class: 'grow', type: 'text', placeholder: t('msgNpubPlaceholder'),
          value: ui.msgInviteTo || '', onInput: (e) => { ui.msgInviteTo = e.target.value; },
        }),
        h('button', {
          class: 'btn-sm',
          onClick: () => { sendDirectInvite(room, ui.msgInviteTo); ui.msgInviteTo = ''; render(); },
        }, t('msgSend'))),
      // Owners can add channels (an owner-signed control edition), but a naming
      // field sitting open is a question nobody asked — it reads as something
      // you're meant to fill in right after making a community.
      myPubkeys().includes(room.jm.owner)
        ? (ui.msgChannelPanel
            ? h('div', { class: 'row gap6' },
                h('input', {
                  class: 'grow', type: 'text', placeholder: t('msgChannelPlaceholder'), maxlength: '64',
                  value: ui.msgNewChannel || '', onInput: (e) => { ui.msgNewChannel = e.target.value; },
                  onKeydown: (e) => { if (e.key === 'Enter') createChannel(room, ui.msgNewChannel); },
                }),
                h('button', { class: 'btn-sm', onClick: () => createChannel(room, ui.msgNewChannel) }, t('msgCreate')),
                h('button', { class: 'btn-ghost btn-sm', onClick: () => { ui.msgChannelPanel = false; render(); } }, t('cancel')))
            : h('div', { class: 'row' },
                h('button', {
                  class: 'btn-sm',
                  onClick: () => { ui.msgChannelPanel = true; render(); },
                }, t('msgNewChannel'))))
        : null,
      // leaving discards the keys on this identity — two taps, default community exempt
      null);
  }

  // ---- dm thread ----------------------------------------------------------

  // The DM flavor of the message action sheet: reactions + Reply + Copy.
  // No Delete — a gift-wrapped DM can't be retracted from the peer's relays.
  function dmSheet(peer) {
    const m = threadOf(peer).get(ui.msgSheet);
    if (!m) { ui.msgSheet = null; return null; }
    const my = myPubkeys();
    const reacts = dmReacts.get(m.rumor.id);
    const myReact = reacts && my.map((pk) => reacts.get(pk)).find(Boolean);
    const close = () => { ui.msgSheet = null; ui.emojiPick = null; render(); };
    const item = (icon, label, onClick) => h('button', { class: 'msg-sheet-item', onClick },
      h('span', { class: 'msg-sheet-ico' }, icon), label);
    return h('div', {
      class: 'confirm-pop-backdrop',
      onClick: (e) => { if (e.target === e.currentTarget) close(); },
    },
      h('div', { class: 'card col msg-sheet' },
        reactRow(myReact, (e2) => { close(); sendDmReaction(peer, m, e2); }),
        ui.emojiPick ? null : item('↩', t('msgReply'), () => {
          ui.msgReplyTo = m.rumor.id;
          close();
          setTimeout(() => document.getElementById('msg-draft')?.focus(), 50);
        }),
        !ui.emojiPick && canZapPk(m.rumor.pubkey) ? item('⚡', t('msgZap'), () => { close(); zapMessage(m.rumor.pubkey, m.rumor.id); }) : null,
        ui.emojiPick ? null : item('⧉', t('copy'), async () => {
          try { await navigator.clipboard.writeText(m.rumor.content); toast(t('copied')); } catch {}
          close();
        })));
  }

  function dmView() {
    startDMs();
    const peer = ui.msgPeer;
    if (!peer) { ui.msgView = 'home'; return homeView(); }
    const thread = threads.get(peer) || new Map();
    const msgs = [...thread.values()].sort((a, b) => a.rumor.created_at - b.rumor.created_at);
    // Looking at the thread is reading it — including anything that lands while
    // it's still open, since every arrival repaints us.
    markRead(dmRead(peer), newestFrom(msgs, (m) => !m.mine));
    stickToBottom();
    const my = myPubkeys();
    const dmQuote = (m) => {
      const replyId = (m.rumor.tags || []).find((x) => x[0] === 'e')?.[1];
      const src = replyId && thread.get(replyId);
      if (!src) return null;
      return h('div', { class: 'chat-quote' },
        h('span', { class: 'chat-quote-name' }, displayName(src.rumor.pubkey)),
        h('span', { class: 'chat-quote-text' }, ...snippetNodes(src.rumor)));
    };
    watchZaps(msgs.slice(-150).map((m) => m.rumor.id));
    const dmChips = (m) => {
      const reacts = dmReacts.get(m.rumor.id);
      const zc = zapChip(m.rumor.id, { cls: 'chat-react', onClick: canZapPk(m.rumor.pubkey) ? () => zapMessage(m.rumor.pubkey, m.rumor.id) : null, onHold: () => openZapSettings(m.rumor.pubkey, m.rumor.id) });
      if ((!reacts || !reacts.size) && !zc) return null;
      const myReact = reacts && my.map((pk) => reacts.get(pk)).find(Boolean);
      const counts = new Map();
      if (reacts) for (const emoji of reacts.values()) counts.set(emoji, (counts.get(emoji) || 0) + 1);
      return h('div', { class: 'chat-reacts' },
        zc,
        [...counts.entries()].map(([emoji, n]) => h('span', {
          class: 'chat-react clickable' + (emoji === myReact ? ' on' : ''),
          onClick: (e) => { e.stopPropagation(); sendDmReaction(peer, m, emoji); },
        }, reactNode(emoji), n > 1 ? ' ' + n : '')));
    };
    const dmReplyBar = () => {
      const m = ui.msgReplyTo && thread.get(ui.msgReplyTo);
      if (!m) { ui.msgReplyTo = null; return null; }
      return h('div', { class: 'reply-bar' },
        h('div', { class: 'col grow', style: 'gap:1px;min-width:0' },
          h('span', { class: 'small', style: 'font-weight:650' }, '↩ ', displayName(m.rumor.pubkey)),
          h('span', { class: 'small muted chat-quote-text' }, ...snippetNodes(m.rumor))),
        h('button', { class: 'chat-del', style: 'position:static;display:flex;flex-shrink:0', onClick: () => { ui.msgReplyTo = null; render(); } }, '×'));
    };
    return h('div', { class: 'card col chat-card chat-page' },
      h('div', { class: 'row chat-head gap6', style: 'align-items:center' },
        backBtn(() => { ui.msgView = 'home'; ui.msgReplyTo = null; ui.msgSheet = null; render(); }),
        avatar(peer),
        h('div', { class: 'col clickable', style: 'gap:2px;min-width:0', onClick: () => openProfile(peer) },
          h('div', { class: 'chat-title' }, displayName(peer)),
          h('div', { class: 'muted small' }, t('msgDmEncrypted')))),
      h('div', {
        class: 'chat-log',
        onScroll: (e) => {
          const el = e.target;
          ui.msgStick = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        },
      },
      ...(msgs.length
        ? msgs.map((m) =>
            h('div', { class: 'chat-row dm' + (m.mine ? ' mine' : '') },
              h('div', { class: 'chat-body' },
                h('div', {
                  class: 'chat-bubble clickable' + (m.mine ? ' me' : '') + (emojiJumbo(m.rumor.content, emojiTagMap(m.rumor.tags)) ? ' jumbo' : ''),
                  // same tap-for-actions as community bubbles
                  onClick: (e) => {
                    if (e.target.closest && e.target.closest('a, button, img:not(.cemoji)')) return;
                    const sel = window.getSelection && window.getSelection();
                    if (sel && String(sel).length) return;
                    ui.msgSheet = ui.msgSheet === m.rumor.id ? null : m.rumor.id;
                    render();
                  },
                }, dmQuote(m), ...(m.rumor.kind === 15 ? [] : noteBody(m.rumor.content, 0, emojiTagMap(m.rumor.tags))), ...attachmentNodes(m.rumor), dmChips(m)),
                h('div', { class: 'chat-time' }, timeLabel(m.rumor.created_at * 1000)))))
        : [h('div', { class: 'muted small', style: 'text-align:center;padding:24px 0' }, t('msgNoDmsYet'))])),
      dmReplyBar(),
      composer(t('msgDmPlaceholder'), () => sendDM(peer), null, 'dm:' + peer, (f) => sendDMFile(peer, f)),
      ui.msgSheet ? dmSheet(peer) : null);
  }

  // ---- notifications: what happened to your posts --------------------------
  // Everything that names you: a like, a boost or a zap on something you
  // wrote, a reply, a mention. One filter (#p = you) on the relays we read,
  // kept as a short list of what-happened rows rather than the raw events —
  // a zap receipt drags its whole request along, and the list rides in the
  // feature state. Painted from the last visit while the relays are asked.
  const NOTIF_KINDS = [1, 6, 7, ...ZAP_KINDS];
  const NOTIF_KEEP = 150;
  let notif = null;      // { status, items }
  let notifAt = 0, notifUnsub = null;
  const notifSeen = () => st().notifSeen || 0;
  // Notifications are about the IDENTITY, not the wallet: the stored list
  // remembers whose it is, and another identity on the same wallet starts
  // empty instead of reading the previous one's.
  const identityPk = () => (hook('nostrLoginIdentity') || {}).pubkey || (wallet.nostr && wallet.nostr.pk) || null;
  function notifNow() {
    if (!notif) {
      const s = st();
      const stored = (!s.notifsPk || s.notifsPk === identityPk()) ? (s.notifs || []) : [];
      notif = { status: stored.length ? 'ready' : 'loading', items: stored };
      refreshNotifs();
    }
    return notif;
  }
  // What an event says happened, or null if it isn't about you after all.
  function notifItem(ev) {
    const my = myPubkeys();
    if (!ev || !ev.id) return null;
    const eTags = (ev.tags || []).filter((x) => x[0] === 'e' && x[1]);
    const lastE = eTags.map((x) => x[1]).at(-1) || null;
    // the relay hint on that tag: where the reactor says the note is
    const hint = /^wss?:\/\//i.test((eTags.at(-1) || [])[2] || '') ? [eTags.at(-1)[2]] : [];
    if (ZAP_KINDS.includes(ev.kind)) {
      const actor = zapperOf(ev), sats = receiptSats(ev);
      if (!actor || my.includes(actor) || !sats) return null;
      return { id: ev.id, what: 'zap', actor, target: lastE, hint, sats, text: zapText(ev), ts: ev.created_at };
    }
    if (my.includes(ev.pubkey)) return null;
    if (ev.kind === 7) {
      if (!lastE) return null;
      const emoji = !ev.content || ev.content === '+' ? '\u2764\ufe0f' : ev.content.slice(0, 12);
      return { id: ev.id, what: 'react', actor: ev.pubkey, target: lastE, hint, emoji, ts: ev.created_at };
    }
    if (ev.kind === 6) return lastE ? { id: ev.id, what: 'boost', actor: ev.pubkey, target: lastE, hint, ts: ev.created_at } : null;
    if (ev.kind === 1) {
      const es = (ev.tags || []).filter((x) => x[0] === 'e' && x[1]);
      const replyTo = (es.find((x) => x[3] === 'reply') || es.find((x) => x[3] === 'root') || es.at(-1) || [])[1] || null;
      return { id: ev.id, what: replyTo ? 'reply' : 'mention', actor: ev.pubkey, target: replyTo, text: String(ev.content || '').slice(0, 300), ts: ev.created_at, pubkey: ev.pubkey };
    }
    return null;
  }
  function mergeNotifs(evs) {
    const c = notifNow();
    const known = new Set(c.items.map((x) => x.id));
    for (const ev of evs || []) noteForSpam(ev);
    const add = (evs || []).map((ev) => (ev.kind === 1 && hidden(ev) ? null : notifItem(ev)))
      .filter((x) => x && !hiddenPk(x.actor) && !known.has(x.id) && known.add(x.id));
    if (!add.length) return false;
    // One zap, two receipts: a coinos zap publishes its own (9737) beside the
    // LNURL server's (9735). The same person, post and amount within a few
    // minutes is one row.
    const all = [...c.items, ...add].sort((a, b) => b.ts - a.ts);
    const kept = [];
    for (const x of all) {
      if (x.what === 'zap' && kept.some((y) => y.what === 'zap' && y.actor === x.actor && y.target === x.target
        && y.sats === x.sats && Math.abs(y.ts - x.ts) < 300)) continue;
      kept.push(x);
    }
    c.items = kept.slice(0, NOTIF_KEEP);
    // the rows already say who; a reply row also wants its reader-facing text,
    // which it carries — the events themselves are not kept
    const s2 = st(); s2.notifs = c.items; s2.notifsPk = identityPk(); save(s2);
    // a reply is a note we can open straight away; keep it in hand
    for (const ev of evs) if (ev.kind === 1) notifNotes.set(ev.id, ev);
    return true;
  }
  const notifNotes = new Map(); // reply id -> event, for opening the thread
  async function refreshNotifs(force) {
    const my = myPubkeys();
    if (!my.length) { if (notif) notif.status = 'ready'; return; }
    if (!force && Date.now() - notifAt < 30_000) return;
    notifAt = Date.now();
    try {
      const evs = await queryOn(zapRelays(), { kinds: NOTIF_KINDS, '#p': my, limit: 120 }, 5000);
      if (mergeNotifs(evs)) scheduleRepaint();
    } catch {} finally {
      if (notif) notif.status = 'ready';
      scheduleRepaint();
    }
    watchNotifs();
  }
  function watchNotifs() {
    stopNotifWatch();
    const my = myPubkeys();
    if (!my.length || !ui.chatOpen || ui.msgView !== 'notifs') return;
    notifUnsub = subscribeOn(zapRelays(), { kinds: NOTIF_KINDS, '#p': my, since: Math.floor(Date.now() / 1000) - 60 },
      (ev) => { if (mergeNotifs([ev])) scheduleRepaint(); });
  }
  function stopNotifWatch() { if (notifUnsub) { try { notifUnsub(); } catch {} notifUnsub = null; } }
  const notifUnread = () => notifNow().items.filter((x) => x.ts > notifSeen() && !hiddenPk(x.actor)).length;
  function markNotifsSeen() {
    const newest = Math.max(0, ...notifNow().items.map((x) => x.ts));
    if (newest > notifSeen()) { const s2 = st(); s2.notifSeen = newest; save(s2); }
  }
  // The post an item is about, if we have it — ours from the feed or a
  // thread, or fetched once by id (quotedNote remembers and repaints).
  function notifTarget(id, relays = []) {
    if (!id) return null;
    for (const pk of myPubkeys()) { const hit = notesInHand(pk).find((e) => e.id === id); if (hit) return hit; }
    if (notifNotes.has(id)) return notifNotes.get(id);
    const q = quotedNote({ id, relays });
    return q.ev || null;
  }
  // A zap can land on a chat message or a DM rather than a post — the
  // receipt e-tags the rumor's id, which no relay has ever seen as an event,
  // so fetching it by id would spin forever. Look in the rooms and threads
  // we hold first; that is where the text is, and where a tap should go.
  function messageInHand(id) {
    for (const [cid, room] of rooms) {
      for (const [chId, msgs] of room.byChannel) {
        const m = msgs.get(id);
        if (m) return { cid, chId, text: String(m.rumor.content || '') };
      }
    }
    for (const [peer, msgs] of threads) {
      const m = msgs.get(id);
      if (m) return { peer, text: String(m.rumor.content || '') };
    }
    return null;
  }
  const targetGone = (id) => { const q = quoted.get(id); return !!q && q.status === 'missing'; };
  // A one-line excerpt: mentions read as names, not as nostr:nprofile1… keys.
  function plainExcerpt(text) {
    return String(text || '').replace(/nostr:(npub|nprofile)1[a-z0-9]+/gi, (m) => {
      const ref = parseNostrRef(m.slice(6));
      return ref && ref.type === 'pubkey' ? '@' + displayName(ref.pk) : m.slice(6, 18) + '\u2026';
    }).replace(/\s+/g, ' ').trim();
  }
  function notifLabel(x) {
    if (x.what === 'zap') return t('alertZap', { sats: fmtSats(x.sats) + ' sats' });
    if (x.what === 'react') return t('alertReact', { emoji: x.emoji });
    if (x.what === 'boost') return t('alertBoost');
    if (x.what === 'reply') return t('alertReply');
    return t('alertMention');
  }
  function notifRow(x) {
    profileOf(x.actor);
    const aboutNote = !(x.what === 'reply' || x.what === 'mention');
    const msg = aboutNote ? messageInHand(x.target) : null;
    const target = aboutNote && !msg ? notifTarget(x.target, x.hint || []) : null;
    const excerpt = !aboutNote
      ? plainExcerpt(x.text)
      : msg ? plainExcerpt(msg.text.slice(0, 140))
        : target ? plainExcerpt(String(target.content || '').slice(0, 140)) : null;
    const open = () => {
      if (!aboutNote) {
        const ev = notifNotes.get(x.id);
        if (ev) openNoteThread(ev); else openNoteRef({ id: x.id }).catch(() => {});
      } else if (msg && msg.peer) { ui.msgView = 'dm'; ui.msgPeer = msg.peer; ui.msgStick = true; stopNotifWatch(); render(); }
      else if (msg) { ui.msgView = 'room'; ui.msgCommunity = msg.cid; ui.msgChannel = msg.chId; ui.msgStick = true; stopNotifWatch(); render(); }
      else {
        // a reaction, boost or zap: land on the note with its who-panel
        // already unfolded, so the tap answers "who?" without a second one
        if (x.target) whoOpenIds.add(x.target);
        if (target) openNoteThread(target);
        // a note we couldn't find is asked for again on tap, hints and all
        else if (x.target) openNoteRef({ id: x.target, relays: x.hint || [] }).catch(() => {});
      }
    };
    return h('div', {
      class: 'row alert-row' + (x.ts > notifSeenAtOpen ? ' fresh' : ''),
      style: 'gap:10px;align-items:flex-start;padding:10px 0;cursor:pointer',
      onClick: (e) => { if (e.target && e.target.closest && e.target.closest('button')) return; open(); },
    },
      avatar(x.actor, 'chat-avatar note-avatar'),
      h('div', { class: 'col grow', style: 'min-width:0;gap:3px' },
        h('div', { class: 'row', style: 'gap:7px;align-items:baseline;min-width:0' },
          h('span', { style: 'font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer',
            onClick: (e) => { e.stopPropagation(); openProfile(x.actor); } }, displayName(x.actor)),
          h('span', { class: 'small', style: 'min-width:0' }, notifLabel(x)),
          h('span', { class: 'small faint', style: 'white-space:nowrap;margin-left:auto' }, timeLabel(x.ts * 1000))),
        x.what === 'zap' && x.text ? h('div', { class: 'small' }, x.text) : null,
        excerpt != null
          ? h('div', { class: 'small muted alert-excerpt' }, excerpt)
          : x.target ? h('div', { class: 'small faint' }, targetGone(x.target) ? t('alertNoteGone') : t('noteRefLoading')) : null));
  }
  let notifSeenAtOpen = 0; // what counted as new when the list was opened
  function openNotifs() {
    notifSeenAtOpen = notifSeen();
    ui.chatOpen = true;
    ui.msgView = 'notifs';
    notifNow();
    refreshNotifs(true).catch(() => {});
    watchNotifs();
    markNotifsSeen();
    render();
  }
  function notifView() {
    const c = notifNow();
    markNotifsSeen(); // anything that lands while you look is seen too
    const items = c.items.filter((x) => !hiddenPk(x.actor)); // a mute made later applies to what was kept
    const rows = items.flatMap((x, i) => [i ? noteSep() : null, notifRow(x)]);
    return h('div', { class: 'card col chat-page', style: 'gap:10px' },
      h('div', { class: 'row gap6', style: 'align-items:center' },
        backBtn(() => { ui.msgView = 'home'; stopNotifWatch(); render(); }),
        h('h3', { style: 'margin:0' }, t('alertsTitle'))),
      c.status === 'loading' && !items.length
        ? h('div', { class: 'row gap6', style: 'justify-content:center;padding:12px 0' }, h('span', { class: 'spinner sm' }))
        : !items.length
          ? h('div', { class: 'small faint', style: 'text-align:center;padding:12px 0' }, t('alertsEmpty'))
          : h('div', { class: 'card col notes-feed', style: 'gap:0' }, ...rows),
      ...noteOverlays());
  }

  // ---- feature ------------------------------------------------------------

  function messagesTab() {
    if (ui.feedEdit) return feedEditView();
    if (ui.msgView === 'feed') return feedView();
    if (ui.msgView === 'notifs') return notifView();
    if (ui.msgView === 'room') return roomView();
    if (ui.msgView === 'dm') return dmView();
    return homeView();
  }

  return {
    id: 'messages',
    nostrSettingsCards() { return [moderationCard()]; },
    // The app came back after being backgrounded. A phone freezes a hidden
    // tab: the relay sockets are cut and every post made in the meantime is
    // simply missing, which is why the feed used to sit there looking stale
    // until you pulled it down by hand. So: re-dial and catch up. The gap is
    // fetched (force, past the thirty-second throttle) and the live
    // subscriptions are rebuilt, since the ones we had are talking to
    // sockets that no longer exist.
    resumed(awayMs) {
      // a blink between apps didn't kill anything
      if (awayMs && awayMs < 5_000) return;
      resubscribeStreams(); // DMs and rooms, whether or not chat is on screen
      if (!ui.chatOpen || !['feed', 'notifs'].includes(ui.msgView)) return true;
      if (ui.msgView === 'notifs') refreshNotifs(true).catch(() => {});
      else refreshFeed({ force: true }).catch(() => {});
      return true;
    },
    // A zap flow reporting how its payment went, so the chip that appeared
    // on tap can stop pulsing (paid) or disappear (failed / never fired).
    // Also the way a zap sent from a form reaches the tally right away,
    // without waiting on its receipt.
    zapSettled(eventId, ok, sats) { settleZap(eventId, ok, sats); return true; },
    // the right thing to say about push on THIS device, wherever it's asked
    pushAdvice() { return pushAdvice(); },
    // Chat lives behind a header button and takes over the whole screen —
    // no balance card, no tabs; each view carries its own way back.
    // The bare avatar node for the app header's identity menu.
    // The header rebuilds every render; recreating the <img> each time makes
    // the picture visibly flash during boot's render bursts. There is exactly
    // one header avatar, so the node itself is reused until the profile
    // (or account) actually changes.
    // A seed minted seconds ago has no kind-0 anywhere — don't make the
    // avatar sit white while a relay lookup confirms that; paint the punk now.
    identityGenerated() {
      // Synchronous on purpose: identity() can await a signer resume, and
      // the header sat avatar-less for that beat. A generated seed's pubkey
      // is right here — paint the punk before the next frame.
      const pk = (hook('nostrLoginIdentity') || {}).pubkey || (wallet.nostr && wallet.nostr.pk);
      setTimeout(seedNewIdentity, 0); // fresh words: something to read from the start
      if (!pk) return;
      const entry = { name: null, picture: null, t: Date.now() };
      profiles.set(pk, entry);
      persistProfile(pk, entry);
      scheduleRepaint();
    },
    headerAvatar(pk) {
      // A fresh node every render: the morph keeps the live element (and its
      // loaded image) in place when nothing changed, which is exactly what
      // the old cached-node trick faked — and reusing one node in two trees
      // let the morph strip its children when positions paired it wrong.
      return avatar(pk, 'chat-avatar header-ava', false);
    },
    // Conversations waiting on us, for the header's message button.
    unreadMessages() {
      // A device with no read watermarks yet (a fresh restore or brand-new
      // wallet) will show the dot the moment the community messages land —
      // which is always: the default community is never empty, the welcome
      // DM is on its way, and read state is device-local. Paint it from the
      // first frame instead of popping it in when the fetch returns. NB the
      // guard must key on "no MESSAGES landed yet", not "no rooms": init()
      // creates the coinos room synchronously before the first paint, so a
      // rooms.size check defeated the optimism it was written for.
      const s = st();
      const anyMsgs = threads.size > 0
        || [...rooms.values()].some((r) => [...r.byChannel.values()].some((m) => m.size));
      if (!Object.keys(s.read || {}).length && !anyMsgs) return 1;
      return unreadCount();
    },
    notifySettingsCards() { return [notifyCard()]; },
    screenView() {
      // A profile deep link mid-resolution holds the frame over EVERY screen
      // — an auto-restored wallet would otherwise flash its home page for the
      // beat the registrar lookup takes. The shell shows the name straight
      // off the URL; no spinner, the empty beat reads calmer.
      if (ui.pubProfPending) return h('div', { class: 'col', style: 'gap:16px' },
        ctx.brandHeader(false),
        h('div', { class: 'card col', style: 'gap:12px' },
          h('div', { class: 'row gap6', style: 'align-items:center' },
            h('div', { class: 'chat-avatar profile-avatar fallback loading' }),
            h('div', { class: 'chat-title' }, ui.pubProfPending))));
      if (ui.screen !== 'wallet') {
        // The public (no-wallet) surface: a deep-linked profile, and the
        // threads reachable from it, are public nostr content — shown
        // without an account. Back falls through to the app's own screens.
        if (ui.pubProf) {
          if (ui.profOverThread && ui.profilePk) return profileScreen();
          if (ui.noteThread) return threadScreen();
          if (ui.profilePk) return profileScreen();
        }
        return null;
      }
      if (ui.zapSetup) return zapSetupScreen();
      if (ui.profOverThread && ui.profilePk) return profileScreen();
      if (ui.noteThread) return threadScreen();
      if (ui.profilePk) return profileScreen();
      if (ui.userSearch && !ui.chatOpen) return userSearchScreen();
      if (!ui.chatOpen) return null;
      return h('div', { class: 'col', style: 'gap:16px' },
        ctx.brandHeader(true),
        messagesTab());
    },
    // The header magnifier: search anyone on nostr, results open profiles.
    userSearchAvailable() { return true; },
    openUserSearch() {
      ui.chatOpen = false;
      ui.profilePk = null;
      ui.userSearch = { q: '', rows: null };
      warmSearch(); // the field is about to be typed into — open the pipes
      return true;
    },
    // nostr-login just connected or resumed a signer: wraps the backfill
    // couldn't open a moment ago can be opened now — drain right away.
    nostrSignerLive() { scheduleDrain(0); },
    // Anyone (ark's history, other features) can open a profile or render a
    // small clickable identity chip.
    showProfile(pk) { openProfile(pk); return true; },
    // The light profile cache, read-only — lets the onboarding wizard skip
    // asks (like the avatar picker) that a loaded identity already answered.
    cachedProfile(pk) { return profileOf(pk); },
    // Start fetching a profile (and its picture bytes) NOW — the login flow
    // calls this the moment it knows the identity, so the avatar is already
    // in cache by the time the home screen first paints.
    warmProfile(pk) { try { prefetchProfilePage(pk); profileOf(pk); } catch {} return true; },
    // Publish (merge) kind-0 fields for the current identity — the onboarding
    // wizard sets name + picture through this.
    publishProfile(fields, opts = {}) { return publishProfileFields(fields, opts); },
    // A migrated coinos.io account brings its face with it: fetch the legacy
    // avatar and cover art and fill our kind 0's EMPTY slots — fill, never
    // overwrite, so an existing nostr identity keeps its own look. The light
    // cache is pre-warmed so the wizard's punk-picker skip sees the picture
    // before the publish round-trips.
    async adoptLegacyProfile(username) {
      try {
        const u = await fetch(`https://coinos.io/api/users/${encodeURIComponent(username)}`).then((r) => r.json());
        if (!u) return true;
        const hosted = (v) => `https://coinos.io/api/public/${v}.webp`;
        const picture = u.profile ? hosted(u.profile)
          : typeof u.picture === 'string' && /^https?:\/\//i.test(u.picture) ? u.picture : null;
        const banner = !u.banner ? null
          : /^https?:\/\//i.test(String(u.banner)) ? String(u.banner) : hosted(u.banner);
        if (!picture && !banner) return true;
        const pk = myPubkeys()[0];
        if (pk && picture) {
          const cur = profiles.get(pk);
          if (!(cur && cur.picture)) {
            profiles.set(pk, { ...(cur || {}), picture, t: Date.now() });
            preloadPicture({ picture });
            scheduleRepaint();
          }
        }
        await publishProfileFields({ picture, banner }, { fillOnly: ['picture', 'banner'] });
      } catch {}
      return true;
    },
    // A payment-address rename released the old name: repoint the kind 0's
    // lud16 and nip05 — but only where they pointed at the released address
    // (or were empty). Deliberately different values are not ours to touch.
    addressRenamed(oldAddr, newAddr) {
      const follows = (k) => (base) => !base[k] || base[k] === oldAddr;
      return publishProfileFields({ lud16: newAddr, nip05: newAddr }, {
        onlyWhen: (base) => ['lud16', 'nip05'].some((k) => follows(k)(base) && base[k] !== newAddr),
        fieldWhen: { lud16: follows('lud16'), nip05: follows('nip05') },
      }).catch(() => {});
    },
    profileChip(pk, size) {
      const big = size === 'lg';
      return h('span', {
        class: 'zap-chip' + (big ? ' lg' : ''),
        onClick: (e) => { e.stopPropagation(); openProfile(pk); },
      }, avatar(pk, 'chat-avatar ' + (big ? 'chip-lg' : 'mini'), false),
        h('span', { class: big ? '' : 'small' }, displayName(pk)));
    },
    // A sign-in (Google, passkey, key) that found no wallet on its identity:
    // the same start, but only the follows of an identity that follows
    // nobody yet — an established nostr user keeps their own list.
    identitySignedInNew() { setTimeout(() => seedNewIdentity({ onlyIfNoFollows: true }), 0); return true; },
    init() {
      const session = ++feedWarmSession;
      // this wallet's cached faces, from its own namespace — the keys are
      // in place now, whatever the header asked for before
      profilesWarmed = false;
      warmProfiles();
      // your own profile is the likeliest first tap — warm it early
      setTimeout(() => {
        try { const me = ctx.shownPubkey && ctx.shownPubkey(); if (me) prefetchProfilePage(me); } catch {}
      }, 2500);
      // A tapped "new reply" notification lands here: as ?open=notifs when
      // it had to open a window, or as a worker message when one was open.
      if (OPEN_VIEW === 'notifs') setTimeout(openNotifs, 0);
      // a connection that came back is a connection whose subs may have died
      window.addEventListener('online', () => setTimeout(resubscribeStreams, 1500));
      armWatchdog(); // and, on screen, keep checking the sockets are really there
      try {
        navigator.serviceWorker?.addEventListener('message', (ev) => {
          if (ev.data && ev.data.type === 'open' && ev.data.view === 'notifs') openNotifs();
        });
      } catch {}
      if (urlInvite && !pendingLink) {
        loadLinkInvite(urlInvite);
        setTimeout(() => { ui.chatOpen = true; ui.msgView = 'home'; render(); }, 0);
      }
      if (urlPack) {
        addPack(urlPack).catch(() => {});
        setTimeout(() => { ui.chatOpen = true; ui.msgView = 'home'; render(); }, 0);
      }
      ui.pubProf = null; // a wallet is open now — its chrome owns the profile
      window.addEventListener('resize', onViewportResize);
      window.visualViewport?.addEventListener('resize', onViewportResize);
      onViewportResize();
      allUnsubs.push(() => {
        window.removeEventListener('resize', onViewportResize);
        window.visualViewport?.removeEventListener('resize', onViewportResize);
        document.documentElement.style.removeProperty('--chat-viewport-height');
      });
      startDMs();
      // Communities are built from CACHE ONLY at boot (subscribe:false) — the
      // unread dot reads the last-known messages, but none of the gift-wrap
      // verify/decrypt runs until the user opens Chat (homeView subscribes
      // them). This keeps the home screen (and the balance carousel) off the
      // hook for the ~500ms of secp256k1 a full community backfill costs.
      for (const jm of communities()) { try { ensureRoom(jm, { subscribe: false }); } catch {} }
      syncLists().catch(() => {});
      syncInbox().catch(() => {});
      // Warm a small opening page while the wallet is idle, before Feed is
      // opened. This is one bounded query, not a live feed subscription.
      syncFollows().catch(() => {});
      feedWarmTimer = setTimeout(() => {
        feedWarmTimer = null;
        if (session === feedWarmSession) feedNow();
      }, 1500);
      syncMutes().catch(() => {});   // and a muted author shouldn't flash past before the list lands
      registerPush().catch(() => {}); // silent refresh when permission already granted
    },
    stop() {
      for (const u of allUnsubs) { try { u(); } catch {} }
      allUnsubs = [];
      rooms.clear();
      threads.clear();
      pendingDirect.clear();
      seenWraps.clear(); wrapLog = null; // the next account must decrypt wraps this one couldn't
      clearTimeout(drainTimer);
      pendingWraps.clear();
      dmStarted = false;
      listsSynced = false;
      if (zapLiveUnsub) { try { zapLiveUnsub(); } catch {} zapLiveUnsub = null; }
      clearTimeout(zapTimer); zapTimer = null; zapQueue = new Set(); zapRecent = [];
      stopFeedWatch();
      ++feedWarmSession;
      clearTimeout(feedWarmTimer); feedWarmTimer = null;
      clearTimeout(feedAheadTimer); feedAheadTimer = null;
      for (const c of feedStates.values()) c.stopped = true;
      feedStates.clear();
      threadCache.clear();
      follows = null; followsAt = 0; feed = null; feedAt = 0; relayLists = null;
      mutes = null; mutesAt = 0;
      reacts.clear(); boosts.clear(); seenNoteEv.clear(); myReactEv.clear(); quoted.clear();
      noteCountsReady.clear();
      // what happened to THEIR posts stays with them — the next identity
      // starts its list empty and asks the relays under its own key
      stopNotifWatch(); notif = null; notifAt = 0; notifNotes.clear();
      zapWho.clear(); whoOpenIds.clear();
      clearTimeout(zapSaveT); zapSaveT = null; zapSeed = null;
      zapTotals.clear(); zapAsked.clear(); zapPending.clear(); // 'mine' is per identity — refetch under the next
    },
  };
}
