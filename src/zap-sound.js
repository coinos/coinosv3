// The supplied zap.mp3, encoded verbatim so hosted and standalone builds
// both include it. Decode ahead of the tap; no network request is needed.
import mp3 from './assets/zap.mp3.base64.txt' with { type: 'text' };

let context, buffer, loading, playing, sequence = 0;

function prepareZap() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;
  if (!context || context.state === 'closed') {
    context = new AudioCtx({ latencyHint: 'interactive' });
    buffer = null;
    loading = null;
  }
  if (!loading) {
    const ctx = context;
    const bytes = Uint8Array.from(atob(mp3.trim()), c => c.charCodeAt(0));
    loading = ctx.decodeAudioData(bytes.buffer).then(decoded => {
      if (context === ctx) buffer = decoded;
      return decoded;
    });
    loading.catch(() => { if (context === ctx) loading = null; });
  }
  return loading;
}

// Decoding is allowed while the audio context is suspended; the tap resumes
// playback. A browser without audio must still be able to load the wallet.
try { prepareZap(); } catch {}

// tappedAt: when the finger landed — the caller's clock, since this module
// may still have been loading when it did.
export function playZapSound(tappedAt = performance.now()) {
  try {
    const ready = prepareZap();
    if (!ready) return;
    const ctx = context, token = ++sequence;
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    const start = decoded => {
      // A very early tap may beat decoding. Never queue an old sound behind
      // a later zap or surprise the user after a stalled decoder recovers.
      if (token !== sequence || context !== ctx || performance.now() - tappedAt > 250) return;
      if (playing) { playing.stop(); playing.disconnect(); }
      const source = ctx.createBufferSource(), gain = ctx.createGain();
      source.buffer = decoded;
      gain.gain.value = .65;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.onended = () => {
        source.disconnect(); gain.disconnect();
        if (playing === source) playing = null;
      };
      playing = source;
      source.start();
    };
    if (buffer) start(buffer);
    else ready.then(start).catch(() => {});
  } catch {} // Unavailable audio never interrupts a payment or its animation.
}
