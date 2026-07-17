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

describe('guardian public webhook signature boundary', () => {
  it('finds the guardian routes on disk (glob is not silently empty)', () => {
    expect(guardianRoutes.length).toBeGreaterThanOrEqual(6);
  });

  it('every provider-facing guardian route verifies the Twilio signature and rejects', () => {
    const offenders: string[] = [];
    for (const file of guardianRoutes) {
      if (!TWILIO_INBOUND.test(file)) continue;
      const src = readFileSync(file, 'utf8');
      const verifies = src.includes('validateTwilioSignature');
      const rejects = /401|403/.test(src);
      if (!verifies || !rejects) offenders.push(file);
    }
    expect(offenders, `guardian inbound routes missing signature verification/reject: ${offenders.join(', ')}`).toEqual([]);
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
    expect(src, 'escalate must fail closed when the secret is unset').toMatch(/if\s*\(\s*!secret\s*\|\||hasCronAuthorization\(|hasInternalSecret\(/);
    expect(src).toMatch(/401|403/);
  });

  it('the signature verifier itself is fail-closed when the auth token is unset', () => {
    const src = readFileSync('lib/guardian/twilio.ts', 'utf8');
    // Must REJECT (return false) when TWILIO_AUTH_TOKEN is missing — never skip.
    expect(src).toMatch(/if\s*\(\s*!TWILIO_AUTH_TOKEN\s*\)\s*return false/);
    expect(src).toContain('timingSafeEqual');
  });
});
