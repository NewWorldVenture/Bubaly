import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MOVE_STATUSES } from '@/lib/moving/planner';
import { getMessages } from '@/lib/i18n/messages';

// I18N-002. Move statuses came from MOVE_STATUSES, an English constant in
// lib/, on the status pill, the "Mark … →" suggestion, the status picker and
// the "Move marked …" toast — which also lowercased the label, something no
// translated label survives (German nouns are capitalised). The screen now
// renders catalogue keys and never changes their case.

const LOCALES = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const camel = (code: string) => code.replace(/(^|_)([a-z])/g, (_, __, c: string) => c.toUpperCase());
const source = readFileSync('components/modules/moving-module.tsx', 'utf8');

describe('move statuses are labelled in the viewer\'s language', () => {
  it.each(MOVE_STATUSES.map((s) => s.value))('%s has a key the screen uses and every catalogue fills', (status) => {
    const key = `moving.status${camel(status)}`;
    expect(source).toContain(`${status}: '${key}'`);
    for (const locale of LOCALES) expect(getMessages(locale)[key], `${locale} ${key}`).toBeTruthy();
  });

  it('never lowercases a translated status', () => {
    expect(source).not.toMatch(/statusLabel\([^)]*\)\.toLowerCase\(\)/);
  });
});
