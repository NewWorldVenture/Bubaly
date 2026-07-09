import { describe, it, expect } from 'vitest';
import {
  DISPUTE_TRANSITIONS, canDisputeTransition, isDisputeTerminal,
  applicableRemedies, isValidRemedy, resolveDispute,
  type DisputeStatus,
} from '@/lib/marketplace/disputes';

describe('dispute transitions', () => {
  it('follows the open → review → resolved/rejected/escalated flow', () => {
    expect(canDisputeTransition('open', 'under_review')).toBe(true);
    expect(canDisputeTransition('open', 'resolved')).toBe(true);
    expect(canDisputeTransition('escalated', 'resolved')).toBe(true);
    expect(canDisputeTransition('resolved', 'open')).toBe(false);
  });

  it('marks terminal states and has no dangling edges', () => {
    expect(isDisputeTerminal('resolved')).toBe(true);
    expect(isDisputeTerminal('rejected')).toBe(true);
    expect(isDisputeTerminal('open')).toBe(false);
    const all = Object.keys(DISPUTE_TRANSITIONS) as DisputeStatus[];
    for (const from of all) for (const to of DISPUTE_TRANSITIONS[from]) expect(all).toContain(to);
  });
});

describe('applicable remedies', () => {
  it('scopes remedies to the dispute kind', () => {
    expect(applicableRemedies('not_received')).toContain('refund_full');
    expect(applicableRemedies('rental_damage')).toContain('deposit_forfeit');
    expect(applicableRemedies('late_return')).toContain('late_fee');
    expect(isValidRemedy('not_received', 'deposit_forfeit')).toBe(false);
    expect(isValidRemedy('rental_damage', 'deposit_forfeit')).toBe(true);
  });
});

describe('resolveDispute (human decision required, never fabricated)', () => {
  it('resolves with a valid remedy', () => {
    expect(resolveDispute('under_review', 'not_received', 'refund_full')).toEqual({ status: 'resolved', remedy: 'refund_full' });
  });

  it('treats no_action as a rejection', () => {
    expect(resolveDispute('open', 'damaged', 'no_action')).toEqual({ status: 'rejected', remedy: 'no_action' });
  });

  it('rejects a remedy that does not apply to the kind', () => {
    expect(() => resolveDispute('under_review', 'not_received', 'deposit_forfeit')).toThrow(/does not apply/i);
  });

  it('rejects an illegal transition (already terminal)', () => {
    expect(() => resolveDispute('resolved', 'fraud', 'refund_full')).toThrow(/Cannot move/i);
  });

  it('allows escalate as a remedy regardless of kind-specific list', () => {
    expect(resolveDispute('open', 'fraud', 'escalate')).toEqual({ status: 'resolved', remedy: 'escalate' });
  });
});
