// Payment names — BIP-353 DNS payment instructions.
//
// Receiving: claim ₿name@halwallet.app. The claim is signed with the wallet's
// nostr key and the registrar publishes a DNSSEC-signed TXT record whose
// BIP-21 URI carries this wallet's (reusable) ark address. The name follows
// the wallet: if the ark address changes (new ASP), the record re-registers
// itself on the next open. Users with their own domain point a single CNAME
// at our record and their name verifies just the same.
//
// Sending: paste name@domain (or ₿name@domain) and it resolves over DNS
// first — an ark= instruction pays natively over Ark; a name with no BIP-353
// record falls back to the Lightning-address flow (zaps feature).

import { resolveBip353, parsePaymentName, parseBip21 } from '../bip353.js';
import { nip98Header } from '../nip98.js';
import { qrSvg } from '../qr.js';
import { isArkAddress } from './ark.js';
import { getNetwork } from '../api.js';
import { t } from '../i18n.js';

const REGISTRAR = 'https://names.coinos.io';
// Claims are namespaced by network: staging's mutinynet wallets get
// name@staging.coinos.io, so play names (and their testnet ark addresses)
// never squat the real coinos.io namespace. Records saved under either
// domain keep working — st.domain wins over the default everywhere.
const DOMAIN = () => (getNetwork() === 'mutinynet' ? 'staging.coinos.io' : 'coinos.io');
const AUTH_KIND = 21353;

export function namesFeature(ctx) {
  const { h, ui, render, wallet, hook, toast, copy, copyBtn, brandHeader, goBack, setAccount } = ctx;

  // The wallet's own key signs registrar requests: it's the one key that is
  // always available — offline, in the background, with no signer attached.
  const walletSigner = () => ({
    pubkey: wallet.nostrPubkey && wallet.nostrPubkey(),
    signEvent: async (e) => wallet.nostrSign(e),
  });

  // Nothing here may hang: a stuck signer prompt or a dead endpoint must
  // surface as an error, not as a spinner that never stops.
  const withTimeout = (p, ms, what) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms)),
  ]);

  async function post(path, method, payload, signer) {
    const url = `${REGISTRAR}${path}`;
    const hasBody = method !== 'GET';
    const body = hasBody ? JSON.stringify(payload) : '';
    const auth = await withTimeout(nip98Header(signer || walletSigner(), url, method, body), 12000, 'signing');
    const r = await withTimeout(fetch(url, {
      method, headers: { 'content-type': 'application/json', authorization: auth }, ...(hasBody ? { body } : {}),
    }), 12000, 'registrar');
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || `registrar refused (${r.status})`);
    return j;
  }

  // One name PER DOMAIN: mainnet and staging claims live side by side in the
  // wallet's state instead of overwriting each other on a network switch.
  // Legacy flat state ({name, domain, …}) reads/migrates into its domain slot.
  const loadAll = () => wallet.loadFeatureState('names', {});
  const load = () => {
    const all = loadAll();
    if (all.byDomain) return all.byDomain[DOMAIN()] || {};
    if (all.name) return (all.domain || 'coinos.io') === DOMAIN() ? all : {};
    return {};
  };
  const save = (st) => {
    const all = loadAll();
    const byDomain = all.byDomain || {};
    if (!all.byDomain && all.name) {
      byDomain[all.domain || 'coinos.io'] = { name: all.name, domain: all.domain || 'coinos.io', uri: all.uri, offerPk: all.offerPk, updated: all.updated };
    }
    byDomain[DOMAIN()] = st;
    wallet.saveFeatureState('names', { byDomain });
  };

  // Mainnet and mutinynet: staging's play network gets the full payment-
  // address experience (claims already registered fine — the record simply
  // carries a testnet ark address). Ark-to-name sends between mutinynet
  // wallets resolve and pay normally; only foreign-LNURL receives assume
  // mainnet. NB the names live in the ONE shared registry either way.
  const available = () => ['mainnet', 'mutinynet'].includes(getNetwork()) && !wallet.watchOnly
    && !!wallet.nostrSign && !!hook('arkReady');

  async function currentUri() {
    const addr = await withTimeout(hook('arkStaticAddress'), 12000, 'ark');
    return addr ? `bitcoin:?ark=${encodeURIComponent(addr)}` : null;
  }

  async function claim(name, { signer, manager, quietProfile } = {}) {
    const uri = await currentUri();
    if (!uri) throw new Error(t('namesNeedArk'));
    const j = await post('/register', 'POST', {
      name, uri, domain: DOMAIN(),
      // lets the address take Lightning payments from LNURL-only wallets:
      // the registrar asks this key for an invoice before minting its own
      ...(hook('nwcOfferPubkey') ? { offerPk: hook('nwcOfferPubkey') } : {}),
      // when the login identity claims its own npub name, it nominates the
      // wallet key to keep the record updated afterwards
      ...(manager ? { manager } : {}),
    }, signer);
    const prev = load().name;
    save({ name, domain: DOMAIN(), uri, offerPk: hook('nwcOfferPubkey') || null, updated: Date.now() });
    // Releasing the previous name is for renames the user meant. A CUSTOM
    // name must never be released because a placeholder claim raced in: that
    // exact race once deleted a user's claimed name — adoptIdentity's npub
    // claim landed in the same instant refresh() was adopting their real
    // name, and `prev` here picked up the fresher read.
    const demotion = /^npub1/.test(name) && prev && !/^npub1/.test(prev);
    if (prev && prev !== name && !demotion) {
      post('/register', 'DELETE', { name: prev, domain: DOMAIN() }).catch(() => {});
      // the old address just died — a kind 0 still pointing at it would send
      // zaps into the void, so the profile's lud16/nip05 follow the rename
      // (messages only touches them if they pointed at the released name).
      // quietProfile: the profile editor claims mid-save and folds these
      // fields into its own publish — a second publish here would race it.
      if (!quietProfile)
        Promise.resolve(hook('addressRenamed', `${prev}@${DOMAIN()}`, `${name}@${DOMAIN()}`)).catch(() => {});
    }
    return j;
  }

  async function release() {
    const st = load();
    if (!st.name) return;
    await post('/register', 'DELETE', { name: st.name, domain: st.domain || DOMAIN() }).catch(() => {});
    save({});
  }

  // An imported seed (or a new browser) doesn't know its username — the
  // registrar does. Ask by the wallet's nostr pubkey and adopt the answer
  // before deciding whether anything needs claiming.
  async function lookupMine() {
    try {
      const pk = wallet.nostrPubkey && wallet.nostrPubkey();
      if (!pk) return;
      const r = await withTimeout(
        fetch(`${REGISTRAR}/pubkey/${pk}?domain=${encodeURIComponent(DOMAIN())}`).then((x) => x.json()), 12000, 'registrar');
      if (r && r.name) save({ ...load(), name: r.name, domain: r.domain || DOMAIN(), uri: r.uri });
    } catch (e) { console.warn('names: lookup failed —', e.message); }
  }

  // Everyone gets an address without being asked: the default username is a
  // prefix of the wallet's npub — unique, boring, and free. Custom names are
  // an optional change (and may cost something one day, to keep squatters
  // out), so nothing here ever blocks the wallet.
  let checked = false;   // setup finished (the pane waits on this)
  let retryTimer = null;
  let deadline = null;
  let lastError = null;
  async function refresh(attempt = 0) {
    clearTimeout(retryTimer);
    // Whatever goes wrong, stop claiming to be "setting up" after a minute
    // and show the user the manual form instead.
    if (!deadline) {
      deadline = setTimeout(() => { checked = true; clearTimeout(retryTimer); render(); }, 12000);
    }
    try {
      if (!available()) {
        // Ark connects lazily AFTER the wallet opens, so the first pass
        // usually lands too early. Keep looking for a while rather than
        // giving up and leaving the user staring at a claim box.
        if (attempt < 40) { retryTimer = setTimeout(() => refresh(attempt + 1), 3000); return; }
        checked = true; render(); return;
      }
      let st = load();
      if (!st.name) { await lookupMine(); st = load(); }
      // A custom name claimed on ANOTHER DEVICE by the login identity beats a
      // local npub placeholder: the username people know the user by should
      // show everywhere they sign in, not only where they typed it.
      if (!st.name || /^npub1/.test(st.name)) {
        const login = hook('nostrLoginIdentity');
        if (login && login.pubkey) {
          try {
            const r = await withTimeout(
              fetch(`${REGISTRAR}/pubkey/${login.pubkey}?domain=${encodeURIComponent(DOMAIN())}`).then((x) => x.json()),
              8000, 'registrar');
            if (r && r.name && !/^npub1/.test(r.name)) {
              save({ ...st, name: r.name, domain: r.domain || DOMAIN(), uri: r.uri });
              st = load();
            }
          } catch {}
        }
      }
      if (!st.name) {
        // The address people see should be the identity they know the user
        // by: their real npub when a nostr account is linked, else the
        // wallet's own. Claiming the real one has to be SIGNED by that
        // identity (the registrar won't let anyone else take an npub-shaped
        // name), so it needs a live signer — after a reload an extension can
        // usually be re-attached silently; anything else falls back to the
        // wallet's own identity rather than retrying a claim that can only
        // ever fail.
        // Claim with the WALLET's own key: it needs no signer, prompts
        // nobody, and always works. Tying the address to the user's real
        // npub happens at login instead (adoptIdentity below), where a
        // signer is already live — an address must never wait on a popup.
        const own = wallet.nostrNpub && wallet.nostrNpub();
        if (own) { await claim(own.slice(0, 12), {}); st = load(); }
      }
      checked = true;
      clearTimeout(deadline); deadline = null;
      render();
      if (!st.name) return;
      const uri = await currentUri();
      // Re-publish when the address changed OR when the registrar doesn't yet
      // know this wallet's offer key — that key is what lets an incoming
      // Lightning payment be delivered straight to us instead of waiting on
      // the operator's float.
      const offerPk = hook('nwcOfferPubkey') || null;
      if (uri && (uri !== st.uri || (offerPk && st.offerPk !== offerPk))) await claim(st.name);
    } catch (e) {
      console.warn('names: refresh failed —', e.message);
      lastError = e.message;
      if (attempt < 3) { retryTimer = setTimeout(() => refresh(attempt + 1), 4000); return; }
      checked = true;
      render();
    }
  }

  // Called right after a nostr login, while that signer is definitely live:
  // move the payment address onto the user's real npub and nominate the
  // wallet key to keep the record updated afterwards.
  async function adoptIdentity(signer, npub) {
    if (!signer || !npub || !available()) return null;
    const name = npub.slice(0, 12);
    let st = load();
    // A restored wallet may not know its name yet — ask the registrar before
    // assuming there is none.
    if (!st.name) { await lookupMine(); st = load(); }
    // The LOGIN identity may already own a custom name, claimed in a past
    // session or on another device — find and adopt it BEFORE reaching for a
    // placeholder (lookupMine only asks by the wallet's own key).
    if (!st.name || /^npub1/.test(st.name)) {
      try {
        const r = await withTimeout(
          fetch(`${REGISTRAR}/pubkey/${signer.pubkey}?domain=${encodeURIComponent(DOMAIN())}`).then((x) => x.json()),
          8000, 'registrar');
        if (r && r.name && !/^npub1/.test(r.name)) {
          save({ ...load(), name: r.name, domain: r.domain || DOMAIN(), uri: r.uri });
          render();
          return r.name;
        }
      } catch {}
      st = load(); // refresh() may have adopted a name while we were looking
    }
    // The npub default is a placeholder for wallets with no name. Adopting it
    // must never displace a custom name — claim() releases the previous name,
    // so getting this wrong deletes the user's address from the registrar.
    if (st.name && !/^npub1/.test(st.name)) return st.name;
    if (st.name === name) return name;
    await claim(name, { signer, manager: wallet.nostrPubkey() });
    render();
    return name;
  }

  // ---- sending to a name -------------------------------------------------

  // Our own names when DNS is late (a fresh claim still inside the negative-
  // cache window) or validation hiccups: the registrar IS the source DNS
  // mirrors, so ask it directly instead of dead-ending in the Lightning
  // fallback — which for staging names points at a webroot that serves HTML.
  const OUR_DOMAINS = ['coinos.io', 'staging.coinos.io', 'halwallet.app'];
  async function registrarUri(name, domain) {
    try {
      const r = await withTimeout(
        fetch(`${REGISTRAR}/name/${encodeURIComponent(name)}?domain=${encodeURIComponent(domain)}`).then((x) => x.json()),
        8000, 'registrar');
      return r && r.taken && r.uri ? r.uri : null;
    } catch { return null; }
  }

  function beginResolve(text) {
    const parsed = parsePaymentName(text);
    if (!parsed) return false;
    ui.nameResolve = { text, status: 'resolving' };
    render();
    (async () => {
      let uri = null, resolveErr = null;
      try { uri = await resolveBip353(parsed.name, parsed.domain); } catch (e) { resolveErr = e; }
      if (ui.nameResolve?.text !== text) return;
      if (!uri && OUR_DOMAINS.includes(parsed.domain)) uri = await registrarUri(parsed.name, parsed.domain);
      if (ui.nameResolve?.text !== text) return;
      ui.nameResolve = null;
      if (!uri && resolveErr) {
        ui.sendError = `${parsed.name}@${parsed.domain}: ${resolveErr.message}`;
        render();
        return;
      }
      if (uri) {
        const dec = parseBip21(uri);
        const ark = dec?.params?.ark;
        if (ark && isArkAddress(ark) && hook('arkReady')) {
          ui.send.recipients[0].address = ark;
          render();
          return;
        }
        if (dec?.onchain) {
          ui.send.recipients[0].address = dec.onchain;
          render();
          return;
        }
        ui.sendError = t('namesNoUsableInstruction');
        render();
        return;
      }
      // no BIP-353 record: hand off to the Lightning-address flow — except
      // staging names, which have no LNURL endpoint (the zap would fetch the
      // web app's HTML and choke); an unknown staging name is simply unknown.
      if (parsed.domain === 'staging.coinos.io' || !hook('lnAddressFallback', text)) {
        ui.sendError = t('namesNotFound', { name: `${parsed.name}@${parsed.domain}` });
      }
      render();
    })();
    return true;
  }

  // ---- UI ---------------------------------------------------------------

  // Suggest the identity's own nostr username as the claim default — nobody
  // should have to retype who they already are — but only when that name is
  // actually free on the registrar (or already theirs to retake).
  let suggestedFor = null;
  function suggestName() {
    const me = (hook('nostrLoginIdentity') || {}).pubkey || (wallet.nostrPubkey && wallet.nostrPubkey());
    if (!me || suggestedFor === me || ui.nameClaim) return;
    suggestedFor = me;
    (async () => {
      try {
        const prof = hook('cachedProfile', me);
        const cand = String((prof && prof.name) || '').toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 30);
        if (!cand || /^npub1/.test(cand)) return;
        const r = await withTimeout(
          fetch(`${REGISTRAR}/name/${encodeURIComponent(cand)}?domain=${encodeURIComponent(DOMAIN())}`).then((x) => x.json()),
          8000, 'registrar');
        const free = r && r.taken === false;
        const mine = r && r.taken && r.pubkey === me;
        if ((free || mine) && !ui.nameClaim) { ui.nameClaim = cand; render(); }
      } catch {}
    })();
  }

  function claimForm(big) {
    suggestName();
    return h('div', { class: 'col', style: 'gap:8px;width:100%' },
      ui.nameClaimError ? h('div', { class: 'notice err' }, ui.nameClaimError) : null,
      h('div', { class: 'row gap6' },
        h('input', {
          type: 'text', placeholder: t('namesPlaceholder'), style: 'flex:1' + (big ? ';font-size:18px' : ''),
          autocapitalize: 'none', autocomplete: 'off', spellcheck: 'false',
          value: ui.nameClaim || '',
          onInput: (e) => { ui.nameClaim = e.target.value.toLowerCase().trim(); },
        }),
        h('span', { class: 'muted', style: 'align-self:center' }, '@' + DOMAIN())),
      h('button', { class: 'btn-primary btn-block', disabled: ui.busy, onClick: async () => {
        const name = (ui.nameClaim || '').toLowerCase().trim();
        if (!name) return;
        ui.busy = true; ui.nameClaimError = null; render();
        try {
          // Sign with the login identity when one can be (re)attached: the
          // registrar lets a migrated coinos user's own identity take their
          // name back, which the wallet key alone could never prove.
          const signer = await Promise.resolve(hook('nostrLoginResume')).catch(() => null);
          await claim(name, signer ? { signer, manager: wallet.nostrPubkey() } : {});
          ui.nameClaim = '';
          ui.nameEditOpen = false;
          toast(t('namesClaimed', { name: `${name}@${DOMAIN()}` }));
        } catch (e) { ui.nameClaimError = e.message; }
        ui.busy = false; render();
      } }, ui.busy ? h('span', { class: 'spinner' }) : t('namesClaim')));
  }

  function namesCard() {
    if (!available()) return null;
    const st = load();
    if (st.name) {
      const addr = `${st.name}@${st.domain || DOMAIN()}`;
      return h('div', { class: 'card col' },
        h('h3', {}, t('namesTitle')),
        h('div', { class: 'addr-box break', style: 'font-size:14px' }, addr),
        h('div', { class: 'row gap6' },
          copyBtn(`${st.name}@${st.domain || DOMAIN()}`, t('namesCopy')),
          h('button', { class: 'btn-ghost btn-sm', onClick: async () => {
            await release(); toast(t('namesReleased')); render();
          } }, t('namesRelease'))),
        h('details', { class: 'small faint' },
          h('summary', {}, t('namesCustom')),
          h('p', { style: 'margin:4px 0' }, t('namesCustomHow')),
          claimForm(false)),
        (() => {
          const code = hook('nwcOfferString');
          return code ? h('details', { class: 'small faint' },
            h('summary', {}, t('namesZapCode')),
            h('p', { style: 'margin:4px 0' }, t('namesZapCodeHow')),
            h('div', { class: 'addr-box break', style: 'font-size:10px' }, code),
            copyBtn(code, t('namesZapCodeCopy'))) : null;
        })(),
        h('details', { class: 'small faint' },
          h('summary', {}, t('namesOwnDomain')),
          h('p', { style: 'margin:4px 0' }, t('namesOwnDomainHow')),
          h('div', { class: 'addr-box break', style: 'font-size:11px' },
            `${st.name}.user._bitcoin-payment.yourdomain.com. CNAME ${st.name}.user._bitcoin-payment.${st.domain || DOMAIN()}.`)));
    }
    return h('div', { class: 'card col' },
      h('h3', {}, t('namesTitle')),
      h('p', { class: 'small muted', style: 'margin:0' }, t('namesDesc')),
      claimForm(false));
  }

  // The Receive tab's default pane: your name, big and scannable.
  function namePane(seg) {
    const st = load();
    if (!st.name && !checked) {
      return h('div', { class: 'card col', style: 'align-items:center;gap:10px' },
        seg, h('span', { class: 'spinner' }),
        h('div', { class: 'small muted' }, t('namesSettingUp')));
    }
    if (!st.name) {
      return h('div', { class: 'card col', style: 'gap:10px' },
        seg,
        lastError ? h('div', { class: 'notice err small' }, t('namesAutoFailed', { why: lastError })) : null,
        h('p', { class: 'small muted', style: 'margin:0' }, t('namesDesc')),
        claimForm(false));
    }
    const addr = `${st.name}@${st.domain || DOMAIN()}`;
    // The more-options section takes over the card when open: two payment
    // codes on screen at once is a good way to have someone scan the wrong one.
    if (ui.namesMore) return h('div', { class: 'card col', style: 'align-items:center;gap:14px' }, seg, moreSection());
    return h('div', { class: 'card col', style: 'align-items:center;gap:14px' },
      seg,
      h('div', { html: qrSvg(addr) }),
      h('div', { class: 'addr-box addr-editable', style: 'width:100%;font-size:16px' },
        addr,
        // editing and copying live right where the name is
        h('span', { class: 'addr-actions' },
          h('button', {
            title: t('namesCustom'),
            onClick: () => { ui.nameEditOpen = true; ui.nameClaimError = null; render(); },
            html: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>',
          }),
          h('button', {
            title: t('namesCopy'),
            onClick: () => copy(addr),
            html: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
          }))),
      moreSection());
  }

  // ---- BOLT 12 offers with a memo ----------------------------------------
  // A reusable offer some payers want instead of a lightning address (mining
  // pools like Ocean pay to one, and the memo is how you label the payout).
  // Settled offer payments ride the registrar's forwarder into Spending, the
  // same path the address already uses.
  async function loadOffers() {
    if (ui.namesOffers) return;
    ui.namesOffers = 'loading';
    try {
      const j = await post('/offer', 'GET');
      ui.namesOffers = j.offers || [];
    } catch (e) {
      ui.namesOffers = [];
      ui.namesOfferError = e.message;
    }
    render();
  }

  async function createOffer() {
    const memo = (ui.namesOfferMemo || '').trim();
    ui.namesOfferBusy = true; ui.namesOfferError = null; render();
    try {
      const j = await post('/offer', 'POST', { memo });
      ui.namesOffers = [
        ...(Array.isArray(ui.namesOffers) ? ui.namesOffers.filter((o) => o.offerId !== j.offerId) : []),
        { offerId: j.offerId, memo: j.memo, bolt12: j.bolt12 },
      ];
      ui.namesOfferMemo = '';
    } catch (e) {
      ui.namesOfferError = e.message;
    }
    ui.namesOfferBusy = false; render();
  }

  function offerPane() {
    const offers = Array.isArray(ui.namesOffers) ? ui.namesOffers : [];
    return h('div', { class: 'col', style: 'gap:10px;width:100%' },
      h('div', { class: 'row gap6' },
        h('input', {
          type: 'text', class: 'grow', maxlength: '120',
          placeholder: t('namesOfferMemoPh'),
          value: ui.namesOfferMemo || '',
          onInput: (e) => { ui.namesOfferMemo = e.target.value; },
        }),
        h('button', { class: 'btn-sm', disabled: !!ui.namesOfferBusy, onClick: createOffer },
          ui.namesOfferBusy ? h('span', { class: 'spinner sm' }) : t('namesOfferCreate'))),
      ui.namesOfferError ? h('div', { class: 'notice err small' }, ui.namesOfferError) : null,
      ui.namesOffers === 'loading' ? h('span', { class: 'spinner sm' }) : null,
      ...offers.map((o) =>
        h('div', { class: 'col', style: 'gap:6px;width:100%' },
          h('div', { class: 'small muted' }, o.memo || t('namesOfferNoMemo')),
          h('div', { class: 'addr-box break', style: 'width:100%;font-size:11px' }, o.bolt12),
          h('div', { class: 'row gap6' },
            copyBtn(o.bolt12, t('copy')),
            h('button', { class: 'btn-sm', onClick: () => { ui.namesOfferQr = ui.namesOfferQr === o.offerId ? null : o.offerId; render(); } }, t('namesOfferQr'))),
          ui.namesOfferQr === o.offerId
            ? h('div', { style: 'align-self:center', html: qrSvg(o.bolt12.toUpperCase(), { ec: 'L', mode: 'Alphanumeric' }) })
            : null)));
  }

  // ---- one-time BOLT 11 invoice (minted by the ASP against this wallet) ---

  async function createInvoice() {
    const inv = ui.namesInv || (ui.namesInv = {});
    const sat = Math.floor(Number(inv.amount));
    if (!sat || sat < 1) { inv.error = t('namesInvBadAmount'); render(); return; }
    inv.busy = true; inv.error = null; render();
    try {
      const a = await hook('arkMakeInvoice', sat, (inv.memo || '').trim().slice(0, 100));
      inv.invoice = a.invoice;
    } catch (e) { inv.error = e.message; }
    inv.busy = false; render();
  }

  function invoicePane() {
    const inv = ui.namesInv || (ui.namesInv = {});
    if (inv.invoice)
      return h('div', { class: 'col', style: 'gap:10px;width:100%;align-items:center' },
        h('div', { html: qrSvg(inv.invoice.toUpperCase(), { ec: 'L', mode: 'Alphanumeric' }) }),
        h('div', { class: 'addr-box break', style: 'width:100%;font-size:11px' }, inv.invoice),
        h('div', { class: 'row gap6' },
          copyBtn(inv.invoice, t('copy')),
          h('button', { class: 'btn-sm', onClick: () => { ui.namesInv = {}; render(); } }, t('namesInvNew'))));
    return h('div', { class: 'col', style: 'gap:10px;width:100%' },
      h('input', {
        type: 'number', inputmode: 'numeric', min: '1',
        placeholder: t('namesInvAmountPh'),
        value: inv.amount || '',
        onInput: (e) => { inv.amount = e.target.value; },
      }),
      h('input', {
        type: 'text', maxlength: '100',
        placeholder: t('namesInvMemoPh'),
        value: inv.memo || '',
        onInput: (e) => { inv.memo = e.target.value; },
      }),
      inv.error ? h('div', { class: 'notice err small' }, inv.error) : null,
      h('button', { class: 'btn-primary btn-block', disabled: !!inv.busy, onClick: createInvoice },
        inv.busy ? h('span', { class: 'spinner sm' }) : t('namesInvCreate')));
  }

  // ---- the raw ark address & the CLINK offer code -------------------------

  function arkPane() {
    if (!ui.namesArkAddr) {
      ui.namesArkAddr = 'loading';
      Promise.resolve(hook('arkStaticAddress'))
        .then((a) => { ui.namesArkAddr = a ? { address: a } : { error: t('namesNeedArk') }; })
        .catch((e) => { ui.namesArkAddr = { error: e.message }; })
        .then(render);
    }
    const st = ui.namesArkAddr;
    if (st === 'loading') return h('span', { class: 'spinner', style: 'align-self:center' });
    if (st.error) return h('div', { class: 'notice err small', style: 'width:100%' }, st.error);
    return h('div', { class: 'col', style: 'gap:10px;width:100%;align-items:center' },
      h('div', { html: qrSvg(st.address) }),
      h('div', { class: 'addr-box break', style: 'width:100%;font-size:11px' }, st.address),
      copyBtn(st.address, t('copy')));
  }

  function clinkPane() {
    const code = hook('nwcOfferString');
    if (!code) return h('div', { class: 'notice err small', style: 'width:100%' }, t('namesNeedArk'));
    return h('div', { class: 'col', style: 'gap:10px;width:100%;align-items:center' },
      h('div', { html: qrSvg(code) }),
      h('div', { class: 'addr-box break', style: 'width:100%;font-size:10px' }, code),
      copyBtn(code, t('copy')),
      h('p', { class: 'small muted', style: 'margin:0' }, t('namesZapCodeHow')));
  }

  // ---- more options -------------------------------------------------------
  // The address covers almost everyone; behind one link live the other codes
  // a payer might insist on.

  function menuPane() {
    const opt = (id, label, how, onOpen) => h('div', {
      class: 'item col clickable', style: 'gap:2px;align-items:flex-start',
      onClick: () => { ui.namesMore = id; if (onOpen) onOpen(); render(); },
    },
      h('strong', { class: 'small' }, label),
      h('span', { class: 'small muted' }, how));
    return h('div', { class: 'list', style: 'width:100%' },
      opt('bolt11', t('namesMoreBolt11'), t('namesMoreBolt11How')),
      opt('bolt12', t('namesMoreBolt12'), t('namesMoreBolt12How'), loadOffers),
      opt('ark', t('namesMoreArk'), t('namesMoreArkHow')),
      opt('clink', t('namesMoreClink'), t('namesMoreClinkHow')),
      // Not a pane: a plain on-chain address means receiving to Savings, so
      // this hands over to the savings receive view instead of showing a
      // second address here.
      opt('onchain', t('namesMoreOnchain'), t('namesMoreOnchainHow'),
        () => { ui.namesMore = null; setAccount('savings'); }));
  }

  function moreSection() {
    if (!ui.namesMore) {
      return h('button', {
        class: 'linklike small',
        onClick: () => { ui.namesMore = 'menu'; render(); },
      }, t('namesMoreOpen'));
    }
    const titles = {
      menu: t('namesMoreTitle'),
      bolt11: t('namesMoreBolt11'),
      bolt12: t('namesMoreBolt12'),
      ark: t('namesMoreArk'),
      clink: t('namesMoreClink'),
    };
    const body = ui.namesMore === 'bolt11' ? invoicePane()
      : ui.namesMore === 'bolt12' ? offerPane()
      : ui.namesMore === 'ark' ? arkPane()
      : ui.namesMore === 'clink' ? clinkPane()
      : menuPane();
    return h('div', { class: 'col', style: 'gap:10px;width:100%' },
      h('div', { class: 'row between', style: 'align-items:baseline' },
        h('strong', {}, titles[ui.namesMore] || titles.menu),
        h('button', {
          class: 'linklike small',
          onClick: () => { ui.namesMore = ui.namesMore === 'menu' ? null : 'menu'; render(); },
        }, t('back'))),
      body);
  }

  return {
    id: 'names',
    init() { checked = false; lastError = null; refresh(); },
    // The pencil by the address opens this: choosing a name gets a page of
    // its own — no balances, no tabs, just the name.
    screenView() {
      if (ui.screen !== 'wallet' || !ui.nameEditOpen) return null;
      const st = load();
      const addr = st.name ? `${st.name}@${st.domain || DOMAIN()}` : null;
      return h('div', { class: 'col', style: 'gap:16px' },
        brandHeader(false),
        h('div', { class: 'card col' },
          h('h3', {}, t('namesCustom')),
          addr ? h('div', { class: 'addr-box break', style: 'font-size:14px' }, addr) : null,
          h('p', { class: 'small muted', style: 'margin:0' }, t('namesCustomHow')),
          claimForm(true)),
        h('button', { class: 'btn-ghost btn-block', onClick: () => goBack(() => { ui.nameEditOpen = null; ui.nameClaimError = null; }) }, t('back')));
    },
    namesAdoptIdentity(signer, npub) { return adoptIdentity(signer, npub); },
    // the claimed payment address, for anyone prefilling a lightning address
    namesAddress() { const st = load(); return st.name ? `${st.name}@${st.domain || DOMAIN()}` : null; },
    // Sign-in races this lookup against the seed work: by the time the
    // wallet opens, the answer is usually already in hand…
    namesLookupByPk(pk) {
      if (!pk) return null;
      return fetch(`${REGISTRAR}/pubkey/${pk}?domain=${encodeURIComponent(DOMAIN())}`)
        .then((x) => x.json()).catch(() => null);
    },
    // …and this seeds it into state just before the first paint, so the
    // Receive pane opens with the QR instead of "setting up your address".
    namesSeed(rec) {
      if (!rec || !rec.name) return null;
      const st = load();
      if (!st.name) save({ name: rec.name, domain: rec.domain || DOMAIN(), uri: rec.uri });
      return true;
    },
    // 'pending' while the restore/claim pass is still running — the wallet
    // screen holds spending-setup prompts until the name question is settled.
    namesSettled() { return checked ? 'yes' : 'pending'; },
    // the onboarding wizard renders the same claim form on its username step
    namesClaimForm() { return claimForm(true); },
    // claim a specific name (the migration flow, after coinos.io released it)
    namesClaimName(name, opts) { return claim(String(name).toLowerCase(), opts || {}); },
    stop() { clearTimeout(retryTimer); clearTimeout(deadline); deadline = null; },
    receiveModes() {
      if (!available()) return [];
      return [{
        id: 'name', label: t('receiveNameTab'),
        icon: '<svg viewBox="0 0 72 72" width="18" height="18" fill="currentColor"><path fill-rule="evenodd" d="M36 4.2C18.5 4.2 4.2 18.5 4.2 36S18.5 67.8 36 67.8 67.8 53.5 67.8 36 53.5 4.2 36 4.2ZM0 36C0 16.1 16.1 0 36 0s36 16.1 36 36-16.1 36-36 36S0 55.9 0 36Z"/><path fill-rule="evenodd" d="M36 58.6c12.5 0 22.6-10.1 22.6-22.6S48.5 13.4 36 13.4 13.4 23.5 13.4 36 23.5 58.6 36 58.6ZM36 54c9.9 0 18-8.1 18-18s-8.1-18-18-18-18 8.1-18 18 8.1 18 18 18Z"/><path d="M36 22.9c-7.2 0-13.1 5.9-13.1 13.1S28.8 49.1 36 49.1V22.9Z"/></svg>',
        render: (seg) => namePane(seg),
      }];
    },
    // BEFORE zaps in the registry: a pasted user@domain tries DNS first.
    matchSendText(text, typed) {
      if (typed) return false; // don't yank the form away mid-keystroke
      if (!ui.send || ui.send.recipients.length !== 1) return false;
      return beginResolve(text);
    },
    // DNS resolution takes visible time — say so under the recipient field
    // instead of leaving a picked name looking ignored.
    sendFormNote(a) {
      const nr = ui.nameResolve;
      if (nr && nr.text === a) {
        return h('div', { class: 'row gap6', style: 'align-items:center;justify-content:center' },
          h('span', { class: 'spinner sm' }),
          h('span', { class: 'small muted' }, t('namesResolving', { name: String(a || '').trim() })));
      }
      // A TYPED name on one of our domains: offer the native send (BIP-353 →
      // instant ark) as a button, mirroring the zap affordance — typed input
      // never auto-advances, since a half-typed domain parses as a name too.
      // This note outranks the zaps one (feature order), so our names get the
      // free instant rail instead of an LNURL round-trip.
      const parsed = parsePaymentName(a);
      if (parsed && OUR_DOMAINS.includes(parsed.domain) && hook('arkReady')) {
        return h('button', {
          type: 'button', class: 'btn-primary btn-block',
          onClick: () => beginResolve(a),
        }, t('namesSendTo', { name: `${parsed.name}@${parsed.domain}` }));
      }
      return null;
    },
    settingsCards() { return [namesCard()]; },
  };
}
