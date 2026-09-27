import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MarketingAuthError, isMarketingAuthError, marketingRefusalBody } from '@/lib/marketing/admin';
import { describeActionError } from '@/lib/supabase/errors';

// A permissions refusal must not be reported as a server fault.
//
// `requireMarketingAdmin` throws to refuse, and the status it deserved lived in
// the English of the message. Two routes recovered it by reading that English
// back — `message.includes('sign in') || message.includes('permission')` — and
// the AI route matched on `'Forbidden'`, a word the guard has never said. So a
// non-admin calling the marketing AI route was told
//
//   500  "Could not generate. Check that the OpenAI API key is set."
//
// No access was granted either way; the cost is operational. A permissions
// problem and a provider outage were the same line in the logs and the same
// status on the wire, and they point whoever is on call at different
// subsystems. The one that is nobody's fault was the one that paged.
//
// The status is data on the error now, so rewording the sentence can no longer
// change the status code — which is exactly what had gone wrong.

describe('MarketingAuthError', () => {
  it('carries the status rather than implying it in prose', () => {
    expect(new MarketingAuthError(401, 'Please sign in to continue.').status).toBe(401);
    expect(new MarketingAuthError(403, 'You do not have permission.').status).toBe(403);
  });

  // Duck-typed, not `instanceof`: a route handler and lib/marketing/admin.ts can
  // land in different bundles, where `instanceof` compares two distinct classes
  // and quietly answers false — reinstating the defect this replaced.
  it('recognises a refusal without instanceof', () => {
    expect(isMarketingAuthError(new MarketingAuthError(403, 'no'))).toBe(true);
    expect(isMarketingAuthError({ name: 'MarketingAuthError', status: 401, message: 'no' })).toBe(true);
    expect(isMarketingAuthError(new Error('You do not have permission to manage marketing settings.'))).toBe(false);
    expect(isMarketingAuthError({ name: 'MarketingAuthError' })).toBe(false);
    expect(isMarketingAuthError({ status: 403 })).toBe(false);
    expect(isMarketingAuthError(null)).toBe(false);
    expect(isMarketingAuthError('Forbidden')).toBe(false);
  });
});

describe('the marketing guard refuses with a status, not a sentence', () => {
  it('throws a typed refusal from both branches', () => {
    const source = readFileSync(`${process.cwd()}/lib/marketing/admin.ts`, 'utf8');
    // Both refusals, and nothing left throwing a bare Error for an authz
    // outcome — that bare Error is what the routes had to guess about.
    expect(source).toContain("throw new MarketingAuthError(401, 'Please sign in to continue.')");
    expect(source).toContain("throw new MarketingAuthError(403, 'You do not have permission to manage marketing settings.')");
  });
});

describe('no route decides an authorization outcome by reading English', () => {
  const ROUTES = [
    'app/api/admin/marketing/ai/route.ts',
    'app/api/admin/marketing/email/send/route.ts',
  ];

  it('matches on the typed error instead of the message text', () => {
    for (const route of ROUTES) {
      const source = readFileSync(`${process.cwd()}/${route}`, 'utf8');
      expect(source, `${route} does not consult the typed refusal`).toContain('isMarketingAuthError(');
      expect(source, `${route} does not use the shared refusal body`).toContain('marketingRefusalBody(');
      // The three phrases the routes used to reconstruct the status from.
      for (const phrase of ["includes('sign in')", "includes('permission')", "includes('Forbidden')"]) {
        expect(source, `${route} still reads ${phrase} to decide a status`).not.toContain(phrase);
      }
    }
  });

  it('answers a refusal with the status the guard chose', () => {
    // The end-to-end property, without a route harness: the errors
    // `requireMarketingAdmin` actually throws are the errors the routes
    // actually check for, and they carry 401 and 403 rather than 500.
    //
    // This replaces a positional assertion — `indexOf('isMarketingAuthError(')
    // < indexOf('status: 500')` — that was dropped for being fragile rather
    // than load-bearing. Reordering the catch so the refusal is checked with
    // `if (!isMarketingAuthError(err)) return 500` is still CORRECT, and the
    // positional test passed it; but it would equally have passed some
    // genuinely broken orderings, because source position is not reachability.
    // Asserting the decision itself does not have that problem.
    const thrown = [
      new MarketingAuthError(401, 'Please sign in to continue.'),
      new MarketingAuthError(403, 'You do not have permission to manage marketing settings.'),
    ];
    for (const err of thrown) {
      expect(isMarketingAuthError(err)).toBe(true);
      const status = isMarketingAuthError(err) ? err.status : 500;
      expect(status, 'a refusal was reported as a server fault').not.toBe(500);
      expect([401, 403]).toContain(status);
    }
    // …and a genuine fault still is one.
    const outage = new Error('OpenAI request failed');
    expect(isMarketingAuthError(outage)).toBe(false);
    expect(isMarketingAuthError(outage) ? 0 : 500).toBe(500);
  });

  // Pinned because the first attempt at this got it wrong, and silently.
  //
  // The AI route was written to answer with `describeActionError(err)`, on the
  // reasoning that a MarketingAuthError carries no Postgres code so the message
  // would come through untouched. It does not. `describeDbError` matches
  // `'permission denied'`, and the refusal says "do not have permission to
  // manage" — no branch classifies it, so `describeActionError` sees the
  // described string equal the raw one, calls it unclassified, and returns
  // "Something went wrong. Please try again."
  //
  // Which is a refusal reported as a generic fault: the exact defect this whole
  // change exists to remove, arriving by a different road. The status would
  // have been right and the sentence useless, and no test would have said so.
  it('says something true, rather than something generic', () => {
    const signIn = new MarketingAuthError(401, 'Please sign in to continue.');
    const forbidden = new MarketingAuthError(403, 'You do not have permission to manage marketing settings.');

    expect(marketingRefusalBody(signIn)).toBe('Please sign in to continue.');
    expect(marketingRefusalBody(forbidden)).toBe('Forbidden');
    for (const body of [marketingRefusalBody(signIn), marketingRefusalBody(forbidden)]) {
      expect(body).not.toMatch(/something went wrong/i);
      expect(body).not.toMatch(/OpenAI|API key/i);
    }

    // The trap itself, asserted so it cannot be walked into again.
    expect(describeActionError(forbidden)).toMatch(/something went wrong/i);
  });
});
