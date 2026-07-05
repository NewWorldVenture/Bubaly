import { describe, it, expect } from 'vitest';
import { summarizeChange, type SnapshotView } from '@/lib/operating-index/summary';

const base: SnapshotView = {
  composite: 70,
  dimensions: { planning: 70, routine: 70, stability: 70, financial: 70, readiness: 70, communication: 70, goals: 70 },
  suggestions: [],
};

function view(over: Partial<SnapshotView>): SnapshotView {
  return { ...base, ...over, dimensions: { ...base.dimensions, ...(over.dimensions ?? {}) } };
}

describe('summarizeChange', () => {
  it('first reading (no prior) is flagged and neutral', () => {
    const s = summarizeChange(base, null);
    expect(s.isFirst).toBe(true);
    expect(s.compositeDelta).toBeNull();
    expect(s.headline).toMatch(/first reading/i);
  });

  it('reports a composite rise', () => {
    const s = summarizeChange(view({ composite: 78 }), view({ composite: 70 }));
    expect(s.compositeDelta).toBe(8);
    expect(s.headline).toMatch(/up 8 points/i);
  });

  it('reports a composite drop', () => {
    const s = summarizeChange(view({ composite: 61 }), view({ composite: 70 }));
    expect(s.compositeDelta).toBe(-9);
    expect(s.headline).toMatch(/down 9 points/i);
  });

  it('only reports dimension moves above the threshold, sorted by size', () => {
    const prior = view({ dimensions: { planning: 60, routine: 90, stability: 70 } });
    const current = view({ dimensions: { planning: 80, routine: 78, stability: 72 } }); // +20, -12, +2 (ignored)
    const s = summarizeChange(current, prior);
    expect(s.improved.map((d) => d.id)).toEqual(['planning']);   // +20; stability +2 below threshold
    expect(s.declined.map((d) => d.id)).toEqual(['routine']);    // -12
    expect(s.improved[0].delta).toBe(20);
    expect(s.declined[0].delta).toBe(-12);
  });

  it('detects resolved vs. emerged suggestions by id', () => {
    const prior = view({ suggestions: [{ id: 'a', title: 'Cover bills' }, { id: 'b', title: 'Resolve conflict' }] });
    const current = view({ suggestions: [{ id: 'b', title: 'Resolve conflict' }, { id: 'c', title: 'Renew doc' }] });
    const s = summarizeChange(current, prior);
    expect(s.resolved.map((x) => x.id)).toEqual(['a']);
    expect(s.emerged.map((x) => x.id)).toEqual(['c']);
  });

  it('headline leads with cleared items when present', () => {
    const prior = view({ composite: 70, suggestions: [{ id: 'a', title: 'x' }, { id: 'b', title: 'y' }] });
    const current = view({ composite: 74, suggestions: [] });
    const s = summarizeChange(current, prior);
    expect(s.headline).toMatch(/up 4 points/i);
    expect(s.headline).toMatch(/2 things cleared/i);
  });

  it('a completely flat day reads calm, not empty', () => {
    const s = summarizeChange(base, base);
    expect(s.compositeDelta).toBe(0);
    expect(s.improved).toHaveLength(0);
    expect(s.declined).toHaveLength(0);
    expect(s.headline).toMatch(/steady/i);
    expect(s.headline).toMatch(/nothing new/i);
  });

  it('is deterministic', () => {
    const a = summarizeChange(view({ composite: 80 }), base);
    const b = summarizeChange(view({ composite: 80 }), base);
    expect(a).toEqual(b);
  });
});
