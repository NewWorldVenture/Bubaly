import { describe, expect, it } from 'vitest';

import { validatePublicCalendarUrl } from '@/lib/server/public-calendar-fetch';

/**
 * A URL a family supplies (a calendar feed, an RSS feed) never reaches an
 * internal address — however that address is spelled.
 *
 * The guard resolves every address a hostname maps to and refuses private,
 * loopback, link-local, CGNAT, multicast and documentation ranges; it unwraps
 * IPv4-mapped (`::ffff:`) and IPv4-compatible (`::`) IPv6 so an embedded
 * 127.0.0.1 is still 127.0.0.1. Fuzzed against the usual literal encodings —
 * decimal, hex, octal, short form — it refused all of them.
 *
 * It did not unwrap NAT64. `64:ff9b::/96` (RFC 6052) carries an IPv4 address in
 * its low 32 bits and, on a NAT64 network, routes to it: `64:ff9b::7f00:1` is
 * 127.0.0.1 and `64:ff9b::a9fe:a9fe` is the cloud metadata endpoint. A hostname
 * resolving to either passed. The fix unwraps the well-known prefix exactly
 * like the `::ffff:` form, so NAT64 to a PUBLIC host still works, and refuses
 * the local-use range (RFC 8215) outright.
 *
 * Practical reach on the current host is low — serverless functions rarely sit
 * on a NAT64 network — but the guard's job is to hold wherever it runs, and the
 * `::ffff:` handling shows the embedding class was meant to be covered.
 */

const resolvesTo = (address: string) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];
const FEED = 'https://feed.example.com/cal.ics';

const INTERNAL = [
  '127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1',
  '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1',
  // NAT64 — the gap.
  '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::a00:1', '64:ff9b:1::1',
];

describe('a resolved internal address is refused', () => {
  for (const address of INTERNAL) {
    it(`refuses a hostname resolving to ${address}`, async () => {
      expect(await validatePublicCalendarUrl(FEED, resolvesTo(address))).toBeNull();
    });
  }
});

describe('an internal IP written into the URL is refused', () => {
  for (const url of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/',
    'http://127.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://169.254.169.254/']) {
    it(`refuses ${url}`, async () => {
      expect(await validatePublicCalendarUrl(url, resolvesTo('93.184.216.34'))).toBeNull();
    });
  }
});

describe('public destinations still work', () => {
  it('allows a public IPv4 address', async () => {
    expect(await validatePublicCalendarUrl(FEED, resolvesTo('93.184.216.34'))).toBeTruthy();
  });
  it('allows NAT64 to a public host — the unwrap must not over-block', async () => {
    expect(await validatePublicCalendarUrl(FEED, resolvesTo('64:ff9b::5db8:d822'))).toBeTruthy();
  });
});
