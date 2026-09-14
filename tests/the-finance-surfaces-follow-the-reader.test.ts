// The Finances surfaces format for whoever is reading them.
//
// Five formatter sites across three modules — lib/finance/hub.ts (usd,
// fmtDueDate), lib/finance/splits.ts (usd) and lib/finance/timeline.ts (money,
// pretty) — used to hardcode 'en-US'. Twelve surfaces render them: the Bill
// Manager, Auto Pay, Due Reminders, Budget Planner, Savings, Payments, Expense
// Splitting, Subscriptions, Tax Vault, the Financial Copilot, the affordability
// form, and the Family CFO forecast tiles.
//
// Two things are asserted with EXACT strings rather than `toContain`, because
// the separators are the part that breaks:
//
//   de-DE puts U+00A0 (NO-BREAK SPACE) between the amount and the symbol, so the
//   figure cannot split across a line. fr-FR uses U+202F (NARROW NO-BREAK SPACE)
//   as its thousands separator. A `toContain('1.234,50')` passes happily against
//   a formatter that has flattened either to a plain space — which is how a
//   previous pass shipped German money that could break mid-amount.
//
// And the CURRENCY stays the money's own. A family's bills are billed in dollars
// whatever language the person looking at them reads; converting the figure
// would misstate an amount. So fr-FR renders "$US" — the dollar, named in French
// — and never euros.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { usd as usdDollars, fmtDueDate } from '@/lib/finance/hub';
import { usd as usdCents } from '@/lib/finance/splits';
import { buildCashflowTimeline, money, pretty } from '@/lib/finance/timeline';

describe('lib/finance/hub — the Finances sub-pages', () => {
  it('formats dollars in the reader locale, in dollars', () => {
    expect(usdDollars(1234.5)).toBe('$1,234.50');
    expect(usdDollars(1234.5, 'de-DE')).toBe('1.234,50 $');
    expect(usdDollars(1234.5, 'fr-FR')).toBe('1 234,50 $US');
    expect(usdDollars(1234.5, 'pt-PT')).toBe('1234,50 US$');
  });

  it('orders the due date the way the reader writes dates, not just names the month', () => {
    // The bug a date-fns pattern hides: 'MMM d, yyyy' gives German month names in
    // American ORDER. Assert the order, not the words.
    const de = fmtDueDate('2026-07-14', 'de-DE');
    expect(de).toBe('14. Juli 2026');
    expect(de.indexOf('14')).toBeLessThan(de.indexOf('Juli'));
    expect(fmtDueDate('2026-07-14', 'pt-PT')).toBe('14/07/2026');
    expect(fmtDueDate('2026-07-14')).toBe('Jul 14, 2026');
  });

  it('still returns empty for an unparseable date in every locale', () => {
    for (const l of ['en-US', 'de-DE', 'it-IT'] as const) {
      expect(fmtDueDate('not-a-date', l)).toBe('');
    }
  });
});

describe('lib/finance/splits — Expense Splitting, Subscriptions, Tax Vault', () => {
  it('formats cents in the reader locale', () => {
    expect(usdCents(1234)).toBe('$12.34');
    expect(usdCents(123450, 'de-DE')).toBe('1.234,50 $');
    expect(usdCents(123450, 'fr-FR')).toBe('1 234,50 $US');
  });
});

describe('lib/finance/timeline — the Financial Copilot', () => {
  it('formats whole dollars and week labels in the reader locale', () => {
    expect(money(1234)).toBe('$1,234');
    expect(money(1234, 'de-DE')).toBe('1.234 $');
    expect(money(1234, 'fr-FR')).toBe('1 234 $US');
    expect(pretty('2026-01-19')).toBe('Jan 19');
    expect(pretty('2026-01-19', 'de-DE')).toBe('19. Jan.');
  });

  // The week label is built at UTC midnight by parseDate(), so rendering it in a
  // viewer's zone would shift a week-start back a day west of Greenwich. The
  // locale changes the wording; timeZone: 'UTC' must survive it.
  it('keeps the week label on the UTC day the week actually starts', () => {
    const original = process.env.TZ;
    try {
      process.env.TZ = 'America/Los_Angeles';
      expect(pretty('2026-01-19')).toBe('Jan 19');
      expect(pretty('2026-01-19', 'fr-FR')).toBe('19 janv.');
    } finally {
      process.env.TZ = original;
    }
  });

  it('formats the amounts inside the insight copy for the reader', () => {
    const input = {
      bills: [{ name: 'Rent', amount: 2400, due_date: '2026-01-22', is_recurring: false, recurrence: null, status: 'unpaid', category: null }],
      goals: [],
      events: [],
      startingBalance: 500,
      now: new Date('2026-01-19T12:00:00Z'),
    };
    const en = buildCashflowTimeline(input).insights.find((i) => i.kind === 'low_balance');
    const de = buildCashflowTimeline({ ...input, locale: 'de-DE' }).insights.find((i) => i.kind === 'low_balance');
    expect(en?.detail).toContain('-$1,900');
    expect(de?.detail).toContain('-1.900 $');
    // Same forecast either way — the locale must not reach the arithmetic.
    expect(de?.amount).toBe(en?.amount);
    expect(de?.weekStart).toBe(en?.weekStart);
  });

  it('leaves the amounts English when there is no reader, rather than guessing', () => {
    const t = buildCashflowTimeline({ bills: [], goals: [], events: [], startingBalance: 10, now: new Date('2026-01-19T12:00:00Z') });
    // U+00A0 is the tell: every locale that separates amount from symbol with a
    // non-breaking space would put one here. en-US does not.
    for (const i of t.insights) expect(i.detail).not.toContain('\u00a0');
  });
});

// Every surface that renders these must bind them to a reader. A view that
// imports the helper unaliased is calling it with one argument and silently
// getting DEFAULT_LOCALE — the exact half-conversion this pass exists to avoid,
// and one tsc cannot see because the locale parameter is optional.
describe('every finance view binds the formatter to its reader', () => {
  const SURFACES: [string, string[]][] = [
    ['components/finance/payments-view.tsx', ['usd', 'fmtDueDate']],
    ['components/finance/savings-view.tsx', ['usd', 'fmtDueDate']],
    ['components/finance/bills-view.tsx', ['usd', 'fmtDueDate']],
    ['components/finance/budgets-view.tsx', ['usd']],
    ['components/modules/tax-vault-module.tsx', ['usd']],
    ['components/modules/expenses-module.tsx', ['usd']],
    ['components/modules/subscriptions-module.tsx', ['usd']],
    ['components/modules/money-timeline-module.tsx', ['money', 'pretty']],
    ['components/finance/affordability-scenario.tsx', ['money', 'pretty']],
    ['app/(app)/dashboard/family-cfo/page.tsx', ['money', 'pretty']],
  ];

  it.each(SURFACES)('%s imports the helper aliased and rebinds it', (file, helpers) => {
    const source = readFileSync(file, 'utf8');
    for (const h of helpers) {
      expect(source, `${file} must import ${h} as ${h}In`).toContain(`${h} as ${h}In`);
      expect(source, `${file} must rebind ${h} to locale.code`).toMatch(
        new RegExp(`const ${h} = \\([^)]*\\) => ${h}In\\([^)]*locale\\.code\\)`),
      );
    }
  });

  it('reads the locale from the right half of the boundary', () => {
    for (const [file] of SURFACES) {
      const source = readFileSync(file, 'utf8');
      const client = source.startsWith("'use client'");
      expect(source, `${file}: ${client ? 'client' : 'server'} component`).toContain(
        client ? 'useLocale()' : 'await getLocaleContext()',
      );
    }
  });
});
