import { describe, expect, it } from 'vitest';
import {
  categoryMeta,
  totalHours,
  hoursByMember,
  hoursByCategory,
  upcomingOpportunities,
  volunteerSummary,
  fmtDate,
  type OpportunityLike,
  type HourLog,
} from '@/lib/volunteer/tracking';

const TODAY = new Date('2026-06-24T12:00:00');

function opp(overrides: Partial<OpportunityLike> & { id: string }): OpportunityLike {
  return {
    title: 'Test',
    organization: 'Org',
    category: 'community',
    status: 'active',
    start_date: null,
    end_date: null,
    ...overrides,
  };
}

function log(overrides: Partial<HourLog> & { id: string }): HourLog {
  return {
    opportunity_id: null,
    member_id: null,
    hours: 2,
    log_date: '2026-06-20',
    ...overrides,
  };
}

describe('categoryMeta', () => {
  it('returns correct meta', () => {
    const m = categoryMeta('school');
    expect(m.label).toBe('School');
    expect(m.emoji).toBe('🎓');
  });
  it('falls back to other', () => {
    const m = categoryMeta('other');
    expect(m.label).toBe('Other');
  });
});

describe('totalHours', () => {
  it('sums hours', () => {
    expect(totalHours([log({ id: 'a', hours: 3 }), log({ id: 'b', hours: 5 })])).toBe(8);
  });
  it('returns 0 for empty', () => {
    expect(totalHours([])).toBe(0);
  });
});

describe('hoursByMember', () => {
  it('groups by member', () => {
    const logs = [
      log({ id: 'a', member_id: 'm1', hours: 3 }),
      log({ id: 'b', member_id: 'm1', hours: 2 }),
      log({ id: 'c', member_id: 'm2', hours: 4 }),
    ];
    const result = hoursByMember(logs);
    expect(result.get('m1')).toBe(5);
    expect(result.get('m2')).toBe(4);
  });
});

describe('hoursByCategory', () => {
  it('groups by opportunity category', () => {
    const opps = [
      opp({ id: 'o1', category: 'school' }),
      opp({ id: 'o2', category: 'church' }),
    ];
    const logs = [
      log({ id: 'a', opportunity_id: 'o1', hours: 3 }),
      log({ id: 'b', opportunity_id: 'o2', hours: 5 }),
    ];
    const result = hoursByCategory(logs, opps);
    expect(result[0]).toEqual({ category: 'church', hours: 5 });
    expect(result[1]).toEqual({ category: 'school', hours: 3 });
  });
});

describe('upcomingOpportunities', () => {
  it('returns active and upcoming, sorted by start', () => {
    const opps = [
      opp({ id: 'a', status: 'upcoming', start_date: '2026-08-01' }),
      opp({ id: 'b', status: 'active', start_date: '2026-06-20' }),
      opp({ id: 'c', status: 'completed' }),
    ];
    const result = upcomingOpportunities(opps, TODAY);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('b');
    expect(result[1].id).toBe('a');
  });
  it('excludes ended opportunities', () => {
    const opps = [opp({ id: 'a', status: 'active', end_date: '2026-06-01' })];
    expect(upcomingOpportunities(opps, TODAY)).toHaveLength(0);
  });
});

describe('volunteerSummary', () => {
  it('handles empty', () => {
    const s = volunteerSummary([], []);
    expect(s.text).toBe('No volunteer activities yet');
  });
  it('reports active and hours', () => {
    const opps = [opp({ id: 'a', status: 'active' }), opp({ id: 'b', status: 'upcoming' })];
    const logs = [log({ id: 'l1', hours: 10 })];
    const s = volunteerSummary(opps, logs);
    expect(s.activeCount).toBe(1);
    expect(s.upcomingCount).toBe(1);
    expect(s.totalHours).toBe(10);
    expect(s.text).toContain('1 active');
    expect(s.text).toContain('1 upcoming');
    expect(s.text).toContain('10.0h logged');
  });
});

describe('fmtDate', () => {
  it('formats a date', () => {
    expect(fmtDate('2026-06-24')).toBe('Jun 24, 2026');
  });
  it('returns dash for null', () => {
    expect(fmtDate(null)).toBe('—');
  });
});
