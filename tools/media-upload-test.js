import { uploadPublicMedia, MediaUploadError } from '../src/media-upload.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

let ok = true;
const check = (name, pass) => { console.log(`${pass ? '✓' : '✗'} ${name}`); if (!pass) ok = false; };
const bytes = new TextEncoder().encode('phone video bytes');
const file = new File([bytes], 'clip.mov', { type: 'video/quicktime' });
let signed = null;
const sign = async (event) => (signed = { ...event, id: '1'.repeat(64), pubkey: '2'.repeat(64), sig: '3'.repeat(128) });
const calls = [];
const fetcher = async (url, init) => {
  calls.push({ url, init });
  if (url.startsWith('https://first')) return new Response(JSON.stringify({ message: 'temporarily unavailable' }), { status: 503 });
  return new Response(JSON.stringify({ url: 'https://cdn.example/clip.mov' }), { status: 201, headers: { 'content-type': 'application/json' } });
};

const url = await uploadPublicMedia(file, sign, { servers: ['https://first', 'https://second/'], fetcher, timeoutMs: 1000 });
check('falls back to a second independent media host', url === 'https://cdn.example/clip.mov' && calls.length === 2);
check('uploads the original video type and bytes', calls[1].init.method === 'PUT' && calls[1].init.body === file
  && calls[1].init.headers['content-type'] === 'video/quicktime');
check('hashes the file and binds the hash into Blossom auth', calls[1].init.headers['x-sha-256'] === bytesToHex(sha256(bytes))
  && signed.tags.some((tag) => tag[0] === 'x' && tag[1] === calls[1].init.headers['x-sha-256']));
check('sends signed Blossom authorization', calls[1].init.headers.authorization.startsWith('Nostr '));

const bareHashUrl = await uploadPublicMedia(file, sign, {
  servers: ['https://media.example'], timeoutMs: 1000,
  fetcher: async () => new Response(JSON.stringify({ url: '/' + 'a'.repeat(64) }), { status: 201 }),
});
check('adds the video extension when a Blossom server returns a bare hash URL', bareHashUrl.endsWith('.mov'));

try {
  await uploadPublicMedia(file, sign, {
    servers: ['https://one', 'https://two'], timeoutMs: 1000,
    fetcher: async () => new Response('', { status: 413 }),
  });
  check('reports provider size rejection', false);
} catch (error) {
  check('reports provider size rejection', error instanceof MediaUploadError && error.code === 'too-big');
}

console.log(ok ? '\n✅ public media upload works' : '\n❌ public media upload failed');
process.exit(ok ? 0 : 1);
