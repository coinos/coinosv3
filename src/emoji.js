// Custom emoji (NIP-30) as Vector speaks it in Concord rooms and DMs: a
// message says `:pika_wave:` in its content and carries an
// ["emoji", "pika_wave", "https://…/x.gif"] tag for every shortcode it uses,
// so anyone can render it without holding the pack. Packs themselves are
// NIP-51 emoji sets (kind 30030: title/image tags + one emoji tag per entry)
// and a user's subscriptions live in their kind 10030 list as `a` tags —
// the same list Vector reads, so a pack added here shows up there and back.
//
// Pure helpers only: no state, no DOM. messages.js owns the packs the user
// holds and the shortcodes learned from what they've seen; public-chat.js
// uses the same tokenizer so the read-only page renders the pictures too.

import { decode as nip19decode, naddrEncode } from 'nostr-tools/nip19';

export const EMOJI_SET_KIND = 30030;
export const EMOJI_LIST_KIND = 10030;

// Vector's shortcode alphabet, plus `~N` — its suffix for two packs that
// disagree on a name (`:love~2:`).
const CODE = 'A-Za-z0-9_~-';
export const SHORTCODE_RE = new RegExp('^[' + CODE + ']+$');
// A splitting regex: capturing, so `text.split()` keeps the tokens.
export const EMOJI_TOKEN_RE = new RegExp('(:[' + CODE + ']+:)', 'g');
// What the composer autocompletes on: a colon and two+ characters, with no
// closing colon yet, right at the caret.
export const EMOJI_PARTIAL_RE = new RegExp('(?:^|[^:' + CODE + ']):([' + CODE + ']{2,})$');

// Vector's share link for a pack; the naddr inside is the pack coordinate.
export const PACK_LINK_RE = /^https?:\/\/[^\s/]+\/emojis\/pack\/(naddr1[a-z0-9]+)\/?$/i;

const okUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/i.test(u.trim());

// ["emoji", code, url] tags of an event → Map(code → url). Bad codes and
// non-http urls are dropped; the first of a repeated code wins.
export function emojiTagMap(tags) {
  const out = new Map();
  for (const t of tags || []) {
    if (!Array.isArray(t) || t[0] !== 'emoji' || t.length < 3) continue;
    const code = String(t[1] || '');
    const url = String(t[2] || '').trim();
    if (!SHORTCODE_RE.test(code) || !okUrl(url) || out.has(code)) continue;
    out.set(code, url);
  }
  return out;
}

// Split message text into strings and { code, url } emoji parts. `lookup`
// answers a shortcode with its image url, or nothing to leave it as text.
export function splitEmoji(text, lookup) {
  const out = [];
  const s = String(text || '');
  if (!s.includes(':')) return s ? [s] : [];
  for (const part of s.split(EMOJI_TOKEN_RE)) {
    if (!part) continue;
    if (part.length > 2 && part[0] === ':' && part[part.length - 1] === ':') {
      const code = part.slice(1, -1);
      const url = lookup(code);
      if (url) { out.push({ code, url }); continue; }
    }
    // keep neighbouring text as one node
    if (out.length && typeof out[out.length - 1] === 'string') out[out.length - 1] += part;
    else out.push(part);
  }
  return out;
}

// How many custom emoji a message is made of when it's NOTHING but them
// (plus whitespace) — those render big, like a lone 🎉 does elsewhere.
// 0 when there's any other text.
export function emojiOnlyCount(parts) {
  let n = 0;
  for (const p of parts) {
    if (typeof p === 'string') { if (p.trim()) return 0; }
    else n++;
  }
  return n;
}

// Every shortcode in outbound text that `lookup` resolves → the NIP-30 tags
// to attach, deduped, in first-use order.
export function outboundEmojiTags(text, lookup) {
  const tags = [];
  const seen = new Set();
  for (const p of splitEmoji(text, lookup)) {
    if (typeof p === 'string' || seen.has(p.code)) continue;
    seen.add(p.code);
    tags.push(['emoji', p.code, p.url]);
  }
  return tags;
}

// `:code:` reaction content → the code, or null for a plain emoji.
export function shortcodeOf(content) {
  const s = String(content || '');
  return s.length > 2 && s[0] === ':' && s[s.length - 1] === ':' && SHORTCODE_RE.test(s.slice(1, -1)) ? s.slice(1, -1) : null;
}

export const packAddr = (pubkey, identifier) => `${EMOJI_SET_KIND}:${pubkey}:${identifier}`;

// A pack coordinate → its naddr (no relay hints).
export function packNaddr(addr) {
  const [kind, pubkey, ...rest] = String(addr).split(':');
  try { return naddrEncode({ kind: Number(kind), pubkey, identifier: rest.join(':') }); } catch { return null; }
}

// Anything a person might paste for a pack — an naddr, `nostr:naddr…`, or
// Vector's share link — → { kind, pubkey, identifier, relays } or null.
// Only emoji sets pass: a random naddr must not become a "pack".
export function parsePackRef(input) {
  let s = String(input || '').trim();
  const link = PACK_LINK_RE.exec(s);
  if (link) s = link[1];
  s = s.replace(/^nostr:/i, '');
  if (!/^naddr1[a-z0-9]+$/i.test(s)) return null;
  try {
    const d = nip19decode(s.toLowerCase());
    if (d.type !== 'naddr' || d.data.kind !== EMOJI_SET_KIND) return null;
    return { kind: d.data.kind, pubkey: d.data.pubkey, identifier: d.data.identifier || '', relays: d.data.relays || [] };
  } catch { return null; }
}

// `30030:<pubkey>:<d>` as found in a kind-10030 `a` tag → the same shape.
export function parsePackAddr(addr) {
  const m = /^(\d+):([0-9a-f]{64}):(.*)$/.exec(String(addr || ''));
  if (!m || Number(m[1]) !== EMOJI_SET_KIND) return null;
  return { kind: EMOJI_SET_KIND, pubkey: m[2], identifier: m[3], relays: [] };
}

// A kind-30030 event → { addr, pubkey, identifier, title, image, emojis }
// or null when it isn't one worth keeping (no d tag, no usable emoji).
// Ditto/Nostria publish `name`/`picture` where NIP-51 says title/image;
// both are read, as Vector does.
export function parseEmojiSet(ev) {
  if (!ev || ev.kind !== EMOJI_SET_KIND) return null;
  const first = (...keys) => {
    for (const k of keys) { const t = (ev.tags || []).find((x) => x[0] === k && x[1]); if (t) return String(t[1]); }
    return '';
  };
  const dTag = (ev.tags || []).find((x) => x[0] === 'd');
  if (!dTag) return null;
  const identifier = String(dTag[1] || '');
  const emojis = [...emojiTagMap(ev.tags).entries()];
  if (!emojis.length) return null;
  return {
    addr: packAddr(ev.pubkey, identifier),
    pubkey: ev.pubkey, identifier,
    title: first('title', 'name') || identifier,
    image: first('image', 'picture') || emojis[0][1],
    emojis, at: ev.created_at || 0,
  };
}
