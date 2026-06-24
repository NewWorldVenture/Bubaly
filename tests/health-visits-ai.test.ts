import { describe, expect, it } from 'vitest';
import {
  analyzeHealthVisits,
  buildHealthVisitsPrompt,
  parseHealthVisitsResponse,
  type HealthVisitEntryLike,
} from '@/lib/health/health-visits-ai';

function visit(overrides: Partial<HealthVisitEntryLike> = {}): HealthVisitEntryLike {
  return { title: 'Annual checkup', kind: 'medical', visit_date: '2024-06-01', provider_name: 'Dr. Smith', follow_up_date: null, cost_cents: null, ...overrides };
}

describe('analyzeHealthVisits', () => {
  it('summarizes visits', () => {
    const r = analyzeHealthVisits([
      visit({ kind: 'medical' }),
      visit({ kind: 'dental', cost_cents: 15000 }),
      visit({ kind: 'medical', follow_up_date: '2099-12-31' }),
    ]);
    expect(r.totalVisits).toBe(3);
    expect(r.kindCounts['medical']).toBe(2);
    expect(r.kindCounts['dental']).toBe(1);
    expect(r.upcomingFollowUps).toBe(1);
    expect(r.totalCostCents).toBe(15000);
  });

  it('handles empty list', () => {
    const r = analyzeHealthVisits([]);
    expect(r.totalVisits).toBe(0);
    expect(r.totalCostCents).toBe(0);
  });
});

describe('buildHealthVisitsPrompt', () => {
  it('builds prompt with visit details', () => {
    const { system, user } = buildHealthVisitsPrompt([visit({ title: 'Dental cleaning', kind: 'dental' })]);
    expect(system).toContain('JSON');
    expect(user).toContain('Dental cleaning');
    expect(user).toContain('dental');
  });
});

describe('parseHealthVisitsResponse', () => {
  it('parses valid JSON', () => {
    const r = parseHealthVisitsResponse('{"suggestions":["schedule annual"],"preventiveTips":["get flu shot"],"wellnessTip":"stay active"}');
    expect(r.suggestions).toEqual(['schedule annual']);
    expect(r.preventiveTips).toEqual(['get flu shot']);
    expect(r.wellnessTip).toBe('stay active');
  });

  it('handles malformed input', () => {
    const r = parseHealthVisitsResponse('nope');
    expect(r.suggestions).toEqual([]);
  });

  it('handles code fences', () => {
    const r = parseHealthVisitsResponse('```json\n{"suggestions":["x"],"preventiveTips":["y"],"wellnessTip":"z"}\n```');
    expect(r.suggestions).toEqual(['x']);
  });
});
