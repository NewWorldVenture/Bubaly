import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'lib/i18n/messages');
const FILES = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));

const read = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8')) as Record<string, string>;

const source = read('en-US.json');

describe('translation catalogue integrity', () => {
  it('ships every locale we advertise', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(11);
    expect(FILES).toContain('en-US.json');
  });

  // A catalogue value is a JavaScript string, not markup. JSX decodes
  // `&rarr;` for free; `{t('key')}` does not, so an entity that survived
  // extraction renders as the literal characters "&rarr;" to every user in
  // every language. Seven strings shipped that way before this guard existed —
  // the source still read correctly, which is exactly why nothing caught it.
  it.each(FILES)('%s holds no undecoded HTML entities', (file) => {
    const offenders = Object.entries(read(file))
      .filter(([, value]) => /&[a-zA-Z][a-zA-Z0-9]{1,10};|&#\d+;|&#x[0-9a-fA-F]+;/.test(value))
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders).toEqual([]);
  });

  // A translation that drops or renames a placeholder renders a literal brace
  // at a user, or silently omits the value the sentence was built around.
  it.each(FILES.filter((f) => f !== 'en-US.json'))('%s preserves placeholders', (file) => {
    const holders = (s: string) => (s.match(/\{(\w+)\}/g) ?? []).sort().join(',');
    const offenders = Object.entries(read(file))
      .filter(([key, value]) => key in source && holders(value) !== holders(source[key]))
      .map(([key, value]) => `${key}: "${source[key]}" -> "${value}"`);
    expect(offenders).toEqual([]);
  });

  // An orphan is a translation whose English key no longer exists: dead weight
  // a reviewer has to chase, and a sign the extractor and the catalogues have
  // drifted apart.
  it.each(FILES.filter((f) => f !== 'en-US.json'))('%s has no orphaned keys', (file) => {
    const orphans = Object.keys(read(file)).filter((key) => !(key in source));
    expect(orphans).toEqual([]);
  });

  // Every locale we ship is written in the Latin script. A stray CJK, Cyrillic
  // or Arabic character means text from somewhere else leaked into a
  // translation mid-edit — it renders as tofu or as a word no reader of that
  // language knows, and it is invisible in a diff full of accented Latin.
  // Emoji are deliberately allowed — the English source uses them on purpose.
  // Adding a non-Latin locale means deliberately removing it from this list.
  const LATIN_SCRIPT = FILES;
  it.each(LATIN_SCRIPT)('%s is written in the Latin script', (file) => {
    const offenders = Object.entries(read(file))
      .filter(([, value]) =>
        /[\u0370-\u074F\u0900-\u0DFF\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/.test(value),
      )
      .map(([key, value]) => `${key}: ${value}`);
    expect(offenders).toEqual([]);
  });

  it('has no blank English values', () => {
    const blank = Object.entries(source)
      .filter(([, value]) => !value.trim())
      .map(([key]) => key);
    expect(blank).toEqual([]);
  });
});
