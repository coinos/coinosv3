// A migration grant names the identity that owns the address. Its manager
// may submit the registration without becoming that identity.
export function registrationIdentity({ existing, signer, manager, grant, granted }) {
  const pubkey = existing?.pubkey || (granted ? grant.pubkey : signer);
  const nominated = /^[0-9a-f]{64}$/.test(manager || '') && manager !== pubkey;
  return {
    pubkey,
    manager: nominated ? manager : existing?.manager || (granted ? grant.manager : undefined),
  };
}
