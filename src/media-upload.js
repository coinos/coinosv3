import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

// Independent public hosts: a phone upload should not fail just because one
// provider is down or rejects a particular container. nostr.download's NIP-96
// document currently advertises large image/video/audio uploads; nostr.build
// is the second, widely-used Blossom home.
export const PUBLIC_MEDIA_SERVERS = ['https://nostr.download', 'https://blossom.nostr.build'];

export class MediaUploadError extends Error {
  constructor(code, details = '') {
    super(code);
    this.name = 'MediaUploadError';
    this.code = code;
    this.details = details;
  }
}

async function fileHash(file) {
  const hash = sha256.create();
  const chunk = 4 * 1024 * 1024;
  for (let at = 0; at < file.size; at += chunk)
    hash.update(new Uint8Array(await file.slice(at, at + chunk).arrayBuffer()));
  return bytesToHex(hash.digest());
}

const responseUrl = (body) => body?.url
  || body?.data?.[0]?.url
  || (body?.tags || []).find((x) => x?.[0] === 'url')?.[1]
  || null;

function mediaUrl(url, server, file) {
  const out = new URL(url, server);
  const tail = out.pathname.split('/').at(-1) || '';
  if (/^[0-9a-f]{64}$/i.test(tail)) {
    const named = String(file.name || '').match(/\.([a-z0-9]{1,8})$/i)?.[1];
    const byType = { 'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/webm': 'webm',
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' }[file.type];
    const ext = (named || byType || '').toLowerCase();
    if (ext) out.pathname += '.' + ext;
  }
  return out.href;
}

// BUD-02 upload. `signEvent` is deliberately injected: the app can use its
// always-available wallet identity, while tests need no secret key.
export async function uploadPublicMedia(file, signEvent, {
  servers = PUBLIC_MEDIA_SERVERS,
  fetcher = globalThis.fetch,
  timeoutMs = 5 * 60_000,
} = {}) {
  if (!file || !file.size || typeof signEvent !== 'function') throw new MediaUploadError('failed');
  const x = await fileHash(file);
  const now = Math.floor(Date.now() / 1000);
  const auth = await signEvent({
    kind: 24242, created_at: now - 5, content: 'upload',
    tags: [['t', 'upload'], ['x', x], ['expiration', String(now + Math.ceil(timeoutMs / 1000) + 120)]],
  });
  if (!auth) throw new MediaUploadError('failed');
  const authorization = 'Nostr ' + btoa(JSON.stringify(auth));
  const failures = [];
  for (const server of servers) {
    try {
      const response = await fetcher(server.replace(/\/$/, '') + '/upload', {
        method: 'PUT', body: file, signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization,
          'content-type': file.type || 'application/octet-stream',
          'x-sha-256': x,
          'x-content-length': String(file.size),
        },
      });
      let body = null;
      try { body = await response.json(); } catch {}
      const url = response.ok && responseUrl(body);
      if (url) return mediaUrl(url, server, file);
      failures.push({ status: response.status, reason: response.headers.get('x-reason') || body?.message || '' });
    } catch (error) {
      failures.push({ status: 0, reason: error?.message || '' });
    }
  }
  const details = failures.map((x) => [x.status, x.reason].filter(Boolean).join(' ')).filter(Boolean).join('; ');
  if (failures.length && failures.every((x) => x.status === 413)) throw new MediaUploadError('too-big', details);
  if (failures.length && failures.every((x) => x.status === 415)) throw new MediaUploadError('unsupported', details);
  throw new MediaUploadError('failed', details);
}
