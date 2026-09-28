// Link previews for the wallet's feed: the Open Graph card a page describes
// for itself (title, one line of description, a picture, the site's name).
// A browser can't read another site's HTML, so the registrar fetches it
// once on the reader's behalf and hands back only what a card needs.
//
// The server sees more than the internet does (containers, the LAN), so a
// URL is fetched only after its host resolves to public addresses — and
// again after every redirect. Bodies are capped, and only HTML is read.
import { promises as dns } from 'node:dns';

const MAX_BODY = 512 * 1024;
const TIMEOUT_MS = 7000;
const MAX_HOPS = 4;
const UA = 'Mozilla/5.0 (compatible; coinos-link-preview/1.0; +https://coinos.io)';

const isPrivate4 = (ip) => {
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || p[0] === 0
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168)
    || (p[0] === 169 && p[1] === 254)
    || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    || p[0] >= 224;
};
const isPrivate6 = (ip) => {
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('::ffff:')) return isPrivate4(s.slice(7));
  return /^(fc|fd|fe[89ab])/.test(s);
};
export const isPrivateIp = (ip) => (ip.includes(':') ? isPrivate6(ip) : isPrivate4(ip));

// A URL the server may fetch: http(s), a default port, a public host.
async function publicUrl(str) {
  let u;
  try { u = new URL(str); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  if (u.username || u.password) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || /\.(local|internal|localhost)$/i.test(host)) return null;
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { return null; }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) return null;
  return u;
}

const ENTITIES = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', middot: '·', bull: '•', euro: '€', pound: '£' };
const decodeEntities = (s) => String(s || '')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; } })
  .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ''; } })
  .replace(/&([a-z]+);/gi, (m, e) => ENTITIES[e.toLowerCase()] ?? m);
const tidy = (s, max) => decodeEntities(s).replace(/\s+/g, ' ').trim().slice(0, max);

// Every <meta> in the head, whichever way its attributes are ordered.
function metaTags(html) {
  const out = [];
  const re = /<meta\s+([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = {};
    const ar = /([a-zA-Z:_-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let a;
    while ((a = ar.exec(m[1]))) attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? '';
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    if (key && attrs.content != null) out.push([key, attrs.content]);
  }
  return out;
}

// What a card shows, from a page's HTML. Exported for the tests.
export function parsePreview(html, baseUrl) {
  const head = html.slice(0, MAX_BODY);
  const meta = new Map();
  for (const [k, v] of metaTags(head)) if (!meta.has(k) && v.trim()) meta.set(k, v);
  const pick = (...keys) => { for (const k of keys) if (meta.get(k)) return meta.get(k); return ''; };
  const titleTag = (head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const title = tidy(pick('og:title', 'twitter:title') || titleTag, 200);
  const description = tidy(pick('og:description', 'twitter:description', 'description'), 300);
  let image = pick('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src');
  if (image) {
    try { image = new URL(decodeEntities(image).trim(), baseUrl).href; } catch { image = ''; }
    if (!/^https?:/.test(image)) image = '';
  }
  let site = tidy(pick('og:site_name'), 80);
  if (!site) { try { site = new URL(baseUrl).hostname.replace(/^www\./, ''); } catch {} }
  if (!title && !image) return null;
  return { url: baseUrl, title, description, image, site };
}

// Read at most MAX_BODY bytes of a response.
async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = []; let got = 0;
  while (got < MAX_BODY) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
  }
  try { await reader.cancel(); } catch {}
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

// Fetch a page and describe it, or null when there is nothing to show
// (not HTML, unreachable, a private host, no title or picture).
export async function fetchPreview(str) {
  let u = await publicUrl(str);
  for (let hop = 0; u && hop < MAX_HOPS; hop++) {
    let res;
    try {
      res = await fetch(u.href, {
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', 'accept-language': 'en' },
      });
    } catch { return null; }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      let next;
      try { next = new URL(res.headers.get('location'), u.href).href; } catch { return null; }
      try { await res.body?.cancel(); } catch {}
      u = await publicUrl(next);
      continue;
    }
    if (!res.ok) return null;
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (!/text\/html|application\/xhtml/.test(type)) { try { await res.body?.cancel(); } catch {} return null; }
    const html = await readCapped(res);
    return parsePreview(html, u.href);
  }
  return null;
}
