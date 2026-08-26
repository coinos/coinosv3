// NIP-98 HTTP Auth header (kind 27235): the signature covers the exact URL,
// method and body hash, so a captured header is useless anywhere else. Its
// own module — every build needs it (registrar calls), but only some builds
// need the login/backup machinery around it in nostr-login.js.
import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha256';

export async function nip98Header(signer, url, method, bodyText) {
  const tags = [['u', url], ['method', method.toUpperCase()]];
  if (bodyText) tags.push(['payload', hex.encode(sha256(new TextEncoder().encode(bodyText)))]);
  const evt = await signer.signEvent({
    kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: '',
  });
  return 'Nostr ' + btoa(JSON.stringify(evt));
}
