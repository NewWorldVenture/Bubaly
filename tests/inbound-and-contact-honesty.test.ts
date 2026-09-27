import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

const inbound = readFileSync('app/api/contact-center/email/route.ts', 'utf8');
const contact = readFileSync('app/api/contact/route.ts', 'utf8');

describe('the inbound-email secret is compared in constant time (C3-S5-08)', () => {
  // Since the merge with PR #548 this goes through the shared
  // lib/server/secret-equals helper rather than a local timingSafeEqual: one
  // comparison for every shared secret the server checks.
  it('uses the constant-time helper, not ===', () => {
    expect(inbound).toContain('secretEquals(provided, secret)');
    // `===` on a secret leaks its prefix through response timing.
    expect(inbound).not.toContain('provided === secret');
  });

  it('leaks no length either: both sides are compared as fixed-size digests', () => {
    // timingSafeEqual throws on a length mismatch, so a raw comparison needs a
    // length check first — which leaks the length. HMAC digests are always 32
    // bytes, so the helper never branches on the secret's length.
    const helper = readFileSync('lib/server/secret-equals.ts', 'utf8');
    expect(helper).toContain("createHmac('sha256'");
    expect(helper).toContain('timingSafeEqual(');
  });

  it('says so when the secret arrives in a URL, where every log keeps it', () => {
    // The query-string form is kept on purpose — the provider's webhook is
    // configured outside this repository — so the warning is the fix that can
    // be shipped without breaking inbound mail.
    expect(inbound).toContain('arrived in the query string');
  });
});

describe('the contact form does not claim to have sent nothing (C3-S5-05)', () => {
  it('reads the ticket insert error instead of assuming it worked', () => {
    // A PostgREST call resolves with { error }; the surrounding catch cannot
    // see a refused insert.
    expect(contact).toContain('const { error: ticketError }');
    expect(contact).toContain('ticketFiled = true');
  });

  it('refuses when there is no mail provider AND no ticket', () => {
    expect(contact).toContain('result.skipped && !ticketFiled');
    expect(at(contact, 'result.skipped && !ticketFiled')).toBeLessThan(at(contact, 'return NextResponse.json({ ok: true });'));
  });

  it('still answers ok when the ticket landed, because a human will find it', () => {
    // sendEmail reports a missing provider as ok+skipped. That is honest only
    // while the message is recorded somewhere.
    expect(contact).not.toContain('if (result.skipped) return');
  });
});
