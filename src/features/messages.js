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
  subscribeOn, publishOn, queryOn, fetchInboxRelays,
  npubOf, neventOf, parseNostrPubkey, parseNostrRef, generateSecretKey, getPublicKey, finalizeEvent, nip44,
  PROFILE_RELAYS, openWrapsOffthread, unwrapDMsOffthread,
} from '../nostr.js';
import {
  channelKey, channelStream, channelEpoch, channelIsPrivate, controlKey, guestbookKey, openWrap, wrapRumor, rumorWithId,
  foldControl, foldGuestbook, observeAuthor, eventMs, msTags, makeEdition,
  communityId, parseInviteLink, makeInviteLink, makeInviteBundleEvent, openInviteBundle,
} from '../concord.js';
import { makeDMRumor, makeDMReaction, unwrapDM, wrapDM } from '../dm.js';
import { saveInbox } from '../dm-inbox.js';
import { makeSearcher, resultRows, fallbackAvatar, warmSearch } from '../recipient-search.js';
import { getNetwork } from '../api.js';
import { decodeBolt11 } from '../ark/lightning.js';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import { base64urlnopad } from '@scure/base';
import { t } from '../i18n.js';
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
const CLIENT_TAG = ['client', 'coinos'];

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
    for (const c of s.communities) c.added_at ||= Date.now();
    // pre-multi-community shape: joined was { [pubkey]: true } for coinos
    for (const k of Object.keys(s.joined))
      if (s.joined[k] === true) { (s.joined[COMMUNITY.community_id] ||= {})[k] = true; delete s.joined[k]; }
    return s;
  };
  const save = (s) => wallet.saveFeatureState('messages', s);

  const communities = () => [COMMUNITY, ...st().communities];

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
      if (ui.screen === 'wallet') render();
    }, 80);
  };

  // Profiles persist across sessions (capped) so known faces paint right
  // away instead of flashing the punk fallback; entries refresh in the
  // background once a day.
  const PROFILE_TTL = 24 * 3600_000;
  let profilesWarmed = false;
  function warmProfiles() {
    if (profilesWarmed) return;
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
      about: p.about || null, banner: p.banner || null, t: Date.now(),
      ...(p.thumbFor === p.picture && p.thumb
        ? { thumb: p.thumb, thumbFor: p.thumbFor, thumbPx: p.thumbPx || 0 } : {}),
      ...(p.thumbFail ? { thumbFail: p.thumbFail, thumbFailAt: p.thumbFailAt || 0, thumbFails: p.thumbFails || 1,
        thumbFailVersion: p.thumbFailVersion || 0 } : {}) };
    // Thumbnails are the bulk of this blob, so they live on a budget: the
    // least recently seen faces give theirs up first. The row itself stays —
    // that face just paints the way it used to.
    if (JSON.stringify(s).length > THUMB_BUDGET) {
      const oldestFirst = Object.keys(s).filter((k) => s[k].thumb).sort((a, b) => (s[a].t || 0) - (s[b].t || 0));
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
    return m ? (big ? `punks/${m[1]}.webp` : `punks-sm/${m[1]}.webp`) : null;
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
  const preloadPicture = (p) => { try { if (p && p.picture) new Image().src = p.picture; } catch {} };

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
    if (thumbing.has(pk) || thumbing.size >= 3) return; // a few at a time
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
      if (patch.thumb) scheduleRepaint();
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
  function profileOf(pk) {
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
    const p = m ? {
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
    } : null;
    // An empty answer must never clobber a remembered face with a punk: keep
    // what we had and just refresh the clock.
    const prev = profiles.get(pk);
    const entry = keepThumb(pk, p ? { ...p, t: Date.now(), miss: 0 } : { ...(prev || {}), t: Date.now() });
    profiles.set(pk, entry);
    persistProfile(pk, entry);
    preloadPicture(entry);
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
        for (const [pk, ev] of newest) { applyProfile(pk, ev); found.add(pk); }
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
        for (const [pk, ev] of idxNewest) { applyProfile(pk, ev); found.add(pk); }
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
          for (const [pk, ev] of newest) { applyProfile(pk, ev); found.add(pk); }
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
      }),
      subscribeOn(room.relays, { kinds: [1059], authors: [room.guestbook.pk], limit: 500 }, (wrap) => {
        if (seenWraps.has(wrap.id)) return;
        seenWraps.add(wrap.id);
        openWrapBg(wrap, room.guestbook, (opened) => {
          if (!opened) return;
          room.guestEntries.push(opened);
          scheduleFold();
        });
      })
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
    });
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
    if (dmStarted) {
      for (const u of dmUnsubs) { try { u(); } catch {} }
      dmUnsubs = []; dmStarted = false;
      startDMs();
    }
    for (const room of rooms.values()) {
      if (!room.subscribed) continue;
      for (const u of room.unsubs || []) { try { u(); } catch {} }
      room.unsubs = []; room.subscribed = false; room.subbed.clear();
      subscribeRoom(room);
    }
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
    if (rumor.kind === 9) {
      const msgs = room.byChannel.get(channelId) || room.byChannel.set(channelId, new Map()).get(channelId);
      msgs.set(rumor.id, { rumor, author });
      bumpMsgRev();
      room.typing.delete(author); // the message itself ends the "typing…"
    } else if (rumor.kind === 5) {
      for (const e of rumor.tags.filter((x) => x[0] === 'e')) {
        const m = room.byChannel.get(channelId)?.get(e[1]);
        if (!m || m.author === author) room.deletes.add(e[1]);
      }
    } else if (rumor.kind === 3302) {
      const target = tag('e')?.[1];
      if (target) {
        const cur = room.edits.get(target);
        if (!cur || eventMs(rumor) > eventMs(cur.rumor)) room.edits.set(target, { rumor, author });
      }
    } else if (rumor.kind === 7) {
      const target = tag('e')?.[1];
      if (target) {
        const r = room.reactions.get(target) || room.reactions.set(target, new Map()).get(target);
        r.set(author, rumor.content);
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
    const rumor = rumorWithId({
      kind: 9, pubkey: id.pubkey, content: text,
      tags: [['channel', chId], ['epoch', String(room.chEpoch(chId))], ...(replyTo ? [['e', replyTo]] : []), ms], created_at,
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
  function reactRow(myReact, onPick) {
    const pick = (e) => { ui.emojiPick = null; noteRecent(e); onPick(e); };
    if (ui.emojiPick) {
      const q = (ui.emojiPick.q || '').trim().toLowerCase();
      const hits = q ? EMOJI_LIB.filter((x) => x.k.includes(q) || x.e === q) : [...new Set([...recentEmojis(), ...EMOJI_LIB.map((x) => x.e)])].map((e) => ({ e }));
      return h('div', { class: 'col', style: 'gap:8px' },
        h('input', {
          type: 'text', placeholder: t('msgEmojiSearch'), value: ui.emojiPick.q || '', autofocus: true,
          onInput: (e) => { ui.emojiPick.q = e.target.value; render(); },
          onKeydown: (e) => { if (e.key === 'Enter' && hits.length) pick(hits[0].e); if (e.key === 'Escape') { ui.emojiPick = null; render(); } },
        }),
        h('div', { class: 'emoji-grid' },
          hits.slice(0, 160).map((x) => h('button', { class: x.e === myReact ? 'on' : '', title: x.k || '', onClick: () => pick(x.e) }, x.e)),
          !hits.length ? h('div', { class: 'small muted', style: 'padding:8px' }, t('msgEmojiNone')) : null));
    }
    const quick = [...new Set([...recentEmojis(), ...REACT_EMOJIS])].slice(0, 6);
    return h('div', { class: 'msg-sheet-emojis' },
      quick.map((e2) => h('button', { class: e2 === myReact ? 'on' : '', onClick: () => pick(e2) }, e2)),
      h('button', { class: 'more', title: t('msgEmojiMore'), onClick: () => { ui.emojiPick = { q: '' }; render(); } }, '＋'));
  }
  async function sendReaction(room, chId, m, emoji) {
    const id = await identity();
    if (!id) { noIdToast(); return; }
    ui.msgSheet = null;
    const { created_at, ms } = msTags(Date.now());
    const rumor = rumorWithId({
      kind: 7, pubkey: id.pubkey, content: emoji,
      tags: [['channel', chId], ['epoch', String(room.chEpoch(chId))], ['e', m.rumor.id], ['k', '9'], ms], created_at,
    });
    const r = room.reactions.get(m.rumor.id) || room.reactions.set(m.rumor.id, new Map()).get(m.rumor.id);
    const prev = r.get(id.pubkey);
    r.set(id.pubkey, emoji);
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
  function msgSnippet(room, m, max = 90) {
    const edit = room.edits.get(m.rumor.id);
    const text = edit && edit.author === m.author ? edit.rumor.content : m.rumor.content;
    const one = String(text || '').replace(/\s+/g, ' ').trim();
    return one.length > max ? one.slice(0, max - 1) + '…' : one;
  }

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
      h('span', { class: 'chat-quote-text' }, msgSnippet(room, src)));
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
        !ui.emojiPick && !mine && canZapPk(m.author) ? item('⚡', t('msgZap'), () => { close(); zapMessage(m.author, m.rumor.id); }) : null,
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
        h('span', { class: 'small muted chat-quote-text' }, msgSnippet(room, m))),
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
    // to / before that route ever saw it
    if (m && ['chat'].includes(m[1])) return null;
    return m ? m[1] : null;
  })();
  if (urlProfile) { try { history.replaceState(null, '', '/'); } catch {} }

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

  async function publishLists() {
    const ids = await selfCryptors();
    const s = st();
    publishFragments(ids, fragAt).catch(() => {});
    const docs = [[13302, buildCommunityList(s)], [13303, buildInviteList(s)]];
    for (const id of ids)
      for (const [kind, doc] of docs) {
        try {
          const evt = await id.sign({
            kind, content: await id.enc(doc), tags: [], created_at: Math.floor(Date.now() / 1000),
          });
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
    const now = Math.floor(Date.now() / 1000);
    for (const id of ids)
      for (let i = 0; i < frags.length; i++) {
        try {
          const created_at = Math.max(now, ((prevAt[id.pk] || {})[i] || 0) + 1);
          const evt = await id.sign({ kind: LIST_FRAG_KIND, tags: [['d', String(i)]], content: await id.enc(JSON.stringify(frags[i])), created_at });
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
      listLiveSub = subscribeOn(listRelays(), { kinds: [LIST_FRAG_KIND], authors, since: Math.floor(Date.now() / 1000) }, () => {
        clearTimeout(listLiveSub.t); listLiveSub.t = setTimeout(() => syncLists({ force: true }).catch(() => {}), 1500);
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
        noteDM(peer, got.rumor, mine);
        persistDms();
      } else if (got.rumor.kind === 7) {
        // a DM reaction (ours echoed back, or the peer's — 0xchat's shape)
        const target = got.rumor.tags?.find((x) => x[0] === 'e')?.[1];
        if (target) {
          (dmReacts.get(target) || dmReacts.set(target, new Map()).get(target)).set(got.author, got.rumor.content);
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
        threadOf(peer).set(m.id, { rumor: { id: m.id, pubkey: m.from, content: m.text, created_at: m.t, kind: 14 }, mine: isMe(m.from) });
    }
    bumpMsgRev();
    if (swept) save(s);
    const dmSub = (relays) => {
      const u = subscribeOn(relays, { kinds: [1059], '#p': pks, limit: 400 }, (wrap) => {
        handleInboxWrap(wrap).catch(() => {});
      });
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
    const rumor = makeDMRumor(id.pubkey, peer, text, replyTo ? [['e', replyTo]] : []);
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
    const rumor = makeDMReaction(id.pubkey, peer, m.rumor.id, emoji);
    const r = dmReacts.get(m.rumor.id) || dmReacts.set(m.rumor.id, new Map()).get(m.rumor.id);
    const prev = r.get(id.pubkey);
    r.set(id.pubkey, emoji);
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
        .map((m) => ({ id: m.rumor.id, from: m.rumor.pubkey, text: m.rumor.content, t: m.rumor.created_at }));
    save(s);
  }

  // ---- views --------------------------------------------------------------

  const timeLabel = (tms) => {
    const d = new Date(tms);
    const today = new Date().toDateString() === d.toDateString();
    return today
      ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) +
        ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
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
    const node = p && p.loading && !p.picture
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
    if (p && p.picture) makeThumb(pk, p);
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
    if (fullFetched.has(pk)) return;
    fullFetched.add(pk);
    queryOn([...new Set([...PROFILE_RELAYS, ...DM_RELAYS])], { kinds: [0], authors: [pk] }, 3500).then((evs) => {
      const newest = evs.sort((a, b) => b.created_at - a.created_at)[0];
      let m = {};
      try { m = newest ? JSON.parse(newest.content) : {}; } catch {}
      fullProfiles.set(pk, m);
      persistPage('full', pk, m);
      // A full fetch is the freshest word on this profile — stamp it into the
      // light cache (and persist) so a picture changed elsewhere replaces the
      // stale one everywhere within a session, not after the 24h TTL. The
      // repaint covers the header/chat avatars, not just an open profile page.
      const entry = {
        name: m.display_name || m.name || null, picture: m.picture || null,
        nip05: m.nip05 || null, lud16: typeof m.lud16 === 'string' ? m.lud16.trim() : null,
        about: typeof m.about === 'string' ? m.about.slice(0, 1000) : null,
        banner: typeof m.banner === 'string' ? m.banner.slice(0, 400) : null,
        t: Date.now(),
      };
      keepThumb(pk, entry);
      profiles.set(pk, entry);
      persistProfile(pk, entry);
      preloadPicture(entry);
      if (ui.profilePk === pk) render();
      else scheduleRepaint();
    }).catch(() => { if (!fullProfiles.has(pk)) fullProfiles.set(pk, {}); });
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
  const reacts = new Map();  // note id -> Map(emoji -> Set<pubkey>)
  const boosts = new Map();  // note id -> Set<pubkey>
  const seenNoteEv = new Set(); // event ids already counted
  const myReactEv = new Map();  // note id -> the id of OUR reaction, so it can be withdrawn
  const zapTotals = new Map(); // id -> { sats, seen: Set<receipt id>, mine }
  const zapWho = new Map();    // id -> Map(receipt id -> { pk, sats, ts, text }) — the tally, by person
  const zapAsked = new Set();
  let zapQueue = new Set(), zapTimer = null, zapLiveUnsub = null, zapRecent = [];
  const zapRelays = () => [...new Set([...NOTE_RELAYS, ...((wallet.nostrRelays && wallet.nostrRelays()) || [])])];
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
    if (ev.kind === 9737) return ev.pubkey;
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
        const emoji = !ev.content || ev.content === '+' ? '\u2764\ufe0f' : ev.content.slice(0, 12);
        if (!reacts.has(id)) reacts.set(id, new Map());
        const m = reacts.get(id);
        if (!m.has(emoji)) m.set(emoji, new Set());
        m.get(emoji).add(ev.pubkey);
        // ours, wherever it was sent from — so it can be taken back here
        if (myPubkeys().includes(ev.pubkey)) myReactEv.set(id, ev.id);
      }
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
      if (from && my.includes(from)) { cur.mine = true; voidPending(x[1], ev.created_at * 1000); }
      changed = true;
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
  // id -> { sats, at, state }, where state is:
  //   flying — tapped, payment in the air: counted on top, chip pulses
  //   paid   — the flow reported success: counted on top, chip solid
  //   void   — one of OUR receipts has been counted into the real total for
  //            this id, so the optimistic amount must not be added again.
  //            Kept rather than deleted, because the receipt usually beats
  //            the flow's own report: an ark zap publishes that receipt
  //            itself, and it returns over the live subscription before the
  //            send call resolves. Deleting would let the later settle
  //            resurrect the amount — which is how a 21-sat zap displayed 42.
  const zapPending = new Map();
  const pendTtl = (p) => (p.state === 'flying' ? ZAP_FLIGHT_MS : ZAP_PAID_MS);
  function pendingOf(id) {
    const p = zapPending.get(id);
    if (!p) return null;
    if (Date.now() - p.at > pendTtl(p)) { zapPending.delete(id); return null; }
    return p;
  }
  function markZapPending(id, sats) {
    if (!id || !sats) return;
    zapPending.set(id, { sats, at: Date.now(), state: 'flying' });
    scheduleRepaint();
    // repaint when the in-flight chip would expire, so a zap nobody ever
    // reported on doesn't pulse forever
    setTimeout(scheduleRepaint, ZAP_FLIGHT_MS + 200);
  }
  // A zap flow reporting back: paid (keep the amount, stop pulsing) or
  // failed (the chip was never real — take it off).
  function settleZap(id, ok, sats) {
    if (!id) return;
    const p = pendingOf(id);
    if (!ok) {
      if (p && p.state !== 'void') { zapPending.delete(id); scheduleRepaint(); }
      return;
    }
    if (p && p.state === 'void') return; // the receipt is already carrying it
    zapPending.set(id, { sats: sats || (p && p.sats) || 0, at: Date.now(), state: 'paid' });
    scheduleRepaint();
  }
  // One of our own receipts has been counted for this id: the real total
  // speaks for the zap now, so the optimistic amount stands down.
  function voidPending(id, evMs) {
    const p = zapPending.get(id);
    // ...unless it's the receipt of an OLDER zap of ours arriving (the first
    // paint fetches every receipt a message has). That one is already in the
    // total and says nothing about the zap currently in the air.
    if (p && p.state !== 'void' && evMs && evMs < p.at - 120_000) return;
    zapPending.set(id, { sats: 0, at: Date.now(), state: 'void' });
  }
  // The chip: a little bolt + the sats total. Absent until the first receipt
  // — or until you zap it yourself, which is its own kind of receipt.
  function zapChip(id, { onClick, cls = '' } = {}) {
    const z = zapTotals.get(id) || zapSeeds().get(id);
    const p = pendingOf(id);
    const optimistic = p && p.state !== 'void' ? p.sats : 0;
    const sats = (z ? z.sats : 0) + optimistic;
    if (!sats) return null;
    const flying = !!p && p.state === 'flying';
    return h('span', {
      class: 'zap-tally' + ((z && z.mine) || optimistic ? ' on' : '') + (flying ? ' flying' : '')
        + (onClick ? ' clickable' : '') + (cls ? ' ' + cls : ''),
      title: flying ? t('zapSending') : t('zapTallyTitle', { n: sats.toLocaleString() }),
      onClick: onClick ? (e) => { e.stopPropagation(); onClick(); } : undefined,
    }, h('span', { style: 'display:flex', html: BOLT_SVG }), fmtSats(sats));
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
      // back at the top of the feed: the waiting posts belong on screen now
      if (ui.chatOpen && ui.msgView === 'feed' && atFeedTop()) flushPending(false);
      if (!ui.profilePk && !(ui.chatOpen && ui.msgView === 'feed')) return;
      if (window.innerHeight + window.scrollY < (document.documentElement.scrollHeight || 0) - 600) return;
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
  // The last screenful is kept locally so the feed opens with posts in it
  // rather than a spinner, exactly like the profile pages do.
  const FEED_CACHE = 'feedNotes';
  const FEED_LIMIT = 80;
  const FEED_PAGE = 20;    // posts on screen at once, grown as you scroll
  const FEED_KEEP = 200;   // in memory
  const FEED_STORE = 50;   // ...and on disk
  let feed = null;         // { status, notes, end, loadingMore }
  let feedUnsubs = [];
  let feedAt = 0;

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
  const feedAuthors = () => [...followsNow().set].slice(0, FEED_AUTHORS_MAX);

  function feedNow() {
    if (!feed) {
      let stored = [];
      try { stored = wallet.loadFeatureState(FEED_CACHE, []) || []; } catch {}
      feed = { status: stored.length ? 'ready' : 'loading', notes: stored, shown: FEED_PAGE };
      // the cached page is on screen already; warm what it shows so the
      // scroll below the fold, and the next boot, paint whole too
      notesReady(stored.slice(0, FEED_PAGE)).catch(() => {});
      refreshFeed();
    }
    return feed;
  }
  // A follow list that changed means a feed built from the wrong authors.
  function feedAuthorsChanged() {
    if (!feed) return;
    feedAt = 0;
    refreshFeed();
  }
  // How far from the top counts as "reading", rather than "sitting at the top
  // of the feed". Inserting a post above what someone is reading moves the
  // words under their eyes; at the top there is nothing to disturb.
  const FEED_TOP_PX = 120;
  const atFeedTop = () => {
    try { return (window.scrollY || 0) < FEED_TOP_PX; } catch { return true; }
  };

  // ---- a post arrives whole ------------------------------------------------
  // A row used to paint the moment its event landed, and then finish itself
  // over the next second or two: a punk turning into a photograph, a blank
  // gap becoming the picture. So a post now waits at the door until its
  // author's face and the images in its body are fetched and decoded — or
  // have had a fair chance. A slow host holds a post for a couple of seconds,
  // not forever, and a batch never waits longer than one post would.
  const READY_MS = 2000;
  const mediaReady = new Set(); // URLs decoded (or given up on) this session
  const warmMedia = (url) => new Promise((resolve) => {
    if (!url || mediaReady.has(url) || typeof Image === 'undefined') return resolve();
    const done = () => { mediaReady.add(url); resolve(); };
    try {
      const img = new Image();
      img.onload = () => { (img.decode ? img.decode() : Promise.resolve()).then(done, done); };
      img.onerror = done; // a picture that won't load won't get better by waiting
      img.src = url;
    } catch { done(); }
  });
  // The pictures a body will show: inline images (by extension, or markdown
  // saying so outright) and a video's poster still. Four at most — a
  // gallery post shows its first row whole and fills in the rest.
  function noteMediaUrls(content) {
    const urls = [];
    for (const part of String(content || '').split(NOTE_SPLIT)) {
      if (!part || urls.length >= 4) continue;
      const md = MD_PARTS.exec(part);
      const url = md ? md[3] : (/^https?:\/\//i.test(part) ? part : null);
      if (!url) continue;
      if ((md && md[1]) || /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i.test(url)) urls.push(url);
      else if (youtubeId(url)) urls.push('https://i.ytimg.com/vi/' + youtubeId(url) + '/hqdefault.jpg');
    }
    return urls;
  }
  // The face: wait for the profile to land (the batch asks within a beat),
  // then for whatever avatarBg would paint from — the local thumbnail is a
  // data URL and costs nothing; an original goes through the network once.
  async function warmAvatar(pk, deadline) {
    let p = profileOf(pk);
    while ((p === null || (p && p.loading && !p.picture)) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
      p = profiles.get(pk);
    }
    if (!p || !p.picture) return; // punk art: drawn from the pubkey, no fetch
    if (localPunk(p.picture) || (p.thumb && p.thumbFor === p.picture)) return;
    await warmMedia(p.picture);
  }
  function noteReady(ev, deadline = Date.now() + READY_MS) {
    const wait = Promise.all([warmAvatar(ev.pubkey, deadline), ...noteMediaUrls(ev.content).map(warmMedia)]);
    return Promise.race([wait, new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]).catch(() => {});
  }
  const notesReady = (evs) => { const deadline = Date.now() + READY_MS; return Promise.all(evs.map((e) => noteReady(e, deadline))); };

  // ---- new posts open up rather than appear ------------------------------
  // A post let in at the top of an open feed used to simply be there on the
  // next paint — one frame nothing, the next frame a whole row, and the rest
  // of the page shoved down by exactly that much. Now it opens: height from
  // nothing to its own, fading in as it goes, over a third of a second. The
  // feed is rebuilt on every render, so the moment a post was let in is
  // remembered per id and a repaint mid-way resumes the animation where it
  // was instead of starting it again.
  const keyed = (node, key) => { node.setAttribute('data-key', key); return node; };
  const ENTER_MS = 380;
  const feedEntered = new Map(); // note id -> ms its row first painted (0: not yet)
  function noteEntering(evs) {
    if (!(ui.chatOpen && ui.msgView === 'feed')) return; // nobody is watching
    for (const e of evs) feedEntered.set(e.id, 0);
  }
  function enterRow(node, id) {
    if (!feedEntered.has(id)) return node;
    // the clock starts at the first paint, not at admission: a repaint can
    // trail the merge by longer than the animation itself
    const at = feedEntered.get(id) || (feedEntered.set(id, Date.now()), Date.now());
    const elapsed = Date.now() - at;
    if (elapsed >= ENTER_MS || typeof node.animate !== 'function') { feedEntered.delete(id); return node; }
    // measured once it is in the page; the row keeps its own padding, which
    // opens with it so the words don't sit on the hairline for a beat
    setTimeout(() => {
      if (!node.isConnected) return;
      const box = node.getBoundingClientRect().height;
      const pad = 10; // the row's vertical padding, see noteRow
      node.style.overflow = 'hidden';
      const anim = node.animate([
        { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0 },
        { height: Math.max(0, box - 2 * pad) + 'px', paddingTop: pad + 'px', paddingBottom: pad + 'px', opacity: 1 },
      ], { duration: ENTER_MS, easing: 'cubic-bezier(.2,.7,.2,1)', fill: 'backwards' });
      anim.currentTime = Math.min(ENTER_MS, Date.now() - at);
      anim.onfinish = anim.oncancel = () => { node.style.overflow = ''; feedEntered.delete(id); };
    }, 0);
    return node;
  }

  // Posts at the door: filtered in synchronously, so the same note from a
  // second relay is dropped while the first copy is still warming.
  const feedStaged = new Set();
  async function mergeFeed(evs, opts = {}) {
    const c = feedNow();
    const known = new Set([...c.notes, ...(c.pending || [])].map((e) => e.id));
    const add = (evs || []).filter((e) => e.kind === 1 && !isReply(e) && !isMuted(e.pubkey)
      && !known.has(e.id) && !feedStaged.has(e.id) && known.add(e.id) && feedStaged.add(e.id));
    if (!add.length) return false;
    await notesReady(add);
    for (const e of add) feedStaged.delete(e.id);
    // A post that arrived on its own while you were reading waits behind the
    // pill instead of shoving the page down. Anything you asked for — a
    // refresh, a scroll to the bottom, the first load — goes straight in.
    if (opts.live && !atFeedTop() && c.notes.length) {
      c.pending = [...(c.pending || []), ...add].sort((a, b) => b.created_at - a.created_at).slice(0, FEED_KEEP);
      return true;
    }
    c.notes = [...c.notes, ...add].sort((a, b) => b.created_at - a.created_at).slice(0, FEED_KEEP);
    if (opts.live) noteEntering(add);
    // posts arriving at the TOP shouldn't cost you the ones you'd scrolled to
    const fresh = add.filter((e) => e.created_at >= (c.notes[0] || {}).created_at).length;
    if (fresh) c.shown = Math.min((c.shown || FEED_PAGE) + fresh, c.notes.length);
    try { wallet.saveFeatureState(FEED_CACHE, c.notes.slice(0, FEED_STORE).map(slimNote)); } catch {}
    return true;
  }

  // Let the waiting posts in. Called by the pill, and by simply scrolling
  // back to the top — once you are up there they cost nothing to show.
  function flushPending(scroll) {
    const c = feed;
    if (!c || !(c.pending || []).length) return;
    const add = c.pending;
    c.pending = [];
    noteEntering(add);
    const seen = new Set(c.notes.map((e) => e.id));
    c.notes = [...c.notes, ...add.filter((e) => !seen.has(e.id))]
      .sort((a, b) => b.created_at - a.created_at).slice(0, FEED_KEEP);
    c.shown = Math.min((c.shown || FEED_PAGE) + add.length, c.notes.length);
    try { wallet.saveFeatureState(FEED_CACHE, c.notes.slice(0, FEED_STORE).map(slimNote)); } catch {}
    render();
    if (scroll) { try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch { window.scrollTo(0, 0); } }
  }
  // One pass over the plan: each relay is asked only for the authors it
  // actually carries. The slowest relay doesn't hold up the rest — every
  // answer merges as it lands.
  // `merge` rides along to mergeFeed: a catch-up after being away is exactly
  // as disruptive as a live arrival if you were reading halfway down, so it
  // goes behind the pill too. A first load, or paging older posts onto the
  // bottom, does not.
  async function feedPass(extra = {}, merge = {}) {
    const authors = feedAuthors();
    if (!authors.length) return false;
    await fetchRelayLists(authors);
    const plan = outboxPlan(authors);
    let got = false;
    await Promise.all(plan.flatMap(({ relays, authors: a }) => {
      const chunks = [];
      for (let i = 0; i < a.length; i += REQ_AUTHORS) chunks.push(a.slice(i, i + REQ_AUTHORS));
      return chunks.map(async (chunk) => {
        const evs = await queryOn(relays, { kinds: [1], authors: chunk, limit: FEED_LIMIT, ...extra }, 5000).catch(() => []);
        if (await mergeFeed(evs, merge)) { got = true; scheduleRepaint(); }
      });
    }));
    return got;
  }
  async function refreshFeed(opts = {}) {
    if (!feedAuthors().length) { if (feed) feed.status = 'ready'; return; }
    if (!opts.force && Date.now() - feedAt < 30_000) return;
    feedAt = Date.now();
    try { await feedPass({}, { live: !!opts.force }); } catch {} finally {
      if (feed) feed.status = 'ready';
      scheduleRepaint();
    }
    watchFeed();
  }
  // While the feed is what's on screen, new posts arrive by themselves — on
  // the same relays the pass above reads, one subscription each.
  function watchFeed() {
    stopFeedWatch();
    if (!feedAuthors().length || !ui.chatOpen || ui.msgView !== 'feed') return;
    const since = Math.floor(Date.now() / 1000) - 60;
    for (const { relays, authors } of outboxPlan(feedAuthors()))
      for (let i = 0; i < authors.length; i += REQ_AUTHORS)
        feedUnsubs.push(subscribeOn(relays, { kinds: [1], authors: authors.slice(i, i + REQ_AUTHORS), since },
          (ev) => { mergeFeed([ev], { live: true }).then((ok) => { if (ok) scheduleRepaint(); }).catch(() => {}); }));
  }
  function stopFeedWatch() {
    for (const u of feedUnsubs) { try { u(); } catch {} }
    feedUnsubs = [];
  }
  // Reaching the bottom shows another twenty. Only when the window has caught
  // up with everything we hold do we go back to the relays for older posts —
  // rendering a hundred notes to show twenty was the whole cost here.
  async function loadOlderFeed() {
    const c = feedNow();
    if (c.shown < c.notes.length) {
      c.shown = Math.min(c.shown + FEED_PAGE, c.notes.length);
      render();
      if (c.shown < c.notes.length) return; // still serving from what we have
    }
    if (c.status !== 'ready' || c.loadingMore || c.end) return;
    const oldest = c.notes[c.notes.length - 1];
    if (!oldest || !feedAuthors().length) { c.end = true; return; }
    c.loadingMore = true;
    render();
    try {
      if (await feedPass({ until: oldest.created_at - 1 })) c.shown += FEED_PAGE;
      else c.end = true;
    } catch {} finally {
      c.loadingMore = false;
      render();
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
  const NOTE_SPLIT = new RegExp('(' + MD_LINK + '|https?:\\/\\/[^\\s]+|nostr:(?:npub|nprofile|note|nevent|naddr)1[a-z0-9]+|' + MENTION + ')', 'gi');
  const MD_PARTS = new RegExp('^(!?)\\[([^\\]\\n]{0,300})\\]\\(\\s*<?(https?:\\/\\/[^\\s>)]+)>?[^)\\n]{0,300}\\)$', 'i');

  // A YouTube link is a video, so show the video. All three shapes it comes
  // in: the long one, the short one, and a Shorts link.
  const YT = /^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:[^\s]*&)?v=([\w-]{6,})|shorts\/([\w-]{6,})|live\/([\w-]{6,}))|youtu\.be\/([\w-]{6,}))/i;
  const youtubeId = (url) => { const m = YT.exec(url || ''); return m ? (m[1] || m[2] || m[3] || m[4]) : null; };
  const ytStart = (url) => {
    const m = /[?&](?:t|start)=(\d+)/.exec(url || '') || /[?&]t=(\d+)s/.exec(url || '');
    return m ? Math.max(0, parseInt(m[1], 10) || 0) : 0;
  };

  // The still, with a play button over it, and the player itself only once
  // it's tapped. A feed of ten videos would otherwise load ten YouTube
  // players — every one of them telling Google what you're scrolling past
  // before you've decided to watch anything. One tap, and it plays in place.
  function youtubeEmbed(url, vid) {
    const start = ytStart(url);
    const src = 'https://www.youtube-nocookie.com/embed/' + vid
      + '?autoplay=1&rel=0' + (start ? '&start=' + start : '');
    const frame = h('div', { class: 'yt-embed' },
      h('img', {
        class: 'yt-poster', loading: 'lazy', alt: '',
        src: 'https://i.ytimg.com/vi/' + vid + '/hqdefault.jpg',
        onError: (e) => { e.target.style.display = 'none'; },
      }),
      h('button', {
        class: 'yt-play', 'aria-label': t('playVideo'), title: t('playVideo'),
        onClick: (e) => {
          e.stopPropagation();
          const box = e.currentTarget.parentElement;
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
          f.src = src;
          f.title = 'YouTube';
          f.allow = 'accelerometer; autoplay; encrypted-media; picture-in-picture; web-share';
          f.referrerPolicy = 'strict-origin-when-cross-origin';
          f.allowFullscreen = true;
          box.append(f);
        },
      }, h('span', { style: 'display:flex', html: '<svg width="30" height="30" viewBox="0 0 24 24" fill="currentColor" style="display:block"><path d="M8 5v14l11-7z"/></svg>' })),
      h('a', {
        class: 'yt-open', href: url, target: '_blank', rel: 'noopener noreferrer',
        title: t('openInYouTube'), onClick: (e) => e.stopPropagation(),
      }, '\u2197'));
    return frame;
  }

  // ---- quoted notes ---------------------------------------------------------
  // A nostr:note1/nevent1 in someone's post IS a post, so show it: the thing
  // they're talking about, inside what they said about it. Fetched once per
  // id and remembered, so a feed that quotes the same note ten times asks for
  // it once.
  const quoted = new Map(); // id -> { status, ev }
  function quotedNote(ref) {
    let c = quoted.get(ref.id);
    if (c) return c;
    c = { status: 'loading', ev: null };
    quoted.set(ref.id, c);
    (async () => {
      const relays = [...new Set([...(ref.relays || []), ...zapRelays()])];
      const evs = await queryOn(relays, { ids: [ref.id] }, 4500).catch(() => []);
      c.ev = (evs || [])[0] || null;
      c.status = c.ev ? 'ready' : 'missing';
      scheduleRepaint();
    })();
    return c;
  }

  // The card. Deliberately not a noteRow: a quote is context, not another
  // post to act on — no reply, no boost, no zap of its own. Tapping it opens
  // the note properly, which is where those live.
  function quoteCard(ref, depth) {
    const c = quotedNote(ref);
    if (c.status === 'loading') {
      return h('div', { class: 'quote-card quote-loading' },
        h('span', { class: 'spinner sm' }), h('span', { class: 'small faint' }, t('noteRefLoading')));
    }
    if (!c.ev) {
      return h('div', { class: 'quote-card' },
        h('span', { class: 'small faint' }, t('noteRefNotFound')));
    }
    const ev = c.ev;
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
        ...noteBody(ev.content, depth + 1)));
  }

  // One URL, rendered as whatever it points at. `isImage` is markdown saying
  // so outright — plenty of perfectly good picture URLs carry no extension
  // (a CDN path, a /media/ route), and ![…] is the author telling us what it
  // is, which beats guessing from the filename.
  function urlNode(url, { label = null, isImage = false } = {}) {
    if (/\.(mp4|webm|mov|m4v)(\?[^\s]*)?$/i.test(url)) {
      // metadata-only preload: the poster frame paints, nothing streams
      // until the viewer presses play
      return h('video', { src: url, class: 'note-video', controls: true,
        preload: 'metadata', playsinline: true,
        onError: (e) => { e.target.style.display = 'none'; } });
    }
    if (isImage || /\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i.test(url)) {
      // tap it to see it properly — a 320px-tall crop of someone's
      // photograph is a thumbnail, not the picture they posted
      return h('img', {
        src: url, class: 'note-img clickable', loading: 'lazy', alt: label || '',
        onClick: (e) => { e.stopPropagation(); ctx.openImage && ctx.openImage(url); },
        // a picture we were TOLD was a picture and which won't load leaves
        // nothing behind — the alt text is already in the sentence above it
        onError: (e) => { e.target.style.display = 'none'; },
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

  function noteBody(text, depth = 0) {
    const out = [];
    for (const part of String(text || '').split(NOTE_SPLIT)) {
      if (!part) continue;
      const md = MD_PARTS.exec(part);
      if (md) {
        const [, bang, label, url] = md;
        out.push(urlNode(url, { label: label || null, isImage: !!bang }));
      } else if (/^https?:\/\//i.test(part)) {
        out.push(urlNode(part));
      } else if (/^nostr:(npub|nprofile)1/i.test(part)) {
        const ref = parseNostrRef(part.slice(6));
        if (ref && ref.type === 'pubkey') out.push(h('a', { href: '#', onClick: (e) => { e.preventDefault(); openProfile(ref.pk); } }, '@' + displayName(ref.pk)));
        else out.push(h('span', { class: 'faint' }, part.slice(6, 18) + '…'));
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
  const canZapPk = (pk) => !!pk && !isMe(pk) && !!(hook('arkReady') || hook('canLnZap'));
  function zapNote(pk, ev) {
    const npubStr = npubOf(pk);
    const def = ctx.zapDefaultSat ? ctx.zapDefaultSat() : 0;
    if (!def) { ui.zapSetup = { pk, npub: npubStr, eventId: ev.id, amount: '21' }; render(); return; }
    markZapPending(ev.id, def); // the chip answers the tap; the flow reports back
    if (!hook('zapNpub', pk, npubStr, ev.id, def) && !hook('lnZapNpub', pk, npubStr, ev.id, def)) {
      // no instant path in this build — the classic form flow
      settleZap(ev.id, false);
      ui.profilePk = null;
      ui.chatOpen = false;
      ui.tab = 'send';
      render();
      if (!hook('zapNpub', pk, npubStr, ev.id)) hook('lnZapNpub', pk, npubStr, ev.id);
    }
  }

  // First ⚡ tap ever: pick the amount one time, then every zap is one tap.
  function zapSetupScreen() {
    const s = ui.zapSetup;
    return h('div', { class: 'col', style: 'gap:16px' },
      ctx.brandHeader(false),
      h('div', { class: 'card col', style: 'gap:10px' },
        h('h3', { style: 'margin:0' }, '⚡ ' + t('zapSetupTitle')),
        h('div', { class: 'small muted' }, t('zapSetupDesc')),
        h('div', { class: 'input-group' },
          h('input', { type: 'number', min: '1', value: s.amount, onInput: (e) => { s.amount = e.target.value; } }),
          h('span', { class: 'small muted', style: 'align-self:center;padding:0 8px' }, 'sats')),
        h('button', { class: 'btn-primary btn-block', onClick: () => {
          const n = parseInt(s.amount, 10);
          if (!n || n <= 0) { toast(t('enterValidAmtForN', { n: 1 })); return; }
          ctx.setZapDefaultSat(n);
          const { pk, npub, eventId } = s;
          ui.zapSetup = null;
          render();
          markZapPending(eventId, n);
          if (!hook('zapNpub', pk, npub, eventId, n) && !hook('lnZapNpub', pk, npub, eventId, n)) settleZap(eventId, false);
          recheckZap(eventId);
        } }, t('zapSetupSave'))),
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
    for (const [emoji, who] of m) for (const pk of mine) if (who.has(pk)) return emoji;
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
      render();
    } else openNoteThread(ev);
    if (ui.noteThread) ui.noteThread.refocus = true;
    setTimeout(() => document.querySelector('.thread-reply-input')?.focus(), 120);
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
      if (m) for (const [emoji, who] of [...m]) { for (const pk of myPubkeys()) who.delete(pk); if (!who.size) m.delete(emoji); }
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
      tags: [['e', ev.id], ['p', ev.pubkey], CLIENT_TAG],
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
  let mutes = null; // { set, tags, content, at }
  let mutesAt = 0;
  function mutesNow() {
    if (!mutes) {
      let st2 = null;
      try { st2 = wallet.loadFeatureState(MUTES, null); } catch {}
      const tags = (st2 && st2.tags) || [];
      mutes = { set: new Set(pTags(tags).map((x) => x[1])), tags, content: (st2 && st2.c) || '', at: (st2 && st2.at) || 0 };
    }
    return mutes;
  }
  const isMuted = (pk) => mutesNow().set.has(pk);
  function saveMutes(m) {
    mutes = m;
    try { wallet.saveFeatureState(MUTES, { tags: m.tags, c: m.content, at: m.at }); } catch {}
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
        saveMutes({ set: new Set(pTags(newest.tags).map((x) => x[1])), tags: newest.tags || [], content: newest.content || '', at: newest.created_at });
        scheduleRepaint();
      }
    } catch { mutesAt = 0; }
    return mutesNow();
  }
  // Same care as the follow list: publish onto the freshest copy the relays
  // will give us, preserving anything in it we didn't write (the encrypted
  // content other clients keep their private mutes in, above all).
  async function toggleMute(pk, { block = false } = {}) {
    const id = await requireIdentity();
    if (pk === id.pubkey) return;
    const before = mutesNow();
    saveMutes({ ...before, set: new Set(before.set.has(pk) ? [...before.set].filter((x) => x !== pk) : [...before.set, pk]) });
    render();
    try {
      await syncMutes({ force: true });
      const fetched = mutesNow(); // see the note in toggleFollow
      const base = fetched.at > before.at ? fetched : before;
      const had = base.set.has(pk);
      const tags = had ? base.tags.filter((x) => !(x[0] === 'p' && x[1] === pk)) : [...base.tags, ['p', pk]];
      const created_at = Math.max(Math.floor(Date.now() / 1000), base.at + 1);
      const partial = { kind: 10000, content: base.content || '', created_at, tags };
      const evt = id.signer instanceof Uint8Array ? finalizeEvent(partial, id.signer) : await id.signer.signEvent(partial);
      const ok = await publishOn(zapRelays(), evt);
      if (!ok) throw new Error(t('msgSendFailed'));
      saveMutes({ set: new Set(pTags(tags).map((x) => x[1])), tags, content: base.content || '', at: created_at });
      if (block && !had && isFollowing(pk)) await toggleFollow(pk);
      toast(had ? t('postUnmuted') : block ? t('postBlocked') : t('postMuted'));
      render();
    } catch (e) {
      saveMutes(before);
      if (!(e instanceof NoIdentity)) toast(e.message || String(e));
      render();
    }
  }

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
    const mineReact = myReactOn(ev.id);
    const rm = reacts.get(ev.id);
    const likeN = rm ? [...rm.values()].reduce((n, who) => n + who.size, 0) : 0;
    const boostN = (boosts.get(ev.id) || new Set()).size;
    const btn = (icon, label, count, on, onClick) => h('button', {
      class: 'note-act' + (on ? ' on' : ''), title: label, 'aria-label': label,
      onClick: (e) => { e.stopPropagation(); onClick(); },
    },
      typeof icon === 'string' && icon.startsWith('<svg')
        ? h('span', { style: 'display:flex', html: icon })
        : h('span', { class: 'note-act-emoji' }, icon),
      count ? h('span', { class: 'note-act-n' }, String(count)) : null);
    return h('div', { class: 'row note-acts' },
      btn(I_REPLY, t('msgReply'), 0, false, () => replyToNote(ev)),
      btn(I_BOOST, t('postBoost'), boostN, iBoosted(ev.id), () => boostNote(ev).catch(() => {})),
      btn(I_QUOTE, t('postQuote'), 0, false, () => quoteNote(ev)),
      // tap to choose how you feel about it; tap again to take it back
      btn(mineReact || I_HEART(false), t('postLike'), likeN, !!mineReact,
        () => { if (mineReact) unreact(ev).catch(() => {}); else { ui.reactPick = ev; render(); } }),
      canZap ? btn(I_ZAP, t('zapTitle'), 0, false, () => { zapNote(pk, ev); recheckZap(ev.id); }) : null,
      // who did all that: a small chevron, only once there is anyone to show
      whoCount(ev.id)
        ? h('button', {
            class: 'note-act note-who-toggle' + (whoOpen(ev.id) ? ' on' : ''),
            title: t('postWho'), 'aria-label': t('postWho'), 'aria-expanded': whoOpen(ev.id) ? 'true' : 'false',
            onClick: (e) => { e.stopPropagation(); toggleWho(ev.id); },
          }, h('span', { class: 'note-who-chev' + (whoOpen(ev.id) ? ' open' : ''), html: I_CHEV }))
        : null);
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
    let n = rm ? [...rm.values()].reduce((k, who) => k + who.size, 0) : 0;
    n += (boosts.get(id) || new Set()).size;
    n += (zapWho.get(id) || new Map()).size;
    return n;
  }
  function whoPanel(ev) {
    const rm = reacts.get(ev.id) || new Map();
    const bs = boosts.get(ev.id) || new Set();
    const zs = [...(zapWho.get(ev.id) || new Map()).values()].sort((a, b) => b.sats - a.sats || b.ts - a.ts);
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
    for (const [emoji, set] of [...rm.entries()].sort((a, b) => b[1].size - a[1].size)) {
      lines.push(line(h('span', { class: 'note-act-emoji' }, emoji), people([...set])));
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
    const canZap = !isMe(pk) && !!(hook('arkReady') || hook('canLnZap'));
    // an optimistic post mid-publish: visible but not yet a real event —
    // dimmed, and no thread/reply/zap until its signed self takes over
    const pending = !!ev.pending;
    const openable = open && !pending;
    if (!pending) watchZaps([ev.id]);
    return h('div', {
      class: 'row',
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
              (isReply ? '↩ ' + t('profReplyTag') + ' · ' : '') + timeLabel(ev.created_at * 1000)),
            zapChip(ev.id, { onClick: canZap ? () => { zapNote(pk, ev); recheckZap(ev.id); } : null })),
          pending ? null : h('button', {
            // the overflow stays up here; reply, boost, quote, react and zap
            // are a row of their own under the post
            class: 'btn-sm', title: t('postMore'), 'aria-label': t('postMore'),
            style: 'flex-shrink:0',
            onClick: (e) => { e.stopPropagation(); ui.noteSheet = ev; render(); },
          }, '\u22ef')),
        h('div', { class: 'note-text', style: 'white-space:pre-wrap;overflow-wrap:anywhere' }, ...noteBody(ev.content)),
        pending ? null : noteActions(pk, ev, { canZap }),
        !pending && whoOpen(ev.id) ? whoPanel(ev) : null));
  }

  // ---- thread view: a note in its conversation ----------------------------
  const threadCache = new Map(); // root id -> { status, root, replies }
  const noteSep = () => h('div', { style: 'height:1px;background:var(--border,rgba(128,128,128,.18));margin:0 -14px' });
  function rootIdOf(ev) {
    const es = ev.tags.filter((x) => x[0] === 'e');
    const marked = es.find((x) => x[3] === 'root');
    return (marked || es[0] || [])[1] || ev.id;
  }
  function threadFor(seed) {
    const rootId = rootIdOf(seed);
    let c = threadCache.get(rootId);
    if (c) return c;
    c = { status: 'loading', rootId, root: seed.id === rootId ? seed : null, replies: [] };
    threadCache.set(rootId, c);
    (async () => {
      // the conversation's home relays are the root author's (NIP-10 outbox);
      // the seed's author is the best guess until the root is known
      const relays = await notesRelays((c.root || seed).pubkey);
      const [roots, replies] = await Promise.all([
        c.root ? Promise.resolve([]) : queryOn(relays, { kinds: [1], ids: [rootId] }, 4000),
        queryOn(relays, { kinds: [1], '#e': [rootId], limit: 80 }, 4500),
      ]);
      if (!c.root) c.root = (roots || [])[0] || null;
      const seen = new Set([rootId]);
      c.replies = (replies || [])
        .filter((e) => !seen.has(e.id) && seen.add(e.id))
        .sort((a, b) => a.created_at - b.created_at);
      c.status = 'ready';
      if (ui.noteThread && ui.noteThread.rootId === rootId) {
        render();
        // The inline reply box may have MOVED on this render (it slots under
        // the focused note once that note exists) — a focus taken before the
        // load finished died with the old position. Re-take it if the reply
        // button asked for it.
        if (ui.noteThread.refocus) {
          ui.noteThread.refocus = false;
          setTimeout(() => document.querySelector('.thread-reply-input')?.focus(), 30);
        }
      }
    })().catch(() => {
      c.status = 'ready';
      if (ui.noteThread && ui.noteThread.rootId === rootId) render();
    });
    return c;
  }
  function openNoteThread(ev) {
    ui.noteThread = { rootId: rootIdOf(ev), focusId: ev.id, seed: ev };
    ui.profOverThread = false; // a freshly opened thread goes on top
    render();
  }
  // A nostr:nevent / nostr:note reference: the thread loader needs the real
  // event (its tags name the root, its author names the home relays), so
  // fetch it by id — the reference's relay hints first — then open.
  async function openNoteRef(ref) {
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
      h('div', { class: 'row', style: 'gap:8px;align-items:center' },
      h('input', {
        type: 'text', class: 'grow thread-reply-input', placeholder: t('threadReplyHint'),
        value: s.draft || '',
        // a render per keystroke only while the preview is open; the morph
        // leaves a focused field alone, so this can't fight the typing
        onInput: (e) => { s.draft = e.target.value; if (s.preview) render(); },
        onKeydown: (e) => { if (e.key === 'Enter') e.target.closest('.col').querySelector('.thread-reply-send')?.click(); },
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
    for (const ev of c.replies) { kids.push(noteSep(), row(ev)); place(ev); }
    if (c.status === 'loading') kids.push(h('div', { class: 'row', style: 'justify-content:center;padding:12px' }, h('span', { class: 'spinner sm' })));
    else if (!c.replies.length) kids.push(h('div', { class: 'small faint', style: 'text-align:center;padding:10px 0' }, t('threadNoReplies')));
    if (!boxPlaced) kids.push(replyBox());
    return h('div', { class: 'col', style: 'gap:16px' },
      // full header: search/chat/settings stay reachable mid-thread (only
      // the public no-wallet surface drops the action row)
      ctx.brandHeader(!ui.pubProf && wallet.loaded),
      h('div', { class: 'card col', style: 'gap:0;padding:2px 14px' }, ...kids),
      h('button', { class: 'btn-ghost btn-block', onClick: () => { ui.noteThread = null; render(); } }, t('back')));
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
                  ui.profilePk = null;
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
                  ui.tab = 'send';
                  render();
                  hook('matchSendText', npubStr);
                } }, t('profPay')),
                // Follow: their posts join your feed, and the service worker
                // learns to treat their DMs as a friend's rather than a
                // stranger's.
                h('button', {
                  class: (isFollowing(pk) ? 'btn-ghost ' : '') + 'grow', disabled: followsPub,
                  onClick: () => toggleFollow(pk),
                }, isFollowing(pk) ? t('feedFollowing') : t('feedFollow')))),
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
      mine ? switchPop() : null);
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
  function feedView() {
    const c = feedNow();
    const authors = feedAuthors();
    const visible = c.notes.filter((ev) => !isMuted(ev.pubkey));
    // Every child keyed by its post, hairlines included, so the morph
    // reconciles the list by post: a new one at the top is inserted as its
    // own node (and can open itself up), the rest keep theirs.
    const rows = visible.slice(0, c.shown || FEED_PAGE).flatMap((ev, i) => [
      i ? h('div', { 'data-key': 'hr:' + ev.id, style: 'height:1px;background:var(--border,rgba(128,128,128,.18));margin:0 -14px' }) : null,
      enterRow(keyed(noteRow(ev.pubkey, ev, displayName(ev.pubkey)), ev.id), ev.id),
    ]);
    // Posts that arrived while you were reading, waiting to be let in. A
    // floating pill rather than an insertion: it says how many, and the tap
    // that shows them also takes you up to them.
    const waiting = (c.pending || []).length;
    const pill = waiting
      ? h('button', {
          class: 'feed-new-pill',
          onClick: () => flushPending(true),
        }, '↑ ' + (waiting === 1 ? t('feedOneNew') : t('feedNNew', { n: waiting })))
      : null;
    // the chat shell draws the brand header; this is just the page under it
    return h('div', { class: 'card col chat-page', style: 'gap:10px' },
        pill,
        h('div', { class: 'row gap6', style: 'align-items:center' },
          backBtn(() => { ui.msgView = 'home'; stopFeedWatch(); render(); }),
          h('h3', { style: 'margin:0' }, t('feedTitle')),
          h('button', {
            class: 'btn-sm', style: 'margin-left:auto',
            onClick: () => { ui.profCompose = ui.profCompose == null ? (draftFor(POST_DRAFT) || '') : null; render(); },
          }, t('profNewPost'))),
        postComposer(),
        !authors.length
          ? h('div', { class: 'col', style: 'gap:8px' },
              h('div', { class: 'small muted' }, t('feedNoFollows')),
              h('button', { class: 'btn-sm', onClick: () => { stopFeedWatch(); hook('openUserSearch'); render(); } }, t('feedFindPeople')))
          : c.status === 'loading' && !visible.length
            ? h('div', { class: 'row gap6', style: 'justify-content:center;padding:12px 0' }, h('span', { class: 'spinner sm' }))
            : !visible.length
              ? h('div', { class: 'small faint', style: 'text-align:center;padding:12px 0' }, t('feedEmpty'))
              : h('div', { class: 'card col notes-feed', style: 'gap:0' }, ...rows),
        c.loadingMore
          ? h('div', { class: 'row gap6', style: 'justify-content:center;padding:4px 0' }, h('span', { class: 'spinner sm' }))
          : null,
        noteSheet(),
        reactPicker());
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
  const onViewportResize = () => { if (ui.chatOpen) stickToBottom(); };

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
  const composer = (placeholder, onSend, onType, draftKey, onAttach = null) =>
    h('div', { class: 'col', style: 'gap:6px' },
      signerNotice(),
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
        onInput: (e) => { setDraft(draftKey, e.target.value); growComposer(e.target); if (onType && e.target.value) onType(); },
        onKeydown: (e) => {
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

  // ---- home ---------------------------------------------------------------

  function homeView() {
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
      .filter((x) => x.last)
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
        onClick: () => { ui.msgView = 'feed'; feedNow(); watchFeed(); render(); },
      },
      h('div', { class: 'chat-avatar fallback' }, '\u2605'),
      h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
        h('span', { class: 'chat-name' }, t('feedTitle')),
        h('div', { class: 'muted small' },
          followsNow().set.size === 1 ? t('feedFollowing1')
            : followsNow().set.size ? t('feedFollowingN', { n: followsNow().set.size })
            : t('feedNoFollowsShort')))),
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
            h('div', { class: 'row between', style: 'align-items:center' },
              h('span', { class: 'chat-name' }, t('alertsTitle')),
              n ? h('i', { class: 'thread-dot' }) : null),
            h('div', { class: 'muted small' }, n ? t('alertsNew', { n }) : t('alertsSub'))));
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
        h('div', { class: 'row between' },
          h('span', { class: 'chat-name' }, name),
          unread ? h('i', { class: 'thread-dot' }) : null),
        h('div', { class: 'muted small' },
          memberCount ? t('msgMembers', { n: memberCount }) : t('msgEncrypted'))));
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
            class: 'chat-bubble clickable',
            // Telegram-style: a tap on the message opens its action sheet
            // (quick reactions, reply, copy, delete). Links, images and the
            // hover × keep their own clicks; a desktop text-selection drag
            // ends in a click too, and must not pop the sheet over the copy.
            onClick: (e) => {
              if (e.target.closest && e.target.closest('a, button, img')) return;
              const sel = window.getSelection && window.getSelection();
              if (sel && String(sel).length) return;
              ui.msgSheet = ui.msgSheet === m.rumor.id ? null : m.rumor.id;
              render();
            },
          },
            replyQuote(room, chId, m),
            ...noteBody(text),
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
                    }, emoji, n > 1 ? ' ' + n : '')))
              : null)(zapChip(m.rumor.id, { cls: 'chat-react', onClick: !mine && canZapPk(m.author) ? () => zapMessage(m.author, m.rumor.id) : null }))))
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
          }, t('msgAddPerson')))),
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
      builtin ? null : h('div', { class: 'row' },
        h('button', {
          class: 'btn-ghost btn-sm ' + (ui.msgLeaveArm ? 'btn-danger' : ''),
          onClick: () => {
            if (ui.msgLeaveArm) leaveCommunity(room);
            else { ui.msgLeaveArm = true; render(); }
          },
        }, ui.msgLeaveArm ? t('msgLeaveConfirm') : t('msgLeave'))));
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
        !ui.emojiPick && !m.mine && canZapPk(m.rumor.pubkey) ? item('⚡', t('msgZap'), () => { close(); zapMessage(m.rumor.pubkey, m.rumor.id); }) : null,
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
        h('span', { class: 'chat-quote-text' }, String(src.rumor.content || '').replace(/\s+/g, ' ').slice(0, 90)));
    };
    watchZaps(msgs.slice(-150).map((m) => m.rumor.id));
    const dmChips = (m) => {
      const reacts = dmReacts.get(m.rumor.id);
      const zc = zapChip(m.rumor.id, { cls: 'chat-react', onClick: !m.mine && canZapPk(m.rumor.pubkey) ? () => zapMessage(m.rumor.pubkey, m.rumor.id) : null });
      if ((!reacts || !reacts.size) && !zc) return null;
      const myReact = reacts && my.map((pk) => reacts.get(pk)).find(Boolean);
      const counts = new Map();
      if (reacts) for (const emoji of reacts.values()) counts.set(emoji, (counts.get(emoji) || 0) + 1);
      return h('div', { class: 'chat-reacts' },
        zc,
        [...counts.entries()].map(([emoji, n]) => h('span', {
          class: 'chat-react clickable' + (emoji === myReact ? ' on' : ''),
          onClick: (e) => { e.stopPropagation(); sendDmReaction(peer, m, emoji); },
        }, emoji, n > 1 ? ' ' + n : '')));
    };
    const dmReplyBar = () => {
      const m = ui.msgReplyTo && thread.get(ui.msgReplyTo);
      if (!m) { ui.msgReplyTo = null; return null; }
      return h('div', { class: 'reply-bar' },
        h('div', { class: 'col grow', style: 'gap:1px;min-width:0' },
          h('span', { class: 'small', style: 'font-weight:650' }, '↩ ', displayName(m.rumor.pubkey)),
          h('span', { class: 'small muted chat-quote-text' }, String(m.rumor.content || '').replace(/\s+/g, ' ').slice(0, 90))),
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
                  class: 'chat-bubble clickable' + (m.mine ? ' me' : ''),
                  // same tap-for-actions as community bubbles
                  onClick: (e) => {
                    if (e.target.closest && e.target.closest('a, button, img')) return;
                    const sel = window.getSelection && window.getSelection();
                    if (sel && String(sel).length) return;
                    ui.msgSheet = ui.msgSheet === m.rumor.id ? null : m.rumor.id;
                    render();
                  },
                }, dmQuote(m), ...(m.rumor.kind === 15 ? [] : noteBody(m.rumor.content)), ...attachmentNodes(m.rumor), dmChips(m)),
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
  function notifNow() {
    if (!notif) {
      const stored = st().notifs || [];
      notif = { status: stored.length ? 'ready' : 'loading', items: stored };
      refreshNotifs();
    }
    return notif;
  }
  // What an event says happened, or null if it isn't about you after all.
  function notifItem(ev) {
    const my = myPubkeys();
    if (!ev || !ev.id) return null;
    const lastE = (ev.tags || []).filter((x) => x[0] === 'e' && x[1]).map((x) => x[1]).at(-1) || null;
    if (ZAP_KINDS.includes(ev.kind)) {
      const actor = zapperOf(ev), sats = receiptSats(ev);
      if (!actor || my.includes(actor) || !sats) return null;
      return { id: ev.id, what: 'zap', actor, target: lastE, sats, text: zapText(ev), ts: ev.created_at };
    }
    if (my.includes(ev.pubkey)) return null;
    if (ev.kind === 7) {
      if (!lastE) return null;
      const emoji = !ev.content || ev.content === '+' ? '\u2764\ufe0f' : ev.content.slice(0, 12);
      return { id: ev.id, what: 'react', actor: ev.pubkey, target: lastE, emoji, ts: ev.created_at };
    }
    if (ev.kind === 6) return lastE ? { id: ev.id, what: 'boost', actor: ev.pubkey, target: lastE, ts: ev.created_at } : null;
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
    const add = (evs || []).map(notifItem).filter((x) => x && !known.has(x.id) && known.add(x.id));
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
    const s2 = st(); s2.notifs = c.items; save(s2);
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
  const notifUnread = () => notifNow().items.filter((x) => x.ts > notifSeen()).length;
  function markNotifsSeen() {
    const newest = Math.max(0, ...notifNow().items.map((x) => x.ts));
    if (newest > notifSeen()) { const s2 = st(); s2.notifSeen = newest; save(s2); }
  }
  // The post an item is about, if we have it — ours from the feed or a
  // thread, or fetched once by id (quotedNote remembers and repaints).
  function notifTarget(id) {
    if (!id) return null;
    for (const pk of myPubkeys()) { const hit = notesInHand(pk).find((e) => e.id === id); if (hit) return hit; }
    if (notifNotes.has(id)) return notifNotes.get(id);
    const q = quotedNote({ id, relays: [] });
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
    const target = aboutNote && !msg ? notifTarget(x.target) : null;
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
      else if (target) openNoteThread(target);
      else if (x.target && !targetGone(x.target)) openNoteRef({ id: x.target }).catch(() => {});
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
    const items = c.items;
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
      noteSheet(),
      reactPicker());
  }

  // ---- feature ------------------------------------------------------------

  function messagesTab() {
    if (ui.msgView === 'feed') return feedView();
    if (ui.msgView === 'notifs') return notifView();
    if (ui.msgView === 'room') return roomView();
    if (ui.msgView === 'dm') return dmView();
    return homeView();
  }

  return {
    id: 'messages',
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
    init() {
      // your own profile is the likeliest first tap — warm it early
      setTimeout(() => {
        try { const me = ctx.shownPubkey && ctx.shownPubkey(); if (me) prefetchProfilePage(me); } catch {}
      }, 2500);
      // A tapped "new reply" notification lands here: as ?open=notifs when
      // it had to open a window, or as a worker message when one was open.
      if (OPEN_VIEW === 'notifs') setTimeout(openNotifs, 0);
      // a connection that came back is a connection whose subs may have died
      window.addEventListener('online', () => setTimeout(resubscribeStreams, 1500));
      try {
        navigator.serviceWorker?.addEventListener('message', (ev) => {
          if (ev.data && ev.data.type === 'open' && ev.data.view === 'notifs') openNotifs();
        });
      } catch {}
      if (urlInvite && !pendingLink) {
        loadLinkInvite(urlInvite);
        setTimeout(() => { ui.chatOpen = true; ui.msgView = 'home'; render(); }, 0);
      }
      ui.pubProf = null; // a wallet is open now — its chrome owns the profile
      window.addEventListener('resize', onViewportResize);
      window.visualViewport?.addEventListener('resize', onViewportResize);
      allUnsubs.push(() => {
        window.removeEventListener('resize', onViewportResize);
        window.visualViewport?.removeEventListener('resize', onViewportResize);
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
      syncFollows().catch(() => {}); // the Follow button should be right on first paint
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
      follows = null; followsAt = 0; feed = null; feedAt = 0; relayLists = null;
      mutes = null; mutesAt = 0;
      reacts.clear(); boosts.clear(); seenNoteEv.clear(); myReactEv.clear(); quoted.clear();
      // what happened to THEIR posts stays with them — the next identity
      // starts its list empty and asks the relays under its own key
      stopNotifWatch(); notif = null; notifAt = 0; notifNotes.clear();
      zapWho.clear(); whoOpenIds.clear();
      clearTimeout(zapSaveT); zapSaveT = null; zapSeed = null;
      zapTotals.clear(); zapAsked.clear(); zapPending.clear(); // 'mine' is per identity — refetch under the next
    },
  };
}
