// Six server actions defaulted a date column with
// `new Date().toISOString().slice(0, 10)` — the HOST's day. On a UTC server
// that is tomorrow from 5pm in California and from 4pm in New York, so:
//
//   a car service logged after dinner was dated tomorrow;
//   so was a home service record, a contact interaction and a wallet
//   transaction;
//   `family_food_scores.snapshot_date` is upserted, so an evening score landed
//   on tomorrow and collided with tomorrow's real one;
//   and `moment_activations.as_of_date` — written by a function whose own
//   comment reads "Hide a moment for the rest of today" — wrote TOMORROW's
//   row, so the moment stayed on screen for the rest of the evening and
//   arrived already dismissed the next morning.
//
// The last one is this audit's recurring shape in miniature: the rule stated in
// a comment where a reader can see it, and absent from the line below it.
//
// `todayKeyFor(ctx)` is the one place the `|| DEFAULT_TZ` fallback is written.
// Six copies of a defaulting rule is how the seventh gets it wrong.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { todayKeyFor } from '@/lib/services/scope';

const family = (timezone: string | null) => ({ active: { family: { timezone } } });

describe('todayKeyFor answers in the family’s zone', () => {
  // 2026-06-24T01:00Z is 6pm on the 23rd in Los Angeles and already the 24th in
  // UTC — the one time of day the two answers differ, which is the only time
  // worth asserting about.
  const eveningInCalifornia = new Date('2026-06-24T01:00:00Z');

  it('is still the 23rd for a family in Los Angeles', () => {
    expect(todayKeyFor(family('America/Los_Angeles'), eveningInCalifornia)).toBe('2026-06-23');
  });

  it('is the 24th for a family in UTC, from the same instant', () => {
    expect(todayKeyFor(family('UTC'), eveningInCalifornia)).toBe('2026-06-24');
  });

  it('is already the 24th in Auckland, hours before UTC agrees', () => {
    // The defect points the other way east of UTC: 2026-06-23T13:00Z is 1am on
    // the 24th in Auckland while the host still says the 23rd.
    expect(todayKeyFor(family('Pacific/Auckland'), new Date('2026-06-23T13:00:00Z'))).toBe('2026-06-24');
  });

  it('falls back to UTC rather than throwing when a family has no zone set', () => {
    expect(todayKeyFor(family(null), eveningInCalifornia)).toBe('2026-06-24');
    expect(todayKeyFor(family(''), eveningInCalifornia)).toBe('2026-06-24');
  });
});

describe('the six actions default their date column to the family’s day', () => {
  // A source assertion, and its limits are worth stating: it can only say the
  // call is present, not that the value reaches the column. What makes it worth
  // having is that the defect it replaces was invisible — every one of these
  // lines READ correctly, which is exactly why six of them accumulated.
  const SITES = [
    'app/(app)/dashboard/auto/actions.ts',
    'app/(app)/dashboard/contacts/[id]/actions.ts',
    'app/(app)/dashboard/home/actions.ts',
    'app/(app)/dashboard/kitchen/actions.ts',
    'app/(app)/dashboard/moments/actions.ts',
    'app/(app)/wallet/hub-actions.ts',
  ];

  for (const site of SITES) {
    it(`${site} asks the family, not the host`, () => {
      const source = readFileSync(site, 'utf8');
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
      expect(code, 'still formats the host instant as a day key')
        .not.toMatch(/new Date\(\)\s*\.toISOString\(\)\s*\.\s*slice\(\s*0\s*,\s*10\s*\)/);
      expect(code).toContain('todayKeyFor(');
    });
  }
});
