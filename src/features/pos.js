// Point of sale: a bill for a stated amount, an optional tip prompt for the
// customer (a few percentages, or their own figure), one Lightning invoice
// for the total — and a ledger that keeps the bill and the tip apart, so a
// day's tips can be counted on their own.
//
// Everything money-shaped goes through the Ark feature's Lightning receive
// (the same invoices the Receive tab hands out); this file is the flow and
// the ledger. Amounts are typed in the display unit (sats / BTC / your
// currency) and kept in sats, with the fiat rate at the time of the sale
// remembered so a receipt reads the same later.
import { qrSvg } from '../qr.js';
import { rateNow, getCurrency, fmtFiat } from '../rates.js';
import { t } from '../i18n.js';

export function posFeature(ctx) {
  const { h, ui, render, wallet, toast, copy, fmtAmount, unitLabel, unitTag, parseAmount, getUnit } = ctx;
  const hook = ctx.hook || (() => null);

  // ---- state ---------------------------------------------------------------
  // { sales: [{ id, at, billSat, tipSat, tipPct, note, invoice, lnId, status: 'open'|'paid'|'void', fiat: { code, rate } }],
  //   askTip: true, tips: [10, 15, 20] }
  const st = () => {
    const s = wallet.loadFeatureState('pos', {}) || {};
    s.sales ||= [];
    if (s.askTip == null) s.askTip = true;
    if (!Array.isArray(s.tips) || !s.tips.length) s.tips = [10, 15, 20];
    return s;
  };
  const save = (s) => { try { wallet.saveFeatureState('pos', s); } catch {} };
  const SALES_MAX = 500;
  // Point-of-sale mode is per device (the till, not every phone the owner
  // carries): with it on, the app opens straight onto the point of sale.
  const POS_MODE = 'btc-wallet-pos-mode';
  const posMode = () => { try { return localStorage.getItem(POS_MODE) === '1'; } catch { return false; } };
  const setPosMode = (on) => { try { if (on) localStorage.setItem(POS_MODE, '1'); else localStorage.removeItem(POS_MODE); } catch {} };

  const fiatLine = (sats, rate = rateNow(), code = getCurrency()) => (rate ? fmtFiat(sats, rate, code) : '');
  const pct = (sats, p) => Math.round(sats * p / 100);
  const dayKey = (ms) => new Date(ms).toDateString();

  // ---- flow ----------------------------------------------------------------
  // ui.pos: { step: 'amount'|'tip'|'invoice'|'paid', amount, note, tipMode, tipCustom, sale, error, busy }
  function open() {
    ui.pos = { step: 'amount', amount: '', note: '', tipMode: null, tipCustom: '', sale: null, error: '' };
    render();
  }
  // Digits on screen, into the same field a keyboard or a paste would fill.
  // In the user's currency the pad works like a till: digits shift in from
  // the right with two decimals, so 5 is 0.05, 277 is 2.77, 5588 is 55.88,
  // and the "." key becomes "00". Sats are whole numbers and type plainly.
  function numpad(get, set) {
    const cents = getUnit() === 'fiat';
    const press = (k) => {
      let v = String(get() || '');
      if (cents) {
        let d = v.replace(/\D/g, '');
        if (k === 'del') d = d.slice(0, -1);
        else d = (d + (k === '.' ? '00' : k)).slice(0, 12);
        d = d.replace(/^0+/, '');
        v = d ? (parseInt(d, 10) / 100).toFixed(2) : '';
      } else if (k === 'del') v = v.slice(0, -1);
      else if (k === '.') { if (!v.includes('.')) v = (v || '0') + '.'; }
      else if (v === '0') v = k;
      else v += k;
      set(v); render();
    };
    const key = (k, label) => h('button', { class: 'pos-key' + (k === 'del' ? ' del' : ''), type: 'button', 'aria-label': k === 'del' ? t('posBackspace') : label, onClick: () => press(k) }, label);
    return h('div', { class: 'pos-pad' },
      ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => key(k, k)),
      key('.', cents ? '00' : '.'), key('0', '0'), key('del', '\u232b'));
  }
  function close() {
    const p = ui.pos;
    if (p && p.sale && p.sale.status === 'open') voidSale(p.sale);
    ui.pos = null;
    render();
  }
  function billSat() {
    const p = ui.pos;
    const n = parseAmount(p.amount, getUnit());
    return n && n > 0 ? n : 0;
  }
  function charge() {
    const p = ui.pos;
    const bill = billSat();
    if (!bill) { p.error = t('posEnterAmount'); render(); return; }
    p.error = '';
    if (!hook('arkReady')) { p.error = t('posNeedsSpending'); render(); return; }
    if (st().askTip) { p.step = 'tip'; p.tipMode = null; p.tipCustom = ''; render(); return; }
    makeSale(bill, 0, 0);
  }
  function tipSat() {
    const p = ui.pos, bill = billSat();
    if (p.tipMode == null || p.tipMode === 'none') return 0;
    if (p.tipMode === 'custom') { const n = parseAmount(p.tipCustom, getUnit()); return n && n > 0 ? n : 0; }
    return pct(bill, p.tipMode);
  }
  async function makeSale(bill, tip, tipPct) {
    const p = ui.pos;
    p.busy = true; p.error = ''; render();
    const s = st();
    const sale = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      at: Date.now(), billSat: bill, tipSat: tip, tipPct, note: (p.note || '').trim().slice(0, 80),
      status: 'open', fiat: rateNow() ? { code: getCurrency(), rate: rateNow() } : null,
    };
    try {
      const memo = (sale.note ? sale.note + ' · ' : '') + t('posMemo', { bill: fmtAmount(bill) + ' ' + unitLabel(), tip: tip ? fmtAmount(tip) + ' ' + unitLabel() : '0' });
      const inv = await hook('arkLnInvoice', bill + tip, memo.slice(0, 120));
      if (!inv || !inv.invoice) throw new Error(t('posInvoiceFailed'));
      sale.invoice = inv.invoice; sale.lnId = inv.id;
      s.sales.push(sale);
      if (s.sales.length > SALES_MAX) s.sales = s.sales.slice(-SALES_MAX);
      save(s);
      p.sale = sale; p.step = 'invoice';
      hook('arkLnWatch', inv.id, (a) => settle(sale, a));
    } catch (e) {
      console.warn('pos: invoice failed', e);
      p.error = (e && e.message) || String(e);
    }
    p.busy = false; render();
  }
  function settle(sale, action) {
    const s = st();
    const row = s.sales.find((x) => x.id === sale.id);
    const paid = action && action.step === 'done';
    if (row) { row.status = paid ? 'paid' : 'void'; if (paid) row.paidAt = Date.now(); save(s); }
    if (ui.pos && ui.pos.sale && ui.pos.sale.id === sale.id) {
      ui.pos.sale = row || sale;
      ui.pos.step = paid ? 'paid' : 'amount';
      if (!paid) ui.pos.error = t('posInvoiceExpired');
    }
    render();
  }
  function voidSale(sale) {
    const s = st();
    const row = s.sales.find((x) => x.id === sale.id);
    if (row && row.status === 'open') { row.status = 'void'; save(s); }
    if (sale.lnId) { hook('arkLnUnwatch', sale.lnId); Promise.resolve(hook('arkLnCancel', sale.lnId)).catch(() => {}); }
  }
  function newSale() {
    const p = ui.pos;
    if (p.sale && p.sale.status === 'open') voidSale(p.sale);
    Object.assign(p, { step: 'amount', amount: '', note: '', tipMode: null, tipCustom: '', sale: null, error: '' });
    render();
  }

  // A paid sale's row opens the same payment detail the history page shows,
  // found by the invoice the movement recorded.
  const movementOf = (sale) => (hook('arkMovements') || []).find((m) => m.type === 'ln-receive' && m.status === 'complete' && m.invoice && m.invoice === sale.invoice) || null;
  function openSale(sale) {
    const m = movementOf(sale);
    if (!m) { toast(t('posNoDetail')); return; }
    // the money arrived while nobody was watching the till (app closed,
    // screen elsewhere): the record says so now
    if (sale.status !== 'paid') {
      const s = st();
      const row = s.sales.find((x) => x.id === sale.id);
      if (row) { row.status = 'paid'; row.paidAt = row.paidAt || m.ts || Date.now(); save(s); }
    }
    ui.arkMoveDetail = m.id;
    render();
  }
  // Sales the till never saw settle, but the wallet did: adopt them on paint.
  function adoptPaid(s) {
    let changed = false;
    for (const x of s.sales) {
      if (x.status === 'paid') continue;
      const m = movementOf(x);
      if (m) { x.status = 'paid'; x.paidAt = x.paidAt || m.ts || Date.now(); changed = true; }
    }
    if (changed) save(s);
  }
  const saleOfMovement = (m) => (m && m.type === 'ln-receive' && m.invoice ? st().sales.find((x) => x.invoice === m.invoice) : null);

  // ---- screens -------------------------------------------------------------
  const big = (text) => h('div', { class: 'pos-big' }, text);
  // The amount in the display unit, and underneath in the other one: the
  // sats a payer's wallet will show under a fiat total, or the money under
  // a sats total — a rate gone wrong is then plain to see on the counter.
  const money = (sats, rate) => h('div', { class: 'col', style: 'align-items:center;gap:2px' },
    big(fmtAmount(sats) + ' ' + unitLabel()),
    getUnit() === 'fiat'
      ? h('div', { class: 'muted' }, Number(sats).toLocaleString('en-US') + ' sats')
      : fiatLine(sats, rate) ? h('div', { class: 'muted' }, fiatLine(sats, rate)) : null);
  const back = () => h('button', { class: 'btn-ghost btn-block', onClick: close }, t('back'));

  function amountScreen(p) {
    const s = st();
    return h('div', { class: 'col', style: 'gap:16px' },
      ctx.brandHeader(false),
      h('div', { class: 'card col', style: 'gap:12px' },
        h('h3', { style: 'margin:0' }, t('posTitle')),
        h('div', { class: 'input-group' },
          h('input', {
            type: 'text', inputmode: 'decimal', class: 'pos-amount', placeholder: '0', value: p.amount,
            onInput: (e) => { p.amount = e.target.value; render(); },
            onKeydown: (e) => { if (e.key === 'Enter') charge(); },
          }),
          unitTag()),
        getUnit() !== 'fiat' && billSat() && fiatLine(billSat()) ? h('div', { class: 'small muted', style: 'text-align:right' }, fiatLine(billSat())) : null,
        numpad(() => p.amount, (v) => { p.amount = v; }),
        h('input', { type: 'text', placeholder: t('posNoteHint'), value: p.note, maxlength: '80', onInput: (e) => { p.note = e.target.value; } }),
        p.error ? h('div', { class: 'notice error small' }, p.error) : null,
        h('button', { class: 'btn-primary btn-block', disabled: !!p.busy, onClick: charge }, p.busy ? h('span', { class: 'spinner sm' }) : t('posCharge')),
        p.busy ? h('div', { class: 'small muted', style: 'text-align:center' }, t('posMakingInvoice')) : null),
      tipSettingsCard(s),
      salesCard(s),
      back());
  }
  function tipSettingsCard(s) {
    return h('div', { class: 'card col', style: 'gap:8px' },
      h('label', { class: 'row gap6', style: 'align-items:center;cursor:pointer' },
        h('input', { type: 'checkbox', checked: !!s.askTip, style: 'width:18px;height:18px;accent-color:var(--accent);margin:0',
          onChange: (e) => { const x = st(); x.askTip = e.target.checked; save(x); render(); } }),
        h('span', {}, t('posAskTip'))),
      s.askTip ? h('label', { class: 'row gap6', style: 'align-items:center' },
        h('span', { class: 'small muted', style: 'flex:0 0 auto' }, t('posTipChoices')),
        h('input', { type: 'text', class: 'grow', value: s.tips.join(', '), inputmode: 'numeric',
          onChange: (e) => {
            const x = st();
            const list = [...new Set(e.target.value.split(/[\s,]+/).map((v) => parseInt(v, 10)).filter((n) => n > 0 && n <= 100))].slice(0, 5);
            if (list.length) { x.tips = list; save(x); }
            render();
          } }),
        h('span', { class: 'small muted' }, '%')) : null);
  }
  function salesCard(s) {
    adoptPaid(s);
    const sales = [...s.sales].reverse();
    if (!sales.length) return null;
    const today = dayKey(Date.now());
    const paidToday = sales.filter((x) => x.status === 'paid' && dayKey(x.paidAt || x.at) === today);
    const sum = (k) => paidToday.reduce((n, x) => n + (x[k] || 0), 0);
    const row = (x) => h('div', {
      class: 'row between pos-sale' + (x.status === 'paid' ? '' : ' faint'),
      style: x.status === 'paid' ? 'cursor:pointer' : '',
      onClick: x.status === 'paid' ? () => openSale(x) : undefined,
    },
      h('div', { class: 'col', style: 'min-width:0;gap:1px' },
        h('span', {}, fmtAmount(x.billSat) + ' ' + unitLabel() + (x.tipSat ? ' + ' + fmtAmount(x.tipSat) + ' ' + t('posTipWord') : '')),
        h('span', { class: 'small muted', style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' },
          new Date(x.paidAt || x.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (x.note ? ' · ' + x.note : '')
          + (x.status === 'open' ? ' · ' + t('posAwaiting') : x.status === 'void' ? ' · ' + t('posVoid') : ''))),
      h('span', { class: 'amount-pos', style: 'white-space:nowrap' }, (x.status === 'paid' ? '+' : '') + fmtAmount(x.billSat + x.tipSat)));
    return h('div', { class: 'card col', style: 'gap:8px' },
      h('h3', { style: 'margin:0' }, t('posSalesToday')),
      h('div', { class: 'row between' }, h('span', { class: 'muted' }, t('posBills')), h('span', {}, fmtAmount(sum('billSat')) + ' ' + unitLabel())),
      h('div', { class: 'row between' }, h('span', { class: 'muted' }, t('posTips')), h('span', {}, fmtAmount(sum('tipSat')) + ' ' + unitLabel())),
      h('div', { class: 'row between', style: 'font-weight:600' }, h('span', {}, t('posTotal')), h('span', {}, fmtAmount(sum('billSat') + sum('tipSat')) + ' ' + unitLabel())),
      h('div', { class: 'col', style: 'gap:6px;margin-top:4px' }, ...sales.slice(0, 30).map(row)));
  }
  // The customer's screen: the bill, and how much to add to it.
  function tipScreen(p) {
    const bill = billSat();
    const s = st();
    const choice = (mode, label, sub) => h('button', {
      class: 'pos-tip' + (p.tipMode === mode ? ' on' : ''), type: 'button',
      onClick: () => { p.tipMode = mode; render(); },
    }, h('span', { class: 'pos-tip-label' }, label), sub ? h('span', { class: 'small muted' }, sub) : null);
    const tip = tipSat();
    return h('div', { class: 'col', style: 'gap:16px' },
      ctx.brandHeader(false),
      h('div', { class: 'card col', style: 'gap:14px;align-items:center' },
        h('div', { class: 'muted' }, t('posYourBill')),
        money(bill),
        h('div', { class: 'muted', style: 'margin-top:6px' }, t('posAddTip')),
        h('div', { class: 'pos-tips' },
          ...s.tips.map((n) => choice(n, n + '%', '+' + fmtAmount(pct(bill, n)) + ' ' + unitLabel())),
          choice('custom', t('posTipCustom'), null),
          choice('none', t('posNoTip'), null)),
        p.tipMode === 'custom' ? h('div', { class: 'col', style: 'width:100%;gap:8px' },
          h('div', { class: 'input-group' },
            h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', value: p.tipCustom, onInput: (e) => { p.tipCustom = e.target.value; render(); } }),
            h('span', { class: 'small muted', style: 'align-self:center;padding:0 8px' }, unitLabel())),
          numpad(() => p.tipCustom, (v) => { p.tipCustom = v; })) : null,
        p.tipMode != null ? h('div', { class: 'pos-total' }, t('posTotalLine', { n: fmtAmount(bill + tip) + ' ' + unitLabel() })) : null,
        p.error ? h('div', { class: 'notice error small', style: 'width:100%' }, p.error) : null,
        h('button', { class: 'btn-primary btn-block', disabled: p.tipMode == null || !!p.busy,
          onClick: () => makeSale(bill, tip, p.tipMode === 'custom' || p.tipMode === 'none' ? 0 : p.tipMode) },
          p.busy ? h('span', { class: 'spinner sm' }) : t('posContinue')),
        p.busy ? h('div', { class: 'small muted' }, t('posMakingInvoice')) : null),
      h('button', { class: 'btn-ghost btn-block', onClick: () => { p.step = 'amount'; render(); } }, t('back')));
  }
  function invoiceScreen(p) {
    const sale = p.sale;
    const total = sale.billSat + sale.tipSat;
    return h('div', { class: 'col', style: 'gap:16px' },
      ctx.brandHeader(false),
      h('div', { class: 'card col', style: 'gap:12px;align-items:center' },
        h('div', { class: 'muted' }, t('posScanToPay')),
        money(total, sale.fiat && sale.fiat.rate),
        sale.tipSat ? h('div', { class: 'small muted' }, t('posBreakdown', { bill: fmtAmount(sale.billSat), tip: fmtAmount(sale.tipSat), u: unitLabel() })) : null,
        h('div', { class: 'pos-qr', html: qrSvg(sale.invoice.toUpperCase()) }),
        h('div', { class: 'row gap6', style: 'width:100%' },
          h('button', { class: 'grow', onClick: () => copy(sale.invoice) }, t('copy')),
          h('button', { class: 'btn-ghost grow', onClick: newSale }, t('cancel'))),
        h('div', { class: 'row gap6', style: 'align-items:center' }, h('span', { class: 'spinner sm' }), h('span', { class: 'small muted' }, t('posWaiting')))));
  }
  function paidScreen(p) {
    const sale = p.sale;
    return h('div', { class: 'col', style: 'gap:16px' },
      ctx.brandHeader(false),
      h('div', { class: 'card col', style: 'gap:12px;align-items:center' },
        h('div', { class: 'pos-check' }, '✓'),
        h('h3', { style: 'margin:0' }, t('posPaid')),
        money(sale.billSat + sale.tipSat, sale.fiat && sale.fiat.rate),
        sale.tipSat ? h('div', { class: 'small muted' }, t('posBreakdown', { bill: fmtAmount(sale.billSat), tip: fmtAmount(sale.tipSat), u: unitLabel() })) : null,
        h('button', { class: 'btn-primary btn-block', onClick: newSale }, t('posNewSale'))),
      back());
  }
  function posScreen() {
    const p = ui.pos;
    if (p.step === 'tip') return tipScreen(p);
    if (p.step === 'invoice' && p.sale) return invoiceScreen(p);
    if (p.step === 'paid' && p.sale) return paidScreen(p);
    return amountScreen(p);
  }

  return {
    id: 'pos',
    // A wallet just opened: the /pos link or point-of-sale mode lands here.
    init() {
      if (ui.posAtBoot || posMode()) { ui.posAtBoot = false; open(); }
    },
    screenView() {
      if (ui.screen !== 'wallet' || !ui.pos) return null;
      return posScreen();
    },
    // Settings → Payments: the door, the mode, and where to bookmark.
    settingsCards() {
      const url = (typeof location !== 'undefined' ? location.origin : 'https://v3.coinos.io') + '/pos';
      return [h('div', { class: 'card col', style: 'gap:10px' },
        h('h3', {}, t('posTitle')),
        h('p', { class: 'small muted', style: 'margin:0' }, t('posDesc')),
        h('button', { class: 'btn-primary', onClick: open }, t('posOpen')),
        h('label', { class: 'row gap6', style: 'align-items:center;cursor:pointer' },
          h('input', { type: 'checkbox', checked: posMode(), style: 'width:18px;height:18px;accent-color:var(--accent);margin:0', onChange: (e) => { setPosMode(e.target.checked); render(); } }),
          h('span', {}, t('posModeToggle'))),
        h('p', { class: 'small faint', style: 'margin:0' }, t('posLinkHint', { url })))];
    },
    openPos: open,
    // The history detail of a till payment says what was the bill and what the tip.
    arkMoveDetailExtra(m, row) {
      const sale = saleOfMovement(m);
      if (!sale) return null;
      const line = row || ((k, v) => h('div', { class: 'line' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v)));
      return [
        line(t('posBills'), fmtAmount(sale.billSat) + ' ' + unitLabel()),
        line(t('posTips'), fmtAmount(sale.tipSat) + ' ' + unitLabel() + (sale.tipPct ? ' (' + sale.tipPct + '%)' : '')),
        sale.note ? line(t('posNoteLabel'), sale.note) : null,
      ];
    },
  };
}
