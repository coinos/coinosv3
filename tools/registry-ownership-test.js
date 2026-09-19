import assert from 'node:assert/strict';
import { registrationIdentity } from '../names/ownership.js';

const owner = 'a'.repeat(64), wallet = 'b'.repeat(64), stranger = 'c'.repeat(64);
const grant = { pubkey: owner, manager: wallet };
for (const signer of [owner, wallet]) {
  assert.deepEqual(registrationIdentity({ signer, grant, granted: true }), { pubkey: owner, manager: wallet });
}
console.log('✓ owner and manager registrations both preserve the migration identity');
assert.deepEqual(registrationIdentity({ signer: wallet, manager: wallet, grant, granted: true }), { pubkey: owner, manager: wallet });
console.log('✓ the signing wallet can remain the nominated manager');
const existing = { pubkey: owner, manager: wallet };
assert.deepEqual(registrationIdentity({ existing, signer: wallet, grant: { pubkey: stranger }, granted: false }), existing);
console.log('✓ later wallet updates preserve existing ownership and management');
assert.deepEqual(registrationIdentity({ signer: wallet, grant, granted: false }), { pubkey: wallet, manager: undefined });
assert.deepEqual(registrationIdentity({ signer: owner, manager: wallet }), existing);
assert.deepEqual(registrationIdentity({ signer: owner, manager: owner }), { pubkey: owner, manager: undefined });
console.log('✓ ordinary claims retain their signer and ignore unauthorized grants');
