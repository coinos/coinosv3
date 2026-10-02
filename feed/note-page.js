// /nevent1… and /note1… rendered with the thread already in the page.
//
// A shared post opened in a fresh browser used to show the front door, then
// the post under a punk and an npub, and the author's real name seconds
// later — every piece waited on relays the browser had only just dialled.
// This server dials them once, keeps the answers, and hands the browser the
// app's own index.html with the thread inlined as JSON (the client puts it
// in its thread cache and opens from there) plus Open Graph tags, so a link
// pasted into a chat previews as the post rather than as the wallet.
//
// It never makes the page slower than the plain one by much: a thread that
// isn't ready inside BUDGET_MS goes out without it (the client fetches as
// before) while the fetch carries on into the cache for the next visitor.
import { decode } from 'nostr-tools/nip19';

export const NOTE_PATH = /^\/((?:note|nevent)1[a-z0-9]+)\/?$/i;
export const NOTE_RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.coinos.io',
  'wss://relay.ditto.pub', 'wss://nostr.mom'];
// where kind 0s live when the conversation relays lack them
const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://user.kindpag.es'];
const BUDGET_MS = 500;
const FRESH_MS = 60_000;          // a thread younger than this is served as is
const KEEP_MS = 6 * 3600_000;     // older, it's still served while a refresh runs
const MAX_THREADS = 500;
const MAX_REPLIES = 60;
const MAX_PROFILES = 40;
const MAX_EVENT = 32_000;

const okEvent = (e) => e && typeof e.id === 'string' && JSON.stringify(e).length <= MAX_EVENT;
function rootIdOf(ev) {
  if (ev.kind === 1111) return (ev.tags.find((t) => (t[0] === 'E' || t[0] === 'e') && t[1]) || [])[1] || ev.id;
  const es = ev.tags.filter((t) => t[0] === 'e' && t[1]);
  return ((es.find((t) => t[3] === 'root') || es[0]) || [])[1] || ev.id;
}

export function parseNoteRef(path) {
  const m = NOTE_PATH.exec(path);
  if (!m) return null;
  try {
    const d = decode(m[1].toLowerCase());
    if (d.type === 'note') return { id: d.data, relays: [], author: null };
    if (d.type === 'nevent') {
      const relays = (d.data.relays || []).filter((u) => /^wss:\/\/[^\s]{1,200}$/.test(u)).slice(0, 3);
      return { id: d.data.id, relays, author: d.data.author || null };
    }
  } catch {}
  return null;
}

// Everything the thread page shows first: the post, the root it hangs off,
// the replies to that root, and the faces of whoever wrote them.
export async function buildThread(ref, query) {
  const relays = [...new Set([...ref.relays, ...NOTE_RELAYS])];
  const [hit, direct] = await Promise.all([
    query(relays, { ids: [ref.id] }, 2500),
    query(relays, { kinds: [1, 1111], '#e': [ref.id], limit: MAX_REPLIES }, 2500),
  ]);
  const focus = hit.find((e) => e.id === ref.id);
  if (!focus || !okEvent(focus)) return null;
  const rootId = rootIdOf(focus);
  let root = focus, replies = direct;
  if (rootId !== focus.id) {
    const [roots, more] = await Promise.all([
      query(relays, { ids: [rootId] }, 2500),
      query(relays, { kinds: [1, 1111], '#e': [rootId], limit: MAX_REPLIES }, 2500),
    ]);
    root = roots.find((e) => e.id === rootId) || null;
    replies = [...more, ...direct, focus];
  }
  const seen = new Set(root ? [root.id] : []);
  replies = replies.filter((e) => okEvent(e) && !seen.has(e.id) && seen.add(e.id))
    .sort((a, b) => a.created_at - b.created_at).slice(0, MAX_REPLIES);
  // no root found: left to the client, which climbs reply chains to find one
  if (!root) return null;
  const people = [...new Set([root.pubkey, focus.pubkey, ...replies.map((e) => e.pubkey)])].slice(0, MAX_PROFILES);
  return { v: 1, root, replies, profiles: await profilesFor(people, query) };
}

async function profilesFor(pks, query) {
  const evs = await query([...NOTE_RELAYS, ...PROFILE_RELAYS], { kinds: [0], authors: pks }, 2000);
  const newest = new Map();
  for (const e of evs) {
    if (e.kind !== 0 || !pks.includes(e.pubkey) || !okEvent(e)) continue;
    if (!newest.has(e.pubkey) || newest.get(e.pubkey).created_at < e.created_at) newest.set(e.pubkey, e);
  }
  return [...newest.values()];
}

// Single flight per thread, stale-while-refresh, oldest evicted first.
export function createThreadCache({ build, now = Date.now }) {
  const entries = new Map(); // id -> { data, at, pending }
  function refresh(ref) {
    let e = entries.get(ref.id);
    if (!e) {
      e = { data: null, at: 0, pending: null };
      entries.set(ref.id, e);
      while (entries.size > MAX_THREADS) entries.delete(entries.keys().next().value);
    }
    if (!e.pending) {
      e.pending = Promise.resolve().then(() => build(ref)).then((data) => {
        if (data) { e.data = data; e.at = now(); }
        return e.data;
      }).catch(() => e.data).finally(() => { e.pending = null; });
    }
    return e.pending;
  }
  async function get(ref, budget = BUDGET_MS) {
    const e = entries.get(ref.id);
    if (e && e.data && now() - e.at < KEEP_MS) {
      if (now() - e.at >= FRESH_MS) void refresh(ref);
      return e.data;
    }
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r(null), budget); });
    try { return await Promise.race([refresh(ref), late]); } finally { clearTimeout(timer); }
  }
  return { get, refresh };
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON inside a script tag: nothing in it may close the tag or open a comment
const scriptJson = (v) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function nameOf(data, pk) {
  const p = (data.profiles || []).find((e) => e.pubkey === pk);
  try { const m = JSON.parse(p.content); return { name: m.display_name || m.name || null, picture: m.picture || null }; } catch { return {}; }
}

// The app's index.html with the thread and its preview tags in the head.
export function renderNotePage(html, data, ref, origin) {
  const focus = [data.root, ...data.replies].find((e) => e.id === ref.id) || data.root;
  const who = nameOf(data, focus.pubkey);
  const text = String(focus.content || '').replace(/nostr:[a-z0-9]+/gi, '').replace(/\s+/g, ' ').trim();
  const image = (String(focus.content || '').match(/https?:\/\/\S+\.(?:jpe?g|png|gif|webp)(?:\?\S*)?/i) || [])[0] || who.picture;
  const title = (who.name || 'A post') + ' on Coinos';
  const desc = text.length > 200 ? text.slice(0, 199) + '…' : text;
  const head = [
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="Coinos">`,
    `<meta property="og:title" content="${esc(title)}">`,
    desc ? `<meta property="og:description" content="${esc(desc)}">` : '',
    desc ? `<meta name="description" content="${esc(desc)}">` : '',
    origin ? `<meta property="og:url" content="${esc(origin + '/' + (ref.path || ''))}">` : '',
    image ? `<meta property="og:image" content="${esc(image)}">` : '',
    `<meta name="twitter:card" content="${image && image !== who.picture ? 'summary_large_image' : 'summary'}">`,
    // the author's face starts downloading with the page, not after the app boots
    who.picture && /^https:\/\//.test(who.picture) ? `<link rel="preload" as="image" href="${esc(who.picture)}">` : '',
    `<script type="application/json" id="boot-thread">${scriptJson(data)}</script>`,
  ].filter(Boolean).join('\n');
  let out = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(title)}</title>`);
  out = out.includes('</head>') ? out.replace('</head>', head + '\n</head>') : head + out;
  return out;
}

// The page itself: the app's index.html, refetched every few seconds so a
// deploy is picked up without a restart.
export function createIndexSource(url, { ttl = 5000, now = Date.now } = {}) {
  let html = null, at = 0, pending = null;
  return async () => {
    if (html && now() - at < ttl) return html;
    pending ||= fetch(url, { signal: AbortSignal.timeout(1500) })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error('index ' + r.status))))
      .then((t) => { html = t; at = now(); return t; })
      .finally(() => { pending = null; });
    try { return await pending; } catch (e) { if (html) return html; throw e; }
  };
}

export async function notePageResponse(req, { index, threads }) {
  const u = new URL(req.url);
  const ref = parseNoteRef(u.pathname);
  const html = await index();
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate' };
  if (!ref) return new Response(html, { headers });
  ref.path = u.pathname.slice(1);
  const data = await threads.get(ref).catch(() => null);
  const proto = req.headers.get('x-forwarded-proto') || 'https';
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host');
  return new Response(data ? renderNotePage(html, data, ref, host ? proto + '://' + host : '') : html, { headers });
}
