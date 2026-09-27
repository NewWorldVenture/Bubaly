// B8 page audit: /dashboard/social/accounts/connect still failed hydration in
// Italian after P-11 bound numbers to the reader's locale. CLDR gives it-IT (and
// es, pt) a two-digit minimum before grouping, and the runtimes ship different
// data for it: Node formatted 2200 as "2200", Chromium as "2.200" — measured
// side by side on the local stack. fmtNumber and fmtMoney now group every
// thousand explicitly, so the server and the browser draw the same text.
import { describe, expect, it } from 'vitest';
import { createFormat } from '@/lib/utils/format';

describe('a four-digit number, in the locales whose default grouping differs', () => {
  it('groups it in Italian, as Chromium does', () => {
    expect(createFormat('it-IT').fmtNumber(2200)).toBe('2.200');
  });

  it('groups it in Spanish and Portuguese too', () => {
    expect(createFormat('es-ES').fmtNumber(2200)).toBe('2.200');
    expect(createFormat('pt-PT').fmtNumber(2200).replace(/\s/g, ' ')).toBe('2 200');
  });

  it('groups money the same way', () => {
    expect(createFormat('it-IT').fmtMoney(220000, 'EUR').replace(/\s/g, ' ')).toBe('2.200,00 €');
  });

  it('leaves English and German as they were', () => {
    expect(createFormat('en-US').fmtNumber(2200)).toBe('2,200');
    expect(createFormat('de-DE').fmtNumber(2200)).toBe('2.200');
    expect(createFormat('en-US').fmtMoney(123456)).toBe('$1,234.56');
  });
});
