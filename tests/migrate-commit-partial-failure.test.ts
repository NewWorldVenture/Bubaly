// The importer's failure copy is the family's, not the database's.
//
// commitImport writes five tables in sequence and cannot be one transaction, so
// a failure in the third write leaves the first two saved. What the family is
// told at that moment decides whether they run the file again — and events and
// contacts are de-duplicated on a second pass while tasks, grocery items and
// notes are not. The old copy was `Events: ${error.message}`: PostgREST's own
// sentence, in English whatever the locale, saying nothing about what had
// already landed. This pins that every write-failure site reports the counts
// saved so far through one keyed sentence, and never offers a retry.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../app/(app)/dashboard/migrate/actions.ts', import.meta.url), 'utf8');
const commit = source.slice(source.indexOf('export async function commitImport'));
const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'];
const KEY = 'migrateActions.theImportStoppedPartWayThrough';

describe('commitImport reports a part-way failure honestly', () => {
  it('never hands the database\'s own message to the family', () => {
    expect(commit).not.toMatch(/error:\s*`[A-Z][a-z ]*:\s*\$\{(error|assignErr)\.message\}`/);
    expect(commit).not.toContain('${error.message}');
    expect(commit).not.toContain('${assignErr.message}');
  });

  it('routes every write failure through the one helper that says what was saved', () => {
    // Seven writes: events, chores, chore assignments, the grocery list, grocery
    // items, notes, contacts. Each failure is one call, with a label for the log.
    const calls = commit.match(/return partialFailure\('[a-z ]+', (error|assignErr)\)/g) ?? [];
    expect(calls).toHaveLength(7);
    const helper = commit.slice(commit.indexOf('const partialFailure'), commit.indexOf('};', commit.indexOf('const partialFailure')));
    expect(helper).toContain(`t('${KEY}', counts)`);
    // A retry here would import the tasks, grocery items and notes a second time.
    expect(helper).not.toContain('retryable');
  });

  it('carries the five counts in every locale', () => {
    for (const locale of LOCALES) {
      const catalogue = JSON.parse(readFileSync(new URL(`../lib/i18n/messages/${locale}.json`, import.meta.url), 'utf8')) as Record<string, string>;
      const copy = catalogue[KEY];
      expect(copy, locale).toBeTruthy();
      for (const placeholder of ['{events}', '{tasks}', '{grocery}', '{notes}', '{contacts}']) {
        expect(copy, `${locale} ${placeholder}`).toContain(placeholder);
      }
    }
  });
});
