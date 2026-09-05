// The Command Center's "Today" (§16): one family-local day, schedule in time
// order, owed tasks ranked through `rankNextActions` so the order is the same
// as the Next Best Actions page — and the same on every render, which is the
// property a home screen must have or it jitters.
import { describe, expect, it } from 'vitest';
import { buildToday, dayKeyInZone, mergeCompletedByBubaly, workingRunsFrom, type TodayInput } from '@/lib/home/today';

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
