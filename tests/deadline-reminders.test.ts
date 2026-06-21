import { describe, it, expect } from 'vitest';
import {
  renewalReminders, opportunityReminders,
  type ManagerLite, type RenewalInput, type OpportunityInput,
} from '@/lib/notifications/deadline-reminders';

const today = '2026-06-21';
const managers: ManagerLite[] = [
  { id: 'mom', user_id: 'u-mom' },
  { id: 'dad', user_id: 'u-dad' },
];

const renewal = (over: Partial<RenewalInput>): RenewalInput => ({
  id: 'r1', title: 'Passport', expires_at: '2026-07-01', reminder_days: 30, status: 'active', ...over,
});
const opp = (over: Partial<OpportunityInput>): OpportunityInput => ({
  id: 'o1', title: 'Soccer camp', deadline: '2026-06-25', status: 'interested', ...over,
});

describe('renewalReminders', () => {
  it('emits one row per manager when inside the item reminder window', () => {
    const rows = renewalReminders([renewal({ expires_at: '2026-07-01', reminder_days: 30 })], managers, today);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.user_id).sort()).toEqual(['u-dad', 'u-mom']);
    expect(rows[0]).toMatchObject({ type: 'document_expiry', related_type: 'renewals', related_id: 'r1' });
    expect(rows[0].related_id).toBe('r1'); // valid uuid placeholder, not composite
    expect(rows[0].title).toBe('Renewal due: Passport');
    expect(rows[0].body).toContain('Jul 1');
  });

  it('respects each item\'s own reminder_days', () => {
    // 20 days out: in window for reminder_days 30, out for 7
    expect(renewalReminders([renewal({ expires_at: '2026-07-11', reminder_days: 30 })], managers, today)).toHaveLength(2);
    expect(renewalReminders([renewal({ expires_at: '2026-07-11', reminder_days: 7 })], managers, today)).toHaveLength(0);
  });

  it('skips expired and inactive renewals', () => {
    expect(renewalReminders([renewal({ expires_at: '2026-06-10' })], managers, today)).toHaveLength(0);
    expect(renewalReminders([renewal({ status: 'renewed' })], managers, today)).toHaveLength(0);
  });

  it('falls back to a single family-wide row when there are no managers', () => {
    const rows = renewalReminders([renewal({})], [], today);
    expect(rows).toHaveLength(1);
    expect(rows[0].user_id).toBeNull();
  });
});

describe('opportunityReminders', () => {
  it('emits per-manager rows for open signups closing within the window', () => {
    const rows = opportunityReminders([opp({ deadline: '2026-06-25' })], managers, today, 7);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ type: 'system', related_type: 'opportunities', related_id: 'o1' });
    expect(rows[0].body).toContain('Jun 25');
  });

  it('skips deadlines beyond the window and already-past ones', () => {
    expect(opportunityReminders([opp({ deadline: '2026-07-10' })], managers, today, 7)).toHaveLength(0);
    expect(opportunityReminders([opp({ deadline: '2026-06-19' })], managers, today, 7)).toHaveLength(0);
  });

  it('skips decided/closed signups and null deadlines', () => {
    expect(opportunityReminders([opp({ status: 'registered' })], managers, today)).toHaveLength(0);
    expect(opportunityReminders([opp({ deadline: null })], managers, today)).toHaveLength(0);
  });
});
