// The Daily Brief and the evening recap (§49).
//
// The load-bearing promise: `handled` is not something Bubaly says about
// itself — it is the runs that really finished. A brief may under-report, but
// it must never claim work that did not complete, so the first test here feeds
// the builder every run state at once and checks what survives.
import { describe, expect, it } from 'vitest';
import { briefRow, briefSchema, buildBrief, dayKeyInZone, readinessPct, type BriefInput } from '@/lib/briefing/build';

const NOW = new Date('2026-09-05T13:00:00Z');
const TZ = 'America/New_York';

function input(over: Partial<BriefInput> = {}): BriefInput {
  return {
    kind: 'daily',
    now: NOW,
    events: [
      { title: 'Dentist', start: '2026-09-05T14:00:00Z', end: '2026-09-05T15:00:00Z' },
      { title: 'Soccer practice', start: '2026-09-05T14:30:00Z', end: '2026-09-05T16:00:00Z' },
      { title: 'Parents evening', start: '2026-09-09T18:00:00Z' },
    ],
    snapshot: {
      bills: [{ name: 'Power', amount: 84, dueDate: '2026-09-03' }],
      maintenance: [{ title: 'Change the filter', dueAt: '2026-09-05T12:00:00Z' }],
    },
    completedRuns: [
      { id: 'run-1', state: 'completed', summary: 'Planned the week', progress: { total: 8, completed: 8 }, completed_at: '2026-09-05T11:00:00Z', updated_at: '2026-09-05T11:00:00Z' },
    ],
    activity: [],
    ...over,
  } as BriefInput;
}

describe('handled is the truth, not a claim', () => {
  it('lists only runs that really completed', () => {
    const brief = buildBrief(input({
      completedRuns: [
        { id: 'done', state: 'completed', summary: 'Planned the week', progress: { total: 8, completed: 8 }, completed_at: '2026-09-05T11:00:00Z', updated_at: '2026-09-05T11:00:00Z' },
        { id: 'partial', state: 'partially_completed', summary: 'Prepared the trip', progress: { total: 8, completed: 6 }, completed_at: '2026-09-05T11:30:00Z', updated_at: '2026-09-05T11:30:00Z' },
        { id: 'running', state: 'executing', summary: 'Still going', progress: { total: 8, completed: 2 }, completed_at: null, updated_at: '2026-09-05T12:00:00Z' },
        { id: 'failed', state: 'failed', summary: 'Did not work', progress: { total: 8, completed: 1 }, completed_at: null, updated_at: '2026-09-05T12:00:00Z' },
        { id: 'waiting', state: 'awaiting_approval', summary: 'Needs a parent', progress: { total: 4, completed: 3 }, completed_at: null, updated_at: '2026-09-05T12:00:00Z' },
      ] as BriefInput['completedRuns'],
    }), TZ);

    // Most recent first, and only the two that actually reached a terminal
    // "it happened" state — executing, failed and awaiting_approval are not
    // things Bubaly did.
    expect(brief.handled.map((h) => h.key)).toEqual(['run:partial', 'run:done']);
    // A partly-finished run is reported AS partial — that is the honesty the
    // whole feature turns on.
    expect(brief.handled.find((h) => h.key === 'run:partial')?.partial).toBe(true);
    expect(brief.handled.find((h) => h.key === 'run:done')?.partial).toBe(false);
    expect(brief.counts.handled).toBe(2);
  });

  it('says nothing rather than something when nothing finished', () => {
    const brief = buildBrief(input({ completedRuns: [], activity: [] }), TZ);
    expect(brief.handled).toEqual([]);
    expect(brief.headline).not.toMatch(/handled/);
  });
});

describe('buildBrief', () => {
  it('composes the calendar half, the cross-domain half and the day it is for', () => {
    const brief = buildBrief(input(), TZ);
    expect(brief.asOfDate).toBe('2026-09-05');
    expect(brief.calendar.todayCount).toBeGreaterThan(0);
    expect(brief.digest.items.some((i) => i.domain === 'bill')).toBe(true);
    expect(brief.digest.counts.overdue).toBeGreaterThan(0);
    expect(brief.counts).toMatchObject({ conflicts: brief.calendar.conflicts.length, overdue: brief.digest.counts.overdue });
    expect(briefSchema.safeParse(brief).success).toBe(true);
  });

  it('leads the morning with what needs a person and the evening with what got done', () => {
    const morning = buildBrief(input({ kind: 'daily' }), TZ);
    expect(morning.headline).toMatch(/today/);

    const evening = buildBrief(input({ kind: 'evening' }), TZ);
    expect(evening.headline).toMatch(/Bubaly finished 1 thing/);
  });

  it('calls a genuinely empty day quiet instead of inventing something', () => {
    const brief = buildBrief(input({ events: [], snapshot: {}, completedRuns: [], activity: [] }), TZ);
    expect(brief.isSparse).toBe(true);
    expect(brief.headline).toMatch(/quiet/i);
    expect(brief.counts).toMatchObject({ today: 0, week: 0, overdue: 0, handled: 0 });
  });

  it('uses the family’s day, not the server’s', () => {
    // 00:30 UTC on the 6th is still the 5th in New York; a brief filed under
    // the wrong day would collide with the next one on the unique index.
    const lateNight = new Date('2026-09-06T00:30:00Z');
    expect(dayKeyInZone(lateNight, 'America/New_York')).toBe('2026-09-05');
    expect(dayKeyInZone(lateNight, 'UTC')).toBe('2026-09-06');
    expect(dayKeyInZone(lateNight, 'Not/AZone')).toBe('2026-09-06');
  });
});

describe('readinessPct', () => {
  it('is 100 when nothing is wrong, and never leaves 0–100', () => {
    const clean = buildBrief(input({ events: [], snapshot: {}, completedRuns: [], activity: [] }), TZ);
    expect(readinessPct(clean)).toBe(100);

    const awful = { counts: { conflicts: 20, overdue: 40, handled: 0, today: 0, week: 0, timeSavedMinutes: 0 } } as ReturnType<typeof buildBrief>;
    expect(readinessPct(awful)).toBe(0);
  });

  it('gives credit for what Bubaly handled, but never more than the problems cost', () => {
    const base = { counts: { conflicts: 1, overdue: 1, handled: 0, today: 2, week: 4, timeSavedMinutes: 0 } } as ReturnType<typeof buildBrief>;
    const withHelp = { counts: { ...base.counts, handled: 3 } } as ReturnType<typeof buildBrief>;
    expect(readinessPct(withHelp)).toBeGreaterThan(readinessPct(base));
    expect(readinessPct(withHelp)).toBeLessThan(100);
  });
});

describe('briefRow', () => {
  it('puts the numbers in columns and the body in jsonb, under the family', () => {
    const brief = buildBrief(input(), TZ);
    const row = briefRow(brief, 'fam-1', 'auth-1');
    expect(row).toMatchObject({
      family_id: 'fam-1', as_of_date: '2026-09-05', kind: 'daily', created_by: 'auth-1',
      conflict_count: brief.counts.conflicts, week_count: brief.counts.week,
      time_saved_minutes: brief.counts.timeSavedMinutes, headline: brief.headline,
    });
    // 0258's unique index is (family_id, as_of_date, kind): all three present.
    expect(row.family_id && row.as_of_date && row.kind).toBeTruthy();
    expect(Array.isArray(row.handled)).toBe(true);
  });
});

describe('handled carries source and reason (M6)', () => {
  it('passes run evidence through to the handled rows, and says nothing without it', () => {
    const bare = buildBrief(input(), TZ);
    expect(bare.handled[0]).toMatchObject({ key: 'run:run-1', sources: [], reason: null });

    const brief = buildBrief(input({
      completedRuns: [
        { id: 'run-1', state: 'completed', summary: 'Planned the week', progress: {}, completed_at: '2026-09-05T11:00:00Z', updated_at: '2026-09-05T11:00:00Z', plan_id: 'plan-1' },
        { id: 'running', state: 'executing', summary: 'Still going', progress: {}, completed_at: null, updated_at: '2026-09-05T12:00:00Z', plan_id: 'plan-2' },
      ],
      evidence: {
        steps: [{ id: 's1', plan_id: 'plan-1', step_type: 'act', tool_name: 'meals.savePlan', status: 'completed' }],
        toolCalls: [{ run_id: 'run-1', plan_step_id: 's1', tool_name: 'meals.savePlan', state: 'succeeded', resource_table: 'meal_plans' }],
        plans: [{ id: 'plan-1', reasoning_summary: 'Four dinners were unplanned.' }, { id: 'plan-2', reasoning_summary: 'Should never surface.' }],
      },
    }), TZ);
    // Still handled ⊆ completed: evidence for a run that is not finished changes nothing.
    expect(brief.handled.map((h) => h.key)).toEqual(['run:run-1']);
    expect(brief.handled[0].sources).toEqual([{ tool: 'meals.savePlan', domain: 'meals' }]);
    expect(brief.handled[0].reason).toBe('Four dinners were unplanned.');
    expect(briefSchema.safeParse(brief).success).toBe(true);
  });

  it('parses a brief stored before source and reason existed, as rows that say nothing about either', () => {
    const brief = buildBrief(input(), TZ);
    const legacy = {
      ...brief,
      handled: brief.handled.map(({ sources: _s, reason: _r, ...rest }) => rest),
    };
    const parsed = briefSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.handled[0]).toMatchObject({ sources: [], reason: null });
  });
});
