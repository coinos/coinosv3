// The standalone wallet (standalone.html opened from a disk) has no files
// beside it: punks, the lazy modules and the language packs come from the
// site instead. Served from anywhere else, paths stay relative.
export const SITE = 'https://v3.coinos.io/';
const fromDisk = () => typeof location !== 'undefined' && location.protocol === 'file:';
export const assetUrl = (path) => fromDisk() ? SITE + path.replace(/^\//, '') : path;
