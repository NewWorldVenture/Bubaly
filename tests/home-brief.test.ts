import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { buildHomeBrief, homeBriefSummary, type HomeBriefInput } from '@/lib/home/home-brief';
import type { DinnerIdea } from '@/lib/onboarding/dinner-ideas';

const NOW = new Date('2026-07-07T12:00:00.000Z');
const DINNERS: DinnerIdea[] = [
  { title: 'Tacos', cuisine: 'Mexican', effort: 'quick', prepMinutes: 25, description: null },
  { title: 'Stir-fry', cuisine: 'Asian', effort: 'quick', prepMinutes: 20, description: null },
  { title: 'Lasagna', cuisine: 'Italian', effort: 'involved', prepMinutes: 75, description: null },
  { title: 'Curry', cuisine: 'Indian', effort: 'standard', prepMinutes: 45, description: null },
];

function input(o: Partial<HomeBriefInput> = {}): HomeBriefInput {
  return {
    upcomingEvents: [], dinnerCandidates: DINNERS,
    choresPending: 0, openTodos: 0, groceryOpen: 0, memberCount: 1,
    ...o,
  };
}

describe('buildHomeBrief', () => {
  it('marks a brand-new family as sparse and leads with getting-started steps', () => {
    const b = buildHomeBrief(input(), NOW);
    expect(b.isSparse).toBe(true);
    expect(b.headline).toMatch(/easier/i);
    // Nothing done yet → all 5 steps unfinished, readiness 0.
    expect(b.readinessPct).toBe(0);
    expect(b.steps[0].done).toBe(false);
    expect(b.dinnerIdeas).toHaveLength(3); // always offers dinner ideas
  });

  it('never returns an empty outcome — always has steps + dinner ideas', () => {
    const b = buildHomeBrief(input(), NOW);
    expect(b.steps.length).toBeGreaterThanOrEqual(5);
    expect(b.dinnerIdeas.length).toBeGreaterThan(0);
  });

  it('is not sparse once the family has real activity, and reflects readiness', () => {
    const b = buildHomeBrief(input({
      upcomingEvents: [
        { title: 'Soccer', start: '2026-07-08T16:00:00.000Z' },
        { title: 'Piano', start: '2026-07-09T15:00:00.000Z' },
        { title: 'Recital', start: '2026-07-10T18:00:00.000Z' },
      ],
      choresPending: 2, memberCount: 3,
    }), NOW);
    expect(b.isSparse).toBe(false);
    // calendar (3 events), family (3 members), chores (2) done → 3/5 = 60%.
    expect(b.readinessPct).toBe(60);
    expect(b.headline).toMatch(/good shape|rolling/i);
  });

  it('orders unfinished steps before done ones', () => {
    const b = buildHomeBrief(input({ memberCount: 4 }), NOW); // only "family" done
    const firstDoneIdx = b.steps.findIndex((s) => s.done);
    const lastUndoneIdx = [...b.steps].map((s) => s.done).lastIndexOf(false);
    expect(firstDoneIdx).toBeGreaterThan(lastUndoneIdx);
  });

  it('surfaces conflicts in the headline when the week has a clash', () => {
    const b = buildHomeBrief(input({
      upcomingEvents: [
        { title: 'Soccer', start: '2026-07-08T16:00:00.000Z', end: '2026-07-08T17:30:00.000Z' },
        { title: 'Dentist', start: '2026-07-08T16:30:00.000Z', end: '2026-07-08T17:15:00.000Z' },
        { title: 'Piano', start: '2026-07-09T15:00:00.000Z' },
      ],
      groceryOpen: 1,
    }), NOW);
    expect(b.conflictCount).toBe(1);
    expect(b.headline).toMatch(/clash/i);
  });

  it('produces a compact persistable summary', () => {
    const s = homeBriefSummary(buildHomeBrief(input(), NOW));
    expect(s.isSparse).toBe(true);
    expect(typeof s.readinessPct).toBe('number');
    expect(Array.isArray(s.steps)).toBe(true);
  });
});

describe('Home snapshot containment (source contracts)', () => {
  const dashboard = readFileSync('components/dashboard/ai-home-dashboard.tsx', 'utf8');

  it('builds the fresh outcome without reading or writing the snapshot table', () => {
    expect(dashboard).toMatch(/homeBrief = buildHomeBrief\(\{[\s\S]*?\}, now\);/);
    expect(dashboard).not.toMatch(/\.from\(['"]home_briefs['"]\)/);
    expect(dashboard).not.toContain('homeBriefSummary');
  });
});
