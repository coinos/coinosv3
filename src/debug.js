// A console kept quiet by default. The chatter that helps when something is
// being chased (the NWC listener's generations, relay health) goes through
// dlog and shows only once debugging is switched on — from the console with
// `coinosDebug(true)`, or by opening the app with `?debug=1`. `coinosDebug(false)`
// turns it off again. Warnings and errors that mean something is wrong are
// not gated; they stay on console.warn / console.error.
const KEY = 'coinos-debug';
export const debugOn = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
export const dlog = (...a) => { if (debugOn()) console.log(...a); };
if (typeof window !== 'undefined') {
  window.coinosDebug = (on = true) => {
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch {}
    console.log('coinos debug ' + (on ? 'on' : 'off'));
    return on;
  };
  try { if (new URLSearchParams(location.search).get('debug') === '1') localStorage.setItem(KEY, '1'); } catch {}
}
