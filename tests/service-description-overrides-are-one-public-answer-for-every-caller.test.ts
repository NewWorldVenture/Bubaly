// API-A3A1F108621E — GET /api/services/descriptions, request level.
//
// A public read of the super-admin service-description OVERRIDES: one global
// row set (service_descriptions has no family column), served to every visitor
// and cached at the edge. The handler takes no request at all, so there is no
// caller-chosen id to try and no session to read.
//
// Already proven elsewhere, and not repeated here:
//   tests/a-failed-description-read-is-not-cached-at-the-edge.test.ts — a
//     refused or thrown read answers 503 no-store with Retry-After and no
//     internal text; a read that worked carries the public cache header.
//   tests/shared-caches-do-not-outlive-revocation.test.ts — the public cache
//     header is allowed here only because the answer is the same for everyone.
//
// Added here: the handler over the in-memory database, seeded with two
// households' data beside the overrides — what it reads (service_descriptions
// only, through the service client, never a session), what it returns (trimmed
// overrides, blank rows dropped), and that a signed-in member of any role gets
// exactly the bytes a signed-out visitor gets.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

const h = vi.hoisted(() => ({ db: null as unknown, createServer: vi.fn() }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => h.db, createServer: h.createServer }));

const FAMILY_A = '4a000000-0000-4000-8000-00000000000a';
const FAMILY_B = '4b000000-0000-4000-8000-00000000000b';
const ROLES = ['parent', 'adult', 'teen', 'child', 'caregiver', 'guest'] as const;
const PUBLIC_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=600';

let db: InMemorySupabase;

beforeEach(() => {
  h.createServer.mockReset();
  db = createInMemorySupabase();
  db.seed('service_descriptions', [
    { service_key: '/dashboard/meals', description: '  Plan dinners together.  ' },
    { service_key: '/dashboard/moving', description: 'Pack room by room.' },
    { service_key: '/dashboard/sleep', description: '   ' },
    { service_key: '/dashboard/garden', description: null },
  ]);
  db.seed('families', [{ id: FAMILY_A, name: 'Household A' }, { id: FAMILY_B, name: 'Household B' }]);
  db.seed('family_members', [
    { family_id: FAMILY_A, user_id: 'user-a', role: 'parent', is_active: true, display_name: 'Parent A' },
    { family_id: FAMILY_B, user_id: 'user-b', role: 'parent', is_active: true, display_name: 'Parent B' },
  ]);
  h.db = db;
});

const get = async () => (await import('@/app/api/services/descriptions/route')).GET();

describe('API-A3A1F108621E GET /api/services/descriptions', () => {
  it('API-A3A1F108621E a signed-out visitor gets the trimmed overrides, blank ones dropped, under the public cache', async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe(PUBLIC_CACHE);
    expect(await response.json()).toEqual({
      overrides: { '/dashboard/meals': 'Plan dinners together.', '/dashboard/moving': 'Pack room by room.' },
    });
    expect(db.log.map((entry) => entry.table)).toEqual(['service_descriptions']);
    expect(h.createServer).not.toHaveBeenCalled();
  });

  it('API-A3A1F108621E reading changes nothing in the table', async () => {
    const before = structuredClone(db.table('service_descriptions'));
    await get();
    expect(db.table('service_descriptions')).toEqual(before);
  });

  it.each(ROLES)('API-A3A1F108621E a signed-in %s gets exactly the public bytes and no household data', async (role) => {
    const anonymous = await (await get()).text();
    db.table('family_members')[0].role = role;
    const member = await get();
    const text = await member.text();
    expect(text).toBe(anonymous);
    for (const secret of ['Household A', 'Household B', 'Parent A', 'Parent B', FAMILY_A, FAMILY_B]) expect(text).not.toContain(secret);
    expect(db.log.every((entry) => entry.table === 'service_descriptions')).toBe(true);
    expect(h.createServer).not.toHaveBeenCalled();
  });
});
