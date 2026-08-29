// NIP-57 Lightning zaps — pay an npub / lightning address / lnurl over
// Lightning, attaching a signed zap request so the recipient's server posts a
// public zap receipt. This feature only does the *resolution* half (target →
// LNURL params → signed request → bolt11); the actual payment reuses the swaps
// feature's Boltz submarine flow via the `startLnPay` hook, so there's one
// tested LN pay/review/confirm/success path.
//
// Routing (see features/index.js order): a bolt11 is caught by swaps first; an
// npub is caught by ark first (an instant free Ark zap) when Ark is available,
// and only reaches here otherwise — plus ark's "no Ark address" screen hands
// off to us explicitly via the lnZapNpub hook. Lightning addresses and lnurls
// land here directly.

import { t } from '../i18n.js';
import { npubOf } from '../nostr.js';
import { parseZapTarget, zapTargetFromProfile, fetchPayParams, buildZapRequest, requestInvoice } from '../lnurl.js';
import { decodeNoffer } from '../noffer.js';
import { requestOfferInvoice } from '../clink.js';
import { decodeOffer } from '../bolt12.js';
import { maybeBolt11 } from '../ark/lightning.js';

export function zapsFeature(ctx) {
  const { h, ui, render, wallet, blankSend, parseAmount, getUnit, unitTag, hook, toast, fmtAmount, unitLabel } = ctx;

  // Lightning payment has to be possible for a zap to make sense.
  const canPay = () => !wallet.watchOnly && !!hook('canLnPay');

  const shortNpub = (npub) => (npub && npub.length > 16 ? npub.slice(0, 12) + '…' + npub.slice(-6) : npub);

  // A pasted CLINK offer code (`noffer1…`) — decoded, or null. The bech32
  // checksum means a partial paste never matches, so auto-advance is safe.
  function maybeNoffer(text) {
    const s = String(text || '').trim().replace(/^lightning:/i, '').toLowerCase();
    if (!/^noffer1/.test(s)) return null;
    try { return { ...decodeNoffer(s), raw: s }; } catch { return null; }
  }

  // A pasted BOLT 12 offer (`lno1…`) — decoded, or null.
  function maybeOffer(text) {
    const s = String(text || '').trim().replace(/^(lightning|bitcoin):/i, '').toLowerCase();
    if (!/^lno1/.test(s)) return null;
    try { return { ...decodeOffer(s), raw: s }; } catch { return null; }
  }

  const shortCode = (s) => s.slice(0, 12) + '…' + s.slice(-6);

  // Begin the amount screen for a decoded offer. Fetching the actual invoice
  // (via the ASP's CLN) and verifying it happens on confirm.
  function beginBolt12(off, display) {
    begin({ kind: 'bolt12', offer: off, address: display }, off.description || display);
    return true;
  }

  // Kick off resolution of a parsed target. `display` is what we show as the
  // recipient until a profile name arrives.
  function begin(target, display) {
    ui.arkZap = null; ui.arkZapped = null; // in case we were handed off from ark
    ui.sendError = '';
    const z = (ui.zap = { status: 'resolving', target, name: display, address: target.address || null, amount: '', comment: '' });
    render();
    resolve(z).catch((e) => { if (ui.zap === z) { z.status = 'error'; z.error = e.message; render(); } });
  }

  async function resolve(z) {
    let target = z.target;
    // A BOLT 12 offer carries its own terms — no lookup until confirm, when
    // the ASP's CLN fetches (and this wallet verifies) the actual invoice.
    if (target.kind === 'bolt12') {
      const off = target.offer;
      if (off.currency) throw new Error(t('bolt12Currency', { currency: off.currency }));
      const fixedSat = off.amountMsat ? Number((off.amountMsat + 999n) / 1000n) : null;
      if (fixedSat) z.amount = getUnit() === 'sats' ? String(fixedSat) : (fixedSat / 1e8).toFixed(8);
      z.params = { minSendable: 1000, maxSendable: 21e15, commentAllowed: 0, allowsNostr: false, fixedSat };
      z.status = 'ready';
      render();
      return;
    }
    // A CLINK offer needs no HTTP at all: the code itself says who to ask.
    if (target.kind === 'noffer') {
      const n = target.noffer;
      // pricing 1 = the service prices the payment itself: ask for an invoice
      // with no amount and let the pay review screen show what came back —
      // the user still approves the actual sats before anything is locked.
      if (n.priceType === 1) {
        z.status = 'invoicing'; render();
        const invoice = await requestOfferInvoice(n, {});
        if (ui.zap !== z) return;
        const dec = maybeBolt11(invoice);
        if (!dec || !dec.amountSat) throw new Error(t('clinkBadInvoice'));
        ui.zap = null;
        hook('startLnPay', invoice, { name: z.name, address: z.address, pk: null, comment: '', isZap: false });
        render();
        return;
      }
      const fixedSat = n.priceType === 0 && n.priceSats ? n.priceSats : null;
      if (fixedSat) z.amount = getUnit() === 'sats' ? String(fixedSat) : (fixedSat / 1e8).toFixed(8);
      z.params = { minSendable: 1000, maxSendable: 21e15, commentAllowed: 100, allowsNostr: false, fixedSat };
      z.status = 'ready';
      render();
      return;
    }
    // An npub needs a profile lookup to find its lud16/lud06.
    if (target.kind === 'npub') {
      const profile = await wallet.nostrProfile(target.pk);
      if (profile && profile.name) z.name = profile.name;
      const lnTarget = zapTargetFromProfile(profile, target.pk);
      if (!lnTarget) { z.status = 'error'; z.error = t('lnZapNoAddress'); render(); return; }
      z.target = target = { ...lnTarget, eventId: target.eventId || null }; // keep the note being zapped

      z.address = lnTarget.address || z.address;
    }
    const params = await fetchPayParams(target.url);
    if (ui.zap !== z) return; // user navigated away
    z.params = params;
    z.status = 'ready';
    render();
  }

  // One-tap zap at the user's default amount: resolve, invoice, pay through
  // the ark seam (its quote + retries included), and report by toast — the
  // whole flow without a single screen.
  async function autoZap(target, sats) {
    const profile = await wallet.nostrProfile(target.pk);
    const lnTarget = zapTargetFromProfile(profile, target.pk);
    if (!lnTarget) throw new Error(t('lnZapNoAddress'));
    const t2 = { ...lnTarget, eventId: target.eventId || null };
    const p = await fetchPayParams(t2.url);
    const msat = sats * 1000;
    if (msat < p.minSendable || msat > p.maxSendable) {
      throw new Error(t('lnZapRange', {
        min: Math.ceil(p.minSendable / 1000).toLocaleString(),
        max: Math.floor(p.maxSendable / 1000).toLocaleString(),
      }));
    }
    let zapRequest = null;
    if (p.allowsNostr && t2.pk && wallet.nostrSign) {
      zapRequest = buildZapRequest({
        amountMsat: msat, relays: wallet.nostrRelays(), lnurlBech32: t2.lnurlBech32,
        recipientPk: t2.pk, eventId: t2.eventId || null, comment: '',
        signFn: (partial) => wallet.nostrSign(partial),
      });
    }
    const invoice = await requestInvoice(p, { amountMsat: msat, zapRequest, lnurlBech32: t2.lnurlBech32 });
    await hook('arkPayInvoice', invoice, { maxAmountSat: sats + 50 });
    toast('⚡ ' + t('zapSentShort', { n: fmtAmount(sats) + ' ' + unitLabel() }));
    render();
  }

  async function confirm() {
    const z = ui.zap;
    if (!z || z.status !== 'ready') return;
    const sats = z.params.fixedSat || parseAmount(z.amount, getUnit());
    const p = z.params;
    if (!sats || sats <= 0) { z.error = t('enterValidAmtForN', { n: 1 }); return render(); }
    const msat = sats * 1000;
    const capSat = Math.min(Math.floor(p.maxSendable / 1000), hook('lnSpendableSat') ?? Infinity);
    if (msat < p.minSendable || sats > capSat) {
      z.error = t('lnZapRange', { min: Math.ceil(p.minSendable / 1000).toLocaleString(), max: capSat.toLocaleString() });
      return render();
    }
    z.error = ''; z.status = 'invoicing'; render();
    if (z.target.kind === 'bolt12') {
      try {
        // fetch through the ASP's CLN; the manager verifies signature, offer
        // mirroring and amount before handing back the lni
        const r = await hook('arkFetchBolt12Invoice', z.target.offer.raw, sats);
        ui.zap = null;
        hook('startLnPay', r.invoice, { name: z.name, address: z.address, pk: null, comment: '', isZap: false });
        render();
      } catch (e) {
        z.status = 'ready'; z.error = e.message; render();
      }
      return;
    }
    if (z.target.kind === 'noffer') {
      try {
        const invoice = await requestOfferInvoice(z.target.noffer, { amountSat: sats, description: z.comment });
        // Never pay on trust: the invoice must say exactly the sats agreed.
        const dec = maybeBolt11(invoice);
        if (!dec || dec.amountMsat !== BigInt(sats) * 1000n) throw new Error(t('clinkBadInvoice'));
        ui.zap = null;
        hook('startLnPay', invoice, { name: z.name, address: z.address, pk: null, comment: z.comment, isZap: false });
        render();
      } catch (e) {
        z.status = 'ready'; z.error = e.message; render();
      }
      return;
    }
    try {
      // Attribute a real zap only when the server supports it and we know the
      // recipient's nostr key; otherwise fall back to a plain LNURL-pay.
      let zapRequest = null;
      const canZap = p.allowsNostr && z.target.pk && wallet.nostrSign;
      if (canZap) {
        zapRequest = buildZapRequest({
          amountMsat: msat, relays: wallet.nostrRelays(), lnurlBech32: z.target.lnurlBech32,
          recipientPk: z.target.pk, eventId: z.target.eventId || null, comment: z.comment,
          signFn: (partial) => wallet.nostrSign(partial),
        });
      }
      const invoice = await requestInvoice(p, { amountMsat: msat, zapRequest, lnurlBech32: z.target.lnurlBech32, comment: z.comment });
      const meta = { name: z.name, address: z.address, pk: z.target.pk || null, comment: canZap ? z.comment : '', isZap: !!zapRequest };
      ui.zap = null;
      // Hand the bolt11 to the swaps feature's pay flow (review → confirm).
      hook('startLnPay', invoice, meta);
      render();
    } catch (e) {
      z.status = 'ready'; z.error = e.message; render();
    }
  }

  function zapView() {
    const z = ui.zap;
    if (!z) return null;
    const back = () => { ui.zap = null; ui.sendError = ''; ui.send = blankSend(); render(); };
    // Resolution is a background step, not a screen: the send form stays put
    // and shows one inline line (resolvingNote below) until we can render
    // something the user can act on.
    if (z.status === 'resolving') {
      // twin of ark's skeleton: identical shape, so the handoff is invisible
      return h('div', { class: 'card col', style: 'gap:12px' },
        h('h3', {}, '⚡ ' + t('zapTitle')),
        (z.target && z.target.pk && hook('profileChip', z.target.pk, 'lg'))
          || h('div', { class: 'small muted break' }, z.name || z.address || ''),
        h('div', { class: 'row gap6', style: 'align-items:center;padding:6px 0' },
          h('span', { class: 'spinner sm' }),
          h('span', { class: 'small muted' }, t('zapFinding'))),
        h('button', { class: 'btn-ghost btn-block', onClick: back }, t('back')));
    }
    if (z.status === 'invoicing') {
      return h('div', { class: 'card col', style: 'align-items:center;gap:14px;padding:32px 14px' },
        h('span', { class: 'spinner' }),
        h('p', { class: 'muted', style: 'margin:0' }, t('lnZapRequesting')));
    }
    if (z.status === 'error') {
      return h('div', { class: 'card col', style: 'gap:12px' },
        h('h3', {}, '⚡ ' + t('zapTitle')),
        (z.target && z.target.pk && hook('profileChip', z.target.pk, 'lg')) || h('div', { class: 'small muted', style: 'word-break:break-all' }, z.name || ''),
        h('div', { class: 'notice err' }, z.error || t('lnZapFailed')),
        h('button', { class: 'btn-ghost btn-block', onClick: back }, t('back')));
    }
    // ready: amount + optional comment. Their LNURL ceiling is meaningless
    // past our own Spending balance — cap to the lower of the two, and when
    // Spending can't even cover their minimum, say so instead of rendering
    // an impossible range.
    const p = z.params;
    const ours = hook('lnSpendableSat');
    const min = Math.ceil(p.minSendable / 1000);
    const max = Math.min(Math.floor(p.maxSendable / 1000), ours != null ? ours : Infinity);
    const broke = ours != null && (ours <= 0 || max < min);
    const commentOk = p.allowsNostr || p.commentAllowed > 0;
    // An amount Spending can't cover isn't a dead end when Savings can: the
    // primary button turns into the door to the board panel, prefilled with
    // what this payment needs (extra is one edit away).
    const typedSats = parseAmount(z.amount, getUnit()) || 0;
    const theirMaxSat = Math.floor(p.maxSendable / 1000);
    const boardable = !!hook('arkReady') && ours != null;
    const needsBoard = boardable && (broke || (typedSats > 0 && typedSats > ours && typedSats <= theirMaxSat));
    return h('div', { class: 'card col', style: 'gap:12px' },
      h('h3', {}, '⚡ ' + t('zapTitle')),
      (z.target && z.target.pk && hook('profileChip', z.target.pk, 'lg')) || h('div', { class: 'small muted', style: 'word-break:break-all' }, z.name || z.address || ''),
      h('div', { class: 'col gap6' },
        h('div', { class: 'input-group' },
          h('input', { type: 'number', min: '0', inputmode: 'decimal', placeholder: t('lnPayAmount'), value: z.amount,
            disabled: !!p.fixedSat,
            onInput: (e) => { z.amount = e.target.value; render(); } }),
          h('div', { style: 'display:flex;align-items:center' }, unitTag())),
        broke
          ? h('div', { class: 'notice info' }, t('zapNoBalance'))
          : p.fixedSat
            ? h('div', { class: 'small faint' }, t('clinkFixedAmount'))
            : h('div', { class: 'small faint' }, `Min ${min.toLocaleString()} · max ${max.toLocaleString()} sats`),
        commentOk
          ? h('input', { type: 'text', class: 'mono-input', placeholder: t('arkZapCommentPh'), value: z.comment,
              maxlength: p.allowsNostr ? '280' : String(p.commentAllowed || 280),
              onInput: (e) => { z.comment = e.target.value; } })
          : null,
        h('div', { class: 'small faint' }, p.allowsNostr ? t('lnZapHintNostr') : t('lnZapHintPlain'))),
      z.error ? h('div', { class: 'notice err' }, z.error) : null,
      h('div', { class: 'row gap6' },
        h('button', { class: 'btn-ghost', onClick: back }, t('back')),
        needsBoard
          ? h('button', { class: 'btn-primary grow', onClick: () => hook('arkOfferBoard', typedSats || min) }, t('zapBoardBtn'))
          : h('button', { class: 'btn-primary grow', onClick: confirm, disabled: broke }, t('arkZapBtn'))));
  }

  return {
    id: 'zaps',
    // A lightning address / lnurl (always), or an npub that Ark didn't claim.
    matchSendText(text, typed) {
      if (!canPay() || !ui.send || ui.send.recipients.length !== 1) return false;
      const nof = maybeNoffer(text);
      if (nof) {
        const short = shortCode(nof.raw);
        begin({ kind: 'noffer', noffer: nof, address: short }, short);
        return true;
      }
      const off = maybeOffer(text);
      if (off) return beginBolt12(off, shortCode(off.raw));
      const target = parseZapTarget(text);
      if (!target) return false;
      // npub with no nostr seam to look up a profile → can't resolve here.
      if (target.kind === 'npub' && !wallet.nostrProfile) return false;
      // A TYPED lightning address matches mid-keystroke (`a@b.co` before the
      // user finishes `.com`), so never auto-advance while typing — the send
      // form offers a zap button via sendFormNote instead. Pasted/scanned
      // text is complete and advances immediately; npub/lnurl carry a bech32
      // checksum and only ever match when complete.
      if (typed && target.kind === 'lnaddr') return false;
      const display = target.kind === 'npub' ? shortNpub(npubOf(target.pk) || text.trim()) : (target.address || text.trim());
      begin(target, display);
      return true;
    },
    // The typed-lightning-address affordance on the send form.
    sendFormNote(a) {
      if (!canPay() || !ui.send || ui.send.recipients.length !== 1) return null;
      const target = parseZapTarget(a);
      if (!target || target.kind === 'npub') return null;
      const display = target.address || String(a || '').trim();
      return h('button', {
        type: 'button', class: 'btn-primary btn-block',
        onClick: () => begin(target, display),
      }, '⚡ ' + t('lnZapOffer', { addr: display }));
    },
    // A BIP-353 name resolved to a record whose lno= is the only payable
    // instruction (a foreign BOLT 12 node, or a coinos name whose owner
    // pointed it at their own node) — pay the offer.
    startBolt12Pay(lno, display) {
      if (!canPay() || !ui.send || ui.send.recipients.length !== 1) return false;
      const off = maybeOffer(lno);
      if (!off) return false;
      return beginBolt12(off, display || shortCode(off.raw));
    },
    // The names feature resolves user@domain over DNS first (BIP-353) and
    // lands here when the name has no DNS record — the classic LNURL path.
    lnAddressFallback(text) {
      if (!canPay() || !ui.send || ui.send.recipients.length !== 1) return false;
      const target = parseZapTarget(text);
      if (!target || target.kind === 'npub') return false;
      begin(target, target.address || String(text).trim());
      return true;
    },
    // True when an npub can be zapped over Lightning from this build/wallet —
    // ark's "no Ark address" screen checks this before offering the fallback.
    canLnZap() { return canPay() && !!wallet.nostrProfile; },
    // Ark's "no Ark address published" screen offers a Lightning fallback,
    // which lands here with the recipient's pubkey (and, when the zap was
    // aimed at a note, its event id for the zap request's e tag).
    lnZapNpub(pk, npub, eventId, autoSat) {
      if (!canPay() || !wallet.nostrProfile) return false;
      if (autoSat && hook('arkReady')) {
        autoZap({ kind: 'npub', pk, eventId: eventId || null }, autoSat)
          .catch((e) => toast('⚡ ' + e.message));
        return true;
      }
      begin({ kind: 'npub', pk, eventId: eventId || null }, shortNpub(npub || npubOf(pk)));
      return true;
    },
    sendView() { return zapView(); },
    // Settings → Payments: the one-tap zap amount.
    settingsCards() {
      const cur = ctx.zapDefaultSat ? ctx.zapDefaultSat() : 0;
      return [h('div', { class: 'card col', style: 'gap:8px' },
        h('div', { class: 'row between', style: 'align-items:center;gap:10px' },
          h('span', { class: 'small' }, '⚡ ' + t('zapDefaultLabel')),
          h('div', { class: 'input-group', style: 'width:130px' },
            h('input', { type: 'number', min: '1', value: cur || '', placeholder: '21',
              style: 'text-align:right',
              onInput: (e) => { const n = parseInt(e.target.value, 10); if (n > 0) ctx.setZapDefaultSat(n); } }),
            h('span', { class: 'small muted', style: 'align-self:center;padding:0 6px' }, 'sats'))),
        h('div', { class: 'small faint' }, t('zapDefaultHint')))];
    },
  };
}
