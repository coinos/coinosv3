// The default coinos community's join material (CORD-02 §8) — genesis output
// of tools/concord-genesis.js. The community_root here is deliberately
// public-ish: every coinos user is meant to be a member, and the public
// read-only chat page (/chat) decrypts with it too. Shared by the messages
// feature and src/public-chat.js so the two can never drift.
export const COMMUNITY = {
  community_id: 'b517fb4ba04c4c4eac2bd486ee800d1a8644fcdca5c5643098062e7733ee4986',
  owner: '98ae4da926c471c23fd12d1ebdd5839ba82917baa618e184e0c9916d93dcf4f7',
  owner_salt: '466450cd6cd0e6991a5acea091c5bc9e9a1c1ba27a970e64d2af4860e7f60cb1',
  community_root: '58b2ce26eba30fbd19d9a57bce4c61e65838686998f10bba1d3e822fb72b372e',
  root_epoch: 0,
  channels: [{ id: '56bf8b96c1a3768c85444873df507cdbc3275fcbc21996af09e60003f850f85c', name: 'general' }],
  relays: ['wss://relay.coinos.io', 'wss://nos.lol'],
  name: 'coinos',
};

export const EPOCH = 0;
