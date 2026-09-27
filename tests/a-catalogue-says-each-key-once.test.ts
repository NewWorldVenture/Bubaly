import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// JSON.parse keeps the LAST of two equal keys and says nothing. Two sessions
// added the locator's three failure messages independently, the merge kept
// both, and the later, vaguer copy won in all seven catalogues: a parent whose
// geofence switch failed read "Could not update that geofence." and never
// "The alert setting has not changed — refresh and try again." A key is said
// once, so the copy a reviewer reads is the copy that ships.
const DIR = 'lib/i18n/messages';

describe('a catalogue says each key once', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

  it('reads every catalogue (non-vacuity)', () => {
    expect(files.length).toBeGreaterThanOrEqual(11);
  });

  it.each(files)('%s has no key twice', (file) => {
    const seen = new Map<string, number>();
    const twice: string[] = [];
    readFileSync(join(DIR, file), 'utf8').split('\n').forEach((line, i) => {
      const key = /^\s*"((?:[^"\\]|\\.)+)"\s*:/.exec(line)?.[1];
      if (!key) return;
      if (seen.has(key)) twice.push(`${key} (lines ${seen.get(key)! + 1} and ${i + 1})`);
      else seen.set(key, i);
    });
    expect(twice).toEqual([]);
  });

  it('keeps the locator copy that says what did not change', () => {
    const en = JSON.parse(readFileSync(join(DIR, 'en-US.json'), 'utf8')) as Record<string, string>;
    expect(en['actions.couldNotUpdateThatGeofence']).toMatch(/alert setting has not changed/);
    expect(en['actions.couldNotSaveThatPlace']).toMatch(/Refresh and try again/);
  });
});
