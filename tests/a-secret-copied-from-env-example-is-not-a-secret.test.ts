import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredSecret, PUBLISHED_SECRET_PLACEHOLDERS } from '@/lib/server/configured-secret';
import { checkFeatureEnv, checkRequiredEnv } from '@/lib/health/status';

/**
 * A SECRET COPIED FROM .env.example IS NOT A SECRET (SEC-002).
 *
 * The behaviour is pinned in a-secret-copied-from-env-example-authenticates-
 * nothing.test.ts. This file pins the list itself: every non-empty value
 * `.env.example` gives a secret must be one `configuredSecret` refuses, so a
 * new example value cannot quietly become a working credential.
 */
const ROOT = join(__dirname, '..');
const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
const assignments = [...example.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map(([, name, value]) => ({ name, value: value.trim() }));
const SECRET_NAME = /SECRET|SERVICE_ROLE_KEY/;

describe('configuredSecret', () => {
  it('answers null for unset, blank and published values', () => {
    for (const value of [undefined, null, '', '   ', ...PUBLISHED_SECRET_PLACEHOLDERS, ' generate_a_random_string ']) {
      expect(configuredSecret(value as string | null | undefined), String(value)).toBeNull();
    }
  });

  it('passes a real value through unchanged', () => {
    expect(configuredSecret('0f6c2e…a-real-value')).toBe('0f6c2e…a-real-value');
    expect(configuredSecret('whsec_c2VjcmV0LWZvci10aGlzLXRlc3Q=')).toBe('whsec_c2VjcmV0LWZvci10aGlzLXRlc3Q=');
  });

  it('refuses every non-empty secret value .env.example ships', () => {
    const shipped = assignments.filter((a) => SECRET_NAME.test(a.name) && a.value !== '');
    expect(shipped.length, 'the example file should still ship some placeholders').toBeGreaterThan(0);
    for (const { name, value } of shipped) {
      expect(configuredSecret(value), `${name}=${value} would be accepted as a real secret`).toBeNull();
    }
  });
});

describe('/api/health reports a placeholder as missing', () => {
  it('a feature secret left as its example value is listed as missing', () => {
    const check = checkFeatureEnv({ INTERNAL_SECRET: 'generate_a_random_string', RESEND_WEBHOOK_SECRET: 'whsec_your_resend_webhook_secret' });
    expect(check.missing).toEqual(expect.arrayContaining(['INTERNAL_SECRET', 'RESEND_WEBHOOK_SECRET']));
  });

  it('a required credential left as its example value is listed as missing', () => {
    const check = checkRequiredEnv({
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key-for-this-test',
      SUPABASE_SERVICE_ROLE_KEY: 'your-service-role-secret-key',
    });
    expect(check.missing).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });
});
