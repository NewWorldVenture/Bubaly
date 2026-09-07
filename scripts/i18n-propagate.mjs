// scripts/i18n-propagate.mjs — give a new key the translation its English
// already has somewhere else.
//
// WHY. Translation here is value-first: "Cancel" is translated once and every
// one of the 125 keys holding it gets the same word. `i18n-apply.mjs --by-text`
// does that — but only for the keys that exist AT THE MOMENT IT RUNS.
//
// The i18n lift adds keys continuously. A string lifted out of a component
// today may be a string that was translated into six languages last week under
// a different key, and nothing would notice: the new key sits empty, the page
// shows English, and the coverage number counts it as outstanding work that
// somebody already did. That is how `featureCards.mealPlanning` came to render
// "Meal Planning" on a French page while `featureRail.mealPlanning` two
// sections above it read "Planification des repas".
//
// So: for every key with no translation, if ANOTHER key holds the same English
// and HAS one, copy it. Nothing is invented and nothing is overwritten — a key
// that already has a translation is left exactly as it is.
import { readFileSync, writeFileSync } from 'node:fs';

const DIR = 'lib/i18n/messages';
const LANGS = ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const write = process.argv.includes('--apply');

const en = JSON.parse(readFileSync(`${DIR}/en-US.json`, 'utf8'));
let filledTotal = 0;

for (const lang of LANGS) {
  const path = `${DIR}/${lang}.json`;
  const cat = JSON.parse(readFileSync(path, 'utf8'));

  // English value -> the translation already agreed for it.
  const byValue = new Map();
  for (const [key, english] of Object.entries(en)) {
    const t = cat[key];
    if (typeof english !== 'string' || typeof t !== 'string' || !t.trim()) continue;
    // First one wins; a value translated two different ways is a review
    // question, not something to silently pick between.
    if (!byValue.has(english)) byValue.set(english, t);
  }

  let filled = 0;
  for (const [key, english] of Object.entries(en)) {
    if (typeof cat[key] === 'string' && cat[key].trim()) continue;
    const known = byValue.get(english);
    if (!known) continue;
    cat[key] = known;
    filled += 1;
  }

  filledTotal += filled;
  const done = Object.keys(en).filter((k) => typeof cat[k] === 'string' && cat[k].trim()).length;
  console.log(
    `  ${lang}  +${String(filled).padStart(4)}  ->  ${done} / ${Object.keys(en).length}` +
      `  ${((done / Object.keys(en).length) * 100).toFixed(1)}%`,
  );
  if (write) {
    const sorted = Object.fromEntries(Object.keys(cat).sort().map((k) => [k, cat[k]]));
    writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
  }
}

console.log(`\n${filledTotal} translation(s) ${write ? 'written' : 'would be written'} from values already agreed.`);
if (!write) console.log('(dry run — pass --apply to write)');
