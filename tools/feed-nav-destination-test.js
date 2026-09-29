// The Feed destination and the new-posts pill deliberately have different
// navigation semantics. Keep this small source-level guard beside the fuller
// browser test for the pill's landing position.
import assert from 'node:assert/strict';

const source = await Bun.file('src/features/messages.js').text();
const navStart = source.indexOf("button('feed', t('feedTitle')");
const navEnd = source.indexOf("button('messages',", navStart);
const feedButton = source.slice(navStart, navEnd);
assert(navStart > 0 && navEnd > navStart, 'Feed bottom-nav handler exists');
assert(feedButton.includes('glideToTop()'), 'Feed bottom-nav button returns to the top');
assert(!feedButton.includes('jumpToNew()'), 'Feed bottom-nav button does not jump to unread posts');

const pillStart = source.indexOf("class: 'feed-new-pill'");
const pill = source.slice(pillStart, source.indexOf('})', pillStart) + 2);
assert(pillStart > 0 && pill.includes('jumpToNew()'), 'new-posts pill jumps to the first unread arrival');

console.log('✓ Feed tab goes to the top; only the new-posts pill jumps to unread posts');
