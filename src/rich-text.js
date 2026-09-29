// <coinos-text>: a plain-text field built on contenteditable, standing in
// for <textarea> in the composers.
//
// Why: Android keyboards (Gboard's GIFs, stickers, image suggestions) only
// offer pictures to a field that says it accepts them, and Chrome says so
// for contenteditable — never for <textarea>, where the GIF key sits greyed
// out with "This app does not support images here". So the field is
// editable HTML that behaves, to the code around it, like a textarea:
// `value`, `selectionStart`/`selectionEnd` (read and write),
// `setSelectionRange`, a `placeholder`, Enter handled by the page. Text
// stays plain — pasted formatting is dropped — and any picture that arrives
// (a keyboard GIF, a pasted or dropped image) is handed to `onmedia(file)`
// as a File, the same path as the paperclip, instead of landing in the text.

const BLOCK = new Set(['DIV', 'P', 'LI']);

// The field's text, newlines where the editor put <br> or a new block.
function textOf(root) {
  let out = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.data;
      else if (c.nodeName === 'BR') out += '\n';
      else if (c.nodeType === 1) {
        if (BLOCK.has(c.nodeName) && out && !out.endsWith('\n')) out += '\n';
        walk(c);
      }
    }
  };
  walk(root);
  // an editor leaves a lone trailing <br> to hold an empty last line open
  return out.endsWith('\n') && root.lastChild && root.lastChild.nodeName === 'BR' ? out.slice(0, -1) : out;
}

// Text length from the start of `root` up to (node, offset).
function offsetOf(root, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(root);
  try { r.setEnd(node, offset); } catch { return textOf(root).length; }
  const frag = r.cloneContents();
  const div = document.createElement('div');
  div.append(frag);
  let t = textOf(div);
  // a <br> right at the caret counts as the newline it is
  if (div.lastChild && div.lastChild.nodeName === 'BR') t += '\n';
  return t.length;
}

// (node, offset) for a text position; the field is normalised to text nodes
// and <br>s, so that is all this walks.
function pointAt(root, pos) {
  let left = pos;
  for (const c of root.childNodes) {
    if (c.nodeType === 3) {
      if (left <= c.data.length) return [c, left];
      left -= c.data.length;
    } else if (c.nodeName === 'BR') {
      if (left === 0) return [root, [...root.childNodes].indexOf(c)];
      left -= 1;
    }
  }
  return [root, root.childNodes.length];
}

const mediaOf = (dt) => [...((dt && dt.files) || [])].filter((f) => /^(image|video)\//.test(f.type));

class CoinosText extends HTMLElement {
  constructor() {
    super();
    this._pendingValue = null;
    this.addEventListener('paste', (e) => this._onPaste(e));
    this.addEventListener('drop', (e) => {
      const files = mediaOf(e.dataTransfer);
      if (files.length) { e.preventDefault(); this._media(files); }
    });
    this.addEventListener('beforeinput', (e) => this._onBeforeInput(e));
    this.addEventListener('input', () => this._tidy());
  }
  connectedCallback() {
    if (!this.hasAttribute('contenteditable')) this.setAttribute('contenteditable', 'true');
    this.setAttribute('role', 'textbox');
    this.setAttribute('aria-multiline', 'true');
    if (this.hasAttribute('placeholder')) this.setAttribute('aria-placeholder', this.getAttribute('placeholder'));
    this._empty();
  }

  get value() { return textOf(this); }
  set value(v) {
    v = v == null ? '' : String(v);
    if (v === this.value) return;
    // text nodes and <br>s only: what pointAt walks
    this.replaceChildren(...v.split('\n').flatMap((line, i) => [...(i ? [document.createElement('br')] : []), ...(line ? [document.createTextNode(line)] : [])]));
    if (v.endsWith('\n')) this.append(document.createElement('br'));
    this._empty();
  }
  get placeholder() { return this.getAttribute('placeholder') || ''; }
  set placeholder(v) { this.setAttribute('placeholder', v); }

  get selectionStart() { return this._sel()[0]; }
  get selectionEnd() { return this._sel()[1]; }
  set selectionStart(v) { const [, e] = this._sel(); this.setSelectionRange(v, Math.max(v, e)); }
  set selectionEnd(v) { const [s] = this._sel(); this.setSelectionRange(Math.min(s, v), v); }
  _sel() {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || !this.contains(sel.anchorNode)) { const n = this.value.length; return [n, n]; }
    const r = sel.getRangeAt(0);
    return [offsetOf(this, r.startContainer, r.startOffset), offsetOf(this, r.endContainer, r.endOffset)];
  }
  setSelectionRange(start, end = start) {
    this.normalize();
    const sel = document.getSelection();
    if (!sel) return;
    const r = document.createRange();
    const [sn, so] = pointAt(this, start);
    const [en, eo] = pointAt(this, end);
    try { r.setStart(sn, so); r.setEnd(en, eo); sel.removeAllRanges(); sel.addRange(r); } catch {}
  }

  // Insert text at the caret as the editor would (undo history intact).
  _insert(text) {
    if (!document.execCommand('insertText', false, text)) {
      const s = this.selectionStart, e = this.selectionEnd, v = this.value;
      this.value = v.slice(0, s) + text + v.slice(e);
      this.setSelectionRange(s + text.length);
      this.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  _media(files) {
    for (const f of files) {
      if (typeof this.onmedia === 'function') this.onmedia(f);
    }
  }
  _onPaste(e) {
    const dt = e.clipboardData;
    const files = mediaOf(dt);
    if (files.length) { e.preventDefault(); this._media(files); return; }
    // plain text only: no fonts, links or colours from wherever it was copied
    e.preventDefault();
    const text = dt ? dt.getData('text/plain') : '';
    if (text) this._insert(text.replace(/\r\n?/g, '\n'));
  }
  _onBeforeInput(e) {
    // keyboard-inserted pictures (Android's commitContent) and drops arrive
    // as insertions carrying a DataTransfer
    if (e.dataTransfer) {
      const files = mediaOf(e.dataTransfer);
      if (files.length) { e.preventDefault(); this._media(files); return; }
      if (/^insertFrom/.test(e.inputType)) {
        e.preventDefault();
        const text = e.dataTransfer.getData('text/plain');
        if (text) this._insert(text.replace(/\r\n?/g, '\n'));
        return;
      }
    }
    // a new line is a newline, not a new <div>
    if (e.inputType === 'insertParagraph') { e.preventDefault(); this._insert('\n'); return; }
    if (/^format/.test(e.inputType)) e.preventDefault(); // no bold/italic shortcuts
  }
  // Anything that isn't text or <br> (an <img> a keyboard managed to put
  // in, a styled span) is taken out; a picture goes to onmedia.
  _tidy() {
    for (const img of this.querySelectorAll('img')) {
      const src = img.getAttribute('src');
      img.remove();
      if (src) fetch(src).then((r) => r.blob()).then((b) => {
        if (/^(image|video)\//.test(b.type)) this._media([new File([b], 'pasted.' + (b.type.split('/')[1] || 'png'), { type: b.type })]);
      }).catch(() => {});
    }
    if ([...this.children].some((c) => c.nodeName !== 'BR')) {
      const s = this.selectionStart, v = this.value;
      this.value = v;
      if (document.activeElement === this) this.setSelectionRange(Math.min(s, v.length));
    }
    this._empty();
  }
  _empty() { this.toggleAttribute('data-empty', !this.value); }
}

if (typeof customElements !== 'undefined' && !customElements.get('coinos-text')) {
  customElements.define('coinos-text', CoinosText);
}
