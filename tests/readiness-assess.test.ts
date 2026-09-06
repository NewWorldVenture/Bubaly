import { describe, it, expect } from 'vitest';
import {
  assessReadiness, overallReadiness, EMPTY_READINESS_SIGNALS, type ReadinessSignals,
} from '@/lib/readiness/assess';
import { calendarReadiness, type CalendarReadinessEvent } from '@/lib/readiness/calendar-source';

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

const source = <T,>(data: T[], count: number | null = data.length) => ({ data, count, error: null });
const roster = source([{ id: 'one' }, { id: 'two' }, { id: 'three' }]);
const event = (index: number, assignee = 'one'): CalendarReadinessEvent => ({
  id: `event-${index}`, starts_at: new Date(Date.UTC(2026, 8, 6, 8 + index * 2)).toISOString(),
  ends_at: null, all_day: false, assignee_id: assignee,
});
const eight = Array.from({ length: 8 }, (_, index) => event(index));
const weeklyCards = (result: ReturnType<typeof calendarReadiness>) => assessReadiness(sig({
  conflictsWeek: result.conflicts, overloadedMembers: result.overloadedMembers,
  weekCalendarCoverage: result.calendarCoverage, workloadCoverage: result.workloadCoverage,
}));

describe('accessible calendar and roster coverage', () => {
  it('includes zero-event members in the relative 8/0/0 workload average', () => {
    const result = calendarReadiness(source(eight), roster);
    expect(result).toMatchObject({ conflicts: 0, overloadedMembers: 1, calendarCoverage: 'complete', workloadCoverage: 'complete' });
    expect(weeklyCards(result)[2].gaps.some((gap) => gap.label.includes('1 person carrying a heavy load'))).toBe(true);
  });

  it('distinguishes a genuinely all-zero known roster from missing coverage', () => {
    const result = calendarReadiness(source<CalendarReadinessEvent>([]), roster);
    expect(result.overloadedMembers).toBe(0);
    expect(overallReadiness(weeklyCards(result))).toEqual({ score: 100, status: 'ready' });
  });

  it('does not turn a failed calendar read into zero conflicts or healthy workload', () => {
    const result = calendarReadiness({ data: null, count: null, error: new Error('Unavailable') }, roster);
    expect(result).toMatchObject({ conflicts: null, unassigned: null, overloadedMembers: null, calendarCoverage: 'unknown' });
    const cards = weeklyCards(result);
    expect(cards[1].status).toBe('at_risk');
    expect(cards[2].status).toBe('at_risk');
    expect(cards[1].gaps[0].label).toContain('could not be read');
  });

  it('retains a known conflict as a lower bound when 200 returned rows are capped', () => {
    const rows = [event(0), { ...event(1), starts_at: event(0).starts_at },
      ...Array.from({ length: 198 }, (_, index) => ({ ...event(index + 2), all_day: true }))];
    const result = calendarReadiness(source(rows, 201), roster);
    expect(result).toMatchObject({ conflicts: 1, calendarCoverage: 'partial', overloadedMembers: null, workloadCoverage: 'partial' });
    const week = weeklyCards(result)[1];
    expect(week.status).toBe('not_ready');
    expect(week.gaps[0].label).toBe('At least 1 clash this week');
    expect(week.gaps.some((gap) => gap.label.includes('incomplete'))).toBe(true);
  });

  it('accepts an exact 200-row result rather than guessing every full page is truncated', () => {
    const rows = Array.from({ length: 200 }, (_, index) => ({ ...event(index), all_day: true }));
    expect(calendarReadiness(source(rows), roster)).toMatchObject({ calendarCoverage: 'complete', workloadCoverage: 'complete', overloadedMembers: 0 });
  });

  it.each([null, 9, 7, -1])('does not certify incomplete or inconsistent exact counts: %s', (count) => {
    const result = calendarReadiness(source(eight, count), roster);
    expect(result.calendarCoverage).toBe('partial');
    expect(result.overloadedMembers).toBeNull();
    expect(overallReadiness(weeklyCards(result)).status).not.toBe('ready');
  });

  it('does not pad a partial household roster with assumed zero loads', () => {
    expect(calendarReadiness(source(eight), source([{ id: 'one' }], 3)))
      .toMatchObject({ conflicts: 0, calendarCoverage: 'complete', workloadCoverage: 'partial', overloadedMembers: null });
  });

  it('does not interpret a failed or empty accessible roster as healthy workload', () => {
    for (const members of [{ data: null, count: null, error: new Error('Denied') }, source<{ id: string }>([])]) {
      const result = calendarReadiness(source(eight), members);
      expect(result.workloadCoverage).toBe('unknown');
      expect(result.overloadedMembers).toBeNull();
      expect(weeklyCards(result)[2].status).toBe('at_risk');
    }
  });

  it('never invents or exposes inaccessible member identities from event assignees', () => {
    const result = calendarReadiness(source([...eight, event(9, 'private-member-id')]), roster);
    expect(result).toMatchObject({ calendarCoverage: 'complete', workloadCoverage: 'partial', overloadedMembers: null });
    expect(JSON.stringify(result)).not.toContain('private-member-id');
    expect(JSON.stringify(weeklyCards(result))).not.toContain('private-member-id');
  });

  it('does not count duplicate roster IDs as additional zero-load people', () => {
    expect(calendarReadiness(source(eight), source([{ id: 'one' }, { id: 'one' }])).workloadCoverage).toBe('partial');
  });

  it('keeps the shared one-hour overlap rule and excludes all-day events', () => {
    const rows = [event(0), { ...event(1), starts_at: '2026-09-06T08:30:00.000Z' }, { ...event(2), starts_at: event(0).starts_at, all_day: true }];
    expect(calendarReadiness(source(rows)).conflicts).toBe(1);
    expect(calendarReadiness(source(rows), roster).conflicts).toBe(1);
  });

  it('marks malformed timed rows incomplete without hiding a valid conflict', () => {
    const rows = [event(0), { ...event(1), starts_at: event(0).starts_at }, { ...event(2), starts_at: 'invalid' }];
    expect(calendarReadiness(source(rows), roster)).toMatchObject({ conflicts: 1, calendarCoverage: 'partial', overloadedMembers: null });
  });

  it('keeps unknown tomorrow coverage and null signals out of the ready state', () => {
    const cards = assessReadiness(sig({ tomorrowConflicts: null, tomorrowUnassigned: null, conflictsWeek: null, overloadedMembers: null }));
    expect(cards.every((card) => card.status === 'at_risk')).toBe(true);
  });
});


// ─── §51's other half: what is handled, and doing something about it ────────

describe("§51's Ready ✓ list", () => {
  it('says what is handled, not only what is not', () => {
    // The card used to carry gaps and nothing else, so a family with the week
    // under control read "Nothing to close." — a shorter list of failures
    // rather than an answer to "are we ready?".
    const [tomorrow, week, month] = assessReadiness(sig());
    expect(tomorrow.ready.map((r) => r.label)).toEqual([
      'Calendar is clear', 'Everything has an owner', "Tomorrow's dinner is planned",
    ]);
    expect(week.ready.map((r) => r.label)).toContain('No clashes this week');
    expect(month.ready.map((r) => r.label)).toContain('Documents are current');
    for (const card of [tomorrow, week, month]) {
      for (const check of card.ready) expect(check.href).toMatch(/^\/dashboard\//);
    }
  });

  it('drops a check from the ✓ column the moment it fails', () => {
    const [tomorrow] = assessReadiness(sig({ tomorrowConflicts: 1 }));
    expect(tomorrow.ready.map((r) => r.label)).not.toContain('Calendar is clear');
    expect(tomorrow.gaps.map((g) => g.label)).toContain('1 schedule clash tomorrow');
    expect(tomorrow.ready.map((r) => r.label)).toContain("Tomorrow's dinner is planned");
  });

  it('does not dress an absence up as an accomplishment', () => {
    // "No bills due this week" and "no trips to prep" are nothing happening,
    // not something the family did.
    const [, week, month] = assessReadiness(sig());
    expect(week.ready.map((r) => r.label).join(' ')).not.toMatch(/bill/i);
    expect(month.ready.map((r) => r.label).join(' ')).not.toMatch(/trip|prep plan/i);
  });

  it('calls the week of dinners planned only when it actually is', () => {
    expect(assessReadiness(sig({ unplannedDinnersWeek: 0 }))[1].ready.map((r) => r.label))
      .toContain('The week of dinners is planned');
    // Two unplanned dinners is below the gap threshold and above nothing: it
    // belongs on neither list rather than being called planned.
    const partial = assessReadiness(sig({ unplannedDinnersWeek: 2 }))[1];
    expect(partial.ready.map((r) => r.label)).not.toContain('The week of dinners is planned');
    expect(partial.gaps.map((g) => g.label).join(' ')).not.toMatch(/dinner/i);
  });
});

describe('a ✓ is a claim, so it needs complete evidence', () => {
  it('does not call a check passed when the read that would prove it failed', () => {
    // Every signal arrives from a read that returns 0 on failure. That was
    // harmless while the card only listed gaps; the moment a zero became
    // "Documents are current" it stopped being harmless.
    const [, , month] = assessReadiness(sig({ coverage: { documents: 'unknown' } }));
    expect(month.ready.map((r) => r.label)).not.toContain('Documents are current');
    expect(month.gaps.map((g) => g.label).join(' ')).toMatch(/Documents could not be read/);
    expect(month.status).toBe('at_risk');
  });

  it('will not certify a source it only read part of, but still reports the floor', () => {
    const [, week] = assessReadiness(sig({ conflictsWeek: 1, weekCalendarCoverage: 'partial' }));
    expect(week.gaps.map((g) => g.label)).toContain('At least 1 clash this week');
    expect(week.ready.map((r) => r.label)).not.toContain('No clashes this week');
  });

  it('offers no ✓ for a partial read that found nothing', () => {
    // Nothing found in half a week is not "no clashes this week".
    const [, week] = assessReadiness(sig({ conflictsWeek: 0, weekCalendarCoverage: 'partial' }));
    expect(week.ready.map((r) => r.label)).not.toContain('No clashes this week');
  });

  it('reports one unknown per missing source, not one per rule that used it', () => {
    // Two tomorrow rules rest on the same calendar read; a person can only do
    // one thing about it.
    const [tomorrow] = assessReadiness(sig({ tomorrowCalendarCoverage: 'unknown' }));
    expect(tomorrow.gaps.filter((g) => g.label.includes('could not be read'))).toHaveLength(1);
  });

  it('cannot work out the workload when the week it is measured over is missing', () => {
    const [, , month] = assessReadiness(sig({ weekCalendarCoverage: 'unknown' }));
    expect(month.ready.map((r) => r.label)).not.toContain('The load is spread evenly');
    expect(month.gaps.map((g) => g.label).join(' ')).toMatch(/Workload balance is unknown/);
  });

  it('leaves a household whose reads all succeeded exactly as it was', () => {
    expect(assessReadiness(sig())).toEqual(assessReadiness(sig({ coverage: {} })));
    expect(overallReadiness(assessReadiness(sig()))).toEqual({ score: 100, status: 'ready' });
  });
});

describe("§51's [Let Bubaly Handle It]", () => {
  it('hands Bubaly the gaps, not just the horizon', () => {
    // "Get us ready for tomorrow" gives the planner nothing to work from.
    const [tomorrow] = assessReadiness(sig({ tomorrowConflicts: 1, dinnerPlannedTomorrow: false }));
    expect(tomorrow.handleIt).toBe(
      "Help me get ready for tomorrow: 1 schedule clash tomorrow and tomorrow's dinner isn't planned.",
    );
  });

  it('asks rather than asserts when there is nothing to close', () => {
    expect(assessReadiness(sig())[0].handleIt).toBe('Is there anything I should be doing about tomorrow?');
  });

  it('reads a single gap as a sentence, not a list of one', () => {
    expect(assessReadiness(sig({ dinnerPlannedTomorrow: false }))[0].handleIt)
      .toBe("Help me get ready for tomorrow: tomorrow's dinner isn't planned.");
  });
});

// ─── The other readiness numbers, and which of them may differ ──────────────

import { readFileSync } from 'node:fs';
import { mostLoaded } from '@/lib/operating-index/score';

describe('the overload rule the readiness month card leans on', () => {
  const load = (memberId: string, upcoming: number) => ({ memberId, name: memberId, upcoming, openTasks: 0 });

  it('names the one person carrying the week when the others carry nothing', () => {
    expect(mostLoaded([load('a', 8), load('b', 0), load('c', 0)])?.memberId).toBe('a');
  });

  it('names nobody when the week is quiet for everyone', () => {
    expect(mostLoaded([load('a', 0), load('b', 0), load('c', 0)])).toBeNull();
  });

  it('names nobody when the work is shared out', () => {
    expect(mostLoaded([load('a', 4), load('b', 3), load('c', 3)])).toBeNull();
  });
});

describe('the readiness page answers once, and with the rules its links point at', () => {
  const page = readFileSync('app/(app)/dashboard/readiness/page.tsx', 'utf8');
  const source = readFileSync('lib/readiness/calendar-source.ts', 'utf8');

  it('answers "are we ready?" with one number, above the activity score', () => {
    // The page carried two 0–100 scores under the word readiness: the §51
    // horizon assessment and `lib/readiness/score.ts`'s activity score, whose
    // bands ("Looking good") and statuses ("Not ready") disagree by
    // construction. §51 asks for one indicator.
    const readiness = page.indexOf('<ReadinessHorizons');
    const activity = page.indexOf('How much your family is running through Bubaly');
    expect(readiness).toBeGreaterThan(-1);
    expect(activity).toBeGreaterThan(-1);
    expect(readiness).toBeLessThan(activity);
    expect(page).not.toContain("What&apos;s driving your score");
  });

  it('counts clashes with the rule the page it links to runs', () => {
    // The gap reads "2 clashes this week" and links to /dashboard/conflicts,
    // which runs `lib/family/conflicts.ts detectConflicts`. A private copy of
    // that sweep could disagree with the page it points at.
    expect(source).toContain("from '@/lib/family/conflicts'");
    expect(source).not.toMatch(/for \(let i = 0; i < timed\.length/);
  });

  it('decides who is overloaded with the rule the page it links to runs', () => {
    // The month gap links to the Family Operating Index; deciding it with a
    // second threshold could send a person to a page that names nobody.
    expect(source).toContain("import { mostLoaded } from '@/lib/operating-index/score'");
    expect(source).not.toMatch(/load >= 4 && load > average \* 1\.5/);
  });

  it('tells the assessor which of the other sources it actually read', () => {
    expect(page).toContain('const readCoverage: Partial<Record<Evidence, ReadinessCoverage>> = {};');
    expect(page).toContain("if (!expiringDocsMonth.known) readCoverage.documents = 'unknown';");
    expect(page).toContain('coverage: readCoverage,');
    expect(page).toContain('return error ? { value: 0, known: false } : { value: n ?? 0, known: true };');
  });

  it('does not pay for a count nothing reads', () => {
    // `groceryActive` was fetched, error-checked, passed to `computeReadiness`
    // and never referenced by the formula.
    expect(page).not.toMatch(/grocery/i);
  });
});

describe('the readiness numbers that are deliberately separate', () => {
  it('each says which question it answers in its own header', () => {
    expect(readFileSync('lib/readiness/score.ts', 'utf8')).toMatch(/NOT §51's readiness/);
    expect(readFileSync('lib/readiness/assess.ts', 'utf8')).toMatch(/§51's signature/);
  });
});
