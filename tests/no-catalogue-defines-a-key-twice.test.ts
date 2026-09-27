import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A catalogue is read with JSON.parse, and JSON.parse keeps the LAST of two
// entries with one key without a word. So a key added a second time — by a
// merge, or by someone who did not see it was there — silently replaces the
// copy the first author chose, and every test that reads the parsed catalogue
// still sees a truthy string.
//
// Found by the page audit (C1-S9-99): all seven catalogues defined
// actions.couldNotSaveThatPlace, couldNotDeleteThatPlace and
// couldNotUpdateThatGeofence twice. The later copy won, and the geofence
// failure lost the sentence it exists to say — "The alert setting has not
// changed" — which tests/a-write-the-user-is-told-about-is-confirmed.test.ts
// asks for by name but could not see.
const DIR = 'lib/i18n/messages';
const catalogues = readdirSync(DIR).filter((f) => f.endsWith('.json'));

function keysOf(text: string): string[] {
  // One entry per line is how every catalogue is written; the parse below
  // proves the count of lines read is the count of entries.
  return [...text.matchAll(/^ {2}("(?:[^"\\]|\\.)*"):/gm)].map((m) => JSON.parse(m[1]) as string);
}

describe('no catalogue defines a key twice', () => {
  it.each(catalogues)('%s', (file) => {
    const text = readFileSync(`${DIR}/${file}`, 'utf8');
    const keys = keysOf(text);
    const parsed = Object.keys(JSON.parse(text) as Record<string, string>);
    const twice = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(twice, `${file} defines these more than once; JSON.parse keeps only the last`).toEqual([]);
    // Non-vacuity: every entry was seen by the line scan.
    expect(keys.length).toBe(parsed.length);
  });

  it('sees all seven base catalogues', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) expect(catalogues).toContain(`${locale}.json`);
  });

  it('and the geofence failure says the alert setting did not change, in the copy that is served', () => {
    const catalogue = JSON.parse(readFileSync(`${DIR}/en-US.json`, 'utf8')) as Record<string, string>;
    expect(catalogue['actions.couldNotUpdateThatGeofence']).toMatch(/has not changed/);
  });

  it('the scan would catch a key written twice', () => {
    expect(keysOf('{\n  "a.b": "one",\n  "a.b": "two"\n}').filter((k, i, all) => all.indexOf(k) !== i)).toEqual(['a.b']);
  });
});
