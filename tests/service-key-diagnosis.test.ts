import { describe, expect, it, vi, afterAll } from 'vitest';
import { credentialHint, SERVICE_ROLE_KEY_HINT } from '../lib/supabase/settle';

vi.mock('@supabase/supabase-js', () => ({ createClient: vi.fn(() => ({})) }));
vi.mock('@supabase/ssr', () => ({ createServerClient: vi.fn(() => ({})) }));
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [], set: () => {} }) }));

// Shapes with filler payloads — never real credentials.
const SECRET = 'sb_secret_' + 'x'.repeat(32);
const PUBLISHABLE = 'sb_publishable_' + 'x'.repeat(32);
const LEGACY_JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig';

// This file writes process.env, and the suite reuses workers — anything left
// behind is read by whatever runs next.
const KEYS = ['SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;
const ORIGINAL = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
  vi.resetModules();
});

async function describeWith(service: string | undefined, anon: string) {
  vi.resetModules();
  if (service === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = service;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anon;
  const { describeConfiguredServiceKey } = await import('../lib/supabase/server');
  return describeConfiguredServiceKey();
}

describe('describeConfiguredServiceKey', () => {
  it('does not infer legacy-key revocation from a publishable key', async () => {
    const note = await describeWith(LEGACY_JWT, PUBLISHABLE);
    expect(note).toContain('legacy JWT');
    expect(note).toContain('can coexist');
    expect(note).toContain('still enabled');
    expect(note).not.toContain('no longer registered');
    expect(note).toBe(await describeWith(LEGACY_JWT, LEGACY_JWT));
  });

  it('catches the publishable key pasted into the secret slot', async () => {
    expect(await describeWith(PUBLISHABLE, PUBLISHABLE)).toContain('that is the public key');
  });

  it('says a right-shaped key is from another project or revoked', async () => {
    const note = await describeWith(SECRET, PUBLISHABLE);
    expect(note).toContain('right shape');
    expect(note).toContain('different project');
  });

  it('reports an empty value distinctly from a wrong one', async () => {
    expect(await describeWith('   ', PUBLISHABLE)).toContain('empty');
    expect(await describeWith(undefined, PUBLISHABLE)).toContain('empty');
  });

  it('does not claim a scheme migration on a legacy-key project', async () => {
    const note = await describeWith(LEGACY_JWT, LEGACY_JWT);
    expect(note).toContain('legacy JWT');
    expect(note).not.toContain('sb_secret_');
  });

  it('handles an unrecognised placeholder — .env.example ships one', async () => {
    expect(await describeWith('your-service-role-secret-key', PUBLISHABLE)).toContain('no known Supabase key format');
  });

  // The whole point of returning a description rather than the value.
  it('never returns any part of the key itself', async () => {
    for (const key of [SECRET, PUBLISHABLE, LEGACY_JWT]) {
      const note = await describeWith(key, PUBLISHABLE);
      expect(note).not.toContain('xxxx');
      expect(note).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    }
  });
});

describe('credentialHint carries the diagnosis', () => {
  const failures = ['families: Unregistered API key'];

  it('leads with what is configured, then what to do', () => {
    const hint = credentialHint(failures, 'The configured key is a legacy JWT (eyJ…).');
    expect(hint).toContain('legacy JWT');
    expect(hint).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(hint).toContain('Vercel');
  });

  it('falls back to the generic hint without a diagnosis', () => {
    expect(credentialHint(failures)).toBe(SERVICE_ROLE_KEY_HINT);
    expect(credentialHint(failures, null)).toBe(SERVICE_ROLE_KEY_HINT);
  });

  it('stays silent for ordinary read failures even with a diagnosis in hand', () => {
    expect(credentialHint(['tickets: relation does not exist'], 'anything')).toBeUndefined();
  });
});
