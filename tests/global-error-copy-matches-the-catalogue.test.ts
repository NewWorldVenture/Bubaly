import { describe, expect, it } from 'vitest';
import enUS from '@/lib/i18n/messages/en-US.json';
import { GLOBAL_ERROR_MESSAGES } from '@/lib/i18n/global-error-messages';

// app/global-error.tsx is the boundary for an error in the ROOT LAYOUT, so the
// document is replaced and no LocaleProvider ever mounted above it. Once
// `translate` stopped falling back to the English catalogue — which is the
// point of lib/i18n/translate.ts — that page needed a source of its own, and a
// copy of four strings is a copy that can drift.
//
// So it is pinned both ways: every key here must exist in en-US with the same
// text, and the page must not ask for a key this map does not carry.
describe('the global error page says what the catalogue says', () => {
  const catalogue = enUS as Record<string, string>;

  it('matches en-US exactly, key for key', () => {
    const drifted: string[] = [];
    for (const [key, value] of Object.entries(GLOBAL_ERROR_MESSAGES)) {
      if (!(key in catalogue)) { drifted.push(`${key} is not in en-US at all`); continue; }
      if (catalogue[key] !== value) {
        drifted.push(`${key}\n      here: ${value}\n     en-US: ${catalogue[key]}`);
      }
    }
    expect(Object.keys(GLOBAL_ERROR_MESSAGES).length, 'the map was not parsed').toBeGreaterThan(0);
    expect(drifted, 'a copy edit reached one of these and not the other — the last-resort '
      + 'error page would show text the catalogue no longer says').toEqual([]);
  });

  it('carries every key the page asks for', () => {
    const source = readGlobalError();
    const asked = [...source.matchAll(/t\(\s*'(globalError\.[A-Za-z0-9_]+)'/g)].map((m) => m[1]);
    expect(asked.length, 'no globalError.* calls were found — has the page stopped '
      + 'translating, or has it been renamed?').toBeGreaterThan(0);
    expect(asked.filter((k) => !(k in GLOBAL_ERROR_MESSAGES)),
      'the page asks for a key GLOBAL_ERROR_MESSAGES does not carry, so it would render '
      + 'the raw key at somebody whose session has just broken').toEqual([]);
  });
});

function readGlobalError(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('node:fs').readFileSync('app/global-error.tsx', 'utf8') as string;
}
