import { describe, it, expect } from 'vitest';
import { simulateDecision, type SimContext, type SimEvent } from '@/lib/twin/simulate';

function evt(over: Partial<SimEvent>): SimEvent {
  return { id: Math.random().toString(36).slice(2), title: 'Event', startsAt: '2026-07-06T09:00:00Z', endsAt: '2026-07-06T10:00:00Z', allDay: false, ...over };
}

const emptyCtx: SimContext = { memberEvents: [], budgets: [] };

describe('simulateDecision — commitment', () => {
  it('a clean slot returns a clear verdict', () => {
    const r = simulateDecision(
      { kind: 'commitment', memberName: 'Sam', title: 'Soccer', startsAt: '2026-07-06T15:00:00Z', durationMin: 60 },
      emptyCtx,
    );
    expect(r.verdict).toBe('clear');
    expect(r.impacts[0].severity).toBe('ok');
    expect(r.headline).toMatch(/fits cleanly/);
  });

  it('flags a direct overlap as a blocker (what has to move)', () => {
    const ctx: SimContext = { memberEvents: [evt({ title: 'Recital', startsAt: '2026-07-06T15:30:00Z', endsAt: '2026-07-06T16:30:00Z' })], budgets: [] };
    const r = simulateDecision(
      { kind: 'commitment', memberName: 'Sam', title: 'Tournament', startsAt: '2026-07-06T15:00:00Z', durationMin: 90 },
      ctx,
    );
    expect(r.verdict).toBe('conflict');
    expect(r.impacts.some((i) => i.severity === 'blocker' && /Recital/.test(i.title))).toBe(true);
    expect(r.headline).toMatch(/collides/);
  });

  it('flags a tight turnaround as a caution', () => {
    const ctx: SimContext = { memberEvents: [evt({ title: 'Practice', startsAt: '2026-07-06T16:05:00Z', endsAt: '2026-07-06T17:00:00Z' })], budgets: [] };
    const r = simulateDecision(
      { kind: 'commitment', memberName: 'Sam', title: 'Class', startsAt: '2026-07-06T15:00:00Z', durationMin: 60 },
      ctx,
    );
    expect(r.verdict).toBe('tight');
    expect(r.impacts.some((i) => /min before/.test(i.title))).toBe(true);
  });

  it('warns when the week would become heavy', () => {
    const many = Array.from({ length: 8 }, (_, i) => evt({ id: `e${i}`, startsAt: `2026-07-0${6}T${String(6 + i).padStart(2, '0')}:00:00Z`, endsAt: `2026-07-06T${String(6 + i).padStart(2, '0')}:30:00Z` }));
    const r = simulateDecision(
      { kind: 'commitment', memberName: 'Sam', title: 'Extra', startsAt: '2026-07-06T21:00:00Z', durationMin: 30 },
      { memberEvents: many, budgets: [], heavyWeek: 8 },
    );
    expect(r.impacts.some((i) => /heavy|commitments/i.test(i.title) || /heavy/i.test(i.detail ?? ''))).toBe(true);
  });

  it('rejects an invalid start time', () => {
    const r = simulateDecision(
      { kind: 'commitment', memberName: 'Sam', title: 'X', startsAt: 'not-a-date', durationMin: 60 },
      emptyCtx,
    );
    expect(r.verdict).toBe('conflict');
  });
});

describe('simulateDecision — spend', () => {
  const ctx: SimContext = { memberEvents: [], budgets: [{ category: 'Vacation', limitCents: 200000, spentCents: 120000 }] };

  it('approves a spend that stays comfortably in budget', () => {
    const r = simulateDecision({ kind: 'spend', label: '2 extra nights', category: 'Vacation', amountCents: 40000 }, ctx);
    expect(r.verdict).toBe('clear');
    expect(r.headline).toMatch(/\$40,?000|\$400 would remain|remain/i);
  });

  it('blocks a spend that exceeds the budget', () => {
    const r = simulateDecision({ kind: 'spend', label: 'Suite upgrade', category: 'Vacation', amountCents: 100000 }, ctx);
    expect(r.verdict).toBe('conflict');
    expect(r.impacts[0].severity).toBe('blocker');
    expect(r.headline).toMatch(/blow the .* budget/);
  });

  it('cautions when it leaves under 10% headroom', () => {
    const r = simulateDecision({ kind: 'spend', label: 'Close', category: 'Vacation', amountCents: 70000 }, ctx); // leaves 10000 of 200000 = 5%
    expect(r.verdict).toBe('tight');
  });

  it('cautions when there is no budget for the category', () => {
    const r = simulateDecision({ kind: 'spend', label: 'Random', category: 'Yacht', amountCents: 5000 }, ctx);
    expect(r.verdict).toBe('tight');
    expect(r.impacts[0].title).toMatch(/No budget/);
  });

  it('is deterministic', () => {
    const d = { kind: 'spend', label: 'x', category: 'Vacation', amountCents: 40000 } as const;
    expect(simulateDecision(d, ctx)).toEqual(simulateDecision(d, ctx));
  });
});
