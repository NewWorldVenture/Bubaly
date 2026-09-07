// The Command Center's "Today" (§16): one family-local day, schedule in time
// order, owed tasks ranked through `rankNextActions` so the order is the same
// as the Next Best Actions page — and the same on every render, which is the
// property a home screen must have or it jitters.
import { describe, expect, it } from 'vitest';
import {
  buildToday, dayKeyInZone, excerpt, mergeCompletedByBubaly, runReason, runSources, workingRunsFrom, EMPTY_EVIDENCE, REASON_EXCERPT_LENGTH,
  type CompletedEvidence, type TodayInput,
} from '@/lib/home/today';
import type { ScheduleInsight } from '@/lib/schedule/intelligence';

const TZ = 'America/New_York';
const NOW = new Date('2026-09-05T14:00:00Z'); // 10:00 in New York
const TODAY = '2026-09-05';

const base: TodayInput = { events: [], todos: [], chores: [], reminders: [], choreTitles: {}, todayKey: TODAY, tz: TZ, now: NOW };

describe('dayKeyInZone', () => {
  it('resolves the family-local day, not the UTC day', () => {
    // 01:30 UTC on the 6th is still the evening of the 5th in New York.
    expect(dayKeyInZone('2026-09-06T01:30:00Z', TZ)).toBe('2026-09-05');
    expect(dayKeyInZone('2026-09-06T01:30:00Z', 'UTC')).toBe('2026-09-06');
    expect(dayKeyInZone('not a date', TZ)).toBeNull();
  });
});

describe('buildToday', () => {
  it('is empty on a clear day', () => {
    expect(buildToday(base)).toEqual({ schedule: [], tasks: [], overdue: 0 });
  });

  it('orders the schedule all-day first then by time, and keeps only today', () => {
    const view = buildToday({
      ...base,
      events: [
        { id: 'e2', title: 'Soccer', starts_at: '2026-09-05T20:00:00Z', all_day: false },
        { id: 'e1', title: 'Dentist', starts_at: '2026-09-05T17:00:00Z', all_day: false },
        { id: 'e0', title: 'Teacher day', starts_at: '2026-09-05T04:00:00Z', all_day: true },
        { id: 'e9', title: 'Tomorrow', starts_at: '2026-09-06T17:00:00Z', all_day: false },
      ],
      reminders: [{ id: 'r1', title: 'Pick up cake', remind_at: '2026-09-05T18:00:00Z' }],
    });
    expect(view.schedule.map((s) => s.key)).toEqual(['event:e0', 'event:e1', 'reminder:r1', 'event:e2']);
    expect(view.tasks).toEqual([]);
  });

  it('ranks owed tasks overdue-first, then high priority, then by source and title', () => {
    const view = buildToday({
      ...base,
      todos: [
        { id: 't1', title: 'Sign permission slip', due_date: TODAY, priority: 'medium' },
        { id: 't2', title: 'Renew car registration', due_date: '2026-09-03', priority: 'low' },
        { id: 't3', title: 'Call the school', due_date: TODAY, priority: 'high' },
        { id: 't4', title: 'Next week', due_date: '2026-09-10', priority: 'high' },
        { id: 't5', title: 'Undated', due_date: null },
      ],
      chores: [
        { id: 'c1', chore_id: 'ch1', member_id: 'm1', status: 'todo', due_at: '2026-09-05T23:00:00Z' },
        { id: 'c2', chore_id: 'ch2', member_id: 'm2', status: 'approved', due_at: '2026-09-05T23:00:00Z' },
      ],
      reminders: [{ id: 'r1', title: 'Take out bins', remind_at: '2026-09-05T11:00:00Z' }], // already past this morning
      choreTitles: { ch1: 'Empty dishwasher' },
    });
    expect(view.tasks.map((t) => t.key)).toEqual(['todo:t2', 'todo:t3', 'reminder:r1', 'chore:c1', 'todo:t1']);
    expect(view.tasks[0].reason).toBe('Overdue by 2 days');
    expect(view.tasks[1].reason).toBe('Due today');
    expect(view.tasks.find((t) => t.key === 'chore:c1')?.title).toBe('Empty dishwasher');
    expect(view.overdue).toBe(1);
  });

  it('is deterministic: the same rows in any order produce the same output', () => {
    const input: TodayInput = {
      ...base,
      events: [
        { id: 'e1', title: 'B', starts_at: '2026-09-05T17:00:00Z', all_day: false },
        { id: 'e2', title: 'A', starts_at: '2026-09-05T17:00:00Z', all_day: false },
      ],
      todos: [
        { id: 'a', title: 'Zed', due_date: TODAY }, { id: 'b', title: 'Alpha', due_date: TODAY }, { id: 'c', title: 'Alpha', due_date: TODAY },
      ],
      reminders: [{ id: 'r', title: 'Alpha', remind_at: '2026-09-05T11:00:00Z' }],
    };
    const first = buildToday(input);
    const shuffled = buildToday({ ...input, events: [...input.events].reverse(), todos: [...input.todos].reverse() });
    expect(shuffled).toEqual(first);
    expect(first.tasks.map((t) => t.key)).toEqual(['reminder:r', 'todo:b', 'todo:c', 'todo:a']);
    expect(first.schedule.map((s) => s.key)).toEqual(['event:e1', 'event:e2']);
  });

  it('caps the task list without losing the overdue count', () => {
    const todos = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, due_date: '2026-09-01' }));
    const view = buildToday({ ...base, todos, taskLimit: 3 });
    expect(view.tasks).toHaveLength(3);
    expect(view.overdue).toBe(10);
  });
});

describe('buildToday with schedule insights (M8)', () => {
  const insight = (over: Partial<ScheduleInsight> & { kind: ScheduleInsight['kind']; severity: ScheduleInsight['severity'] }): ScheduleInsight => ({
    id: `${over.kind}:e1`, eventId: 'e1', reason: '', reasonKey: `scheduleInsight.${over.kind}`, params: {}, href: '/dashboard/calendar', at: null, relatedIds: [], ...over,
  });

  it("uses the event's most pressing insight as its reason and carries it for the strip", () => {
    const view = buildToday({
      ...base,
      events: [
        { id: 'e1', title: 'Soccer', starts_at: '2026-09-05T19:00:00Z', all_day: false },
        { id: 'e0', title: 'Teacher day', starts_at: '2026-09-05T04:00:00Z', all_day: true },
        { id: 'e2', title: 'Dentist', starts_at: '2026-09-05T21:00:00Z', all_day: false },
      ],
      insights: {
        e1: [
          insight({ kind: 'leave_by', severity: 'info', reason: 'Leave by 2:25 PM — 35 min to City Fields' }),
          insight({ kind: 'care_gap', severity: 'urgent', reason: 'No adult is free for Emma during Soccer (3:00 PM–4:30 PM) and no sitter is booked', href: '/wallet/babysitters' }),
        ],
        e0: [insight({ kind: 'leave_by', severity: 'info', reason: 'should be ignored for an all-day row' })],
      },
    });
    const soccer = view.schedule.find((s) => s.key === 'event:e1')!;
    expect(soccer.reason).toBe('No adult is free for Emma during Soccer (3:00 PM–4:30 PM) and no sitter is booked');
    expect(soccer.insight).toMatchObject({ kind: 'care_gap', severity: 'urgent', reasonKey: 'scheduleInsight.care_gap', href: '/wallet/babysitters' });
    expect(view.schedule.find((s) => s.key === 'event:e0')).toMatchObject({ reason: 'All day' });
    expect(view.schedule.find((s) => s.key === 'event:e0')?.insight).toBeUndefined();
    expect(view.schedule.find((s) => s.key === 'event:e2')).toMatchObject({ reason: 'Today' });
    expect(view.schedule.find((s) => s.key === 'event:e2')?.insight).toBeUndefined();
  });

  it('is unchanged without insights', () => {
    const events = [{ id: 'e1', title: 'Soccer', starts_at: '2026-09-05T19:00:00Z', all_day: false }];
    expect(buildToday({ ...base, events, insights: {} })).toEqual(buildToday({ ...base, events }));
    expect(buildToday({ ...base, events }).schedule[0]).toMatchObject({ reason: 'Today' });
  });
});

describe('workingRunsFrom', () => {
  const runs = [
    { id: 'r1', summary: "Planning next week's meals", state: 'executing', plan_id: 'p1', updated_at: '2026-09-05T13:00:00Z', created_at: '2026-09-05T12:00:00Z' },
    { id: 'r2', summary: 'Preparing beach vacation', state: 'awaiting_approval', plan_id: 'p2', updated_at: '2026-09-05T12:30:00Z', created_at: '2026-09-05T12:00:00Z' },
    { id: 'r3', summary: 'Organizing Saturday', state: 'completed', plan_id: 'p3', updated_at: '2026-09-05T13:30:00Z', created_at: '2026-09-05T12:00:00Z' },
    { id: 'r4', summary: null, state: 'paused', plan_id: null, updated_at: '2026-09-05T11:00:00Z', created_at: '2026-09-05T11:00:00Z' },
  ];
  const steps = [
    ...Array.from({ length: 7 }, () => ({ plan_id: 'p1', status: 'completed' })),
    { plan_id: 'p1', status: 'executing' }, { plan_id: 'p1', status: 'queued' },
    { plan_id: 'p2', status: 'completed' }, { plan_id: 'p2', status: 'awaiting_approval' },
  ];

  it('counts live steps, describes what a run waits on, and lists finished runs nowhere', () => {
    const out = workingRunsFrom(runs, steps);
    expect(out.map((r) => r.id)).toEqual(['r2', 'r1', 'r4']);
    expect(out[0].detail).toBe('waiting for your OK');
    expect(out[0].waitingOn).toBe('approval');
    expect(out[1].detail).toBe('7 of 9 steps complete');
    expect(out[1].href).toBe('/dashboard/concierge/runs/r1');
    expect(out[2]).toMatchObject({ title: 'Working on your request', detail: 'paused', total: 0 });
  });
});

describe('mergeCompletedByBubaly', () => {
  it('lists runs and agent actions newest first and labels partial runs honestly', () => {
    const out = mergeCompletedByBubaly(
      [
        { id: 'r1', summary: 'Organizing Saturday', state: 'completed', progress: { summary: '6 of 6 steps completed.' }, completed_at: '2026-09-05T13:00:00Z', updated_at: '2026-09-05T13:00:00Z' },
        { id: 'r2', summary: 'Remind everyone', state: 'partially_completed', progress: { summary: '2 of 3 steps completed — 1 failed.' }, completed_at: '2026-09-05T12:00:00Z', updated_at: '2026-09-05T12:00:00Z' },
        { id: 'r3', summary: 'Still going', state: 'executing', progress: {}, completed_at: null, updated_at: '2026-09-05T14:00:00Z' },
      ],
      [{ id: 'a1', title: 'Rebalanced chores', detail: 'Moved two chores to Sam', href: '/dashboard/chores', created_at: '2026-09-05T12:30:00Z' }],
    );
    expect(out.map((i) => i.key)).toEqual(['run:r1', 'activity:a1', 'run:r2']);
    expect(out[2].partial).toBe(true);
    expect(out[2].detail).toBe('2 of 3 steps completed — 1 failed.');
    expect(out[1].href).toBe('/dashboard/chores');
  });
});

// ─── M6: the source and reason under a Handled row ───────────────────────────
//
// A ledger row says WHICH tool acted and WHY from persisted state only — the
// run's succeeded write calls (else its completed act/notify steps) and the
// plan's reasoning_summary. Nothing here is inferred from the title, and a run
// the tables say nothing about carries no source and no reason.
describe('mergeCompletedByBubaly — source and reason', () => {
  const runs = [
    { id: 'r1', summary: 'Organizing Saturday', state: 'completed', progress: {}, completed_at: '2026-09-05T13:00:00Z', updated_at: '2026-09-05T13:00:00Z', plan_id: 'p1' },
    { id: 'r2', summary: 'Remind everyone', state: 'partially_completed', progress: {}, completed_at: '2026-09-05T12:00:00Z', updated_at: '2026-09-05T12:00:00Z', plan_id: 'p2' },
    { id: 'r3', summary: 'No plan', state: 'completed', progress: {}, completed_at: '2026-09-05T11:00:00Z', updated_at: '2026-09-05T11:00:00Z', plan_id: null },
  ];
  const evidence: CompletedEvidence = {
    steps: [
      { id: 's1', plan_id: 'p1', step_type: 'retrieve', tool_name: 'calendar.searchEvents', status: 'completed' },
      { id: 's2', plan_id: 'p1', step_type: 'act', tool_name: 'calendar.createEvent', status: 'completed' },
      { id: 's3', plan_id: 'p1', step_type: 'act', tool_name: 'tasks.createTask', status: 'completed' },
      { id: 's4', plan_id: 'p2', step_type: 'notify', tool_name: 'messages.send', status: 'completed' },
      { id: 's5', plan_id: 'p2', step_type: 'act', tool_name: 'tasks.createTask', status: 'failed' },
      { id: 's6', plan_id: 'p2', step_type: 'retrieve', tool_name: 'tasks.listTasks', status: 'completed' },
    ],
    toolCalls: [
      { run_id: 'r1', plan_step_id: 's1', tool_name: 'calendar.searchEvents', state: 'succeeded', resource_table: null },
      { run_id: 'r1', plan_step_id: 's2', tool_name: 'calendar.createEvent', state: 'succeeded', resource_table: 'events' },
      { run_id: 'r1', plan_step_id: 's2', tool_name: 'calendar.createEvent', state: 'succeeded', resource_table: 'events' },
      { run_id: 'r1', plan_step_id: 's3', tool_name: 'tasks.createTask', state: 'succeeded', resource_table: 'todo_items' },
      { run_id: 'r1', plan_step_id: null, tool_name: 'finances.updateBudget', state: 'failed', resource_table: 'budgets' },
    ],
    plans: [
      { id: 'p1', reasoning_summary: 'Two free slots on Saturday and the pool is open.' },
      { id: 'p2', reasoning_summary: null },
    ],
  };

  it('names the tools from the ledger — writes that succeeded, each once, reads never', () => {
    const out = mergeCompletedByBubaly(runs, [], { evidence });
    expect(out.map((i) => i.key)).toEqual(['run:r1', 'run:r2', 'run:r3']);
    expect(out[0].sources).toEqual([
      { tool: 'calendar.createEvent', domain: 'calendar' },
      { tool: 'tasks.createTask', domain: 'tasks' },
    ]);
    expect(out[0].reason).toBe('Two free slots on Saturday and the pool is open.');
    // The partial-run honesty pin from the original case still holds beside the new fields.
    expect(out[1].partial).toBe(true);
  });

  it('falls back to the completed act/notify steps when the ledger has no rows, and never to a failed step', () => {
    const out = mergeCompletedByBubaly(runs, [], { evidence });
    expect(out[1].sources).toEqual([{ tool: 'messages.send', domain: 'messages' }]);
    expect(out[1].reason).toBeNull();
  });

  it('says nothing for a run the tables say nothing about, and with no evidence at all', () => {
    const withEvidence = mergeCompletedByBubaly(runs, [], { evidence });
    expect(withEvidence[2]).toMatchObject({ sources: [], reason: null });
    const bare = mergeCompletedByBubaly(runs, []);
    expect(bare.every((i) => i.sources.length === 0 && i.reason === null)).toBe(true);
    expect(runSources({ id: 'r1', plan_id: 'p1' }, EMPTY_EVIDENCE)).toEqual([]);
    expect(runReason({ plan_id: 'p1' }, EMPTY_EVIDENCE)).toBeNull();
  });

  it('names the agent that wrote an activity row, and keeps a reason off it — no plan, no why', () => {
    const out = mergeCompletedByBubaly([], [
      { id: 'a1', title: 'Moved practice', detail: null, href: '/dashboard/calendar', created_at: '2026-09-05T12:30:00Z', agent: 'scheduler' },
      { id: 'a2', title: 'Unknown author', detail: null, href: null, created_at: '2026-09-05T12:00:00Z' },
    ]);
    expect(out[0]).toMatchObject({ sources: [{ tool: 'scheduler', domain: 'scheduler' }], reason: null });
    expect(out[1]).toMatchObject({ sources: [], reason: null, href: '/dashboard/agents' });
  });

  it('respects the limit through the options bag', () => {
    expect(mergeCompletedByBubaly(runs, [], { limit: 2 }).map((i) => i.key)).toEqual(['run:r1', 'run:r2']);
  });
});

describe('excerpt', () => {
  it('returns a short summary whole, and cuts a long one at a word with a mark', () => {
    expect(excerpt('  Two   free slots.  ')).toBe('Two free slots.');
    expect(excerpt(null)).toBeNull();
    expect(excerpt('   ')).toBeNull();
    const long = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const cut = excerpt(long);
    expect(cut).not.toBeNull();
    expect(cut!.length).toBeLessThanOrEqual(REASON_EXCERPT_LENGTH + 1);
    expect(cut!.endsWith('…')).toBe(true);
    expect(long.startsWith(cut!.slice(0, -1))).toBe(true);
    expect(cut!.slice(0, -1)).not.toMatch(/\s$/);
  });
});
