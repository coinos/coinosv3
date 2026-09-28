// A rough guess at the language a post is written in, cheap enough to run
// on every post of a public feed. Script first (a post in Han or Arabic
// letters is not English), then, among the Latin-script languages the app
// speaks, a handful of function words each. Short or ambiguous text is
// "unknown", and unknown is never held against a post.
const SCRIPTS = [
  ['latin', /[A-Za-zÀ-ɏḀ-ỿ]/g],
  ['cyrillic', /[Ѐ-ӿ]/g],
  ['arabic', /[؀-ۿݐ-ݿ]/g],
  ['devanagari', /[ऀ-ॿ]/g],
  ['bengali', /[ঀ-৿]/g],
  ['tamil', /[஀-௿]/g],
  ['telugu', /[ఀ-౿]/g],
  ['kana', /[぀-ヿ]/g],
  ['han', /[一-鿿㐀-䶿]/g],
  ['hangul', /[가-힯ᄀ-ᇿ]/g],
];
const LANG_SCRIPT = {
  en: 'latin', es: 'latin', fr: 'latin', de: 'latin', pt: 'latin', id: 'latin', sw: 'latin', tr: 'latin', vi: 'latin',
  ru: 'cyrillic', ar: 'arabic', ur: 'arabic', hi: 'devanagari', mr: 'devanagari', bn: 'bengali', ta: 'tamil', te: 'telugu',
  ja: 'kana', ko: 'hangul', zh: 'han',
};
const STOP = {
  en: 'the and is to of in that it for you with this on are be have not was but they'.split(' '),
  es: 'el la de que y en los es un una por con para las del se no como más pero'.split(' '),
  fr: 'le la les de des et est un une pour que qui dans pas sur avec ce il nous vous'.split(' '),
  de: 'der die und das ist nicht ein eine ich zu mit den auf für sich dem des auch wir'.split(' '),
  pt: 'o a de que e do da em um uma para com não os as se mais por isso você'.split(' '),
  id: 'yang dan di ini itu dengan untuk tidak dari ada saya akan ke juga bisa kita sudah atau kalau aku'.split(' '),
  tr: 've bir bu için ile de da çok ne gibi daha ama var ben sen mi değil kadar her olan'.split(' '),
  vi: 'và của là có không được một trong cho những này với các để người đã tôi khi cũng như'.split(' '),
  sw: 'na ya wa kwa ni za la katika hii kuwa kama hata lakini sana yake wote sasa tu huo hapa'.split(' '),
};
const STOPSETS = Object.fromEntries(Object.entries(STOP).map(([k, v]) => [k, new Set(v)]));

// The text a reader actually reads: no links, no nostr references, no tags.
export const proseOf = (text) => String(text || '')
  .replace(/https?:\/\/\S+/g, ' ').replace(/nostr:[a-z0-9]+/gi, ' ').replace(/#[\p{L}\p{N}_]+/gu, ' ');

export function scriptOf(text) {
  let best = null, bestN = 0, total = 0;
  for (const [name, re] of SCRIPTS) {
    const n = (text.match(re) || []).length;
    total += n;
    if (n > bestN) { best = name; bestN = n; }
  }
  return total < 3 ? null : best;
}

// A language code from the app's list, or null when it cannot tell.
export function guessLang(text) {
  const prose = proseOf(text);
  const script = scriptOf(prose);
  if (!script) return null;
  if (script === 'kana') return 'ja';
  if (script === 'han') return 'zh';
  if (script !== 'latin') {
    const langs = Object.entries(LANG_SCRIPT).filter(([, s]) => s === script).map(([l]) => l);
    return langs.length === 1 ? langs[0] : null; // ar/ur, hi/mr share a script: unknown between them
  }
  const words = prose.toLowerCase().match(/[\p{L}']+/gu) || [];
  if (words.length < 4) return null;
  const score = {};
  for (const w of words) for (const [l, set] of Object.entries(STOPSETS)) if (set.has(w)) score[l] = (score[l] || 0) + 1;
  const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
  if (!ranked.length || ranked[0][1] < 2) return null;
  if (ranked[1] && ranked[0][1] < ranked[1][1] * 1.5) return null;
  return ranked[0][0];
}

// Does a post read in this language, as far as we can tell? Unknown passes;
// a wrong script or a clear other language fails.
export function inLanguage(text, lang) {
  const want = LANG_SCRIPT[lang];
  if (!want) return true;
  const prose = proseOf(text);
  const script = scriptOf(prose);
  if (!script) return true; // nothing readable to judge (a picture post, an emoji)
  if (script !== want) return false;
  if (want === 'han' && lang === 'zh' && /[぀-ヿ]/.test(prose)) return false; // kana means Japanese
  const g = guessLang(prose);
  return g === null || g === lang;
}

// Machine output dressed as a post: JSON, a hash dump, a wall of symbols.
export function isMachinePost(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  if (/^[\[{]/.test(s)) { try { JSON.parse(s); return true; } catch {} }
  const prose = proseOf(s).replace(/\s+/g, '');
  if (prose.length < 24) return false;
  const letters = (prose.match(/\p{L}/gu) || []).length;
  return letters / prose.length < 0.4;
}
