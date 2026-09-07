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
    expect(source).toContain('error: throttleReadError');
    expect(source).toContain('error: loginLookupError');
    expectTranslates(source, 'actions.kidSignInIsTemporarily', "Kid sign-in is temporarily unavailable. Try again shortly.");
  });
});
