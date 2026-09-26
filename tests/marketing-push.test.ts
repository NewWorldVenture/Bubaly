import { describe, expect, it } from 'vitest';
import {
  selectPushRecipients,
  deliveryRate,
  canSendPush,
  summarizePush,
} from '@/lib/marketing/push';

describe('selectPushRecipients', () => {
  it('dedupes user ids and drops empties', () => {
    expect(selectPushRecipients(['u1', 'u1', '', null, 'u2'], {}, [])).toEqual(['u1', 'u2']);
  });
  it('excludes suppressed emails (case-insensitive)', () => {
    const emails = { u1: 'A@x.com', u2: 'b@x.com', u3: null };
    expect(selectPushRecipients(['u1', 'u2', 'u3'], emails, ['a@x.com'])).toEqual(['u2', 'u3']);
  });
});

describe('deliveryRate', () => {
  it('computes a percentage, 0 when no recipients', () => {
    expect(deliveryRate(8, 10)).toBe(80);
    expect(deliveryRate(0, 0)).toBe(0);
  });
});

describe('canSendPush', () => {
  it('allows a fresh draft and only a failed attempt proven to precede dispatch', () => {
    expect(canSendPush('draft')).toBe(true);
    expect(canSendPush('failed')).toBe(false);
    expect(canSendPush('failed', { push_delivery: { version: 1, attemptId: 'fixture', phase: 'preflight_failed' } })).toBe(true);
    expect(canSendPush('failed', { push_delivery: { version: 1, attemptId: 'fixture', phase: 'review' } })).toBe(false);
    expect(canSendPush('sent')).toBe(false);
    expect(canSendPush('sending')).toBe(false);
  });
});

describe('summarizePush', () => {
  it('rolls up counts without dividing device acceptances by recipient users', () => {
    const s = summarizePush([
      { status: 'sent', recipients: 10, sent: 9 },
      { status: 'sent', recipients: 10, sent: 7 },
      { status: 'draft', recipients: 0, sent: 0 },
    ]);
    expect(s).toEqual({ campaigns: 3, sentCampaigns: 2, totalSent: 16, totalRecipients: 20, reviewCampaigns: 0 });
  });
});
