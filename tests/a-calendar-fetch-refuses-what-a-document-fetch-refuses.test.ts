import { describe, expect, it } from 'vitest';

import { validatePublicCalendarUrl } from '@/lib/server/public-calendar-fetch';
import { isPublicDocumentAddress } from '@/lib/server/public-document-fetch';

/**
 * The calendar/feed/link-preview fetch refuses every address the document fetch
 * refuses (SEC-002).
 *
 * The app had two SSRF address policies. The document fetcher (also used by the
 * push endpoint, the Alexa certificate check and the media proxy) allows only
 * ordinary global unicast and blocks the transition and special-purpose ranges.
 * The calendar fetcher kept its own range list, which had drifted: a hostname
 * resolving to 6to4 wrapping the metadata address, Teredo, SIIT, site-local,
 * the discard prefix, the 6to4 relay anycast or the Azure platform endpoint
 * passed it. Those are reached from user-supplied URLs: calendar sync, feed
 * sync, weekend discovery and social link previews.
 *
 * The calendar fetcher still unwraps an IPv4 address carried in IPv6 (mapped,
 * compatible, NAT64 RFC 6052) and checks it as that IPv4 address, so a NAT64
 * route to a PUBLIC host keeps working — but every address is now judged by the
 * one shared policy.
 */

const resolvesTo = (address: string) => async () => [{ address, family: address.includes(':') ? 6 : 4 }];
const FEED = 'https://feed.example.com/cal.ics';

const DRIFTED = [
  '2002:a9fe:a9fe::1', // 6to4 wrapping 169.254.169.254
  '2002:7f00:1::1', // 6to4 wrapping 127.0.0.1
  '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
  '2001:2::1', // IETF protocol assignments (benchmarking)
  'fec0::1', // deprecated site-local
  '::ffff:0:a9fe:a9fe', // SIIT, 169.254.169.254
  '100::1', // discard prefix
  '3fff::1', // documentation (RFC 9637)
  '192.88.99.1', // 6to4 relay anycast
  '168.63.129.16', // Azure platform endpoint
];

describe('addresses the calendar fetch used to let through', () => {
  for (const address of DRIFTED) {
    it(`refuses a hostname resolving to ${address}`, async () => {
      expect(isPublicDocumentAddress(address)).toBe(false);
      expect(await validatePublicCalendarUrl(FEED, resolvesTo(address))).toBeNull();
    });
    if (!address.includes(':')) {
      it(`refuses ${address} written into the URL`, async () => {
        expect(await validatePublicCalendarUrl(`https://${address}/cal.ics`, resolvesTo('93.184.216.34'))).toBeNull();
      });
    }
  }
});

describe('a refused embedded IPv4 is refused however it is carried', () => {
  for (const address of ['::ffff:192.88.99.1', '::ffff:168.63.129.16', '64:ff9b::c058:6301', '64:ff9b::a83f:8110']) {
    it(`refuses ${address}`, async () => {
      expect(await validatePublicCalendarUrl(FEED, resolvesTo(address))).toBeNull();
    });
  }
});

describe('public destinations still work', () => {
  for (const address of ['93.184.216.34', '2606:4700:4700::1111', '::ffff:93.184.216.34', '64:ff9b::5db8:d822']) {
    it(`allows ${address}`, async () => {
      expect(await validatePublicCalendarUrl(FEED, resolvesTo(address))).toBe(FEED);
    });
  }
});
