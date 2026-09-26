import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CARE_LOG_TYPE_LABELS } from '@/lib/care/log';
import { getMessages } from '@/lib/i18n/messages';

// I18N-002. The care log drew its type chips, entry labels, type picker and
// "{type} logged" toast from CARE_LOG_TYPE_LABELS, an English constant in
// lib/ (which the hardcoded-string scanner does not read), so the whole log
// stayed English in every language. The screen now renders catalogue keys.

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const camel = (code: string) => code.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());
const source = readFileSync('components/modules/care-module.tsx', 'utf8');

describe('care log types are labelled in the viewer\'s language', () => {
  it.each(Object.keys(CARE_LOG_TYPE_LABELS))('%s has a key the screen uses and every catalogue fills', (type) => {
    const key = `careModule.logType${camel(type)}`;
    expect(source).toContain(`${type}: '${key}'`);
    for (const locale of LOCALES) expect(getMessages(locale)[key], `${locale} ${key}`).toBeTruthy();
  });

  it('no longer renders the English constant', () => {
    expect(source).not.toMatch(/CARE_LOG_TYPE_LABELS\[/);
    expect(source).toContain("tr('careModule.typeLogged', { type: typeLabel(type) })");
  });
});
