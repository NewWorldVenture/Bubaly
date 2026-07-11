import { describe, it, expect } from 'vitest';
import { isDemoFamily, formatMMSS, remainingSeconds, DEMO_SESSION_SECONDS, PRIMARY_DEMO_FAMILY_ID } from '@/lib/constants/demo';

describe('isDemoFamily', () => {
  it('matches the demo family ids and nothing else', () => {
    expect(isDemoFamily(PRIMARY_DEMO_FAMILY_ID)).toBe(true);
    expect(isDemoFamily('55555555-5555-5555-5555-555555555555')).toBe(true);
    expect(isDemoFamily('92298eb2-1a9e-4bdc-9361-677b6c01b499')).toBe(false);
    expect(isDemoFamily(null)).toBe(false);
    expect(isDemoFamily(undefined)).toBe(false);
    expect(isDemoFamily('')).toBe(false);
  });
});

describe('formatMMSS', () => {
  it('zero-pads minutes and seconds', () => {
    expect(formatMMSS(300)).toEqual({ mm: '05', ss: '00' });
    expect(formatMMSS(299)).toEqual({ mm: '04', ss: '59' });
    expect(formatMMSS(9)).toEqual({ mm: '00', ss: '09' });
    expect(formatMMSS(0)).toEqual({ mm: '00', ss: '00' });
  });
  it('clamps negatives to 00:00', () => {
    expect(formatMMSS(-5)).toEqual({ mm: '00', ss: '00' });
  });
});

describe('remainingSeconds', () => {
  it('counts down from the session length and never goes negative', () => {
    const start = 1_000_000;
    expect(remainingSeconds(start, start)).toBe(DEMO_SESSION_SECONDS);       // just started
    expect(remainingSeconds(start, start + 60_000)).toBe(DEMO_SESSION_SECONDS - 60); // 1 min in
    expect(remainingSeconds(start, start + 999_000)).toBe(0);                // long past → 0
  });
});
