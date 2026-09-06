import { describe, it, expect } from 'vitest';
import {
  assessReadiness, overallReadiness, EMPTY_READINESS_SIGNALS, type ReadinessSignals,
} from '@/lib/readiness/assess';

const sig = (over: Partial<ReadinessSignals> = {}): ReadinessSignals => ({ ...EMPTY_READINESS_SIGNALS, ...over });

describe('assessReadiness', () => {
  it('returns three horizon cards', () => {
    const cards = assessReadiness(sig());
    expect(cards.map((c) => c.horizon)).toEqual(['tomorrow', 'week', 'month']);
  });

  it('is fully ready when everything is clear', () => {
    const cards = assessReadiness(sig());
    for (const c of cards) {
      expect(c.status).toBe('ready');
      expect(c.score).toBe(100);
      expect(c.gaps).toHaveLength(0);
    }
  });

  it('marks a horizon not_ready when a blocker exists', () => {
    const [tomorrow] = assessReadiness(sig({ tomorrowConflicts: 1 }));
    expect(tomorrow.status).toBe('not_ready');
    expect(tomorrow.gaps[0].severity).toBe('blocker');
    expect(tomorrow.score).toBe(65); // 100 - 35
  });

  it('marks a horizon at_risk when only watch-level gaps exist', () => {
    const [tomorrow] = assessReadiness(sig({ dinnerPlannedTomorrow: false, tomorrowUnassigned: 2 }));
    expect(tomorrow.status).toBe('at_risk');
    expect(tomorrow.score).toBe(70); // 100 - 2*15
  });

  it('orders blockers before watches', () => {
    const cards = assessReadiness(sig({ conflictsWeek: 1, billsDueWeek: 2 }));
    const week = cards.find((c) => c.horizon === 'week')!;
    expect(week.gaps[0].severity).toBe('blocker');
    expect(week.gaps[week.gaps.length - 1].severity).toBe('watch');
  });

  it('only flags unplanned dinners at 3+', () => {
    const week2 = assessReadiness(sig({ unplannedDinnersWeek: 2 })).find((c) => c.horizon === 'week')!;
    expect(week2.gaps.some((g) => g.label.includes('unplanned'))).toBe(false);
    const week3 = assessReadiness(sig({ unplannedDinnersWeek: 3 })).find((c) => c.horizon === 'week')!;
    expect(week3.gaps.some((g) => g.label.includes('unplanned'))).toBe(true);
  });

  it('surfaces expiring documents as a month blocker', () => {
    const month = assessReadiness(sig({ expiringDocsMonth: 1 })).find((c) => c.horizon === 'month')!;
    expect(month.status).toBe('not_ready');
    expect(month.gaps[0].href).toBe('/dashboard/documents');
  });

  it('clamps score at 0 for many gaps (2 blockers + 2 watches)', () => {
    const week = assessReadiness(sig({ conflictsWeek: 1, overduePrepSteps: 1, unplannedDinnersWeek: 3, billsDueWeek: 1 })).find((c) => c.horizon === 'week')!;
    expect(week.score).toBe(0); // 100 - 2*35 - 2*15 = 0
  });
});

describe('overallReadiness', () => {
  it('takes the weakest link', () => {
    const cards = assessReadiness(sig({ expiringDocsMonth: 1 }));
    const overall = overallReadiness(cards);
    expect(overall.status).toBe('not_ready');
    expect(overall.score).toBe(65); // month card dragged it down
  });

  it('is ready when all horizons are ready', () => {
    expect(overallReadiness(assessReadiness(sig()))).toEqual({ score: 100, status: 'ready' });
  });

  it('reports at_risk when the worst card is a watch', () => {
    const overall = overallReadiness(assessReadiness(sig({ billsDueWeek: 1 })));
    expect(overall.status).toBe('at_risk');
  });
});

// ─── The two signals the page never actually computed ──────────────────────

import { readFileSync } from 'node:fs';

describe('the readiness page computes what it claims to know', () => {
  const page = readFileSync('app/(app)/dashboard/readiness/page.tsx', 'utf8');

  it('no longer hands the assessor hardcoded zeros', () => {
    // `conflictsWeek: 0` and `overloadedMembers: 0` were literals, so the week
    // card could never report a clash and the month card could never name an
    // overloaded person — while the rows to compute both sat in the same file.
    const code = page.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    expect(code).not.toMatch(/conflictsWeek:\s*0\b/);
    expect(code).not.toMatch(/overloadedMembers:\s*0\b/);
    expect(page).toContain('const conflictsWeek = countOverlaps(weekEvents, HOUR)');
    expect(page).toContain('const overloadedMembers = loads.filter(');
  });

  it('reads the week, not just tomorrow', () => {
    expect(page).toContain("gte('starts_at', `${todayStr}T00:00:00Z`).lte('starts_at', `${weekEndStr}T23:59:59Z`)");
  });

  it('uses one overlap rule for both windows rather than two copies', () => {
    expect((page.match(/countOverlaps\(/g) ?? []).length).toBe(3); // definition + two calls
  });
});
