// A phone's video, made light enough to stream before it's uploaded.
//
// A phone records 1080p–4K at 15–20 Mbps; played back from a Blossom host
// over mobile data that stalls every few seconds, and none of the public
// hosts transcode (nostr.build's and primal's BUD-05 /media endpoints hand
// back the same bitrate — measured 2026-09-30). So the phone does it:
// WebCodecs on the device's hardware encoder, via Mediabunny (loaded only
// when a video is picked), to H.264 at 720p and ~2.5 Mbps, the moov atom up
// front so playback starts before the download ends. Audio passes through
// untouched when the container allows (phones record AAC already).
//
// Anything short of a clear win — no WebCodecs, an unreadable file, an
// encoder error, a result not meaningfully smaller — uploads the original,
// exactly as before.

const SHORT_EDGE = 720;
const VIDEO_BPS = 2_500_000;

export async function compressVideo(file, onProgress = () => {}) {
  if (!file || !/^video\//.test(file.type || '')) return file;
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return file;
  let mb;
  try { mb = await import('mediabunny'); } catch { return file; }
  const { Input, Output, Conversion, BlobSource, BufferTarget, Mp4OutputFormat, ALL_FORMATS } = mb;
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) return file;
    const seconds = await input.computeDuration();
    const w = video.displayWidth, h = video.displayHeight;
    const short = Math.min(w, h);
    const bps = seconds > 0 ? (file.size * 8) / seconds : Infinity;
    // already light: nothing to gain, and a re-encode only loses quality
    if (short <= SHORT_EDGE && bps <= VIDEO_BPS * 1.4) return file;
    const size = short > SHORT_EDGE ? (w >= h ? { height: SHORT_EDGE } : { width: SHORT_EDGE }) : {};
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input, output,
      video: { ...size, codec: 'avc', bitrate: VIDEO_BPS, forceTranscode: true },
    });
    if (!conversion.isValid) return file;
    conversion.onProgress = (p) => { try { onProgress(p); } catch {} };
    await conversion.execute();
    const buf = output.target.buffer;
    // not worth it unless it's clearly smaller
    if (!buf || buf.byteLength > file.size * 0.8) return file;
    const name = String(file.name || 'video').replace(/\.[a-z0-9]{1,8}$/i, '') + '.mp4';
    return new File([buf], name, { type: 'video/mp4' });
  } catch {
    return file;
  } finally {
    try { input.dispose?.(); } catch {}
  }
}
