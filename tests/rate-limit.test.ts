import { describe, expect, it } from 'vitest';
import { clientIp, rateLimit } from '@/lib/server/rate-limit';

describe('local rate-limit boundary', () => {
  it('accepts normalized IPv4 and IPv6 proxy values', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': ' 203.0.113.10, 10.0.0.1' }))).toBe('203.0.113.10');
    expect(clientIp(new Headers({ 'x-forwarded-for': '2001:db8::10' }))).toBe('2001:db8::10');
  });

  it('rejects malformed or oversized proxy values instead of using them as keys', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': 'not-an-ip', 'x-real-ip': 'also-invalid' }))).toBe('unknown');
    expect(clientIp(new Headers({ 'x-forwarded-for': '1'.repeat(65) }))).toBe('unknown');
  });

  it('normalizes invalid limiter parameters and enforces the bounded key bucket', () => {
    const key = `parameter-normalization-${Date.now()}-${Math.random()}`;
    expect(rateLimit(key, { limit: Number.NaN, windowMs: Number.NaN })).toEqual({
      ok: true,
      remaining: 9,
      retryAfter: 0,
    });
    expect(rateLimit(key, { limit: 1 })).toMatchObject({ ok: false, remaining: 0 });
  });
});
