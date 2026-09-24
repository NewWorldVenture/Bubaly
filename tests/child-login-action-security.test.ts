import { readFileSync } from 'node:fs';
import { expectTranslates } from './helpers/translated';
import { describe, expect, it } from 'vitest';

describe('public child sign-in boundary', () => {
  it('uses an IP-wide durable guard and fails closed on throttle/lookup errors', () => {
    const source = readFileSync('app/(auth)/actions.ts', 'utf8');

    expect(source).toContain("from '@/lib/server/request-rate-limit'");
    expect(source).toContain('await enforceRequestRateLimit(');
    expect(source).toContain("child-login:${clientIp(await headers())}");
    expect(source).toContain("const payload = (input && typeof input === 'object' ? input : {})");
    // The throttle read moved into the reservation (SEC-019); a read error there
    // is 'unavailable', and the action refuses anything but a taken attempt.
    const store = readFileSync('lib/auth/child-throttle-store.ts', 'utf8');
    expect(store).toContain("if (readError) return { ok: false, reason: 'unavailable', error: readError };");
    expect(source).toContain('if (!reservation.ok) {');
    expect(source).toContain('error: loginLookupError');
    expectTranslates(source, 'actions.kidSignInIsTemporarily', "Kid sign-in is temporarily unavailable. Try again shortly.");
  });
});
