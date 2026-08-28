// Build a single, self-contained dist/index.html (plus PWA sidecar files).
//
// Everything — app code, the @scure/@noble crypto libs, the QR generator, and
// all CSS — is bundled and inlined so the result is one file you can save and
// open offline straight from the filesystem (file://). No server, no network.
//
// For the hosted site we also emit a web manifest, icons, and a small service
// worker so the page can be installed as a PWA and still work offline once
// installed. index.html stays self-contained; these are optional extras that
// simply 404 (harmlessly) when the file is opened on its own from file://.

import { mkdir, readdir } from 'node:fs/promises';

const FAVICON = 'data:image/svg+xml,%3Csvg%20width%3D%2272%22%20height%3D%2272%22%20viewBox%3D%220%200%2072%2072%22%20fill%3D%22none%22%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%3E%20%3Cpath%20d%3D%22M69.8824%2036C69.8824%2054.7127%2054.7127%2069.8824%2036%2069.8824C17.2873%2069.8824%202.11765%2054.7127%202.11765%2036C2.11765%2017.2873%2017.2873%202.11765%2036%202.11765C54.7127%202.11765%2069.8824%2017.2873%2069.8824%2036Z%22%20fill%3D%22white%22/%3E%20%3Cpath%20fill-rule%3D%22evenodd%22%20clip-rule%3D%22evenodd%22%20d%3D%22M36%204.23529C18.4568%204.23529%204.23529%2018.4568%204.23529%2036C4.23529%2053.5432%2018.4568%2067.7647%2036%2067.7647C53.5432%2067.7647%2067.7647%2053.5432%2067.7647%2036C67.7647%2018.4568%2053.5432%204.23529%2036%204.23529ZM0%2036C0%2016.1177%2016.1177%200%2036%200C55.8823%200%2072%2016.1177%2072%2036C72%2055.8823%2055.8823%2072%2036%2072C16.1177%2072%200%2055.8823%200%2036Z%22%20fill%3D%22black%22/%3E%20%3Cpath%20fill-rule%3D%22evenodd%22%20clip-rule%3D%22evenodd%22%20d%3D%22M36%2058.5882C48.4751%2058.5882%2058.5882%2048.4751%2058.5882%2036C58.5882%2023.5248%2048.4751%2013.4117%2036%2013.4117C23.5249%2013.4117%2013.4118%2023.5248%2013.4118%2036C13.4118%2048.4751%2023.5249%2058.5882%2036%2058.5882ZM36%2054C45.9411%2054%2054%2045.9411%2054%2036C54%2026.0589%2045.9411%2018%2036%2018C26.0589%2018%2018%2026.0589%2018%2036C18%2045.9411%2026.0589%2054%2036%2054Z%22%20fill%3D%22black%22/%3E%20%3Cpath%20fill-rule%3D%22evenodd%22%20clip-rule%3D%22evenodd%22%20d%3D%22M36.0001%2022.8988C36.0001%2022.8988%2036%2022.8988%2036%2022.8988C28.7644%2022.8988%2022.8988%2028.7644%2022.8988%2036C22.8988%2043.2356%2028.7644%2049.1012%2036%2049.1012C36%2049.1012%2036.0001%2049.1012%2036.0001%2049.1012V22.8988Z%22%20fill%3D%22black%22/%3E%20%3C/svg%3E';

// Static assets copied verbatim into dist/ (icons referenced by the manifest).
const STATIC = ['icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'icon.svg', 'badge-96.png'];

const MANIFEST = {
  id: '/',
  name: 'Coinos',
  short_name: 'Coinos',
  description: 'Self-custody Bitcoin wallet that runs entirely in your browser.',
  start_url: './',
  scope: './',
  display: 'standalone',
  background_color: '#eef0f3',
  theme_color: '#15171a',
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

// Service worker: precache the app shell, network-first for the page (so a new
// deploy shows up), cache-first for the icons/manifest, and never touch the
// cross-origin explorer/Nostr requests. CACHE carries a build token so each
// deploy supersedes the previous cache. {{VERSION}} is filled in at build time.
const SW = `const CACHE = 'cold-{{VERSION}}';
// jsqr.js / nip46.js are precached so the lazy QR decoder and remote-signer
// module are available offline too. app-{{VERSION}}.js is the main bundle —
// content-addressed, so a new deploy precaches a new name and the old cache
// is dropped wholesale.
const SHELL = ['./', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'jsqr.js', 'nip46.js', 'app-{{VERSION}}.js'{{EXTRA_SHELL}}];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
});

// The page asks which build we are, and reloads only if it's running an older
// one. Without this it reloads on every controller change, including the very
// common case where the navigation that woke us already fetched the new page.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'sw-version' && e.source) {
    e.source.postMessage({ type: 'sw-version', version: '{{VERSION}}' });
  }
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// NWC push handling lives in src/sw-nwc.js (bundled and appended below when
// the nwc+ark features ship): it tries to ANSWER the request from the pouch
// and falls back to a notification. The placeholder below carries a
// notify-only handler for builds without those features.
{{NWC_WAKE_FALLBACK}}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin !== self.location.origin) return; // explorer/ws → network
  // Live API paths served from OUR origin (esplora, sp indexer, lnurl,
  // well-known) must never be cached: a chain answer frozen at first sight
  // wedges every flow that polls it (a refresh once waited forever on a
  // cached "unconfirmed"). Straight to network, always.
  if (/^\\/(esplora|sp|lnurlp|electrum)\\//.test(u.pathname) || u.pathname.startsWith('/.well-known/')) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./', copy));
          return res;
        })
        .catch(() => caches.match('./'))
    );
    return;
  }
  // Cache-first, but cache same-origin assets (e.g. the chosen locale, icons)
  // on first fetch so they're available offline without precaching them all.
  e.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});
`;

const PWA_HEAD = `<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#15171a">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Coinos">
<link rel="apple-touch-icon" href="/icon-192.png">
`;

// Register with updateViaCache:'none' so the browser always re-fetches sw.js
// (never from HTTP cache) and detects a new build immediately.
//
// When a new worker takes control we may need to reload, because the app is
// inlined in the page: a page serving the old build would keep running it. But
// navigations are network-first, so the refresh that triggered the update
// usually delivered the NEW page already — reloading then is pure
// interruption, a second unasked-for refresh a beat after your own.
//
// So ask the new worker which build it is and reload only on a genuine
// mismatch. The page's own token is stamped in at build time; both come from
// the same {{VERSION}}, hashed before substitution so the two agree.
const SW_REGISTER =
  `<script>if('serviceWorker'in navigator){var _v='{{VERSION}}',_had=!!navigator.serviceWorker.controller,_ref=false;` +
  `function _ask(c){try{c&&c.postMessage({type:'sw-version'})}catch(e){}}` +
  `navigator.serviceWorker.addEventListener('message',function(e){` +
  `if(!e.data||e.data.type!=='sw-version')return;` +
  // _v.charAt(0)==='{' means the token never got substituted; treating that as
  // a mismatch would reload forever.
  `if(_had&&!_ref&&e.data.version&&_v.charAt(0)!=='{'&&e.data.version!==_v){_ref=true;location.reload()}});` +
  `navigator.serviceWorker.addEventListener('controllerchange',function(){_ask(navigator.serviceWorker.controller)});` +
  `addEventListener('load',function(){navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(function(){})})}</script>`;

// Lazy bundles load as classic scripts into the page's global scope, where
// the main bundle's minified top-level names already live — two Bun outputs
// can mint the same identifier and die with "already been declared". An IIFE
// wrapper gives each its own scope; they publish through window.* on purpose.
const iife = (js) => `(function(){${js}\n})();`;

// Bundle the standalone jsQR decoder (sets window.jsQR) for lazy loading.
export async function buildJsQr({ minify = true } = {}) {
  const result = await Bun.build({
    entrypoints: ['./src/jsqr-global.js'],
    target: 'browser',
    minify,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('jsqr bundle failed');
  }
  return iife(await result.outputs[0].text());
}

// Standalone bundle for the NIP-46 remote-signer client — loaded on demand by
// nostr-login.js the first time a bunker/nostrconnect login happens.
export async function buildNip46({ minify = true } = {}) {
  const result = await Bun.build({
    entrypoints: ['./src/nip46-global.js'],
    target: 'browser',
    minify,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('nip46 bundle failed');
  }
  return iife(await result.outputs[0].text());
}

// The notify-only push handler for builds without the ark+nwc features (the
// full builds get the bundled auto-answering handler from src/sw-nwc.js).
const SW_WAKE_ONLY = `self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (_) {}
  if (data.type !== 'nwc') return;
  e.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (clients.length) {
      for (const c of clients) c.postMessage({ type: 'nwc-wake', servicePubkey: data.servicePubkey });
      return;
    }
    await self.registration.showNotification('Payment request', {
      body: 'An app is asking your wallet to pay. Open Coinos to approve.',
      icon: 'icon-192.png', badge: 'badge-96.png',
      tag: 'nwc-' + (data.servicePubkey || 'req'), renotify: false,
      data: { url: './' },
    });
  })());
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = all.find((c) => 'focus' in c);
    if (open) return open.focus();
    if (self.clients.openWindow) return self.clients.openWindow('./');
  })());
});`;

// The auto-answering NWC worker module, bundled for the SW global scope.
export async function buildSwNwc({ minify = true } = {}) {
  const result = await Bun.build({
    entrypoints: ['./src/sw-nwc.js'],
    target: 'browser',
    minify,
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('sw-nwc bundle failed');
  }
  return result.outputs[0].text();
}

// Optional-feature selection: HAL_FEATURES is a comma list of enabled
// features (gifts,swaps,ark,zaps,sp,nwc). Unset means all; "none"/"" means a minimal
// on-chain-only wallet. A build plugin swaps src/features/index.js for a
// generated module that only imports the enabled features, so a disabled
// feature's code (and its network endpoints) never enters the bundle.
// NB order matters and must match src/features/index.js — nwc sits after ark
// because it drives ark's headless pay/balance seam.
const ALL_FEATURES = { gifts: 'giftsFeature', ark: 'arkFeature', nostrlogin: 'nostrLoginFeature', names: 'namesFeature', zaps: 'zapsFeature', nwc: 'nwcFeature', hats: 'hatsFeature', sync: 'syncFeature', messages: 'messagesFeature' };

// Features with no first-frame surface load as separate chunks right after
// boot (dynamic import; real files in the split build, inlined in the
// single-file build). Hook precedence is POSITION in the features array, so
// each deferred feature holds its slot with an empty placeholder object —
// every `f[hook]` probe skips it — and is filled in place when it arrives.
// NOT deferrable: ark (balance on the home screen), messages (deep-linked
// profiles + the boot shell), gifts is deferrable because app.js awaits the
// deferred load before the bootUrl check when the path looks like a gift.
const DEFERRED_FEATURES = ['gifts', 'nwc', 'hats'];

export function enabledFeatures(spec = process.env.HAL_FEATURES) {
  if (spec == null) return Object.keys(ALL_FEATURES);
  return spec.split(',').map((x) => x.trim().toLowerCase()).filter((x) => x in ALL_FEATURES);
}

export function featureIndexSource(enabled) {
  const lazy = enabled.filter((f) => DEFERRED_FEATURES.includes(f));
  const eager = enabled.filter((f) => !lazy.includes(f));
  return eager.map((f) => `import { ${ALL_FEATURES[f]} } from './${f}.js';`).join('\n') + `
export function buildFeatures(ctx) {
  return [${enabled.map((f) => (lazy.includes(f) ? '{}' : `${ALL_FEATURES[f]}(ctx)`)).join(', ')}];
}
export async function loadDeferredFeatures(ctx, features) {
  const late = [];
  await Promise.all([${lazy.map((f) => `
    import('./${f}.js').then((m) => { late.push(features[${enabled.indexOf(f)}] = m.${ALL_FEATURES[f]}(ctx)); })`).join(',')}
  ]);
  return late;
}
`;
}

const featurePlugin = (enabled) => ({
  name: 'coinos-features',
  setup(b) {
    b.onLoad({ filter: /src[\/\\]features[\/\\]index\.js$/ }, () => ({
      contents: featureIndexSource(enabled),
      loader: 'js',
    }));
  },
});

// HAL_TARGET=staging flips src/build-flags.js in the bundle: mutinynet-first
// defaults and a visible staging stamp, without a diverging branch.
export const isStaging = (target = process.env.HAL_TARGET) => target === 'staging';

const flagsPlugin = (staging) => ({
  name: 'coinos-build-flags',
  setup(b) {
    b.onLoad({ filter: /src[\/\\]build-flags\.js$/ }, () => ({
      contents: `export const STAGING = ${!!staging};\n`,
      loader: 'js',
    }));
  },
});

// The commit this build came from: the deploy hook passes GIT_COMMIT (the
// worktree it builds in has no .git), local builds ask git directly.
function gitCommit() {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT.slice(0, 7);
  try {
    const r = Bun.spawnSync(['git', 'rev-parse', '--short', 'HEAD']);
    const out = r.stdout.toString().trim();
    if (/^[0-9a-f]{6,}$/.test(out)) return out;
  } catch {}
  return 'dev';
}

async function bundleApp({ minify, features, staging, splitting = false }) {
  const result = await Bun.build({
    entrypoints: ['./src/app.js'],
    target: 'browser',
    minify,
    // The split build emits real ESM chunks (deferred features arrive as their
    // own files); the single-file build inlines the dynamic imports instead.
    ...(splitting ? { splitting: true, format: 'esm', naming: { chunk: 'chunk-[hash].[ext]' } } : {}),
    plugins: [featurePlugin(enabledFeatures(features)), flagsPlugin(staging)],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error('bundle failed');
  }
  return result.outputs;
}

// The brand mark for the static boot shell, lifted from brandHeader in
// src/app.js at build time so the two can never drift apart. Missing match
// degrades to an empty (invisible) logo, never a broken build.
async function brandSvg() {
  const src = await Bun.file('./src/app.js').text();
  const m = src.match(/'(<svg viewBox="0 0 224 72"[\s\S]*?<\/svg>)'/);
  return m ? m[1] : '';
}

// A static boot shell inside #app: painted the instant HTML+CSS arrive,
// before any JS parses — no blank page, no flash. It mirrors the DOM the
// app's own first render produces (brand row; plus the profile shell when
// the path deep-links a profile), so the morph replaces it invisibly.
function bootShell(logo) {
  return `<div class="col" style="gap:16px"><div class="row between"><div class="brand"><div class="logo-full" aria-label="coinos" role="img">${logo}</div></div></div><div class="card col" id="boot-shell" style="gap:12px;display:none"><div class="row gap6" style="align-items:center"><div class="chat-avatar profile-avatar fallback loading"></div><div class="chat-title" id="boot-shell-name"></div></div></div></div>`;
}
const BOOT_SHELL_SCRIPT = `<script>try{var m=location.pathname.match(/^\\/([A-Za-z0-9._-]{1,64})\\/?$/);if(m){document.getElementById('boot-shell').style.display='';document.getElementById('boot-shell-name').textContent=decodeURIComponent(m[1]);}}catch(e){}</script>`;

async function pageHtml({ css, staging, pwa, scriptHtml }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, interactive-widget=resizes-content">
<meta name="color-scheme" content="light dark">
<title>${staging ? 'Coinos Staging' : 'Coinos'}</title>
<link rel="icon" href="${FAVICON}">
<script>try{var t=localStorage.getItem('btc-wallet-theme');if(t!=='dark'&&t!=='light')t=matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light';document.documentElement.dataset.theme=t;}catch(e){}</script>
${pwa ? PWA_HEAD : ''}<style>${css}</style>
</head>
<body>
<div id="app">${bootShell(await brandSvg())}</div>
${BOOT_SHELL_SCRIPT}
${scriptHtml}
${pwa ? SW_REGISTER + '\n' : ''}</body>
</html>`;
}

// Self-contained single file (dev server, test tools, save-and-open-offline).
export async function buildHtml({ minify = true, pwa = minify, features = process.env.HAL_FEATURES, staging = isStaging() } = {}) {
  const outputs = await bundleApp({ minify, features, staging });
  let js = await outputs[0].text();
  // Guard against a literal </script> inside the bundle closing our tag early.
  js = js.replaceAll('</script', '<\\/script');
  const css = await Bun.file('./src/style.css').text();
  const html = await pageHtml({ css, staging, pwa, scriptHtml: `<script>${js}</script>` });
  return html.replaceAll('{{COMMIT}}', gitCommit());
}

// The hosted split build: a small no-cache index.html (CSS + boot shell) that
// loads the app as a content-addressed ESM entry plus chunks — the deferred
// features ride in their own files, fetched right after boot. The page stays
// tiny on every load while the heavy bundles are cached by name — a repeat
// visit re-downloads kilobytes, not the app.
export async function buildSplit({ minify = true, features = process.env.HAL_FEATURES, staging = isStaging() } = {}) {
  const outputs = await bundleApp({ minify, features, staging, splitting: true });
  const entry = outputs.find((o) => o.kind === 'entry-point') || outputs[0];
  const js = (await entry.text()).replaceAll('{{COMMIT}}', gitCommit());
  const chunks = await Promise.all(outputs.filter((o) => o !== entry).map(async (o) => ({
    name: o.path.split('/').pop(),
    text: (await o.text()).replaceAll('{{COMMIT}}', gitCommit()),
  })));
  const css = await Bun.file('./src/style.css').text();
  // module scripts defer by default; the boot shell paints while this loads
  const html = (await pageHtml({ css, staging, pwa: true, // root-absolute: the page can be served from any path (/ag/…, /g/…) and a
    // relative src would resolve into that subpath, get the index.html
    // fallback, and die on strict module MIME checking — a gift link once
    // showed nothing but the boot shell this way
    scriptHtml: '<script type="module" src="/app-{{VERSION}}.js"></script>' }))
    .replaceAll('{{COMMIT}}', gitCommit());
  return { html, js, chunks };
}

if (import.meta.main) {
  await mkdir('dist', { recursive: true });
  // Hashed with {{VERSION}} still a placeholder, so the page, the bundle
  // filename and the worker are all stamped with the same token — the page
  // cannot contain a hash of itself.
  const { html: rawHtml, js: rawJs, chunks } = await buildSplit({ minify: true });
  const version = Bun.hash(rawHtml + rawJs + chunks.map((c) => c.text).join('')).toString(36);
  const html = rawHtml.replaceAll('{{VERSION}}', version);
  await Bun.write('dist/index.html', html);
  await Bun.write(`dist/app-${version}.js`, rawJs.replaceAll('{{VERSION}}', version));
  for (const c of chunks) await Bun.write('dist/' + c.name, c.text);
  // Drop stale content-addressed bundles from earlier local builds so dist/
  // mirrors a deploy (the deploy hook rsyncs dist/ wholesale).
  const keep = new Set([`app-${version}.js`, ...chunks.map((c) => c.name)]);
  for (const f of await readdir('dist')) {
    if (/^(app|chunk)-[A-Za-z0-9]+\.js$/.test(f) && !keep.has(f)) await Bun.file('dist/' + f).delete();
  }

  // Lazy-loaded QR decoder — kept out of index.html, fetched only when a
  // browser without BarcodeDetector opens the scanner.
  await Bun.write('dist/jsqr.js', await buildJsQr());
  // Lazy-loaded NIP-46 remote-signer client — fetched on first bunker login.
  await Bun.write('dist/nip46.js', await buildNip46());

  // Per-language strings — fetched on demand so visitors only download theirs.
  await mkdir('dist/locales', { recursive: true });
  const locales = await readdir('src/locales');
  for (const f of locales) await Bun.write('dist/locales/' + f, Bun.file('src/locales/' + f));

  // PWA sidecars. The staging install gets its own name so the two icons are
  // tellable apart on a phone's home screen (identity is per-origin anyway).
  const manifest = isStaging()
    ? { ...MANIFEST, name: 'Coinos Staging', short_name: 'Staging' }
    : MANIFEST;
  await Bun.write('dist/manifest.webmanifest', JSON.stringify(manifest, null, 2));
  // Full builds get the auto-answering NWC worker; feature-stripped builds
  // keep the notify-only handler (the responder would just dead-weight them).
  const feats = enabledFeatures();
  const nwcSw = feats.includes('nwc') && feats.includes('ark');
  const swBody = SW
    .replaceAll('{{VERSION}}', version)
    .replaceAll('{{EXTRA_SHELL}}', chunks.map((c) => `, '${c.name}'`).join(''))
    .replaceAll('{{NWC_WAKE_FALLBACK}}', nwcSw ? '' : SW_WAKE_ONLY);
  await Bun.write('dist/sw.js', nwcSw ? swBody + '\n' + await buildSwNwc() : swBody);
  for (const f of STATIC) await Bun.write('dist/' + f, Bun.file('static/' + f));
  // default avatars, self-hosted since coinos.io's copies are half-broken
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync('static/punks')) await Bun.write('dist/punks/' + f, Bun.file('static/punks/' + f));

  const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
  const jkb = (Buffer.byteLength(rawJs) / 1024).toFixed(0);
  const ckb = (chunks.reduce((n, c) => n + Buffer.byteLength(c.text), 0) / 1024).toFixed(0);
  console.log(`✓ dist/index.html (${kb} KB) + app-${version}.js (${jkb} KB) + ${chunks.length} deferred chunk(s) (${ckb} KB) — offline use: install the PWA`);
  console.log(`✓ PWA: manifest.webmanifest, sw.js (cold-${version}), ${STATIC.length} icons, jsqr.js, nip46.js, ${locales.length} locales`);
}
