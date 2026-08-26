// Standalone bundle for the NIP-46 remote-signer client (bunker:// and
// nostrconnect:// logins) — emitted as a separate dist/nip46.js and loaded on
// demand by nostr-login.js, the first time a bunker interaction happens.
// It's the heaviest, rarest corner of the login stack (and drags a second
// copy of the noble crypto stack via nostr-tools' own pins), so it stays out
// of the main bundle and off the initial load.
import * as nip46 from 'nostr-tools/nip46';

window.__nip46 = nip46;
