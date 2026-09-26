import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import type { Database } from '@/lib/database.types';
import { resolveFamilyByEmailLocalResult } from '@/lib/contact-center/server';

const OURS = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
type Row = { family_id: string; email_local: string };

// Installed SDK, intercepted HTTP only. This models SQL LIKE metacharacters;
// it proves the application/wire boundary, not an executed PostgreSQL query.
function matchesLike(value: string, pattern: string): boolean {
  let source = '';
  const literal = (char: string) => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\') source += literal(pattern[++i] ?? '\\');
    else source += char === '%' ? '.*' : char === '_' ? '.' : literal(char);
  }
  return new RegExp(`^${source}$`, 'i').test(value);
}

function fixture(rows: Row[], forced?: { data: unknown; status?: number }) {
  const requests: URL[] = [];
  const client = createClient<Database>('https://synthetic.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input, init) => {
      const url = new URL(String(input)); requests.push(url);
      expect(init?.method ?? 'GET').toBe('GET');
      const filter = url.searchParams.get('email_local') ?? '';
      expect(filter.startsWith('ilike.')).toBe(true);
      const selected = forced?.data ?? rows.filter(row => matchesLike(row.email_local, filter.slice(6)));
      return Response.json(selected, { status: forced?.status ?? 200 });
    } },
  });
  return { client, requests };
}

describe('Contact Center exact family email ownership', () => {
  it('keeps mixed-case lookup for the same literal local-part', async () => {
    const { client } = fixture([{ family_id: OURS, email_local: 'Smith_Family' }]);
    expect(await resolveFamilyByEmailLocalResult(client, 'sMiTh_fAmIlY')).toEqual({ familyId: OURS, error: null });
  });

  it('does not route an underscore address to a different family with one matching character', async () => {
    const { client } = fixture([{ family_id: OTHER, email_local: 'smitha1' }]);
    expect(await resolveFamilyByEmailLocalResult(client, 'smith_1')).toEqual({ familyId: null, error: null });
  });

  it('finds the exact owner even when a wildcard neighbor also exists', async () => {
    const { client } = fixture([{ family_id: OTHER, email_local: 'smitha1' }, { family_id: OURS, email_local: 'smith_1' }]);
    expect(await resolveFamilyByEmailLocalResult(client, 'SMITH_1')).toEqual({ familyId: OURS, error: null });
  });

  it('returns verified absence for an unassigned address', async () => {
    const { client } = fixture([]);
    expect(await resolveFamilyByEmailLocalResult(client, 'unassigned')).toEqual({ familyId: null, error: null });
  });

  it.each([
    { family_id: OTHER, email_local: 'another-family' },
    { family_id: OURS },
    { family_id: null, email_local: 'smith_1' },
  ])('refuses an incomplete or mismatched successful lookup receipt: %j', async row => {
    const { client } = fixture([], { data: [row] });
    const result = await resolveFamilyByEmailLocalResult(client, 'smith_1');
    expect(result.familyId).toBeNull(); expect(result.error).toBeTruthy();
  });

  it('does not turn a provider read error into unassigned address success', async () => {
    const { client } = fixture([], { data: { code: '42501', message: 'Synthetic lookup denied' }, status: 403 });
    const result = await resolveFamilyByEmailLocalResult(client, 'smith_1');
    expect(result.familyId).toBeNull(); expect(result.error).toMatchObject({ code: '42501' });
  });
});
