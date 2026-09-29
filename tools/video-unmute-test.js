// Repaint before autoplay used to copy a handler closing over a detached video.
// Run: bun tools/video-unmute-test.js
// Phone: adb reverse tcp:5302 tcp:5302; BROWSER_URL=http://localhost:9223 bun tools/video-unmute-test.js
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const app = await Bun.file('src/app.js').text();
const messages = await Bun.file('src/features/messages.js').text();
const dom = app.slice(app.indexOf('function h(tag,'), app.indexOf("const root = document.getElementById('app');"));
const video = messages.slice(messages.indexOf('  const autoplayOk ='), messages.indexOf('  // The still, with a play button'));
const clip = '/tmp/coinos-unmute-test.webm';
const ffmpeg = Bun.spawnSync(['ffmpeg', '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=size=160x90:rate=10', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '10', '-c:v', 'libvpx', '-c:a', 'libvorbis', clip]);
assert.equal(ffmpeg.exitCode, 0, 'generate a video with audio');
const server = Bun.serve({ port: 5302, fetch(req) {
  if (new URL(req.url).pathname === '/clip.webm') return new Response(Bun.file(clip), { headers: { 'content-type': 'video/webm' } });
  return new Response(`<style>video{width:280px}.note-video-box{position:relative}.vid-sound{position:absolute;top:8px;left:8px}</style><div id="app"></div><script>
  // Hold autoplay until after repaint to make the race deterministic.
  window.IntersectionObserver = undefined;
  const t = key => key;
  ${dom}
  ${video}
  const url = '/clip.webm';
  const live = videoNode(url);
  document.getElementById('app').append(live);
  const originalButton = live.querySelector('button');
  const fresh = videoNode(url);
  morph(live, fresh);
  window.test = { live, fresh, originalButton, rebuild() {
    const next = videoNode(url); live.replaceWith(next); return next.querySelector('video').muted;
  } };
  </script>`, { headers: { 'content-type': 'text/html' } });
} });
const remote = !!process.env.BROWSER_URL;
const browser = remote
  ? await puppeteer.connect({ browserURL: process.env.BROWSER_URL })
  : await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage();
try {
  if (!remote) await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto('http://localhost:5302/');
  await page.waitForFunction(() => test.live.querySelector('video').readyState >= 2);
  assert.equal(await page.evaluate(() => test.originalButton === test.live.querySelector('button') && !test.fresh.isConnected && test.live.querySelector('video').muted), true, 'repaint retains the live muted player and button');
  await page.tap('.vid-sound');
  await page.waitForFunction(() => !test.live.querySelector('video').paused);
  assert.deepEqual(await page.evaluate(() => ({ muted: test.live.querySelector('video').muted, button: !!test.live.querySelector('button'), detachedMuted: test.fresh.querySelector('video').muted, frozen: test.live._skipMorph })), { muted: false, button: false, detachedMuted: true, frozen: true });
  assert.equal(await page.evaluate(() => test.rebuild()), false, 'remounted clip remembers sound');
  console.log('✓ Touch after repaint unmutes the live player, starts playback, removes the button, and survives remount');
} finally {
  await page.close();
  if (remote) await browser.disconnect(); else await browser.close();
  server.stop(true);
}
