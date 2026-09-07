// SSR contract for the approval card (§31). There is no DOM test harness in
// this repo, so the card is rendered with react-dom/server the way
// tests/display-render.test.ts renders the kitchen display. What matters:
// the consequences read as plain bullets, the buttons exist only for a
// manager (44px targets on touch), Edit appears only when there is something
// editable, and nothing that looks like a payload, a tool name or a reasoning
// chain ever reaches the markup.
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
vi.mock('@/app/(app)/dashboard/approvals-actions', () => ({
  decideApproval: async () => ({ ok: true, data: { status: 'approved', executed: true, resumedRunId: null, summary: 'done' } }),
  editAndApproveApproval: async () => ({ ok: true, data: { status: 'modified', resumedRunId: null } }),
}));

const { ApprovalCard, formatExpiry, formatAmount } = await import('@/components/approvals/approval-card');
const { ToastProvider } = await import('@/components/ui/toast');
const { toApprovalCardData, editableFieldsFor } = await import('@/lib/approvals/card-data');
const { PendingApprovals, toPendingCard } = await import('@/components/home/pending-approvals');

const row = {
  id: 'appr-1', domain: 'calendar', capability: 'automate', requested_by_kind: 'ai', requested_by_member_id: null,
  agent: 'concierge', title: 'Schedule Saturday family plan', summary: 'Four changes to Saturday.',
  payload: { name: 'calendar.createEvent', args: { title: 'Soccer', starts_at: '2026-09-06T13:00:00Z', all_day: false, guests: 3, secret_token: 'abc' } },
  payload_kind: 'tool', amount_cents: 4200, confidence: 0.91,
  reasoning: 'CHAIN OF THOUGHT: the model considered three options', required_approvals: 1, approvals: [],
  status: 'pending', priority: 'normal', created_at: '2026-09-05T10:00:00Z',
  // RELATIVE, because the case below asserts the card says "Expires in". A fixed
  // timestamp is a date the wall clock eventually passes, and this one did — at
  // 10:00 UTC on 2026-09-07 the card started saying "Expired" and the test went
  // red on a tree nobody had touched.
  expires_at: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString(),
  run_id: 'run-1', plan_step_id: null, plan_step_ids: [],
  consequences: ['Adds soccer at 9:00 AM Saturday', 'Reserves 12:00–2:00 PM for family lunch', 'Reminds Emma to pack her uniform'],
  edited_payload: null,
};

function render(node: React.ReactElement) {
  return renderToStaticMarkup(React.createElement(ToastProvider, null, node));
}

describe('ApprovalCard', () => {
  const data = toApprovalCardData(row, { requestedBy: null, canEdit: true });

  it('renders the title, consequences as bullets, requester, amount and expiry — and never the payload or reasoning', () => {
    const html = render(React.createElement(ApprovalCard, { approval: data, canDecide: true }));
    expect(html).toContain('Schedule Saturday family plan');
    expect(html).toContain('Bubaly will:');
    for (const line of row.consequences) expect(html).toContain(line);
    expect(html).toContain('$42');
    expect(html).toContain('Expires in');
    expect(html).toContain('Bubaly');
    // No architecture, no chain-of-thought, no raw arguments.
    expect(html).not.toContain('calendar.createEvent');
    expect(html).not.toContain('CHAIN OF THOUGHT');
    expect(html).not.toContain('secret_token');
    expect(html).not.toContain('starts_at');
    expect(html).not.toContain('{');
  });

  it('offers Approve / Edit / Decline to a manager with 44px touch targets, and nothing but a waiting note otherwise', () => {
    const manager = render(React.createElement(ApprovalCard, { approval: data, canDecide: true }));
    expect(manager).toContain('aria-label="Approve: Schedule Saturday family plan"');
    expect(manager).toContain('aria-label="Decline: Schedule Saturday family plan"');
    expect(manager).toContain('aria-label="Edit: Schedule Saturday family plan"');
    expect(manager.match(/coarse:min-h-11/g)?.length ?? 0).toBeGreaterThanOrEqual(3);

    const viewer = render(React.createElement(ApprovalCard, { approval: data, canDecide: false }));
    expect(viewer).toContain('Waiting for a parent or adult.');
    expect(viewer).not.toContain('aria-label="Approve');
    expect(viewer).not.toContain('aria-label="Edit');
  });

  it('hides Edit when the payload has nothing editable, and disables decisions once expired', () => {
    const plain = toApprovalCardData({ ...row, payload: { kind: 'plan_steps', run_id: 'run-1', step_ids: ['s1'] }, payload_kind: 'plan_steps', plan_step_ids: ['s1'] }, { requestedBy: null, canEdit: true });
    expect(plain.canEdit).toBe(false);
    const html = render(React.createElement(ApprovalCard, { approval: plain, canDecide: true }));
    expect(html).not.toContain('aria-label="Edit');
    expect(html).toContain('aria-label="Approve');

    const expired = render(React.createElement(ApprovalCard, { approval: { ...data, expiresAt: '2020-01-01T00:00:00Z' }, canDecide: true }));
    expect(expired).toContain('Expired');
    expect(expired.match(/<button[^>]*disabled/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('renders the compact variant on Home from a bare {id,title} row without throwing', () => {
    const html = render(React.createElement(PendingApprovals, {
      items: [{ id: 'p1', title: 'Order the birthday cake', agent: 'concierge' }],
      totalCount: 5,
      canDecide: true,
    }));
    expect(html).toContain('Order the birthday cake');
    expect(html).toContain('aria-label="Approve: Order the birthday cake"');
    expect(html).toContain('Review all (+2 more)');
    expect(toPendingCard({ id: 'p1', title: 't' })).toMatchObject({ consequences: [], canEdit: false, editableFields: [] });
  });
});

describe('editable fields', () => {
  it('exposes only scalars, with human labels, and never identity keys', () => {
    const fields = editableFieldsFor({ title: 'Soccer', starts_at: '2026-09-06T13:00:00Z', guests: 3, all_day: false, id: 'x', plan_id: 'p', nested: { a: 1 }, list: [1] });
    expect(fields.map((f) => f.key)).toEqual(['title', 'starts_at', 'guests', 'all_day']);
    expect(fields.map((f) => f.type)).toEqual(['text', 'text', 'number', 'boolean']);
    expect(fields.find((f) => f.key === 'starts_at')?.label).toBe('Starts at');
  });
});

describe('formatting', () => {
  it('formats expiry relative to now and amounts without noise', () => {
    const now = Date.parse('2026-09-05T12:00:00Z');
    expect(formatExpiry('2026-09-05T12:30:00Z', now)).toBe('Expires in 30 min');
    expect(formatExpiry('2026-09-05T18:00:00Z', now)).toBe('Expires in 6h');
    expect(formatExpiry('2026-09-08T12:00:00Z', now)).toBe('Expires in 3 days');
    expect(formatExpiry('2026-09-01T12:00:00Z', now)).toBe('Expired');
    expect(formatExpiry(null, now)).toBeNull();
    expect(formatAmount(4200)).toBe('$42');
    expect(formatAmount(1050)).toBe('$10.50');
    expect(formatAmount(null)).toBeNull();
  });
});
