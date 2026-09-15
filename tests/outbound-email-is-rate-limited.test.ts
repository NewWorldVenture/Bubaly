import { at } from './helpers/source-order';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// An endpoint that sends mail to an address the CALLER chose is an amplifier:
// one request becomes one message from Bubaly's own sender to somebody who did
// not ask this caller for it. `/api/email/invite` was exactly that and had no
// bound at all — the invite row is inserted straight from the browser
// (components/family/invite-form.tsx) with a free-text email, and the route
// re-sends on every call with no dedupe and no count. A family manager could
// turn one invite row into unlimited mail to an address of their choosing.
//
// Twenty-nine other routes and actions already carry `enforceRequestRateLimit`
// — billing, sync, gift, contact, forms, push, blog subscribe — and the
// referral path, which mails a caller-chosen address for the same reason, has a
// dedicated per-family policy of its own. This one had neither.
//
// So the rule is swept rather than listed: any route that sends mail must
// either bound how often it can be asked to, or be reachable only by our own
// server (the internal secret), which is how /api/email/welcome is safe
// without a limit — its recipient comes from the onboarding action, not from a
// client.
function routeFilesUnder(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...routeFilesUnder(`${dir}/${e.name}`));
    else if (e.name === 'route.ts') out.push(`${dir}/${e.name}`);
  }
  return out;
}

const SENDS_MAIL = /\bsendReactEmail\(|\bsendEmail\(/;
const BOUNDED = /enforceRequestRateLimit\(|rateLimitDb\(|evaluateReferralEmailThrottle\(/;
const SERVER_ONLY = /hasInternalSecret\(|hasCronAuthorization\(|CONTACT_CENTER_INBOUND_SECRET|validateTwilioSignature/;

const mailRoutes = routeFilesUnder('app/api').filter((f) => SENDS_MAIL.test(readFileSync(f, 'utf8')));

describe('an endpoint that mails a caller-chosen address is bounded', () => {
  it('finds the mail-sending routes at all (guards the guard)', () => {
    expect(mailRoutes.length).toBeGreaterThan(0);
    expect(mailRoutes).toContain('app/api/email/invite/route.ts');
  });

  it('every mail-sending route is rate limited or server-only', () => {
    const offenders = mailRoutes.filter((f) => {
      const src = readFileSync(f, 'utf8');
      return !BOUNDED.test(src) && !SERVER_ONLY.test(src);
    });
    expect(
      offenders,
      `these send mail with no bound and no server-only gate, so one caller can amplify: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('the invite route answers 429 with Retry-After rather than sending', () => {
    const src = readFileSync('app/api/email/invite/route.ts', 'utf8');
    // The limit has to come BEFORE the send, or it bounds nothing.
    expect(at(src, 'enforceRequestRateLimit(')).toBeLessThan(at(src, 'sendReactEmail('));
    expect(src).toContain("status: 429");
    expect(src).toMatch(/'Retry-After': String\(limited\.retryAfter\)/);
  });

  it('the invite limit is keyed per family, not per request', () => {
    // Keying on something the caller varies freely (the invite id, the
    // recipient) would let one family mail a different address every time and
    // never hit the bound. The household's total outbound is the thing to cap.
    const src = readFileSync('app/api/email/invite/route.ts', 'utf8');
    expect(src).toMatch(/`email:invite:\$\{ctx\.active\.familyId\}`/);
  });
});
