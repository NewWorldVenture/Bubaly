import { describe, it, expect } from 'vitest';
import { computeEntitlement } from '@/lib/server/entitlement';

const NOW = new Date('2026-07-11T12:00:00Z');
const future = new Date('2026-07-13T12:00:00Z').toISOString(); // within trial
const past = new Date('2026-07-01T12:00:00Z').toISOString();   // trial over

describe('computeEntitlement', () => {
  it('grandfathers existing free families (no trial clock) — never locked, level 0', () => {
    const e = computeEntitlement({ paidLevel: 0, trialEndsAt: null, closedAt: null, now: NOW });
    expect(e).toMatchObject({ effectiveLevel: 0, locked: false, inTrial: false });
  });

  it('grants Family Basic (level 1) during an active trial', () => {
    const e = computeEntitlement({ paidLevel: 0, trialEndsAt: future, closedAt: null, now: NOW });
    expect(e).toMatchObject({ effectiveLevel: 1, locked: false, inTrial: true });
  });

  it('LOCKS a new free family once the 5-day trial has expired', () => {
    const e = computeEntitlement({ paidLevel: 0, trialEndsAt: past, closedAt: null, now: NOW });
    expect(e).toMatchObject({ effectiveLevel: 0, locked: true, inTrial: false });
  });

  it('paid Family Basic is unlocked at level 1 regardless of trial', () => {
    const e = computeEntitlement({ paidLevel: 1, trialEndsAt: past, closedAt: null, now: NOW });
    expect(e).toMatchObject({ effectiveLevel: 1, locked: false });
  });

  it('paid Family+ is unlocked at level 2', () => {
    const e = computeEntitlement({ paidLevel: 2, trialEndsAt: past, closedAt: null, now: NOW });
    expect(e).toMatchObject({ effectiveLevel: 2, locked: false });
  });

  it('a closed account is locked (but nothing is deleted) even if paid', () => {
    const e = computeEntitlement({ paidLevel: 2, trialEndsAt: null, closedAt: past, now: NOW });
    expect(e).toMatchObject({ locked: true, closed: true });
  });

  it('super-admins are never locked (full access to preview)', () => {
    const e = computeEntitlement({ paidLevel: 0, trialEndsAt: past, closedAt: past, isSuperAdmin: true, now: NOW });
    expect(e).toMatchObject({ effectiveLevel: 2, locked: false, closed: false });
  });

  it('trial boundary: expired exactly at trial_ends_at locks (not < now)', () => {
    const e = computeEntitlement({ paidLevel: 0, trialEndsAt: NOW.toISOString(), closedAt: null, now: NOW });
    expect(e.locked).toBe(true);
  });
});
