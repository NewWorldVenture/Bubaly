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

// ─── AI approvals (approval_requests) ───────────────────────────────────────
import { aiApprovalDedupeKey, aiApprovalReminders } from '@/lib/notifications/approval-reminders';

describe('aiApprovalReminders', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const pending = { id: 'appr-1', title: 'Add soccer Saturday', amount_cents: null, created_at: 'x', expires_at: '2026-09-07T12:00:00Z', agent: 'concierge' };

  it('emits one row per manager keyed by the approval + member dedupe key', () => {
    const out = aiApprovalReminders([pending], managers, now);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.dedupe_key)).toEqual(['ai-approval:appr-1:m1', 'ai-approval:appr-1:m2']);
    expect(out.map((r) => r.related_id)).toEqual(out.map((r) => r.dedupe_key));
    expect(out.map((r) => r.user_id)).toEqual(['u1', 'u2']);
    expect(out[0]).toMatchObject({ type: 'system', related_type: 'approval_requests', member_id: 'm1', approval_id: 'appr-1' });
    expect(out[0].title).toBe('Needs your OK: Add soccer Saturday');
    expect(out[0].body).toContain('Expires in 2 days');
    expect(aiApprovalDedupeKey('a', 'b')).toBe('ai-approval:a:b');
  });

  it('shows the amount and skips managers with no login instead of notifying the whole family', () => {
    const out = aiApprovalReminders(
      [{ ...pending, amount_cents: 4250, expires_at: null }],
      [{ id: 'm1', user_id: 'u1' }, { id: 'm-managed', user_id: null }],
      now,
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Needs your OK: Add soccer Saturday · $42.50');
    expect(out[0].body).not.toContain('Expires');
  });

  it('returns nothing for no approvals or no managers', () => {
    expect(aiApprovalReminders([], managers, now)).toEqual([]);
    expect(aiApprovalReminders([pending], [], now)).toEqual([]);
  });
});
