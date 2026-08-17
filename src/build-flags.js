// Build-time flags. This module ships its defaults (a production build); the
// deploy hook builds the staging webroot with HAL_TARGET=staging and build.js
// swaps these values in the bundle (same mechanism as features/index.js) — so
// staging behavior lives on master instead of a perpetually-rebased branch.
//
// STAGING: new profiles default to Mutinynet (Settings can still switch to
// mainnet), and the header logo wears a staging stamp so nobody mistakes
// which site their sats are on.
export const STAGING = false;
