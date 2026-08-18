// Hats — cosmetic supporter hats, worn above the avatar everywhere it shows:
// chat rows, DMs, profile pages, notes, search results, the header.
//
// Ownership lives on the names registrar (a kind-0 field would be
// self-asserted — anyone could wear anything). Buying is a plain Lightning
// invoice minted by the registrar and paid headlessly from the Spending
// balance; the registrar grants on settle, and the sats simply stay with
// coinos. That's the whole point: a hat is proof you chipped in.
//
// Display is a batched lookup (`GET /hats?pks=…`) cached alongside nothing
// else — one request covers a whole room, answers persist for a few hours.
// The crown is Adam's and is not for sale.

import { t } from '../i18n.js';
import { fmtSats } from '../format.js';
import { nip98Header } from '../nostr-login.js';
import { getNetwork } from '../api.js';

const REGISTRAR = 'https://names.coinos.io';
// Hats exist per network: mainnet hats are the real supporter hats; mutinynet
// runs a parallel play-money economy so staging can exercise the whole flow.
const hatNet = () => (getNetwork() === 'mutinynet' ? 'mutinynet' : 'mainnet');
const ADMIN_PK = '98ae4da926c471c23fd12d1ebdd5839ba82917baa618e184e0c9916d93dcf4f7';

// One drawing per hat, tuned to perch on a circle: `w` scales against the
// avatar's width, `b` is where the hat's bottom sits (as % of avatar height,
// from the bottom), `r` gives it the jaunty angle.
const svg = (inner) => `<svg viewBox="0 0 64 44" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
const HATS = [
  {
    id: 'beanie', nameKey: 'hatBeanie', sat: 21, w: 96, b: 60, r: -8,
    art: svg(`<circle cx="32" cy="9" r="5.5" fill="#f3e6c9"/>
      <path d="M11 34 Q11 12 32 12 Q53 12 53 34 Z" fill="#e0554a"/>
      <path d="M20 14.5 Q26 25 25 32 M32 12.5 Q32 23 32 32 M44 14.5 Q38 25 39 32" stroke="#c9443b" stroke-width="2" fill="none"/>
      <rect x="8" y="31" width="48" height="10" rx="5" fill="#c9443b"/>
      <path d="M15 33 V39.5 M23 32.5 V40.5 M31 32.5 V40.5 M39 32.5 V40.5 M47 33 V39.5" stroke="#b23a32" stroke-width="2"/>`),
  },
  {
    id: 'party', nameKey: 'hatParty', sat: 2100, w: 78, b: 70, r: -11,
    art: svg(`<path d="M32 5 L46 39 Q32 44 18 39 Z" fill="#2fb3a5"/>
      <path d="M26.5 18.5 Q32 20.5 37.5 18.5 L40 24.5 Q32 27 24 24.5 Z" fill="#ff7bac"/>
      <path d="M21.5 30.5 Q32 34 42.5 30.5 L44.5 35.5 Q32 40 19.5 35.5 Z" fill="#ffd166"/>
      <circle cx="32" cy="5" r="4.2" fill="#ffd166"/>`),
  },
  {
    id: 'trucker', nameKey: 'hatTrucker', sat: 2100, w: 106, b: 62, r: -6,
    art: svg(`<path d="M9 33 Q9 10 29 10 Q49 10 49 33 Z" fill="#3579c2"/>
      <path d="M17 33 Q17 14 29 14 Q41 14 41 33 Z" fill="#f2f5f8"/>
      <text x="29" y="28" font-size="14" font-weight="700" text-anchor="middle" fill="#f7931a" font-family="system-ui,sans-serif">₿</text>
      <circle cx="29" cy="9.5" r="2.4" fill="#2a5f9c"/>
      <path d="M47 28.5 Q60 27 62 32.5 Q60 37 52 36.5 L46 34.5 Z" fill="#2a5f9c"/>
      <rect x="9" y="32" width="39" height="5" rx="2.5" fill="#2a5f9c"/>`),
  },
  {
    id: 'cowboy', nameKey: 'hatCowboy', sat: 21000, w: 122, b: 62, r: -7,
    art: svg(`<path d="M21 26 Q21 5 32 5 Q43 5 43 26 Z" fill="#a97844"/>
      <path d="M32 5.5 Q29.5 14 31 24" stroke="#8a5f33" stroke-width="1.8" fill="none"/>
      <rect x="20" y="20.5" width="24" height="5" rx="2" fill="#6f4a26"/>
      <path d="M6 27 Q5 18.5 11 24.5 L53 24.5 Q59 18.5 58 27 Q57 31.5 47 34.5 Q32 38.5 17 34.5 Q7 31.5 6 27 Z" fill="#a97844"/>
      <path d="M8 28 Q17 32.5 32 32.5 Q47 32.5 56 28" stroke="#8a5f33" stroke-width="1.5" fill="none"/>`),
  },
  {
    id: 'fedora', nameKey: 'hatFedora', sat: 21000, w: 118, b: 64, r: -8,
    art: svg(`<path d="M18 29 L20 11 Q32 6 44 11 L46 29 Z" fill="#4c525b" stroke="rgba(255,255,255,.1)" stroke-width="0.8"/>
      <path d="M20 11 Q32 15.5 44 11" stroke="#3a3f47" stroke-width="2" fill="none"/>
      <path d="M17.4 23 L46.6 23 L47 29 L17 29 Z" fill="#23262c"/>
      <path d="M6 31 Q32 25 58 31 Q58 37 32 37.5 Q6 37 6 31 Z" fill="#3a3f47" stroke="rgba(255,255,255,.1)" stroke-width="0.8"/>`),
  },
  {
    id: 'bowler', nameKey: 'hatBowler', sat: 210000, w: 104, b: 64, r: -7,
    art: svg(`<path d="M15 29 Q15 7 32 7 Q49 7 49 29 Z" fill="#2b2e35" stroke="rgba(255,255,255,.14)" stroke-width="0.8"/>
      <path d="M22 11 Q27 8.5 33 9.5" stroke="#464b55" stroke-width="2" fill="none" stroke-linecap="round"/>
      <path d="M14.6 24 L49.4 24 L49.6 29 L14.4 29 Z" fill="#17191d"/>
      <path d="M7 31 Q7 26.5 13 29 L51 29 Q57 26.5 57 31 Q57 36 32 36 Q7 36 7 31 Z" fill="#17191d" stroke="rgba(255,255,255,.14)" stroke-width="0.8"/>`),
  },
  {
    id: 'top', nameKey: 'hatTop', sat: 210000, w: 96, b: 66, r: -7,
    art: svg(`<path d="M17 5 Q32 1.5 47 5 L45.5 28 L18.5 28 Z" fill="#26282f" stroke="rgba(255,255,255,.14)" stroke-width="0.8"/>
      <path d="M18.7 22 L45.3 22 L45.6 28 L18.4 28 Z" fill="#b6382e"/>
      <path d="M7 30.5 Q7 26.5 14 29 L50 29 Q57 26.5 57 30.5 Q57 36 32 36 Q7 36 7 30.5 Z" fill="#17191d" stroke="rgba(255,255,255,.14)" stroke-width="0.8"/>`),
  },
  {
    id: 'wizard', nameKey: 'hatWizard', sat: 2100000, w: 112, b: 66, r: -4, dx: -8,
    art: svg(`<path d="M25 35 Q33 21 36.5 11 Q37.5 5.5 44 3 Q41 9 40 13 Q44 25 50 35 Z" fill="#6d4bb8"/>
      <circle cx="44.5" cy="3.5" r="2.6" fill="#ffd166"/>
      <ellipse cx="37" cy="36" rx="21" ry="5" fill="#59389f"/>
      <path d="M33 19 l1.2 2.6 2.6 1.2 -2.6 1.2 -1.2 2.6 -1.2 -2.6 -2.6 -1.2 2.6 -1.2 Z" fill="#ffd166"/>
      <path d="M41.5 26 l0.9 2 2 0.9 -2 0.9 -0.9 2 -0.9 -2 -2 -0.9 2 -0.9 Z" fill="#ffe08a"/>`),
  },
  {
    id: 'crown', nameKey: 'hatCrown', sat: null, w: 86, b: 66, r: -7,
    art: svg(`<path d="M10 38 L7 13 L20 25 L32 6 L44 25 L57 13 L54 38 Z" fill="#f2b32a"/>
      <circle cx="7" cy="12" r="3" fill="#ffd97a"/><circle cx="32" cy="6" r="3" fill="#ffd97a"/><circle cx="57" cy="12" r="3" fill="#ffd97a"/>
      <rect x="9" y="34" width="46" height="8" rx="2.5" fill="#d9930f"/>
      <circle cx="18" cy="38" r="2.2" fill="#e04a56"/><circle cx="32" cy="38" r="2.2" fill="#3a7bd5"/><circle cx="46" cy="38" r="2.2" fill="#3fae6a"/>`),
  },
];
const hatById = (id) => HATS.find((x) => x.id === id) || null;
const posStyle = (hat) => `width:${hat.w}%;bottom:${hat.b}%;transform:translateX(${-50 + (hat.dx || 0)}%) rotate(${hat.r}deg)`;

export function hatsFeature(ctx) {
  const { h, ui, render, wallet, hook, toast, brandHeader } = ctx;

  // ---- who wears what: batched lookup + persistent cache ------------------

  const TTL = 6 * 3600_000;
  const worn = new Map(); // pk -> { hat: id|null, t }
  let loaded = false;
  const loadStore = () => {
    if (loaded) return;
    loaded = true;
    try {
      for (const [pk, v] of Object.entries(wallet.loadFeatureState('hats', {}).worn || {}))
        worn.set(pk, v);
    } catch {}
  };
  let saveT = 0;
  const saveStore = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      try {
        const keep = [...worn.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, 300);
        wallet.saveFeatureState('hats', { worn: Object.fromEntries(keep) });
      } catch {}
    }, 800);
  };

  const pending = new Set();
  let fetchT = 0, failedAt = 0;
  const queueFetch = (pk) => {
    if (Date.now() - failedAt < 60_000) return;
    pending.add(pk);
    if (!fetchT) fetchT = setTimeout(flushFetch, 400);
  };
  async function flushFetch() {
    fetchT = 0;
    const pks = [...pending].slice(0, 100);
    pending.clear();
    if (!pks.length) return;
    try {
      const net = hatNet();
      const r = await fetch(`${REGISTRAR}/hats?pks=${pks.join(',')}&net=${net}`);
      const j = await r.json();
      if (!r.ok) throw new Error('hats lookup failed');
      const now = Date.now();
      for (const pk of pks) worn.set(net + ':' + pk, { hat: (j.hats || {})[pk] || null, t: now });
      saveStore();
      if ([...worn.entries()].some(([pk, v]) => v.hat && v.t === now)) render();
    } catch {
      failedAt = Date.now();
    }
  }

  // Stale-while-revalidate: answer from cache immediately, refresh behind.
  function hatFor(pk) {
    if (!pk || !/^[0-9a-f]{64}$/.test(pk)) return null;
    loadStore();
    const v = worn.get(hatNet() + ':' + pk);
    if (!v || Date.now() - v.t > TTL) queueFetch(pk);
    return v ? v.hat : null;
  }

  // ---- registrar calls ----------------------------------------------------

  const withTimeout = (p, ms, what) => Promise.race([
    p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out`)), ms)),
  ]);

  // Hats belong to the shown identity (login npub when there is one, else
  // the wallet key) — the same face the hat will sit on.
  async function identity() {
    const id = hook('nostrLoginIdentity');
    if (id) {
      const signer = id.signer || (await hook('nostrLoginResume'));
      return signer ? { pubkey: id.pubkey, signer } : null;
    }
    const pk = wallet.nostrPubkey && wallet.nostrPubkey();
    return pk ? { pubkey: pk, signer: { signEvent: (e) => wallet.nostrSign(e) } } : null;
  }

  async function post(path, payload, signer) {
    const url = `${REGISTRAR}${path}`;
    const body = JSON.stringify(payload);
    const auth = await withTimeout(nip98Header(signer, url, 'POST', body), 12000, 'signing');
    const r = await withTimeout(fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: auth }, body,
    }), 12000, 'registrar');
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) throw new Error(j.error || `registrar refused (${r.status})`);
    return j;
  }

  // ---- the shop -----------------------------------------------------------

  function openShop() {
    ui.hatShop = true;
    ui.hatShopData = null;
    ui.hatConfirm = null;
    render();
    const me = ctx.shownPubkey();
    if (!me) { ui.hatShopData = { owned: [], equipped: null }; render(); return; }
    fetch(`${REGISTRAR}/hats/${me}?net=${hatNet()}`).then((r) => r.json()).then((j) => {
      if (!ui.hatShop) return;
      ui.hatShopData = { owned: j.owned || [], equipped: j.equipped || null, prices: j.prices || null };
      const now = Date.now();
      worn.set(hatNet() + ':' + me, { hat: j.equipped || null, t: now });
      saveStore();
      render();
    }).catch(() => {
      if (ui.hatShop && !ui.hatShopData) { ui.hatShopData = { owned: [], equipped: null, offline: true }; render(); }
    });
  }
  const closeShop = () => { ui.hatShop = null; ui.hatShopData = null; ui.hatConfirm = null; render(); };

  async function buy(hat) {
    const price = priceOf(hat);
    if (!['mainnet', 'mutinynet'].includes(getNetwork())) { toast(t('hatMainnetOnly')); return; }
    if (!hook('arkReady')) { toast(t('hatNeedSpending')); return; }
    const spendable = hook('arkSpendableSat') || 0;
    // routing fee headroom: the ASP charges the quoted route fee (~1%)
    if (spendable < price + Math.ceil(price * 0.02) + 2) {
      toast(t('hatNoFunds', { sats: fmtSats(price) }));
      return;
    }
    ui.hatBuying = hat.id;
    render();
    try {
      const id = await identity();
      if (!id) throw new Error(t('msgNoIdentity'));
      const inv = await post('/hats/invoice', { hat: hat.id, net: hatNet() }, id.signer);
      await hook('arkPayInvoice', inv.invoice, { maxAmountSat: inv.sat });
      const rec = await post('/hats/claim', { paymentHash: inv.paymentHash, hat: hat.id, net: hatNet() }, id.signer);
      ui.hatShopData = { ...ui.hatShopData, owned: rec.owned, equipped: rec.equipped };
      worn.set(hatNet() + ':' + id.pubkey, { hat: rec.equipped, t: Date.now() });
      saveStore();
      toast(t('hatYours', { name: t(hat.nameKey) }));
    } catch (e) {
      toast(e.message || String(e));
    } finally {
      ui.hatBuying = null;
      ui.hatConfirm = null;
      render();
    }
  }

  async function equip(hatId) {
    ui.hatBuying = hatId || 'none';
    render();
    try {
      const id = await identity();
      if (!id) throw new Error(t('msgNoIdentity'));
      const rec = await post('/hats/equip', { hat: hatId, net: hatNet() }, id.signer);
      ui.hatShopData = { ...ui.hatShopData, owned: rec.owned, equipped: rec.equipped };
      worn.set(hatNet() + ':' + id.pubkey, { hat: rec.equipped, t: Date.now() });
      saveStore();
    } catch (e) {
      toast(e.message || String(e));
    } finally {
      ui.hatBuying = null;
      render();
    }
  }

  const priceOf = (hat) => {
    const d = ui.hatShopData;
    return (d && d.prices && d.prices[hat.id]) || hat.sat;
  };

  const demo = (hat) => h('span', { class: 'hat-demo' },
    h('span', { class: 'hat-demo-head' }),
    h('span', { class: 'ava-hat', style: posStyle(hat), html: hat.art }));

  function shopRow(hat, d, me) {
    const ownedHere = d && d.owned.includes(hat.id);
    const wearing = d && d.equipped === hat.id;
    const busy = ui.hatBuying === hat.id;
    let action;
    if (hat.id === 'crown' && me !== ADMIN_PK && !ownedHere) {
      action = h('span', { class: 'small faint' }, t('hatCrownTaken'));
    } else if (busy) {
      action = h('span', { class: 'spinner sm' });
    } else if (wearing) {
      action = h('button', { class: 'btn-sm hat-btn wearing', onClick: () => equip(null) }, t('hatWearing'));
    } else if (ownedHere) {
      action = h('button', { class: 'btn-sm hat-btn', onClick: () => equip(hat.id) }, t('hatWear'));
    } else if (ui.hatConfirm === hat.id) {
      action = h('button', { class: 'btn-sm hat-btn confirm', onClick: () => buy(hat) }, t('hatConfirmTap'));
    } else {
      action = h('button', {
        class: 'btn-sm hat-btn', disabled: !!ui.hatBuying,
        onClick: () => { ui.hatConfirm = hat.id; render(); setTimeout(() => { if (ui.hatConfirm === hat.id) { ui.hatConfirm = null; render(); } }, 5000); },
      }, fmtSats(priceOf(hat)) + ' sats');
    }
    return h('div', { class: 'hat-row' },
      demo(hat),
      h('div', { class: 'col grow', style: 'min-width:0;gap:1px' },
        h('div', { class: 'chat-name' }, t(hat.nameKey)),
        hat.id === 'crown'
          ? h('div', { class: 'muted small' }, t('hatCrownWho'))
          : ownedHere ? h('div', { class: 'muted small' }, t('hatOwned')) : null),
      action);
  }

  function shopScreen() {
    const d = ui.hatShopData;
    const me = ctx.shownPubkey();
    return h('div', { class: 'col', style: 'gap:16px' },
      brandHeader(false),
      h('div', { class: 'card col', style: 'gap:12px' },
        h('h3', { style: 'margin:0' }, '🎩 ' + t('hatShopTitle')),
        h('p', { class: 'small muted', style: 'margin:0' }, t('hatShopBlurb')),
        d === null
          ? h('div', { style: 'text-align:center;padding:16px' }, h('span', { class: 'spinner' }))
          : h('div', { class: 'col', style: 'gap:2px' },
              // the crown stays off the menu — it appears only for the head
              // that already wears it
              ...HATS.filter((hat) => hat.id !== 'crown' || me === ADMIN_PK || (d.owned || []).includes('crown'))
                .map((hat) => shopRow(hat, d, me))),
        d && d.offline ? h('div', { class: 'small faint', style: 'text-align:center' }, t('hatShopOffline')) : null),
      h('button', { class: 'btn-ghost btn-block', onClick: closeShop }, t('back')));
  }

  // -------------------------------------------------------------------------

  return {
    id: 'hats',
    // The avatar factory (and the search rows) offer every avatar up for
    // decoration; a bare head comes back null and is used as-is.
    wrapAvatar(pk, node) {
      const hat = hatById(hatFor(pk));
      if (!hat) return null;
      return h('span', { class: 'hat-wrap' },
        node,
        h('span', { class: 'ava-hat', style: posStyle(hat), html: hat.art }));
    },
    // Own-profile editor entry: the door to the shop.
    hatShopEntry() {
      return h('button', { class: 'btn-block', onClick: openShop }, '🎩 ' + t('hats'));
    },
    screenView() {
      if (ui.screen !== 'wallet' || !ui.hatShop) return null;
      return shopScreen();
    },
  };
}
