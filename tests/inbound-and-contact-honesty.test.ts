import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at } from './helpers/source-order';

const inbound = readFileSync('app/api/contact-center/email/route.ts', 'utf8');
const contact = readFileSync('app/api/contact/route.ts', 'utf8');

describe('the inbound-email secret is compared in constant time (C3-S5-08)', () => {
  it('uses timingSafeEqual, not ===', () => {
    expect(inbound).toContain('timingSafeEqual(a, b)');
    // `===` on a secret leaks its prefix through response timing.
    expect(inbound).not.toContain('provided === secret');
  });

  it('length is checked first, because timingSafeEqual throws on a mismatch', () => {
    expect(at(inbound, 'a.length === b.length')).toBeLessThan(at(inbound, 'timingSafeEqual(a, b)'));
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
