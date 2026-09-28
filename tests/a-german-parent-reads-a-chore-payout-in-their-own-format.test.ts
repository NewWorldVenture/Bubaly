// The Pay item on a finished chore was the last family-facing call to the
// wallet's `formatCents` that passed no locale, so it took the en-US default:
// a German parent read "Pay $12.50" in English, with an American amount, on
// the only menu item that moves money. "Paying…" was a literal beside it.
//
// The label now comes from the catalogue and the amount from Intl in the
// reader's locale — both, because localising the number inside an English
// sentence changes nothing a German reader can use (I18N-003).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatCents } from '@/lib/wallet/ledger';
import { translate } from '@/lib/i18n/translate';

const FULL = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const catalogue = (code: string) =>
  JSON.parse(readFileSync(`lib/i18n/messages/${code}.json`, 'utf8')) as Record<string, string>;

describe('a chore payout reads in the parent\'s own language and format', () => {
  it('a German parent reads the amount the German way, in German', () => {
    const label = translate(catalogue('de-DE'), 'chores.payAmount', { amount: formatCents(1250, 'USD', 'de-DE') });
    expect(label).toBe('12,50 $ auszahlen');
    expect(translate(catalogue('de-DE'), 'chores.paying')).not.toBe('Paying…');
  });

  it('an American parent reads what they read before (control)', () => {
    expect(translate(catalogue('en-US'), 'chores.payAmount', { amount: formatCents(1250, 'USD', 'en-US') })).toBe('Pay $12.50');
    expect(translate(catalogue('en-US'), 'chores.paying')).toBe('Paying…');
  });

  it('every full catalogue carries both keys, and the amount has a place to go', () => {
    for (const code of FULL) {
      const messages = catalogue(code);
      expect(messages['chores.paying'], code).toBeTruthy();
      expect(messages['chores.payAmount'], code).toContain('{amount}');
    }
  });

  it('the menu item asks the catalogue and passes the reader\'s locale', () => {
    const source = readFileSync('components/modules/chores-module.tsx', 'utf8');
    const item = source.slice(source.indexOf('{canPay && <MenuItem'));
    const line = item.slice(0, item.indexOf('</MenuItem>'));
    expect(line).toContain("tr('chores.paying')");
    expect(line).toContain("tr('chores.payAmount', { amount: formatCents(a.chore!.cash_cents!, 'USD', locale.code) })");
    expect(line).not.toMatch(/'Paying…'|`Pay \$/);
  });
});
