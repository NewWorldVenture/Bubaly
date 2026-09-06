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

  // ── §51's "Ready ✓" half ─────────────────────────────────────────────────
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
    // The rules that still pass are still reported.
    expect(tomorrow.ready.map((r) => r.label)).toContain("Tomorrow's dinner is planned");
  });

  it('does not dress an absence up as an accomplishment', () => {
    // "No bills due this week" and "no trips to prep" are nothing happening,
    // not something the family did. Padding the ✓ column with them would make
    // a quiet week look like an achievement and devalue a real ✓.
    const [, week, month] = assessReadiness(sig());
    expect(week.ready.map((r) => r.label).join(' ')).not.toMatch(/bill/i);
    expect(month.ready.map((r) => r.label).join(' ')).not.toMatch(/trip|prep plan/i);
  });

  it('calls the week of dinners planned only when it actually is', () => {
    const planned = assessReadiness(sig({ unplannedDinnersWeek: 0 }))[1];
    expect(planned.ready.map((r) => r.label)).toContain('The week of dinners is planned');
    // Two unplanned dinners is below the gap threshold and above nothing: it
    // belongs on neither list rather than being called planned.
    const partial = assessReadiness(sig({ unplannedDinnersWeek: 2 }))[1];
    expect(partial.ready.map((r) => r.label)).not.toContain('The week of dinners is planned');
    expect(partial.gaps.map((g) => g.label).join(' ')).not.toMatch(/dinner/i);
  });

  // ── A ✓ is a claim, so it needs evidence ─────────────────────────────────
  it('does not call a check passed when the read that would prove it failed', () => {
    // Every signal arrives from a best-effort read that returns 0 on failure.
    // That was harmless while the card only listed gaps — nothing to report
    // reads the same as nothing wrong. The moment a zero became "Documents are
    // current" it stopped being harmless.
    const [, , month] = assessReadiness(sig({ unavailable: ['documents'] }));
    expect(month.ready.map((r) => r.label)).not.toContain('Documents are current');
    expect(month.gaps.map((g) => g.label).join(' ')).toMatch(/Documents could not be read/);
  });

  it('says the check could not be run, and does not call the horizon ready', () => {
    const [tomorrow] = assessReadiness(sig({ unavailable: ['calendar_tomorrow'] }));
    expect(tomorrow.ready.map((r) => r.label)).not.toContain('Calendar is clear');
    expect(tomorrow.ready.map((r) => r.label)).not.toContain('Everything has an owner');
    expect(tomorrow.status).toBe('at_risk');
    // The rules that DID have their evidence still report.
    expect(tomorrow.ready.map((r) => r.label)).toContain("Tomorrow's dinner is planned");
  });

  it('reports one unknown per missing source, not one per rule that used it', () => {
    // Two tomorrow rules rest on the same calendar read; a person can only do
    // one thing about it.
    const [tomorrow] = assessReadiness(sig({ unavailable: ['calendar_tomorrow'] }));
    const unknowns = tomorrow.gaps.filter((g) => g.label.includes('could not be read'));
    expect(unknowns).toHaveLength(1);
  });

  it('cannot work out the workload when the week it is measured over is missing', () => {
    const [, , month] = assessReadiness(sig({ unavailable: ['calendar_week'] }));
    expect(month.ready.map((r) => r.label)).not.toContain('The load is spread evenly');
    expect(month.gaps.map((g) => g.label).join(' ')).toMatch(/could not be worked out/);
  });

  it('leaves a household whose reads all succeeded exactly as it was', () => {
    // The guard must not make a working page cautious.
    expect(assessReadiness(sig())).toEqual(assessReadiness(sig({ unavailable: [] })));
    expect(overallReadiness(assessReadiness(sig()))).toEqual({ score: 100, status: 'ready' });
  });

  // ── §51's [Let Bubaly Handle It] ─────────────────────────────────────────
  it('hands Bubaly the gaps, not just the horizon', () => {
    // "Get us ready for tomorrow" gives the planner nothing to work from.
    const [tomorrow] = assessReadiness(sig({ tomorrowConflicts: 1, dinnerPlannedTomorrow: false }));
    expect(tomorrow.handleIt).toBe(
      "Help me get ready for tomorrow: 1 schedule clash tomorrow and tomorrow's dinner isn't planned.",
    );
  });

  it('asks rather than asserts when there is nothing to close', () => {
    const [tomorrow] = assessReadiness(sig());
    expect(tomorrow.handleIt).toBe('Is there anything I should be doing about tomorrow?');
  });

  it('reads a single gap as a sentence, not a list of one', () => {
    const [tomorrow] = assessReadiness(sig({ dinnerPlannedTomorrow: false }));
    expect(tomorrow.handleIt).toBe("Help me get ready for tomorrow: tomorrow's dinner isn't planned.");
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
import { mostLoaded } from '@/lib/operating-index/score';

describe('the readiness page computes what it claims to know', () => {
  const page = readFileSync('app/(app)/dashboard/readiness/page.tsx', 'utf8');

  it('no longer hands the assessor hardcoded zeros', () => {
    // `conflictsWeek: 0` and `overloadedMembers: 0` were literals, so the week
    // card could never report a clash and the month card could never name an
    // overloaded person — while the rows to compute both sat in the same file.
    const code = page.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    expect(code).not.toMatch(/conflictsWeek:\s*0\b/);
    expect(code).not.toMatch(/overloadedMembers:\s*0\b/);
    expect(page).toContain('const conflictsWeek = detectConflicts(weekEvents).length');
  });

  it('reads the week, not just tomorrow', () => {
    expect(page).toContain("gte('starts_at', `${todayStr}T00:00:00Z`).lte('starts_at', `${weekEndStr}T23:59:59Z`)");
  });

  it('counts clashes with the rule the page it links to runs', () => {
    // The gap reads "2 clashes this week" and links to /dashboard/conflicts,
    // which runs `lib/family/conflicts.ts detectConflicts`. This page carried
    // its own copy of that sweep, so the number and its destination could
    // disagree about the same week. The Family Operating Index deliberately
    // uses the OTHER rule (`lib/home/conflicts.ts`: one person double-booked)
    // for a different question — two named rules, not a third written here.
    expect(page).toContain("from '@/lib/family/conflicts'");
    expect(page).not.toMatch(/function countOverlaps/);
    // Both windows go through it.
    expect((page.match(/detectConflicts\(/g) ?? []).length).toBe(2);
  });

  it('decides who is overloaded with the rule the page it links to runs', () => {
    // The month gap links to the Family Operating Index. Deciding it here with
    // a second threshold could send a person to a page that names nobody.
    expect(page).toContain("import { mostLoaded } from '@/lib/operating-index/score'");
    expect(page).not.toMatch(/averageLoad \* 1\.5/);
  });

  it('measures the load against the whole roster, not just who owns an event', () => {
    // Counting only event owners meant eight things on one parent and nothing
    // on the other two averaged over `[8]`, so the person carrying the entire
    // week was never "clearly above the family average" and nobody was named.
    // The people carrying nothing are what make it an imbalance.
    expect(page).toContain('for (const m of activeMembersRes.data ?? []) perMember.set(m.id, 0);');
    expect(page).toContain("select('id', { count: 'exact' })");
    // An assignee outside the accessible roster must not be padded in as a
    // zero-load member — that would drag the average down and invent a person.
    expect(page).toContain('if (!perMember.has(e.assignee_id)) continue;');
  });

  it('tells the assessor which reads actually succeeded', () => {
    // A failed query and a genuinely quiet week both arrive as zero. Without
    // this the §51 ✓ list turns a source failure into "Documents are current".
    expect(page).toContain('const unavailable: Evidence[] = [];');
    expect(page).toContain("if (tomorrowEventsRes.error) unavailable.push('calendar_tomorrow');");
    expect(page).toContain('unavailable,');
    // `cnt` used to swallow the error into a zero.
    expect(page).toContain('return error ? { value: 0, known: false } : { value: n ?? 0, known: true };');
  });

  it('knows when the week was longer than the page asked for', () => {
    // The week is capped at 200 events; an exact count is what distinguishes a
    // fully-measured quiet week from a truncated busy one.
    expect(page).toContain('const weekTruncated = typeof weekEventsRes.count === \'number\' && weekEventsRes.count > weekEvents.length;');
    expect(page).toContain("if (weekEventsRes.error || weekTruncated) unavailable.push('calendar_week');");
  });

  it('does not pay for a count nothing reads', () => {
    // `groceryActive` was fetched with its own Supabase count query, passed
    // into `computeReadiness`, and never referenced by the formula.
    expect(page).not.toMatch(/grocery/i);
  });

  it('answers "are we ready?" with one number, above the activity score', () => {
    // The page carried two 0–100 scores under the word readiness: the §51
    // horizon assessment and `lib/readiness/score.ts`'s activity score, whose
    // bands ("Looking good") and statuses ("Not ready") disagree by
    // construction. A family reading both on one screen has no way to know
    // they are different questions. §51 asks for one indicator, so the horizon
    // readiness is the headline and the activity panel says what it measures.
    const readiness = page.indexOf('<ReadinessHorizons');
    const activity = page.indexOf('How much your family is running through Bubaly');
    expect(readiness).toBeGreaterThan(-1);
    expect(activity).toBeGreaterThan(-1);
    expect(readiness).toBeLessThan(activity);
    // The activity panel no longer calls its own number a readiness score.
    expect(page).not.toContain("What&apos;s driving your score");
    expect(page).not.toMatch(/shapes your readiness/);
  });
});

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

// ── The other readiness numbers, and which of them may differ ───────────────
describe('a trip scores the same wherever it is asked', () => {
  const overview = readFileSync('components/vacations/trip-overview.tsx', 'utf8');
  const service = readFileSync('lib/services/trips/index.ts', 'utf8');

  it('measures the trip in the same days on both sides', () => {
    // One formula (`lib/vacations/readiness.ts`), two input assemblies. The
    // client read `tripNights` — end minus start — while the service used
    // `dateRange(...).length`, always one more. The itinerary factor is
    // `daysWithItems / tripDays` and `daysWithItems` counts `vacation_days`
    // rows, which are the inclusive dates, so the trip overview inflated its
    // own score and the AI readiness card disagreed with the page.
    expect(service).toContain('dateRange(s.trip.start_date, s.trip.end_date).length');
    expect(overview).toContain('dateRange(trip.start_date, trip.end_date).length');
    expect(overview).not.toMatch(/tripDays:\s*tripNights\(/);
  });

  it('counts the people going, not the whole household, on both sides', () => {
    // Already true and worth pinning: `members` in the overview is the
    // `vacation_members` query, and the service falls back to the family only
    // when a trip has no travellers recorded.
    expect(overview).toContain("useRealtimeQuery<Tables<'vacation_members'>>");
    expect(service).toContain('membersCount: s.travelers.length || members.data.length');
  });
});

// The readiness numbers that are allowed to differ, recorded so a later reader
// does not "fix" them into one. Each answers a different question about a
// different subject; §51's is the household one and lives in ./assess.ts.
describe('the readiness numbers that are deliberately separate', () => {
  it('each says which question it answers in its own header', () => {
    expect(readFileSync('lib/readiness/score.ts', 'utf8')).toMatch(/NOT §51's readiness/);
    expect(readFileSync('lib/readiness/assess.ts', 'utf8')).toMatch(/§51's signature/);
  });
});
