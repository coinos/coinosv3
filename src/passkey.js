// Passkey sign-in: WebAuthn's PRF extension turns a passkey into a
// deterministic 32-byte secret, which hashes into a nostr key — and the
// login flow then treats it exactly like a pasted nsec, so the wallet seed
// derives from it the usual way. No server anywhere: the wallet follows the
// passkey wherever the platform syncs it (iCloud Keychain, Google Password
// Manager), and the same passkey always opens the same wallet because the
// PRF salt is a fixed app-scoped constant.
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';

const PRF_SALT = sha256(new TextEncoder().encode('coinos-passkey-v1'));
const DERIVE_TAG = new TextEncoder().encode('coinos-passkey-key:v1');

export const passkeySupported = () =>
  typeof window !== 'undefined' && !!window.PublicKeyCredential && !!navigator.credentials;

// Hash the PRF output into a valid secp256k1 scalar. An out-of-range hash is
// a ~2^-128 event, but the loop makes the derivation total rather than lucky.
function skFromPrf(prf) {
  let buf = new Uint8Array(DERIVE_TAG.length + prf.length);
  buf.set(DERIVE_TAG, 0);
  buf.set(prf, DERIVE_TAG.length);
  let sk = sha256(buf);
  while (!secp256k1.utils.isValidPrivateKey(sk)) sk = sha256(sk);
  return sk;
}

const NO_PRF = 'this device’s passkeys can’t derive a wallet key (no PRF support)';

async function assertionPrf(allowCredentials) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
      ...(allowCredentials ? { allowCredentials } : {}),
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  const out = cred && cred.getClientExtensionResults().prf?.results?.first;
  if (!out) throw new Error(NO_PRF);
  return new Uint8Array(out);
}

// Sign in with an existing (discoverable) passkey.
export async function passkeySignIn() {
  return skFromPrf(await assertionPrf(null));
}

// Create a passkey, then derive the key from it. Some platforms evaluate PRF
// during creation; the rest need a follow-up assertion against the new
// credential — both paths end at the same bytes.
export async function passkeyCreate() {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Coinos', id: location.hostname },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'coinos', displayName: 'Coinos wallet',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: { prf: { eval: { first: PRF_SALT } } },
    },
  });
  const ext = cred.getClientExtensionResults();
  const direct = ext.prf?.results?.first;
  if (direct) return skFromPrf(new Uint8Array(direct));
  if (ext.prf && ext.prf.enabled === false) throw new Error(NO_PRF);
  return skFromPrf(await assertionPrf([{ type: 'public-key', id: cred.rawId }]));
}
