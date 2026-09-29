// Canceling a new post closes the composer and discards every part of its
// saved state, including a late attachment result.
import assert from 'node:assert/strict';

const source = await Bun.file('src/features/messages.js').text();
const start = source.indexOf('function cancelPost()');
const end = source.indexOf('\n  }', start);
const cancel = source.slice(start, end);
assert(start > 0, 'post cancel handler exists');
assert(cancel.includes('postAttachGeneration++'), 'late uploads are invalidated');
assert(cancel.includes('ui.profCompose = null'), 'composer is closed');
assert(cancel.includes('ui.postMedia = []'), 'pending attachment metadata is removed');
assert(cancel.includes('ui.postPreview = false'), 'preview state is removed');
assert(cancel.includes('discardDraft(POST_DRAFT)'), 'persisted draft is removed immediately');
assert(source.includes("onClick: cancelPost }, t('cancel')"), 'Cancel button uses the discard handler');

console.log('✓ Cancel closes the new-post form and removes its complete saved draft');
