import { describe, it, expect } from 'vitest';
import {
  selectAbandonedOnboarding, selectAbandonedDemoLeads,
  type OnboardingJourney, type DemoLead,
} from '@/lib/marketing/journey-recovery';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-07-12T12:00:00Z');
const agoH = (h: number) => new Date(NOW - h * HOUR).toISOString();

const onb = (over: Partial<OnboardingJourney>): OnboardingJourney => ({
  user_id: 'u1', status: 'in_progress', completed_at: null, reset_at: null,
  created_at: agoH(10), updated_at: agoH(10), ...over,
});

describe('selectAbandonedOnboarding', () => {
  it('selects in-progress runs stalled within the window', () => {
    const rows = [onb({ user_id: 'in', updated_at: agoH(10) })];
    expect(selectAbandonedOnboarding(rows, NOW).map((r) => r.user_id)).toEqual(['in']);
  });

  it('excludes completed / reset runs', () => {
    const rows = [
      onb({ user_id: 'done', completed_at: agoH(5) }),
      onb({ user_id: 'reset', status: 'reset', reset_at: agoH(5) }),
      onb({ user_id: 'statusdone', status: 'completed' }),
    ];
    expect(selectAbandonedOnboarding(rows, NOW)).toEqual([]);
  });

  it('respects the grace window (too fresh) and max age (too cold)', () => {
    const rows = [
      onb({ user_id: 'fresh', updated_at: agoH(0.5) }), // within 2h grace → skip
      onb({ user_id: 'cold', updated_at: agoH(100) }),  // past 72h maxAge → skip
      onb({ user_id: 'ok', updated_at: agoH(24) }),
    ];
    expect(selectAbandonedOnboarding(rows, NOW).map((r) => r.user_id)).toEqual(['ok']);
  });

  it('honors custom windows', () => {
    const rows = [onb({ user_id: 'x', updated_at: agoH(4) })];
    expect(selectAbandonedOnboarding(rows, NOW, { graceHours: 6 })).toEqual([]); // now too fresh
  });
});

const lead = (over: Partial<DemoLead>): DemoLead => ({
  email: 'a@b.com', lead_source: 'demo', lifecycle_stage: 'lead', created_at: agoH(10), ...over,
});

describe('selectAbandonedDemoLeads', () => {
  it('selects demo leads that never became customers, within the window', () => {
    expect(selectAbandonedDemoLeads([lead({ email: 'x@y.com' })], NOW).map((l) => l.email)).toEqual(['x@y.com']);
  });

  it('excludes customers, non-demo sources, and missing/invalid emails', () => {
    const leads = [
      lead({ email: 'cust@y.com', lifecycle_stage: 'customer' }),
      lead({ email: 'signup@y.com', lead_source: 'signup' }),
      lead({ email: null }),
      lead({ email: 'noat' }),
    ];
    expect(selectAbandonedDemoLeads(leads, NOW)).toEqual([]);
  });

  it('respects grace + max age', () => {
    const leads = [
      lead({ email: 'fresh@y.com', created_at: agoH(0.2) }),
      lead({ email: 'cold@y.com', created_at: agoH(100) }),
      lead({ email: 'ok@y.com', created_at: agoH(24) }),
    ];
    expect(selectAbandonedDemoLeads(leads, NOW).map((l) => l.email)).toEqual(['ok@y.com']);
  });
});
