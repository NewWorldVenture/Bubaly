import { describe, it, expect } from 'vitest';
import { buildInsightCandidates, rankInsights, topInsight, type Insight, type InsightSources } from '@/lib/home/insight-of-day';

describe('buildInsightCandidates', () => {
  it('supports the leave-earlier (traffic + weather) insight', () => {
    const cs = buildInsightCandidates({ departure: { leaveEarlierMinutes: 20, eventTitle: 'Swim meet' } });
    expect(cs).toHaveLength(1);
    expect(cs[0].kind).toBe('departure');
    expect(cs[0].title).toMatch(/leave 20 min earlier/i);
    expect(cs[0].impact).toBeGreaterThan(85);
  });

  it('supports unacknowledged homework due tomorrow', () => {
    const cs = buildInsightCandidates({ homeworkDueTomorrow: [{ title: 'Math p.42', who: 'Mia' }, { title: 'Essay', who: 'Mia' }] });
    expect(cs[0].kind).toBe('homework');
    expect(cs[0].title).toContain('2 assignments due tomorrow');
    expect(cs[0].title).toContain('Mia');
  });

  it('supports the grocery-savings / meal-planning insight', () => {
    const cs = buildInsightCandidates({ unplannedDinners: 3, lowGrocery: 6 });
    const meal = cs.find((c) => c.kind === 'meal');
    const grocery = cs.find((c) => c.kind === 'grocery');
    expect(meal?.detail).toMatch(/saves money|save/i);
    expect(grocery?.detail).toMatch(/save/i);
  });

  it('only emits candidates for signals that are present', () => {
    expect(buildInsightCandidates({})).toEqual([]);
    expect(buildInsightCandidates({ departure: { leaveEarlierMinutes: 0, eventTitle: 'x' } })).toEqual([]); // 0 min → no nudge
    expect(buildInsightCandidates({ autopilotTop: { title: 'x', confidence: 60 } })).toEqual([]); // below threshold
  });

  it('scores renewals by urgency (sooner = higher)', () => {
    const soon = buildInsightCandidates({ renewalsSoon: [{ title: 'Passport', days: 2 }] })[0];
    const later = buildInsightCandidates({ renewalsSoon: [{ title: 'Passport', days: 20 }] })[0];
    expect(soon.impact).toBeGreaterThan(later.impact);
  });
});

describe('rankInsights / topInsight', () => {
  const sources: InsightSources = {
    conflictsSoon: [{ title: 'Soccer vs Dentist', when: 'Today' }],
    homeworkDueTomorrow: [{ title: 'Essay', who: 'Sam' }],
    unplannedDinners: 3,
    lowGrocery: 5,
    pendingApprovals: 1,
  };

  it('surfaces exactly one insight — the highest impact', () => {
    const top = topInsight(buildInsightCandidates(sources));
    expect(top).not.toBeNull();
    // A today clash outranks homework/approvals/meals.
    expect(top!.kind).toBe('conflict');
  });

  it('ranks by impact then a stable kind priority', () => {
    const a: Insight = { id: 'a', kind: 'meal', title: '', detail: '', href: '', impact: 50 };
    const b: Insight = { id: 'b', kind: 'homework', title: '', detail: '', href: '', impact: 50 };
    // Equal impact → homework (higher priority) beats meal.
    expect(rankInsights([a, b])[0].kind).toBe('homework');
  });

  it('returns null when there is nothing worth surfacing', () => {
    expect(topInsight([])).toBeNull();
    expect(topInsight(buildInsightCandidates({}))).toBeNull();
  });

  it('falls through to the next-best insight when the top is removed (dismissal)', () => {
    const all = buildInsightCandidates(sources);
    const top = topInsight(all)!;
    const rest = all.filter((c) => c.id !== top.id);
    const next = topInsight(rest)!;
    expect(next.id).not.toBe(top.id);
    expect(next.impact).toBeLessThanOrEqual(top.impact);
  });
});
