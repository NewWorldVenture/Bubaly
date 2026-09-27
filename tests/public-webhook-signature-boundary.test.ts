import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The middleware PUBLIC allowlist lets `/api/guardian/**` through WITHOUT a session
// (see middleware.ts) because these are inbound Twilio telephony webhooks — the
// caller is Twilio, not a logged-in user. That makes the Twilio SIGNATURE the only
// authorization boundary: an unguarded inbound route would let anyone POST forged
// voice/SMS/WhatsApp events (screening bypass, spoofed escalations, cost abuse).
// This guard asserts every guardian route that ingests a provider request verifies
// the signature (or, for the internal escalate trigger, uses the shared secret),
// enumerated from disk so a newly-added inbound route is covered automatically.

function routeFilesUnder(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...routeFilesUnder(`${dir}/${e.name}`));
    else if (e.name === 'route.ts') out.push(`${dir}/${e.name}`);
  }
  return out;
}

const guardianRoutes = routeFilesUnder('app/api/guardian');

// Inbound provider webhooks: the caller is Twilio, so the signature is the gate.
const TWILIO_INBOUND = /(inbound|screen|status|twiml)/;

// The Contact Center's Twilio webhooks are the same boundary reached by a
// different door, and F-E07 was open on both sets at once. Listing them here
// rather than only under app/api/guardian is what makes this guard cover the
// whole surface instead of two thirds of it.
const CONTACT_CENTER_TWILIO = [
  'app/api/contact-center/voice/route.ts',
  'app/api/contact-center/voice/transcription/route.ts',
  'app/api/contact-center/sms/route.ts',
  'app/api/contact-center/sms/status/route.ts',
].filter((f) => existsSync(f));

const TWILIO_FACING = [...guardianRoutes.filter((f) => TWILIO_INBOUND.test(f)), ...CONTACT_CENTER_TWILIO];

describe('guardian public webhook signature boundary', () => {
  it('finds the guardian routes on disk (glob is not silently empty)', () => {
    expect(guardianRoutes.length).toBeGreaterThanOrEqual(6);
  });

  it('every provider-facing guardian route verifies the Twilio signature and rejects', () => {
    const offenders: string[] = [];
    for (const file of TWILIO_FACING) {
      const src = readFileSync(file, 'utf8');
      // Either the shared gate, or a direct call that is itself unconditional —
      // the two Contact Center SMS routes validate the configured origin
      // strictly and refuse 503 on a bad one, which is a different and equally
      // unconditional shape. What the next case enforces is that neither form
      // is skippable.
      const verifies = src.includes('verifyTwilioRequest(') || src.includes('validateTwilioSignature(');
      // `twilioRefusal(verdict)` IS the rejection — it carries the 401/503
      // that the routes used to spell out eight times over.
      const rejects = /401|403|twilioRefusal\(|verdict\.status/.test(src);
      if (!verifies || !rejects) offenders.push(file);
    }
    expect(offenders, `Twilio-facing routes missing signature verification/reject: ${offenders.join(', ')}`).toEqual([]);
  });

  // ── the assertion above used to be satisfiable by a check that never ran ──
  //
  // Every one of these routes contained `validateTwilioSignature` and a 401, so
  // the presence test passed — while six of them wrapped both in
  // `if (process.env.NODE_ENV === 'production')`. The rule was right and the
  // search could not reach the violation, which is why F-E07 sat open through
  // a guard that was green the whole time. Presence is not reachability, so
  // this asserts the shape that makes it unconditional: the gate is reached
  // with nothing between it and the handler's entry that could skip it.
  it('no Twilio-facing route makes its signature check conditional on the build', () => {
    const offenders: string[] = [];
    for (const file of TWILIO_FACING) {
      const src = readFileSync(file, 'utf8');
      // Comment bodies blanked (newlines kept) so a NODE_ENV named in prose —
      // as lib/server/twilio-ingress.ts explains at length — is not a gate.
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, ' '));
      if (/NODE_ENV/.test(code)) offenders.push(file);
    }
    expect(offenders, `signature verification gated on NODE_ENV (it must run in every environment):\n${offenders.join('\n')}`).toEqual([]);
  });

  it('the shared gate refuses rather than skips when it cannot verify', () => {
    const src = readFileSync('lib/server/twilio-ingress.ts', 'utf8');
    // An unset token must not mean "come in" — that is the SEC-009 shape, a
    // signature check that passes because there is nothing to check against.
    expect(src).toMatch(/status:\s*503,\s*reason:\s*'not_configured'/);
    // The single bypass is explicit, named and greppable — never a build mode.
    expect(src).toContain("process.env.ALLOW_UNSIGNED_TWILIO_WEBHOOKS === '1'");
    expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')).not.toMatch(/NODE_ENV/);
    // …and it is set in exactly one place: the test config.
    expect(readFileSync('vitest.config.ts', 'utf8')).toContain('ALLOW_UNSIGNED_TWILIO_WEBHOOKS');
  });

  it('the internal escalate trigger is secret-gated AND fail-closed, not open', () => {
    // escalate can blast SMS + outbound calls to every parent, so it must reject
    // when the secret is unset. It legitimately inlines a GUARDIAN_INTERNAL_SECRET
    // (|| CRON_SECRET) check rather than the shared helper — what matters is the
    // fail-closed shape: an unset secret -> 401, never an open endpoint.
    const escalate = 'app/api/guardian/escalate/route.ts';
    if (!existsSync(escalate)) return;
    const src = readFileSync(escalate, 'utf8');
    expect(src).toMatch(/GUARDIAN_INTERNAL_SECRET|hasCronAuthorization|hasInternalSecret|CRON_SECRET/);
    // `bearerMatches` returns false for an absent secret before it ever builds
    // the `Bearer ` string, which is the same fail-closed shape done properly
    // (SEC-011) — and is asserted by running it, in
    // tests/shared-secrets-compare-in-constant-time.test.ts.
    expect(src, 'escalate must fail closed when the secret is unset').toMatch(/if\s*\(\s*!secret\s*\|\||hasCronAuthorization\(|hasInternalSecret\(|bearerMatches\(/);
    expect(src).toMatch(/401|403/);
  });

  it('the signature verifier itself is fail-closed when the auth token is unset', () => {
    const src = readFileSync('lib/guardian/twilio.ts', 'utf8');
    // Must REJECT (return false) when TWILIO_AUTH_TOKEN is missing — never skip.
    expect(src).toMatch(/if\s*\(\s*!TWILIO_AUTH_TOKEN\s*\)\s*return false/);
    expect(src).toContain('timingSafeEqual');
  });
});
