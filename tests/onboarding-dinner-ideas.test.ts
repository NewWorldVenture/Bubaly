import { describe, it, expect } from 'vitest';
import { pickDinnerIdeas, type DinnerIdea } from '@/lib/onboarding/dinner-ideas';

const CANDS: DinnerIdea[] = [
  { title: 'Sheet-pan chicken', cuisine: 'Comfort', effort: 'quick', prepMinutes: 20, description: null },
  { title: 'Tacos', cuisine: 'Mexican', effort: 'quick', prepMinutes: 25, description: null },
  { title: 'Stir-fry', cuisine: 'Asian', effort: 'quick', prepMinutes: 20, description: null },
  { title: 'Spaghetti Bolognese', cuisine: 'Italian', effort: 'standard', prepMinutes: 40, description: null },
  { title: 'Chicken curry', cuisine: 'Indian', effort: 'standard', prepMinutes: 45, description: null },
  { title: 'Lasagna', cuisine: 'Italian', effort: 'involved', prepMinutes: 75, description: null },
  { title: 'Beef bourguignon', cuisine: 'French', effort: 'involved', prepMinutes: 120, description: null },
];

describe('pickDinnerIdeas', () => {
  it('returns exactly 3 ideas from a full catalog', () => {
    const picks = pickDinnerIdeas(CANDS, { now: new Date('2026-07-07T12:00:00Z'), busyCount: 1 });
    expect(picks).toHaveLength(3);
    expect(new Set(picks.map((p) => p.title)).size).toBe(3); // no dupes
  });

  it('prefers quick meals on a busy day', () => {
    const picks = pickDinnerIdeas(CANDS, { now: new Date('2026-07-07T12:00:00Z'), busyCount: 4 });
    // A busy weekday should lead with quick options.
    expect(picks[0].effort).toBe('quick');
  });

  it('prefers an involved meal on the weekend', () => {
    // 2026-07-11 is a Saturday.
    const picks = pickDinnerIdeas(CANDS, { now: new Date('2026-07-11T12:00:00Z'), busyCount: 0 });
    expect(picks[0].effort).toBe('involved');
  });

  it('is deterministic for a given day but varies across days', () => {
    const a = pickDinnerIdeas(CANDS, { now: new Date('2026-07-07T12:00:00Z'), busyCount: 1 });
    const a2 = pickDinnerIdeas(CANDS, { now: new Date('2026-07-07T23:00:00Z'), busyCount: 1 });
    const b = pickDinnerIdeas(CANDS, { now: new Date('2026-07-08T12:00:00Z'), busyCount: 1 });
    expect(a.map((p) => p.title)).toEqual(a2.map((p) => p.title)); // same UTC day → same trio
    expect(a.map((p) => p.title)).not.toEqual(b.map((p) => p.title)); // next day → rotated
  });

  it('returns [] for an empty catalog and handles a thin one', () => {
    expect(pickDinnerIdeas([], { now: new Date(), busyCount: 0 })).toEqual([]);
    const two = pickDinnerIdeas(CANDS.slice(0, 2), { now: new Date(), busyCount: 0 });
    expect(two.length).toBe(2); // never throws when < 3 available
  });

  it('ignores blank-title junk entries', () => {
    const picks = pickDinnerIdeas([{ title: '  ', cuisine: 'x', effort: 'quick', prepMinutes: 5, description: null }, ...CANDS], { now: new Date('2026-07-07T12:00:00Z'), busyCount: 0 });
    expect(picks.every((p) => p.title.trim().length > 0)).toBe(true);
  });
});
