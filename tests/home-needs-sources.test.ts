import { describe, it, expect } from 'vitest';
import { usdFromCents, parentApprovalToNeed, renewalToNeed } from '@/lib/home/needs-sources';

describe('usdFromCents', () => {
  it('drops cents for whole dollars, keeps them otherwise', () => {
    expect(usdFromCents(1200)).toBe('$12');
    expect(usdFromCents(1250)).toBe('$12.50');
    expect(usdFromCents(99)).toBe('$0.99');
  });
});

describe('parentApprovalToNeed', () => {
  it('maps a card purchase with amount to an urgent card', () => {
    const n = parentApprovalToNeed({ id: 'a1', kind: 'card_spend', amount_cents: 2500, created_at: '2026-06-28T10:00:00Z' });
    expect(n).toMatchObject({ id: 'approval:a1', kind: 'approval', urgency: 'urgent', href: '/wallet/cards' });
    expect(n.title).toBe('Card purchase to approve · $25');
  });
  it('falls back gracefully for an unknown kind and missing amount', () => {
    const n = parentApprovalToNeed({ id: 'a2', kind: 'mystery', amount_cents: null, created_at: '2026-06-28T10:00:00Z' });
    expect(n.title).toBe('Approval to approve');
    expect(n.href).toBe('/wallet');
  });
});

describe('renewalToNeed', () => {
  const now = new Date('2026-06-28T12:00:00Z');

  it('is urgent within 3 days and normal further out', () => {
    const soon = renewalToNeed({ id: 'r1', title: 'Car registration', expires_at: '2026-06-30T12:00:00Z', reminder_days: 30, status: 'active' }, now);
    expect(soon).toMatchObject({ kind: 'renewal', urgency: 'urgent', href: '/dashboard/renewals' });
    expect(soon!.title).toContain('Renew Car registration');

    const later = renewalToNeed({ id: 'r2', title: 'Passport', expires_at: '2026-07-10T12:00:00Z', reminder_days: 30, status: 'active' }, now);
    expect(later!.urgency).toBe('normal');
  });

  it('marks an already-expired active renewal as urgent', () => {
    const n = renewalToNeed({ id: 'r3', title: 'Insurance', expires_at: '2026-06-20T12:00:00Z', reminder_days: 14, status: 'active' }, now);
    expect(n).toMatchObject({ urgency: 'urgent' });
    expect(n!.title).toContain('expired');
  });

  it('returns null when outside the reminder window, renewed, or cancelled', () => {
    expect(renewalToNeed({ id: 'r4', title: 'Far off', expires_at: '2026-12-01T12:00:00Z', reminder_days: 14, status: 'active' }, now)).toBeNull();
    expect(renewalToNeed({ id: 'r5', title: 'Done', expires_at: '2026-06-29T12:00:00Z', reminder_days: 30, status: 'renewed' }, now)).toBeNull();
    expect(renewalToNeed({ id: 'r6', title: 'Gone', expires_at: '2026-06-29T12:00:00Z', reminder_days: 30, status: 'cancelled' }, now)).toBeNull();
  });
});
