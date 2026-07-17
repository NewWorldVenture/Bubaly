import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/economy/page.tsx', 'utf8');

// PLA-0782: Family Economy is a kids-money surface — each child's coin balance
// derives from the immutable currency_transactions ledger. If any of the five
// economy reads fails, the page must fail closed rather than compute every
// balance as 0 from an empty ledger (a reassuring-but-wrong picture where a
// kid's earned coins appear to vanish). A genuinely missing table (unapplied
// migration) is still tolerated as empty.
describe('economy page read boundary', () => {
  it('collects the five economy read errors with a missing-table filter', () => {
    expect(page).toContain('const economyError = [currenciesRes.error, membersRes.error, txnsRes.error, rewardsRes.error, redemptionsRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on an economy read failure', () => {
    expect(page).toContain('if (economyError) {');
    expect(page).toContain("console.error('[economy] family economy read failed', economyError);");
    expect(page).toContain('return <ErrorState message="Could not load your family economy from Supabase. Refresh and try again." />;');
  });

  it('derives the economy data (incl. the ledger txns) only after the guard', () => {
    const guardIdx = page.indexOf('if (economyError) {');
    const txnsIdx = page.indexOf('const txns = txnsRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(txnsIdx).toBeGreaterThan(guardIdx);
  });
});
