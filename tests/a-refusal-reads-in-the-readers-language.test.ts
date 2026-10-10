import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { renderTranslated } from './helpers/render-translated';
import { ActionError } from '@/components/ui/action-error';
import { Field } from '@/components/ui/input';
import { getMessages } from '@/lib/i18n/messages';
import { AUTH_SCOPE, MARKETING_SCOPE, PUBLIC_LINK_SCOPE, ROOT_CHROME_SCOPE, SURVEY_SCOPE, scopeMessages } from '@/lib/i18n/scopes';
import {
  DB_ERROR_ENGLISH, describeActionError, describeDbError, localizeDbErrorText, rememberDbErrorText, type DbErrorKey,
} from '@/lib/supabase/errors';

// I18N-011: describeDbError's five sentences were English in every locale.
//
// It classifies a refused write (RLS, a duplicate, a missing row, a broken
// constraint, a dropped connection) and answers with one of five fixed
// sentences, from ~700 call sites. A German family refused by RLS read
// "You don't have permission to do that…" on an otherwise German screen. The
// sentences are catalogue keys now, and they reach the reader two ways:
//   - in the browser, describeDbError answers in the language of the latest
//     LocaleProvider still mounted;
//   - a sentence written on the server (a server action's `{ error }`) is put
//     into the reader's language where it is shown: the toast, ActionError and
//     a form field's error.

const KEYS = Object.keys(DB_ERROR_ENGLISH) as DbErrorKey[];
const FULL = ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const de = getMessages('de-DE');

// One error of each class, as Supabase hands them back.
const REFUSALS: Record<DbErrorKey, unknown> = {
  'dbError.permission': { code: '42501', message: 'new row violates row-level security policy for table "todos"' },
  'dbError.conflict': { code: '23505', message: 'duplicate key value violates unique constraint "todos_pkey"' },
  'dbError.notFound': { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' },
  'dbError.invalid': { code: '23514', message: 'new row for relation "todos" violates check constraint "todos_title_check"' },
  'dbError.network': new TypeError('Failed to fetch'),
};

/** What a test registered, to take out again afterwards, as unmounting does. */
const mounted: (() => void)[] = [];
const remember = (messages: Record<string, string>) => { const leave = rememberDbErrorText(messages); mounted.push(leave); return leave; };

/** A browser for the length of one test: rememberDbErrorText only listens there. */
function inBrowser(run: () => void) {
  const had = 'window' in globalThis;
  if (!had) (globalThis as { window?: unknown }).window = globalThis;
  try { run(); } finally {
    for (const leave of mounted.splice(0).reverse()) leave();
    if (!had) delete (globalThis as { window?: unknown }).window;
  }
}
afterEach(() => inBrowser(() => {}));

describe('the five sentences are in every full catalogue', () => {
  it('en-US holds exactly the sentences describeDbError writes', () => {
    const en = getMessages('en-US');
    for (const key of KEYS) expect(en[key], key).toBe(DB_ERROR_ENGLISH[key]);
  });

  it('every full translation has its own words for each', () => {
    for (const locale of FULL) {
      const raw = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      for (const key of KEYS) {
        expect(raw[key], `${locale} ${key}`).toBeTruthy();
        expect(raw[key], `${locale} ${key} is still English`).not.toBe(DB_ERROR_ENGLISH[key]);
      }
    }
  });

  // localizeDbErrorText finds a sentence by its exact words, in any language
  // it has seen, and swaps in the receiving reader's. That holds only while
  // each of the 35 sentences (five keys, seven catalogues) names one key and
  // none sits inside another's: otherwise a swap could rewrite part of a
  // different sentence.
  it('each of the 35 sentences is one key’s, and none is inside another', () => {
    const all = (['en-US', ...FULL] as const).flatMap((locale) => {
      const raw = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>;
      return KEYS.map((key) => ({ locale, key, sentence: raw[key] }));
    });
    expect(all).toHaveLength(35);
    for (const a of all) {
      for (const b of all) {
        if (a.sentence === b.sentence) expect(b.key, `${a.locale} ${a.key} = ${b.locale} ${b.key}`).toBe(a.key);
        else expect(b.sentence.includes(a.sentence), `${a.locale} ${a.key} inside ${b.locale} ${b.key}`).toBe(false);
      }
    }
  });

  it('every surface carries them, so the toast can translate on a public page too', () => {
    expect(ROOT_CHROME_SCOPE).toContain('dbError');
    for (const scope of [ROOT_CHROME_SCOPE, MARKETING_SCOPE, AUTH_SCOPE, PUBLIC_LINK_SCOPE, SURVEY_SCOPE]) {
      const scoped = scopeMessages(de, scope);
      for (const key of KEYS) expect(scoped[key], key).toBe(de[key]);
    }
  });
});

describe('describeDbError answers in the reader’s language in the browser', () => {
  it('on the server (no reader to remember) it is English, as before', () => {
    rememberDbErrorText(de); // ignored: there is no window
    for (const key of KEYS) expect(describeDbError(REFUSALS[key], 'fallback'), key).toBe(DB_ERROR_ENGLISH[key]);
  });

  it('in a German browser it is German, for describeActionError too', () => {
    inBrowser(() => {
      remember(de);
      for (const key of KEYS) {
        expect(describeDbError(REFUSALS[key], 'fallback'), key).toBe(de[key]);
        expect(describeActionError(REFUSALS[key], 'fallback'), key).toBe(de[key]);
      }
      // What it does not classify is unchanged: the caller's fallback.
      expect(describeDbError({ code: '22P02', message: 'invalid input value for enum' }, 'Nicht gespeichert.')).toBe('Nicht gespeichert.');
    });
  });

  it('follows a change of language, and a catalogue without the sentences changes nothing', () => {
    inBrowser(() => {
      remember(de);
      remember({ 'toast.dismiss': 'Schließen' });
      expect(describeDbError(REFUSALS['dbError.conflict'])).toBe(de['dbError.conflict']);
      remember(getMessages('fr-FR'));
      expect(describeDbError(REFUSALS['dbError.conflict'])).toBe(getMessages('fr-FR')['dbError.conflict']);
    });
  });

  it('a nested provider that goes away leaves the one around it current, in whichever order they go', () => {
    const fr = getMessages('fr-FR');
    const refused = REFUSALS['dbError.permission'];
    inBrowser(() => {
      remember(fr);
      const leaveGerman = remember(de);
      expect(describeDbError(refused)).toBe(de['dbError.permission']);
      leaveGerman();
      expect(describeDbError(refused)).toBe(fr['dbError.permission']);
    });
    inBrowser(() => {
      // The outer one going first (a remount above) leaves the inner one current.
      const leaveFrench = remember(fr);
      remember(de);
      leaveFrench();
      expect(describeDbError(refused)).toBe(de['dbError.permission']);
    });
    // Every provider gone: English, as on the server.
    inBrowser(() => expect(describeDbError(refused)).toBe(DB_ERROR_ENGLISH['dbError.permission']));
  });
});

describe('a sentence written on the server is shown in the reader’s language', () => {
  const english = DB_ERROR_ENGLISH['dbError.permission'];

  it('localizeDbErrorText translates each sentence, inside a longer message too, and nothing else', () => {
    const t = (key: string) => de[key] ?? key;
    expect(localizeDbErrorText(english, t)).toBe(de['dbError.permission']);
    expect(localizeDbErrorText(`Rezept: ${english}`, t)).toBe(`Rezept: ${de['dbError.permission']}`);
    expect(localizeDbErrorText('Could not save that policy.', t)).toBe('Could not save that policy.');
    // A translator without the key answers with the key; the English stays.
    expect(localizeDbErrorText(english, (key) => key)).toBe(english);
  });

  it('a sentence kept from a language the reader has left is put into the new one', () => {
    const fr = getMessages('fr-FR');
    const german = de['dbError.notFound'];
    // Shown once under German (a toast or a field rendering it), then the reader switches.
    expect(localizeDbErrorText(german, (key) => de[key] ?? key)).toBe(german);
    expect(localizeDbErrorText(german, (key) => fr[key] ?? key)).toBe(fr['dbError.notFound']);
    // And back: French is known now too.
    expect(localizeDbErrorText(fr['dbError.notFound'], (key) => de[key] ?? key)).toBe(german);
  });

  it('a form field shows it in German', () => {
    const html = renderTranslated(createElement(Field, { label: 'Titel', error: english, children: () => null }), 'de-DE');
    expect(html).toContain(escape(de['dbError.permission']));
    expect(html).not.toContain(escape(english));
  });

  it('ActionError shows it in German, and an English reader still reads English', () => {
    expect(renderTranslated(createElement(ActionError, { message: english }), 'de-DE')).toContain(escape(de['dbError.permission']));
    expect(renderTranslated(createElement(ActionError, { message: english }), 'en-US')).toContain(escape(english));
  });
});

function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}
