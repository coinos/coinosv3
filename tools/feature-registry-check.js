// Guard: src/features/index.js and build.js's featureIndexSource must agree.
// They drifted once (nwc was added to index.js only, so its i18n strings
// shipped but its code never did — the settings card silently never rendered,
// because build.js SWAPS OUT features/index.js for a generated module).
//
// The strongest form of agreement is equality: the checked-in module must be
// code-identical (comments and whitespace aside) to what featureIndexSource
// generates for the full feature set — imports, construction order, deferred
// placeholder slots, and the deferred loader all included.
//   bun tools/feature-registry-check.js
import { readFileSync } from 'node:fs';
import { featureIndexSource, enabledFeatures } from '../build.js';

const strip = (s) => s
  .replace(/\/\/[^\n]*/g, '')       // line comments
  .replace(/\s+/g, ' ')             // whitespace runs
  .replace(/, /g, ',').replace(/ ,/g, ',')
  .trim();

const idx = readFileSync(new URL('../src/features/index.js', import.meta.url), 'utf8');
const gen = featureIndexSource(enabledFeatures(undefined));

if (strip(idx) !== strip(gen)) {
  console.log('x src/features/index.js does not match build.js featureIndexSource (full set)');
  console.log('\n--- generated (normalized) ---\n' + strip(gen));
  console.log('\n--- checked in (normalized) ---\n' + strip(idx));
  process.exit(1);
}
console.log(`ok features/index.js matches the generator (${enabledFeatures(undefined).length} features, deferred slots included)`);
