import { describe, expect, it } from 'vitest';
import { clientIp, rateLimit } from '@/lib/server/rate-limit';

/**
 * A per-client limit counts a client, not an address it picked. (SEC-020)
 *
 * `clientIp` returned the forwarded address as written, and every per-client
 * limit in the app — child PIN sign-in, the contact form, the AI gift finder,
 * form and survey submissions, 23 keys in all — was keyed on it. An IPv6
 * subscriber is routinely assigned a whole /64 and can source from any address
 * in it, so each limit was unbounded for anyone on IPv6. Measured through the
 * real `rateLimit` at a limit of 5, before the fix:
 *
 *   one /64, 50 host addresses        50/50 allowed, 50 subjects
 *   one address, 4 spellings × 12     20/48 allowed,  4 subjects
 *   IPv4 and its IPv4-mapped form     10/50 allowed,  2 subjects
 *
 * Each case below drives the same measurement and must land on one subject.
 */

const LIMIT = 5;
const subjectOf = (address: string) => clientIp(new Headers({ 'x-forwarded-for': address }));
function allowed(label: string, addresses: string[]): { allowed: number; subjects: number } {
  const key = `${label}-${Date.now()}-${Math.random()}`;
  const subjects = new Set<string>();
  let count = 0;
  for (const address of addresses) {
    const subject = subjectOf(address);
    subjects.add(subject);
    if (rateLimit(`${key}:${subject}`, { limit: LIMIT }).ok) count += 1;
  }
  return { allowed: count, subjects: subjects.size };
}

describe('the control: one address is one subject, as before', () => {
  it('holds one IPv4 address to the limit', () => {
    expect(allowed('v4', Array(50).fill('203.0.113.7'))).toEqual({ allowed: LIMIT, subjects: 1 });
  });

  it('holds one IPv6 address to the limit', () => {
    expect(allowed('v6', Array(50).fill('2001:db8:1:2::7'))).toEqual({ allowed: LIMIT, subjects: 1 });
  });

  it('keeps different networks apart', () => {
    expect(subjectOf('2001:db8:1:2::1')).not.toBe(subjectOf('2001:db8:1:3::1'));
    expect(subjectOf('203.0.113.7')).not.toBe(subjectOf('203.0.113.8'));
  });
});

describe('an address a client can choose is not a new subject', () => {
  it('counts fifty hosts in one /64 as one client', () => {
    const hosts = Array.from({ length: 50 }, (_, i) => `2001:db8:1:2::${(i + 1).toString(16)}`);
    expect(allowed('slash64', hosts)).toEqual({ allowed: LIMIT, subjects: 1 });
  });

  it('counts every spelling of one address as one client', () => {
    const spellings = ['2001:db8:1:2::7', '2001:DB8:1:2::7', '2001:0db8:0001:0002:0000:0000:0000:0007', '2001:db8:1:2:0:0:0:7'];
    expect(allowed('spellings', Array.from({ length: 48 }, (_, i) => spellings[i % 4]))).toEqual({ allowed: LIMIT, subjects: 1 });
  });

  it('counts an IPv4 client and its IPv4-mapped IPv6 form as one client', () => {
    const forms = ['198.51.100.9', '::ffff:198.51.100.9', '::FFFF:C633:6409'];
    expect(allowed('mapped', Array.from({ length: 48 }, (_, i) => forms[i % 3]))).toEqual({ allowed: LIMIT, subjects: 1 });
  });

  it('ignores a zone index, including after an IPv4-mapped address', () => {
    expect(subjectOf('fe80::1%eth0')).toBe(subjectOf('fe80::2'));
    expect(subjectOf('::ffff:198.51.100.9%eth0')).toBe('198.51.100.9');
  });
});
