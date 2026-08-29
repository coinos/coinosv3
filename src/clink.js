// CLINK payer — ask an offer code's service for an invoice over nostr.
// The counterpart of src/noffer.js (the codec) and the responder in
// features/nwc.js: a NIP-44-encrypted kind-21001 request goes to the service
// pubkey on the relay the code names, and {bolt11} (or {error}) comes back.

import {
  nip44, finalizeEvent, generateSecretKey, publishOn, subscribeOn,
} from './nostr.js';

const OFFER_KIND = 21001;

// dest: a decoded noffer ({ pubkey, relay, offerId }). Signs with a throwaway
// key, so paying reveals no identity to the service. amountSat may be omitted
// for offers that price themselves (the returned invoice carries the amount).
// Resolves the bolt11 string; rejects on a service error or silence.
export function requestOfferInvoice(dest, { amountSat, description, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    const relays = [dest.relay].filter(Boolean);
    if (!relays.length) return reject(new Error('offer code names no relay'));
    const sk = generateSecretKey();
    const key = nip44.getConversationKey(sk, dest.pubkey);
    const payload = { offer: dest.offerId || '' };
    if (amountSat) payload.amount_sats = Math.floor(amountSat);
    if (description) payload.description = String(description).slice(0, 100);
    const req = finalizeEvent({
      kind: OFFER_KIND, created_at: Math.floor(Date.now() / 1000),
      tags: [['p', dest.pubkey], ['clink_version', '1']],
      content: nip44.encrypt(JSON.stringify(payload), key),
    }, sk);
    let done = false;
    let close = () => {};
    const finish = (err, bolt11) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      close();
      err ? reject(err) : resolve(bolt11);
    };
    const timer = setTimeout(() => finish(new Error('the recipient’s service did not answer')), timeoutMs);
    // subscribe before publishing — a fast service can answer within the RTT
    close = subscribeOn(relays, { kinds: [OFFER_KIND], '#e': [req.id], since: Math.floor(Date.now() / 1000) - 5 }, (ev) => {
      try {
        const body = JSON.parse(nip44.decrypt(ev.content, key));
        if (body.bolt11) return finish(null, body.bolt11);
        if (body.error) return finish(new Error(body.error));
      } catch {}
    });
    publishOn(relays, req).catch(() => {});
  });
}
