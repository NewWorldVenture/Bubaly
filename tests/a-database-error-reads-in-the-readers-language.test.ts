import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMessages } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import type { LocaleCode } from '@/lib/i18n/locales';

// I18N-011. describeDbError's five classified messages were English literals,
// returned from 689 call sites, so a German family refused by RLS read
// "You don't have permission to do that…" in English.
const tFor = (locale: LocaleCode) => (key: string) => translate(getMessages(locale), key);
const ERRORS = [
  { code: '42501' }, { code: '23505' }, { code: '23503' }, { code: '23514' }, { message: 'Failed to fetch' },
];

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("a classified database error reads in the reader's language", () => {
  it('is English with no translator registered (the server)', async () => {
    const { describeDbError, DB_ERROR_MESSAGES } = await import('@/lib/supabase/errors');
    expect(describeDbError({ code: '42501' })).toBe(DB_ERROR_MESSAGES.permission.en);
  });

  it('is German in a German browser, for every one of the five classes', async () => {
    vi.stubGlobal('window', {});
    const { describeDbError, setDbErrorTranslator, DB_ERROR_MESSAGES } = await import('@/lib/supabase/errors');
    setDbErrorTranslator(tFor('de-DE'));
    const english = Object.values(DB_ERROR_MESSAGES).map((m) => m.en);
    for (const error of ERRORS) {
      const text = describeDbError(error);
      expect(english, JSON.stringify(error)).not.toContain(text);
      expect(text.length).toBeGreaterThan(10);
    }
    expect(describeDbError({ code: '42501' })).toBe(translate(getMessages('de-DE'), 'error.dbPermission'));
  });

  it('never shows a raw key when a translator lacks it', async () => {
    vi.stubGlobal('window', {});
    const { describeDbError, setDbErrorTranslator, DB_ERROR_MESSAGES } = await import('@/lib/supabase/errors');
    setDbErrorTranslator((key) => key);
    expect(describeDbError({ code: '23505' })).toBe(DB_ERROR_MESSAGES.conflict.en);
  });

  it('translates the English a server action returned, where the toast shows it', async () => {
    const { localizeDbErrorText, DB_ERROR_MESSAGES } = await import('@/lib/supabase/errors');
    expect(localizeDbErrorText(DB_ERROR_MESSAGES.notFound.en, tFor('fr-FR'))).toBe(translate(getMessages('fr-FR'), 'error.dbNotFound'));
    expect(localizeDbErrorText('Something else entirely.', tFor('fr-FR'))).toBe('Something else entirely.');
    const toast = readFileSync('components/ui/toast.tsx', 'utf8');
    expect(toast).toContain('localizeDbErrorText(t.message, tr)');
    expect(readFileSync('components/i18n/locale-provider.tsx', 'utf8')).toMatch(/setDbErrorTranslator\(/);
  });

  it('every complete catalogue carries all five, and none of them is the English', async () => {
    const { DB_ERROR_MESSAGES } = await import('@/lib/supabase/errors');
    for (const locale of ['de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as LocaleCode[]) {
      for (const { key, en } of Object.values(DB_ERROR_MESSAGES)) {
        const text = translate(getMessages(locale), key);
        expect(text, `${locale} ${key}`).not.toBe(key);
        expect(text, `${locale} ${key}`).not.toBe(en);
      }
    }
    for (const { key, en } of Object.values(DB_ERROR_MESSAGES)) expect(translate(getMessages('en-US'), key)).toBe(en);
  });
});
