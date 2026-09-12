// What a bitcoin was worth, now and at the time.
//
// Two jobs. The first is the live price, for balances and for typing an
// amount in dollars. The second is history: a payment is worth what it was
// worth WHEN IT HAPPENED, and that number is gone by the time you look at it
// unless someone wrote it down. So every price we fetch is kept as a sample —
// one an hour, a few months back — and a payment's fiat value is read off the
// sample nearest its timestamp.
//
// The rates come from coinos' own endpoint (a map of every currency to the
// bitcoin price in it), so there's no third party watching what the wallet
// asks about.

const RATES_URL = 'https://coinos.io/api/rates';
const CUR_KEY = 'btc-wallet-currency';
const SERIES_KEY = 'btc-wallet-rate-series'; // [[unixSeconds, rate], ...] oldest first
const LIVE_KEY = 'btc-wallet-rates'; // the last full map, so a cold start has a price
const SAMPLE_MS = 3600_000; // one sample an hour is plenty to price a payment
const SERIES_MAX = 2200; // ~3 months
const REFRESH_MS = 10 * 60_000;
// How far a sample may be from a payment before it stops being "the price at
// the time". Beyond this we say so rather than quietly pricing last week's
// payment at today's number.
export const RATE_TOLERANCE = 24 * 3600;

let map = null; // { USD: 77239.99, ... }
let fetchedAt = 0;
let inflight = null;
let series = null;

const read = (k, fb) => { try { const v = JSON.parse(localStorage.getItem(k) || 'null'); return v == null ? fb : v; } catch { return fb; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

export function getCurrency() {
  try { return localStorage.getItem(CUR_KEY) || 'USD'; } catch { return 'USD'; }
}
export function setCurrency(code) {
  try { localStorage.setItem(CUR_KEY, String(code || 'USD').toUpperCase()); } catch {}
  // the series is denominated in whatever was chosen when it was recorded, so
  // a currency change starts a new one rather than mislabelling the old
  series = [];
  write(SERIES_KEY, series);
  if (map) sample(map[getCurrency()]);
}
export function currencies() {
  const m = map || read(LIVE_KEY, null);
  return m ? Object.keys(m).sort() : ['USD'];
}

function loadSeries() {
  if (!series) series = read(SERIES_KEY, []) || [];
  return series;
}
// Keep one sample an hour: a price that moves 2% in a minute is still the
// same answer to "what was this payment worth".
function sample(rate) {
  if (!rate || !isFinite(rate)) return;
  const s = loadSeries();
  const now = Math.floor(Date.now() / 1000);
  const last = s[s.length - 1];
  if (last && now - last[0] < SAMPLE_MS / 1000) { last[1] = rate; } // same hour: keep it current
  else s.push([now, rate]);
  if (s.length > SERIES_MAX) s.splice(0, s.length - SERIES_MAX);
  write(SERIES_KEY, s);
}

// The live price in the chosen currency, or null before we've ever had one.
export function rateNow() {
  if (!map) map = read(LIVE_KEY, null);
  const r = map && map[getCurrency()];
  return r && isFinite(r) ? r : null;
}

// The price at a moment: the nearest sample, and how far off it was. A caller
// that gets `stale` back is looking at today's price on an older payment and
// should say so.
export function rateAt(unixSeconds) {
  const now = rateNow();
  if (!unixSeconds) return { rate: now, stale: false };
  const s = loadSeries();
  if (!s.length) return { rate: now, stale: !!now };
  // binary search for the closest sample
  let lo = 0, hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid][0] < unixSeconds) lo = mid + 1; else hi = mid;
  }
  const near = [s[lo], s[lo - 1]].filter(Boolean)
    .sort((a, b) => Math.abs(a[0] - unixSeconds) - Math.abs(b[0] - unixSeconds))[0];
  const gap = Math.abs(near[0] - unixSeconds);
  if (gap <= RATE_TOLERANCE) return { rate: near[1], stale: false };
  return { rate: now, stale: !!now };
}

// Fetch the map, remember it, and record this moment's price. Cheap to call
// often — it refreshes at most every ten minutes.
export async function refreshRates({ force = false } = {}) {
  if (!force && Date.now() - fetchedAt < REFRESH_MS) return map;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(RATES_URL, { signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      if (!j || typeof j !== 'object' || !j.USD) throw new Error('bad rates');
      map = j;
      fetchedAt = Date.now();
      write(LIVE_KEY, j);
      sample(j[getCurrency()]);
      return map;
    } catch { return map; } finally { inflight = null; }
  })();
  return inflight;
}

// Does this build know a price at all? The unit toggle only offers fiat when
// it does — a third position that shows blanks is worse than two that work.
export const haveRate = () => rateNow() != null;

export function fmtFiat(sats, rate, code = getCurrency()) {
  if (!rate) return '';
  const v = (Number(sats) / 100_000_000) * rate;
  const digits = Math.abs(v) < 1 && v !== 0 ? 4 : 2;
  try {
    return v.toLocaleString(undefined, { style: 'currency', currency: code, maximumFractionDigits: digits, minimumFractionDigits: 2 });
  } catch {
    return v.toFixed(digits) + ' ' + code; // a code Intl doesn't know
  }
}
