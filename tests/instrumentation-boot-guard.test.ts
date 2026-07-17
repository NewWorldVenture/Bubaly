import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest';

// The boot env guard lives in instrumentation.ts register(). It must:
//  - log ONE clear line naming the missing vars when any required var is absent,
//  - stay silent when all are present,
//  - never throw (a boot hook that throws would take down the deploy),
//  - no-op outside the Node runtime.

const REQUIRED = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
];

describe('instrumentation boot env guard', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of [...REQUIRED, 'NEXT_RUNTIME']) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of [...REQUIRED, 'NEXT_RUNTIME']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  async function runRegister() {
    const mod = await import('../instrumentation');
    return mod.register();
  }

  it('logs a single greppable line naming the missing vars', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => runRegister()).not.toThrow();
    await runRegister();
    expect(err).toHaveBeenCalled();
    expect(err.mock.calls[0][0]).toContain('[boot] MISSING REQUIRED ENV');
    expect(err.mock.calls[0][0]).toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('stays silent when every required var is present', async () => {
    process.env.NEXT_RUNTIME = 'nodejs';
    for (const k of REQUIRED) process.env[k] = 'set';
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runRegister();
    expect(err).not.toHaveBeenCalled();
  });

  it('no-ops in a non-node runtime (edge) even with missing vars', async () => {
    process.env.NEXT_RUNTIME = 'edge';
    for (const k of REQUIRED) delete process.env[k];
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runRegister();
    expect(err).not.toHaveBeenCalled();
  });
});
