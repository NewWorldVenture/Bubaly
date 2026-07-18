import { describe, expect, it } from 'vitest';
import fs from 'node:fs';

const page = fs.readFileSync('app/(app)/dashboard/family-sports/page.tsx', 'utf8');

// PLA-0804: the Family Sports Hub's teams, game results, and sports events are
// source-of-truth. If any read fails, the page must fail closed rather than
// render "No teams added yet" / "No game results logged" / "No practices or
// games scheduled" and a 0-0-0 record for a family that has them (a parent
// misses tomorrow's game). A genuinely missing table (unapplied migration) is
// still tolerated as empty.
describe('family-sports page read boundary', () => {
  it('collects the four sports read errors with a missing-table filter', () => {
    expect(page).toContain('const sportsError = [membersRes.error, teamsRes.error, gamesRes.error, eventsRes.error]');
    expect(page).toContain('.find((e) => e && !isMissingTableError(e));');
  });

  it('logs and returns an ErrorState on a sports read failure', () => {
    expect(page).toContain('if (sportsError) {');
    expect(page).toContain("console.error('[dashboard/family-sports] sports read failed', sportsError);");
    expect(page).toContain('return <ErrorState message="Could not load your family sports hub from Supabase. Refresh and try again." />;');
  });

  it('derives the sports data only after the fail-closed guard', () => {
    const guardIdx = page.indexOf('if (sportsError) {');
    const deriveIdx = page.indexOf('const teams = teamsRes.data;');
    expect(guardIdx).toBeGreaterThan(-1);
    expect(deriveIdx).toBeGreaterThan(guardIdx);
  });
});
