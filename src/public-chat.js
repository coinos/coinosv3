// Public read-only view of the default coinos community — served at /chat.
//
// No wallet, no login, no server-side decoder: the community's join material
// (community.js) ships in this bundle — the root is deliberately public-ish,
// every coinos user is meant to be a member — so this page derives the
// stream keys and decrypts wraps right in the visitor's browser, exactly
// like the app's Chat tab does. Reading is open; POSTING still requires a
// signed seal from a real identity, which is what the sign-in button is for.
//
// Deliberately lean: plain DOM (append/rebuild, no morphing), messages +
// edits + deletes + reactions only (no presence, typing, or guestbook), and
// the moderation that matters publicly — the folded control state's ban list
// hides banned members' messages here just as it does in the app.

import { subscribeOn, queryOn, npubOf, openWrapsOffthread, PROFILE_RELAYS } from './nostr.js';
import { channelKey, controlKey, openWrap, foldControl, eventMs } from './concord.js';
import { COMMUNITY, EPOCH } from './community.js';
import { hexToBytes } from '@noble/hashes/utils';
import { timeAgo } from './format.js';
import { t } from './i18n.js';

// Same shape as the app's h() for the attributes this page uses.
function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on') && typeof v === 'function') e[k.toLowerCase()] = v;
    else e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false || c === true) continue;
    e.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return e;
}

// Message text, safely: content stays text nodes (relay content must never
// reach innerHTML); URLs become links, image URLs render inline. The app's
// richer noteBody also resolves nostr: mentions — here they stay dim stubs,
// since this page has no profile screens to open.
const LINK_SPLIT = /(https?:\/\/[^\s]+|nostr:(?:npub|nprofile|note|nevent|naddr)1[a-z0-9]+)/gi;
function linkedBody(text) {
  const out = [];
  for (const part of String(text || '').split(LINK_SPLIT)) {
    if (!part) continue;
    if (/^https?:\/\//i.test(part)) {
      if (/\.(png|jpe?g|gif|webp|avif)(\?[^\s]*)?$/i.test(part)) {
        out.push(h('img', { src: part, class: 'note-img', loading: 'lazy',
          onError: (e) => { e.target.style.display = 'none'; } }));
      } else {
        out.push(h('a', { href: part, target: '_blank', rel: 'noopener noreferrer' },
          part.length > 64 ? part.slice(0, 61) + '…' : part));
      }
    } else if (/^nostr:/i.test(part)) {
      out.push(h('span', { class: 'faint' }, part.slice(6, 18) + '…'));
    } else out.push(part);
  }
  return out;
}

export function mountPublicChat() {
  const root = document.getElementById('app');
  const rootBytes = hexToBytes(COMMUNITY.community_root);
  const cid = COMMUNITY.community_id;

  // ---- state ---------------------------------------------------------------
  const byChannel = new Map(); // channelId -> Map(rumorId -> { rumor, author })
  const edits = new Map(); // rumorId -> { rumor, author }
  const deletes = new Map(); // rumorId -> Set(author)
  const reactions = new Map(); // rumorId -> Map(author -> emoji)
  const controlEntries = [];
  let folded = null; // foldControl result: banned set + channel renames
  let foldT = 0; // fold-once-per-burst debounce, same as the app's rooms
  const profiles = new Map(); // pk -> { name, picture } | null while loading
  const seen = new Set();
  let activeChannel = (COMMUNITY.channels[0] || {}).id;

  // ---- decrypt (worker first, sliced main-thread fallback) -----------------
  function openBg(wrap, stream, cb) {
    const job = openWrapsOffthread([wrap], stream.convKey);
    if (!job) { cb(openWrap(wrap, stream)); return; }
    job.then((r) => cb(r ? r[0] : openWrap(wrap, stream)));
  }

  // ---- repaint (debounced full rebuild of the log) --------------------------
  let paintT = 0;
  const schedule = () => { clearTimeout(paintT); paintT = setTimeout(paint, 120); };

  // Profiles fetched in one batched kind-0 query per burst of new authors —
  // a REQ per author tripped relay concurrency limits with a full backlog.
  const pendingPks = new Set();
  let profT = 0;
  function profileOf(pk) {
    if (profiles.has(pk)) return profiles.get(pk);
    profiles.set(pk, null);
    pendingPks.add(pk);
    clearTimeout(profT);
    profT = setTimeout(async () => {
      const batch = [...pendingPks];
      pendingPks.clear();
      try {
        const evs = await queryOn([...new Set([...PROFILE_RELAYS, ...COMMUNITY.relays])], { kinds: [0], authors: batch }, 3500);
        for (const ev of evs.sort((a, b) => a.created_at - b.created_at)) { // newest overwrites
          try {
            const p = JSON.parse(ev.content);
            profiles.set(ev.pubkey, { name: p.display_name || p.name, picture: p.picture });
          } catch {}
        }
        for (const pk2 of batch) if (!profiles.get(pk2)) profiles.set(pk2, {});
      } catch {}
      schedule();
    }, 300);
    return null;
  }
  const nameOf = (pk) => {
    const p = profileOf(pk);
    return (p && p.name) || (npubOf(pk) || pk).slice(0, 12);
  };
  const avatar = (pk) => {
    const p = profileOf(pk);
    if (p && p.picture) return h('img', { class: 'chat-avatar', src: p.picture, alt: '' });
    return h('div', { class: 'chat-avatar fallback' }, nameOf(pk).slice(0, 2));
  };

  function onRumor(channelId, { rumor, author }) {
    const tag = (k) => rumor.tags?.find((x) => x[0] === k);
    // CORD-03 §3: the rumor must commit to the channel/epoch that decrypted it
    if (tag('channel')?.[1] !== channelId || tag('epoch')?.[1] !== String(EPOCH)) return;
    if (rumor.kind === 9) {
      const msgs = byChannel.get(channelId) || byChannel.set(channelId, new Map()).get(channelId);
      msgs.set(rumor.id, { rumor, author });
    } else if (rumor.kind === 5) {
      for (const e of rumor.tags.filter((x) => x[0] === 'e')) {
        (deletes.get(e[1]) || deletes.set(e[1], new Set()).get(e[1])).add(author);
      }
    } else if (rumor.kind === 3302) {
      const target2 = tag('e')?.[1];
      if (target2) {
        const cur = edits.get(target2);
        if (!cur || eventMs(rumor) > eventMs(cur.rumor)) edits.set(target2, { rumor, author });
      }
    } else if (rumor.kind === 7) {
      const target2 = tag('e')?.[1];
      if (target2) (reactions.get(target2) || reactions.set(target2, new Map()).get(target2)).set(author, rumor.content);
    } else {
      return;
    }
    schedule();
  }

  // ---- subscriptions ---------------------------------------------------------
  const control = controlKey(rootBytes, cid, COMMUNITY.root_epoch || EPOCH);
  subscribeOn(COMMUNITY.relays, { kinds: [1059], authors: [control.pk], limit: 500 }, (wrap) => {
    if (seen.has(wrap.id)) return;
    seen.add(wrap.id);
    openBg(wrap, control, (opened) => {
      if (!opened || opened.rumor.kind !== 3308) return;
      controlEntries.push(opened);
      clearTimeout(foldT);
      foldT = setTimeout(() => {
        folded = foldControl(controlEntries, { ownerHex: COMMUNITY.owner, cid });
        schedule();
      }, 250);
    });
  });
  const streams = new Map(); // channelId -> derived stream key
  for (const c of COMMUNITY.channels) {
    const stream = channelKey(rootBytes, c.id, EPOCH);
    streams.set(c.id, stream);
    subscribeOn(COMMUNITY.relays, { kinds: [1059], authors: [stream.pk], limit: 200 }, (wrap) => {
      if (seen.has(wrap.id)) return;
      seen.add(wrap.id);
      openBg(wrap, stream, (opened) => { if (opened) onRumor(c.id, opened); });
    });
  }

  // ---- view ------------------------------------------------------------------
  const channelList = () => {
    // control-plane renames/additions win over the baked-in genesis list
    if (folded && folded.channels && folded.channels.size) {
      return [...folded.channels.entries()].map(([id, c]) => ({ id, name: c.name }));
    }
    return COMMUNITY.channels;
  };

  const hasAccount = (() => {
    try {
      return !!(sessionStorage.getItem('btc-wallet-accounts') || (JSON.parse(localStorage.getItem('btc-wallet-watch') || '[]')).length);
    } catch { return false; }
  })();

  const log = h('div', { class: 'chat-log', style: 'flex:1 1 auto' });
  const tabs = h('div', { class: 'row gap6', style: 'flex-wrap:wrap' });

  function paint() {
    // channel tabs (only when there's more than one)
    tabs.replaceChildren();
    const chans = channelList();
    if (chans.length > 1) {
      for (const c of chans) {
        tabs.append(h('button', {
          class: 'btn-sm' + (c.id === activeChannel ? ' btn-primary' : ''),
          onClick: () => {
            if (!streams.has(c.id)) {
              const stream = channelKey(rootBytes, c.id, EPOCH);
              streams.set(c.id, stream);
              subscribeOn(COMMUNITY.relays, { kinds: [1059], authors: [stream.pk], limit: 200 }, (wrap) => {
                if (seen.has(wrap.id)) return;
                seen.add(wrap.id);
                openBg(wrap, stream, (opened) => { if (opened) onRumor(c.id, opened); });
              });
            }
            activeChannel = c.id;
            paint();
          },
        }, '#' + c.name));
      }
    }
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60 || !log.childElementCount;
    const banned = (folded && folded.banned) || new Set();
    const rows = [...(byChannel.get(activeChannel) || new Map()).values()]
      .filter(({ rumor, author }) => !banned.has(author)
        && !(deletes.get(rumor.id) && deletes.get(rumor.id).has(author)))
      .sort((a, b) => (eventMs(a.rumor) || 0) - (eventMs(b.rumor) || 0));
    log.replaceChildren();
    if (!rows.length) {
      log.append(h('div', { class: 'small muted center', style: 'padding:30px 0' },
        h('span', { class: 'spinner sm', style: 'margin-right:8px' }), t('publicChatLoading')));
    }
    let prev = null;
    for (const m of rows) {
      const ms = eventMs(m.rumor) || m.rumor.created_at * 1000;
      const grouped = prev && prev.author === m.author
        && ms - (eventMs(prev.rumor) || 0) < 5 * 60_000;
      prev = m;
      const edit = edits.get(m.rumor.id);
      const content = edit && edit.author === m.author ? edit.rumor.content : m.rumor.content;
      const reacts = reactions.get(m.rumor.id);
      log.append(h('div', { class: 'chat-row' + (grouped ? ' grouped' : '') },
        grouped ? h('div', { class: 'chat-avatar spacer' }) : avatar(m.author),
        h('div', { class: 'chat-body' },
          grouped ? null : h('div', { class: 'chat-meta' },
            h('span', { class: 'chat-name' + (m.author === COMMUNITY.owner ? ' owner' : '') }, nameOf(m.author)),
            m.author === COMMUNITY.owner ? h('span', { class: 'chat-badge' }, t('msgAdmin')) : null,
            h('span', { class: 'chat-time' }, timeAgo(ms / 1000))),
          h('div', { class: 'chat-bubble' }, ...linkedBody(content),
            edit && edit.author === m.author ? h('span', { class: 'chat-edited' }, ' ' + t('msgEdited')) : null),
          reacts && reacts.size ? h('div', { class: 'chat-reacts' },
            ...[...[...reacts.values()].reduce((m2, e) => m2.set(e, (m2.get(e) || 0) + 1), new Map()).entries()]
              .map(([emoji, n]) => h('span', { class: 'chat-react' }, emoji + (n > 1 ? ' ' + n : '')))) : null)));
    }
    if (stick) log.scrollTop = log.scrollHeight;
  }

  // ---- shell -------------------------------------------------------------------
  // #app is already the centered 560px column; .chat-card manages its own
  // viewport height and .chat-log scrolls — the same shell the app's Chat
  // tab uses, so this page inherits its look for free.
  document.title = 'coinos chat';
  root.replaceChildren(
    h('div', { class: 'chat-card card' },
      h('div', { class: 'chat-head' },
        h('div', { class: 'row between', style: 'align-items:center;gap:10px' },
          h('div', { class: 'col', style: 'gap:2px;min-width:0' },
            h('div', { class: 'chat-title' }, t('publicChatTitle', { name: COMMUNITY.name })),
            h('div', { class: 'small muted' }, t('publicChatDesc'))),
          h('button', { class: 'btn-primary btn-sm', style: 'flex-shrink:0', onClick: () => { location.href = '/'; } },
            hasAccount ? t('publicChatOpenApp') : t('publicChatSignIn'))),
        tabs),
      log));
  paint();
}
