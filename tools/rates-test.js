// What a payment was worth WHEN IT HAPPENED. The price is sampled as the app
// runs and kept as a series; a payment's fiat value is read off the sample
// nearest its timestamp, and a payment older than anything we sampled is
// priced at today's number and SAID to be — never quietly.
//
// Run: bun tools/rates-test.js
let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(` ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + String(detail).slice(0, 90) : ''}`);
  if (!ok) fails++;
};
globalThis.localStorage = {
  _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); },
  removeItem(k) { delete this._d[k]; }, key(i) { return Object.keys(this._d)[i] ?? null; },
  get length() { return Object.keys(this._d).length; },
};
const HOUR = 3600;
const now = Math.floor(Date.now() / 1000);
// a week of hourly samples, climbing from 50k to 100k
const series = [];
for (let i = 7 * 24; i >= 0; i--) series.push([now - i * HOUR, 50_000 + (7 * 24 - i) * 300]);
localStorage.setItem('btc-wallet-rate-series', JSON.stringify(series));
localStorage.setItem('btc-wallet-rates', JSON.stringify({ USD: series[series.length - 1][1], EUR: 1234 }));

const { rateAt, rateNow, fmtFiat, getCurrency, setCurrency, currencies, RATE_TOLERANCE } = await import('../src/rates.js');
const { parseAmount, SATS } = await import('../src/format.js');

check('the live price is the newest sample', rateNow() === series[series.length - 1][1], String(rateNow()));

// a payment three days ago is priced at the price three days ago
const threeDays = now - 3 * 24 * HOUR;
const then = rateAt(threeDays);
const want = series.find(([ts]) => ts === threeDays)[1];
check('a payment is priced at the moment it happened', then.rate === want && !then.stale, `${then.rate} vs ${want}`);
check("...which isn't today's price", then.rate !== rateNow(), `${then.rate} vs ${rateNow()}`);

// a payment between samples takes the nearest one
const between = rateAt(threeDays + 900);
check('between samples, the nearest one wins', between.rate === want && !between.stale, String(between.rate));

// older than anything we have: today's price, flagged
const ancient = rateAt(now - 400 * 24 * HOUR);
check('an older payment than we have samples for is flagged', ancient.stale === true && ancient.rate === rateNow(), JSON.stringify(ancient));
check('...and the tolerance is a day', RATE_TOLERANCE === 24 * HOUR, String(RATE_TOLERANCE));

// no timestamp at all (a balance, a form) is simply the live price
check('an amount with no time is the live price', rateAt(null).rate === rateNow() && !rateAt(null).stale);

// typing money
check('typing 5 with the unit on fiat buys five dollars of bitcoin',
  parseAmount('5', 'fiat', 100_000) === Math.round((5 / 100_000) * SATS), String(parseAmount('5', 'fiat', 100_000)));
check('...and without a price it refuses rather than guessing', parseAmount('5', 'fiat', null) === null);
check('sats and BTC are untouched', parseAmount('2100', 'sats') === 2100 && parseAmount('0.001', 'btc') === 100_000);

// formatting
check('an amount formats as money', /\$1[,.]/.test(fmtFiat(SATS / 100, 100_000)), fmtFiat(SATS / 100, 100_000));
check('a small amount keeps more decimals', fmtFiat(100, 100_000).includes('0.10'), fmtFiat(100, 100_000));
check('a currency Intl has never heard of still renders', /XYZ/.test(fmtFiat(SATS, 10, 'XYZ')), fmtFiat(SATS, 10, 'XYZ'));

// changing currency drops the series rather than mislabelling it
check('the currency list comes from the rates map', currencies().includes('EUR'), currencies().join(','));
setCurrency('EUR');
check('changing currency starts the history again', JSON.parse(localStorage.getItem('btc-wallet-rate-series')).length <= 1,
  localStorage.getItem('btc-wallet-rate-series').slice(0, 40));
check('...and the live price follows it', rateNow() === 1234, String(rateNow()));
check('the choice sticks', getCurrency() === 'EUR');

console.log(fails ? `\n❌ ${fails} failed` : '\n✅ prices are remembered, not invented');
process.exit(fails ? 1 : 0);
