import { describe, expect, it } from 'vitest';
import {
  reunionStatusMeta,
  rsvpMeta,
  rsvpSummary,
  upcomingReunions,
  totalBudget,
  reunionSummaryResult,
  fmtDate,
  type ReunionLike,
  type RsvpLike,
} from '@/lib/reunion/planner';

const TODAY = new Date('2026-06-24T12:00:00');

function reunion(overrides: Partial<ReunionLike> & { id: string }): ReunionLike {
  return {
    title: 'Test Reunion',
    status: 'planning',
    start_date: null,
    budget: null,
    headcount: 0,
    ...overrides,
  };
}

function rsvp(overrides: Partial<RsvpLike> & { id: string }): RsvpLike {
  return {
    reunion_id: 'r1',
    response: 'pending',
    party_size: 1,
    ...overrides,
  };
}

describe('reunionStatusMeta', () => {
  it('returns correct meta', () => {
    expect(reunionStatusMeta('confirmed').emoji).toBe('✅');
  });
});

describe('rsvpMeta', () => {
  it('returns correct meta', () => {
    expect(rsvpMeta('attending').emoji).toBe('✅');
  });
});

describe('rsvpSummary', () => {
  it('counts responses', () => {
    const rsvps = [
      rsvp({ id: 'a', response: 'attending', party_size: 3 }),
      rsvp({ id: 'b', response: 'attending', party_size: 2 }),
      rsvp({ id: 'c', response: 'maybe', party_size: 1 }),
      rsvp({ id: 'd', response: 'not_attending', party_size: 1 }),
      rsvp({ id: 'e', response: 'pending', party_size: 1 }),
    ];
    const s = rsvpSummary(rsvps);
    expect(s.attending).toBe(2);
    expect(s.maybe).toBe(1);
    expect(s.pending).toBe(1);
    expect(s.declined).toBe(1);
    expect(s.totalGuests).toBe(6);
  });
});

describe('upcomingReunions', () => {
  it('returns planning/confirmed sorted by date', () => {
    const reunions = [
      reunion({ id: 'a', status: 'planning', start_date: '2026-09-01' }),
      reunion({ id: 'b', status: 'confirmed', start_date: '2026-07-15' }),
      reunion({ id: 'c', status: 'completed' }),
    ];
    const result = upcomingReunions(reunions, TODAY);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('b');
  });
  it('excludes past reunions', () => {
    const reunions = [reunion({ id: 'a', status: 'planning', start_date: '2026-01-01' })];
    expect(upcomingReunions(reunions, TODAY)).toHaveLength(0);
  });
});

describe('totalBudget', () => {
  it('sums budgets', () => {
    expect(totalBudget([
      reunion({ id: 'a', budget: 5000 }),
      reunion({ id: 'b', budget: 3000 }),
    ])).toBe(8000);
  });
});

describe('reunionSummaryResult', () => {
  it('handles empty', () => {
    const s = reunionSummaryResult([], TODAY);
    expect(s.text).toBe('No reunions planned yet');
  });
  it('reports upcoming', () => {
    const reunions = [reunion({ id: 'a', status: 'planning', start_date: '2026-09-01' })];
    const s = reunionSummaryResult(reunions, TODAY);
    expect(s.upcoming).toBe(1);
    expect(s.text).toContain('1 upcoming');
  });
});

describe('fmtDate', () => {
  it('formats a date', () => {
    expect(fmtDate('2026-06-24')).toBe('Jun 24, 2026');
  });
});
