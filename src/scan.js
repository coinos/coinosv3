import { assetUrl } from './asset-url.js';
// Camera QR scanner. Opens a fullscreen overlay, streams the back camera, and
// resolves with the decoded string (or null if the user cancels).
//
// Decoder strategy, to keep the main bundle small:
//   - Prefer the native BarcodeDetector (Chrome desktop/Android) — no library.
//   - Otherwise lazy-load jsQR from a separate dist/jsqr.js, only on first use.
//
// Needs a secure context with a camera (getUserMedia). Callers gate the button
// on navigator.mediaDevices?.getUserMedia so it never shows where unavailable.

let jsqrLoader;

// Load the jsQR fallback bundle on demand (separate file → off the initial load).
function loadJsQR() {
  if (typeof window !== 'undefined' && window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsqrLoader) {
    jsqrLoader = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = assetUrl('jsqr.js');
      s.onload = () => (window.jsQR ? resolve(window.jsQR) : reject(new Error('decoder unavailable')));
      s.onerror = () => reject(new Error('decoder unavailable'));
      document.head.appendChild(s);
    });
  }
  return jsqrLoader;
}

// Native detector, but only if it can actually do QR (on some platforms the API
// exists yet supports no formats — in which case we fall back to jsQR).
async function makeDetector() {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) return null;
  try {
    const fmts = await window.BarcodeDetector.getSupportedFormats();
    if (!fmts.includes('qr_code')) return null;
    return new window.BarcodeDetector({ formats: ['qr_code'] });
  } catch {
    return null;
  }
}

export async function scanQr(t) {
  const label = (k, d) => (t ? t(k) : d);

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
  } catch {
    throw new Error(label('scanNoCamera', 'Could not access the camera.'));
  }

  // Pick a decoder before scanning (lazy-loading jsQR if there's no native one).
  const detector = await makeDetector();
  let jsQR = null;
  if (!detector) {
    try {
      jsQR = await loadJsQR();
    } catch {
      for (const tr of stream.getTracks()) tr.stop();
      throw new Error(label('scanNoDecoder', 'QR scanning needs a network connection the first time.'));
    }
  }

  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'scan-overlay';

    const video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.muted = true;
    video.srcObject = stream;

    const frame = document.createElement('div');
    frame.className = 'scan-frame';

    const hint = document.createElement('div');
    hint.className = 'scan-hint';
    hint.textContent = label('scanHint', 'Point the camera at a QR code');

    const close = document.createElement('button');
    close.className = 'scan-close';
    close.setAttribute('aria-label', 'Close');
    close.textContent = '✕';

    overlay.append(video, frame, hint, close);
    document.body.append(overlay);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let raf = 0;
    let done = false;

    function stop(result) {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      for (const tr of stream.getTracks()) tr.stop();
      overlay.remove();
      resolve(result);
    }
    close.onclick = () => stop(null);
    overlay.onclick = (e) => {
      if (e.target === overlay) stop(null);
    };

    async function tick() {
      if (done) return;
      if (video.readyState >= 2 && video.videoWidth) {
        try {
          let data = null;
          if (detector) {
            const codes = await detector.detect(video);
            if (codes && codes.length) data = codes[0].rawValue;
          } else {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
            if (code && code.data) data = code.data;
          }
          if (data) return stop(data);
        } catch {}
      }
      raf = requestAnimationFrame(tick);
    }

    video.play().then(() => { raf = requestAnimationFrame(tick); }).catch(() => stop(null));
  });
}
