// Outside the app's morphed tree so relay updates cannot restart the effect.
// This is tap feedback only: payment settlement never plays it again.

// The clip is 62KB of base64 — messages.js can't be deferred (it's the boot
// shell), so the sound is its own chunk instead, fetched once a zappable
// post or chat message is on screen. By the first tap it's decoded; and if
// it isn't, the sound keeps the tap's own clock and stays silent when late.
let soundModule = null, sound = null;
export function warmZapSound() {
  if (!soundModule) {
    soundModule = import('./zap-sound.js')
      .then((m) => (sound = m))
      .catch(() => { soundModule = null; return null; });
  }
  return soundModule;
}

const trembles = new WeakMap();
function tremblePost(id) {
  if (!id || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const post of document.querySelectorAll(`[data-zap-post="${CSS.escape(id)}"]`)) {
    // Web Animations survive the app's DOM morphs without adding a class
    // that a balance update could remove or accidentally restart.
    trembles.get(post)?.cancel();
    const animation = post.animate([
      { transform: 'none' },
      { transform: 'translate(-3px, 1px) rotate(-.3deg)' },
      { transform: 'translate(3px, -1px) rotate(.3deg)' },
      { transform: 'translate(-2.5px, 0) rotate(-.2deg)' },
      { transform: 'translate(2px, 1px) rotate(.2deg)' },
      { transform: 'translate(-1.5px, -1px)' },
      { transform: 'translate(1px, 0)' },
      { transform: 'none' },
    ], { duration: 360, easing: 'ease-out' });
    trembles.set(post, animation);
    animation.onfinish = () => { if (trembles.get(post) === animation) trembles.delete(post); };
  }
}

export function animateZap(sats, origin, postId) {
  // Warm: play inside the tap itself (the audio context resumes on a
  // gesture). Cold: play when the chunk lands, if that's still soon enough.
  if (sound) sound.playZapSound();
  else { const tappedAt = performance.now(); warmZapSound().then((m) => { if (m) m.playZapSound(tappedAt); }); }
  try { tremblePost(postId); } catch {} // Optional motion must never block a zap.
  const layer = document.createElement('div');
  layer.className = 'zap-fx';
  layer.setAttribute('aria-hidden', 'true');
  const x = origin ? origin.left + origin.width / 2 : innerWidth / 2;
  const y = origin ? origin.top + origin.height / 2 : innerHeight / 2;
  layer.style.setProperty('--zap-x', `${x}px`);
  layer.style.setProperty('--zap-y', `${Math.max(110, y)}px`);
  layer.innerHTML = '<div class="zap-fx-impact">'
    + '<svg class="zap-fx-bolt" viewBox="0 0 100 180"><path d="M62 0 25 65 52 59 15 122 43 110 50 180 72 91 48 100 88 35 59 43Z"/></svg>'
    + '<i class="zap-fx-flash"></i><i class="zap-fx-ring"></i>'
    + '<div class="zap-fx-amount"><strong></strong><span>sats</span></div></div>';
  layer.querySelector('strong').textContent = '+' + sats.toLocaleString();
  const impact = layer.firstElementChild;
  for (let i = 0; i < 26; i++) {
    const spark = document.createElement('i');
    const angle = i * 2.39996;
    const distance = 38 + (i % 6) * 15;
    spark.className = 'zap-fx-spark' + (i >= 16 ? ' ember' : '');
    spark.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    spark.style.setProperty('--dy', `${Math.sin(angle) * distance - 35}px`);
    spark.style.setProperty('--angle', `${angle}rad`);
    spark.style.setProperty('--delay', `${i >= 16 ? 600 + (i % 5) * 55 : 60 + (i % 4) * 20}ms`);
    impact.append(spark);
  }
  document.body.append(layer);
  // Leave room for the pop's 1.2x overshoot, even for long amounts at an edge.
  const label = layer.querySelector('.zap-fx-amount');
  if (label.offsetWidth > (innerWidth - 32) / 1.2) {
    const strong = label.querySelector('strong');
    strong.style.fontSize = `${parseFloat(getComputedStyle(strong).fontSize) * (innerWidth - 80) / (label.offsetWidth * 1.2)}px`;
  }
  const margin = label.offsetWidth * .6 + 12;
  const labelX = Math.max(margin, Math.min(innerWidth - margin, x));
  layer.style.setProperty('--zap-label-x', `${labelX - x}px`);
  const clean = () => { layer.remove(); window.removeEventListener('pagehide', clean); };
  window.addEventListener('pagehide', clean, { once: true });
  setTimeout(clean, 1700);
}
