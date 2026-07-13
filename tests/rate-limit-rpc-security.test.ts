import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/0179_harden_rate_limit_rpc_grants.sql'),
  'utf8',
);

describe('durable rate-limit RPC security contract', () => {
  it('blocks public and anonymous execution while preserving authenticated server calls', () => {
    expect(migration).toContain('revoke execute on function public.rate_limit_hit(text, integer, integer) from public, anon');
    expect(migration).toContain('grant execute on function public.rate_limit_hit(text, integer, integer) to authenticated, service_role');
    expect(migration).toContain("auth.uid()::text");
    expect(migration).toContain("rate limit key must be scoped to the authenticated caller");
    expect(migration).toContain('revoke execute on function public.rate_limit_prune() from public, anon, authenticated');
    expect(migration).toContain('grant execute on function public.rate_limit_prune() to service_role');
  });
});
