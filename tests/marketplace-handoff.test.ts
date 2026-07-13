import { describe, it, expect } from 'vitest';
import {
  SAFE_SPOTS, isSafePublicSpot, generateHandoffCode, normalizeCode, codesMatch,
  suggestedMeetTimes, canConfirm, canCancel, canComplete, statusLabel, meetSummary,
} from '@/lib/marketplace/handoff';

describe('safe spots', () => {
  it('leads with the police safe-exchange zone', () => {
    expect(SAFE_SPOTS[0].label).toMatch(/police/i);
    expect(SAFE_SPOTS.every((s) => s.hint.length > 0)).toBe(true);
  });
  it('classifies public spots', () => {
    expect(isSafePublicSpot('public_spot')).toBe(true);
    expect(isSafePublicSpot('seller_place')).toBe(false);
  });
});

describe('hand-off codes', () => {
  it('generates a 6-char code from the unambiguous alphabet', () => {
    const code = generateHandoffCode(() => 0.5);
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/);
    expect(code).not.toMatch(/[0O1I]/);
  });
  it('normalizes case, spaces, and dashes', () => {
    expect(normalizeCode(' ab-c d ')).toBe('ABCD');
  });
  it('matches case/format-insensitively but never an empty code', () => {
    expect(codesMatch('ab cd', 'ABCD')).toBe(true);
    expect(codesMatch('a-b-c-d', 'ABCD')).toBe(true);
    expect(codesMatch('wrong', 'ABCD')).toBe(false);
    expect(codesMatch('', 'ABCD')).toBe(false);
    expect(codesMatch('ABCD', null)).toBe(false);
  });
});

describe('suggested meet times', () => {
  it('offers a today slot only when it is still early', () => {
    const early = suggestedMeetTimes(new Date('2026-07-13T09:00:00'));
    expect(early[0].label).toBe('Today, 6:00 PM');
    const late = suggestedMeetTimes(new Date('2026-07-13T20:00:00'));
    expect(late.some((t) => t.label.startsWith('Today'))).toBe(false);
  });
  it('every suggestion is a valid future-ish ISO', () => {
    const list = suggestedMeetTimes(new Date('2026-07-13T09:00:00'));
    expect(list.length).toBeGreaterThanOrEqual(3);
    for (const t of list) expect(new Date(t.iso).toString()).not.toBe('Invalid Date');
  });
});

describe('turn / action gating', () => {
  it('only the non-proposer can confirm a proposal', () => {
    expect(canConfirm('proposed', 'buyer', 'seller')).toBe(true);
    expect(canConfirm('proposed', 'seller', 'seller')).toBe(false);
    expect(canConfirm('confirmed', 'buyer', 'seller')).toBe(false);
  });
  it('cancel is allowed while open; complete only when confirmed', () => {
    expect(canCancel('proposed')).toBe(true);
    expect(canCancel('confirmed')).toBe(true);
    expect(canCancel('completed')).toBe(false);
    expect(canComplete('confirmed')).toBe(true);
    expect(canComplete('proposed')).toBe(false);
  });
});

describe('labels', () => {
  it('gives a status label for every state', () => {
    expect(statusLabel('proposed')).toMatch(/proposed/i);
    expect(statusLabel('completed')).toMatch(/handed off/i);
  });
  it('summarizes place-only and place+time', () => {
    expect(meetSummary(null, 'Library')).toBe('At Library');
    expect(meetSummary(null, null)).toMatch(/to be decided/);
    expect(meetSummary('2026-07-14T18:00:00.000Z', 'Coffee shop')).toContain('Coffee shop');
  });
});
