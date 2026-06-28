import { describe, it, expect } from 'vitest';
import { approvalReminders } from '@/lib/notifications/approval-reminders';

const managers = [
  { id: 'm1', user_id: 'u1' },
  { id: 'm2', user_id: 'u2' },
];

describe('approvalReminders', () => {
  it('emits one notification per manager with a unique related_id', () => {
    const out = approvalReminders([{ id: 'a1', kind: 'card_spend', amount_cents: 2500, created_at: 'x' }], managers);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.related_id)).toEqual(['a1:m1', 'a1:m2']);
    expect(out.map((r) => r.user_id)).toEqual(['u1', 'u2']);
    expect(out[0]).toMatchObject({ type: 'system', related_type: 'parent_approvals' });
    expect(out[0].title).toBe('Approval needed: Card purchase · $25');
  });

  it('formats labels and amounts; falls back for unknown kind / no amount', () => {
    const [r] = approvalReminders([{ id: 'a2', kind: 'mystery', amount_cents: null, created_at: 'x' }], [{ id: 'm1', user_id: 'u1' }]);
    expect(r.title).toBe('Approval needed: Approval');

    const [r2] = approvalReminders([{ id: 'a3', kind: 'allowance_request', amount_cents: 1050, created_at: 'x' }], [{ id: 'm1', user_id: 'u1' }]);
    expect(r2.title).toBe('Approval needed: Allowance request · $10.50');
  });

  it('falls back to a whole-family notification when there are no managers', () => {
    const out = approvalReminders([{ id: 'a1', kind: 'gift', amount_cents: 500, created_at: 'x' }], []);
    expect(out).toEqual([
      expect.objectContaining({ related_id: 'a1', user_id: null, title: 'Approval needed: Gift · $5' }),
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(approvalReminders([], managers)).toEqual([]);
  });
});
