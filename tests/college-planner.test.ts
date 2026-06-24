import { describe, expect, it } from 'vitest';
import {
  appStatusMeta,
  scholarshipStatusMeta,
  deadlineUrgency,
  upcomingDeadlines,
  netCost,
  totalScholarships,
  collegeSummary,
  fmtMoney,
  type AppLike,
  type ScholarshipLike,
} from '@/lib/college/planner';

const TODAY = new Date('2026-06-24T12:00:00');

function app(overrides: Partial<AppLike> & { id: string }): AppLike {
  return {
    school_name: 'MIT',
    status: 'researching',
    deadline: null,
    tuition: null,
    financial_aid: null,
    ...overrides,
  };
}

function scholarship(overrides: Partial<ScholarshipLike> & { id: string }): ScholarshipLike {
  return {
    name: 'Test Scholarship',
    amount: 5000,
    status: 'researching',
    deadline: null,
    ...overrides,
  };
}

describe('appStatusMeta', () => {
  it('returns correct meta', () => {
    expect(appStatusMeta('accepted').emoji).toBe('🎉');
  });
});

describe('scholarshipStatusMeta', () => {
  it('returns correct meta', () => {
    expect(scholarshipStatusMeta('awarded').emoji).toBe('🏆');
  });
});

describe('deadlineUrgency', () => {
  it('returns none for null', () => {
    expect(deadlineUrgency(null, TODAY)).toBe('none');
  });
  it('returns past for old date', () => {
    expect(deadlineUrgency('2026-06-01', TODAY)).toBe('past');
  });
  it('returns urgent within 14 days', () => {
    expect(deadlineUrgency('2026-07-01', TODAY)).toBe('urgent');
  });
  it('returns upcoming beyond 14 days', () => {
    expect(deadlineUrgency('2026-12-01', TODAY)).toBe('upcoming');
  });
});

describe('upcomingDeadlines', () => {
  it('returns researching/applying apps with deadlines', () => {
    const apps = [
      app({ id: 'a', deadline: '2026-08-01', status: 'applying' }),
      app({ id: 'b', deadline: '2026-09-01', status: 'researching' }),
      app({ id: 'c', deadline: '2026-07-01', status: 'submitted' }),
    ];
    const result = upcomingDeadlines(apps, TODAY);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('a');
  });
});

describe('netCost', () => {
  it('calculates net cost', () => {
    expect(netCost(app({ id: 'a', tuition: 50000, financial_aid: 20000 }))).toBe(30000);
  });
  it('returns null when no tuition', () => {
    expect(netCost(app({ id: 'a' }))).toBeNull();
  });
});

describe('totalScholarships', () => {
  it('sums awarded/accepted only', () => {
    const list = [
      scholarship({ id: 'a', amount: 5000, status: 'awarded' }),
      scholarship({ id: 'b', amount: 3000, status: 'accepted' }),
      scholarship({ id: 'c', amount: 10000, status: 'researching' }),
    ];
    expect(totalScholarships(list)).toBe(8000);
  });
});

describe('collegeSummary', () => {
  it('handles empty', () => {
    const s = collegeSummary([], [], TODAY);
    expect(s.text).toBe('No college applications yet');
  });
  it('reports accepted and scholarships', () => {
    const apps = [
      app({ id: 'a', status: 'accepted' }),
      app({ id: 'b', status: 'applying', deadline: '2026-06-30' }),
    ];
    const schols = [scholarship({ id: 's1', amount: 10000, status: 'awarded' })];
    const s = collegeSummary(apps, schols, TODAY);
    expect(s.accepted).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.scholarshipTotal).toBe(10000);
    expect(s.text).toContain('1 accepted');
  });
});

describe('fmtMoney', () => {
  it('formats USD', () => {
    expect(fmtMoney(50000)).toBe('$50,000');
  });
});
