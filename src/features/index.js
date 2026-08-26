// Which optional features this build includes. In dev (and by default in
// builds) everything is on. Release builds can exclude features entirely:
// build.js replaces this module's contents based on HAL_FEATURES, so a
// disabled feature's code — and its network endpoints — never enters the
// bundle. See featureIndexSource() in build.js.
//
// This checked-in copy must stay byte-equivalent (comments aside) to
// featureIndexSource(all features) — tools/feature-registry-check.js enforces
// it. Deferred features (gifts, nwc, hats) hold their array position with an
// empty placeholder — hook precedence is position — and are filled in place
// by loadDeferredFeatures right after boot, as separate chunks in the split
// build. NB order is meaningful where hooks stack: gifts' receive takeover
// and balance line come before ark's; zaps sits after ark so an npub prefers
// an instant Ark zap; nwc sits after ark because it drives ark's headless
// pay/balance seam; names sits between ark and zaps so a pasted user@domain
// resolves over DNS (BIP-353) before zaps treats it as a Lightning address.
import { arkFeature } from './ark.js';
import { nostrLoginFeature } from './nostrlogin.js';
import { namesFeature } from './names.js';
import { zapsFeature } from './zaps.js';
import { syncFeature } from './sync.js';
import { messagesFeature } from './messages.js';

export function buildFeatures(ctx) {
  return [{}, arkFeature(ctx), nostrLoginFeature(ctx), namesFeature(ctx), zapsFeature(ctx), {}, {}, syncFeature(ctx), messagesFeature(ctx)];
}
export async function loadDeferredFeatures(ctx, features) {
  const late = [];
  await Promise.all([
    import('./gifts.js').then((m) => { late.push(features[0] = m.giftsFeature(ctx)); }),
    import('./nwc.js').then((m) => { late.push(features[5] = m.nwcFeature(ctx)); }),
    import('./hats.js').then((m) => { late.push(features[6] = m.hatsFeature(ctx)); })
  ]);
  return late;
}
