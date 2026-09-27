import { describe, it, expect } from 'vitest';
import { approvalReminders } from '@/lib/notifications/approval-reminders';
import { getMessages, translate } from '@/lib/i18n/messages';

const managers = [
  { id: 'm1', user_id: 'u1' },
  { id: 'm2', user_id: 'u2' },
];

// The builders word their rows for a READER (AQ-01 / I18N-003): the amount in
// the reader's format and the sentence from the reader's catalogue. This file
// pins the structure — fan-out, dedupe keys, fallbacks — for an en-US reader off
// the real catalogue, which is the only reader either production caller passes
// today (no per-recipient locale exists, I18N-001); a de-DE reader's wording
// and the stored en-US residual are pinned in
// tests/a-money-approval-reminder-is-worded-from-the-catalogue-and-still-stored-in-english.test.ts.
// The English sentences below come from catalogue keys asked for with that
// change (approvalReminders.*, aiApprovalReminders.*); until the catalogue merge
// lands, a key renders as itself and the title assertions here are red.
const reader = {
  locale: 'en-US' as const,
  t: (key: string, params?: Record<string, string | number>) => translate(getMessages('en-US'), key, params),
};

describe('approvalReminders', () => {
  it('emits one notification per manager with a unique related_id', () => {
    const out = approvalReminders([{ id: 'a1', kind: 'card_spend', amount_cents: 2500, created_at: 'x' }], managers, reader);
    expect(out).toHaveLength(2);
    expect(out.map((r) => r.related_id)).toEqual(['a1:m1', 'a1:m2']);
    expect(out.map((r) => r.user_id)).toEqual(['u1', 'u2']);
    expect(out[0]).toMatchObject({ type: 'system', related_type: 'parent_approvals' });
    expect(out[0].title).toBe('Approval needed: Card purchase · $25');
  });

  it('formats labels and amounts; falls back for unknown kind / no amount', () => {
    const [r] = approvalReminders([{ id: 'a2', kind: 'mystery', amount_cents: null, created_at: 'x' }], [{ id: 'm1', user_id: 'u1' }], reader);
    expect(r.title).toBe('Approval needed: Approval');

    const [r2] = approvalReminders([{ id: 'a3', kind: 'allowance_request', amount_cents: 1050, created_at: 'x' }], [{ id: 'm1', user_id: 'u1' }], reader);
    expect(r2.title).toBe('Approval needed: Allowance request · $10.50');
  });

  it('falls back to a whole-family notification when there are no managers', () => {
    const out = approvalReminders([{ id: 'a1', kind: 'gift', amount_cents: 500, created_at: 'x' }], [], reader);
    expect(out).toEqual([
      expect.objectContaining({ related_id: 'a1', user_id: null, title: 'Approval needed: Gift · $5' }),
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(approvalReminders([], managers, reader)).toEqual([]);
  });
});

// ─── AI approvals (approval_requests) ───────────────────────────────────────
import { aiApprovalDedupeKey, aiApprovalReminders } from '@/lib/notifications/approval-reminders';

describe('aiApprovalReminders', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const pending = { id: 'appr-1', title: 'Add soccer Saturday', amount_cents: null, created_at: 'x', expires_at: '2026-09-07T12:00:00Z', agent: 'concierge' };

  it('emits one row per manager keyed by the approval + member dedupe key', () => {
    const out = aiApprovalReminders([pending], managers, reader, now);
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
      reader,
      now,
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Needs your OK: Add soccer Saturday · $42.50');
    expect(out[0].body).not.toContain('Expires');
  });

  it('returns nothing for no approvals or no managers', () => {
    expect(aiApprovalReminders([], managers, reader, now)).toEqual([]);
    expect(aiApprovalReminders([pending], [], reader, now)).toEqual([]);
  });
});
