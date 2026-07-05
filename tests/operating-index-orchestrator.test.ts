import { describe, it, expect } from 'vitest';
import { orchestrate, type OrchestratorInput, type DayEvent } from '@/lib/operating-index/orchestrator';

function ev(over: Partial<DayEvent>): DayEvent {
  return {
    id: Math.random().toString(36).slice(2), title: 'Event',
    startsAt: '2026-07-06T09:00:00Z', endsAt: '2026-07-06T10:00:00Z',
    allDay: false, assigneeId: null, location: 'Home', needsLocation: false, ...over,
  };
}

const calm: OrchestratorInput = {
  tomorrowEvents: [], autoCompletable: [], overloaded: null, pendingApprovals: [], openVotes: 0, missingInfo: [],
};

describe('orchestrate', () => {
  it('a calm day returns all five answers as clear', () => {
    const r = orchestrate(calm);
    expect(r.answers).toHaveLength(5);
    expect(r.allClear).toBe(true);
    expect(r.answers.every((a) => a.status === 'clear')).toBe(true);
  });

  it('flags a same-person overlap tomorrow', () => {
    const r = orchestrate({
      ...calm,
      tomorrowEvents: [
        ev({ id: 'a', title: 'Soccer', assigneeId: 'm1', startsAt: '2026-07-06T09:00:00Z', endsAt: '2026-07-06T10:30:00Z' }),
        ev({ id: 'b', title: 'Dentist', assigneeId: 'm1', startsAt: '2026-07-06T10:00:00Z', endsAt: '2026-07-06T11:00:00Z' }),
      ],
    });
    const q = r.answers.find((a) => a.id === 'go_wrong')!;
    expect(q.status).toBe('attention');
    expect(q.items[0].label).toMatch(/overlaps/);
    expect(r.allClear).toBe(false);
  });

  it('flags a tight turnaround between back-to-back events', () => {
    const q = orchestrate({
      ...calm,
      tomorrowEvents: [
        ev({ id: 'a', title: 'Meeting', assigneeId: 'm1', startsAt: '2026-07-06T09:00:00Z', endsAt: '2026-07-06T10:00:00Z' }),
        ev({ id: 'b', title: 'Pickup', assigneeId: 'm1', startsAt: '2026-07-06T10:05:00Z', endsAt: '2026-07-06T10:30:00Z' }),
      ],
    }).answers.find((a) => a.id === 'go_wrong')!;
    expect(q.items.some((i) => /Tight turnaround/.test(i.label))).toBe(true);
  });

  it('counts unowned and location-less events tomorrow', () => {
    const q = orchestrate({
      ...calm,
      tomorrowEvents: [
        ev({ id: 'a', title: 'Game', assigneeId: null, needsLocation: true, location: null }),
        ev({ id: 'b', title: 'Recital', assigneeId: null, needsLocation: true, location: null }),
      ],
    }).answers.find((a) => a.id === 'go_wrong')!;
    expect(q.items.some((i) => /2 events tomorrow with no owner/.test(i.label))).toBe(true);
    expect(q.items.some((i) => /2 events missing a location/.test(i.label))).toBe(true);
  });

  it('ignores all-day events for conflict/turnaround risk', () => {
    const q = orchestrate({
      ...calm,
      tomorrowEvents: [
        ev({ id: 'a', title: 'Holiday', allDay: true, assigneeId: 'm1' }),
        ev({ id: 'b', title: 'Holiday2', allDay: true, assigneeId: 'm1' }),
      ],
    }).answers.find((a) => a.id === 'go_wrong')!;
    expect(q.status).toBe('clear');
  });

  it('surfaces auto-completable tasks', () => {
    const q = orchestrate({ ...calm, autoCompletable: [{ label: 'Add team snacks' }, { label: 'Leave-by reminder' }] })
      .answers.find((a) => a.id === 'auto_today')!;
    expect(q.status).toBe('attention');
    expect(q.headline).toMatch(/2 tasks/);
  });

  it('names the overloaded member', () => {
    const q = orchestrate({ ...calm, overloaded: { memberId: 'm', name: 'Mom', upcoming: 6, openTasks: 4 } })
      .answers.find((a) => a.id === 'overloaded')!;
    expect(q.headline).toMatch(/Mom is carrying the most/);
    expect(q.items[0].label).toMatch(/6 events · 4 open tasks/);
  });

  it('combines approvals and open votes into decisions', () => {
    const q = orchestrate({ ...calm, pendingApprovals: [{ label: 'Approve $20 game pass' }], openVotes: 2 })
      .answers.find((a) => a.id === 'decide_next')!;
    expect(q.status).toBe('attention');
    expect(q.items).toHaveLength(2);
    expect(q.items[1].label).toMatch(/2 open family votes/);
  });

  it('reports missing info for upcoming events', () => {
    const q = orchestrate({ ...calm, missingInfo: [{ label: 'Recital — no location', href: '/dashboard/calendar' }] })
      .answers.find((a) => a.id === 'missing_info')!;
    expect(q.status).toBe('attention');
    expect(q.items).toHaveLength(1);
  });

  it('is deterministic', () => {
    const input: OrchestratorInput = { ...calm, openVotes: 1, overloaded: { memberId: 'm', name: 'A', upcoming: 5, openTasks: 3 } };
    const now = new Date('2026-07-05T12:00:00Z');
    expect(orchestrate(input, now)).toEqual(orchestrate(input, now));
  });
});
