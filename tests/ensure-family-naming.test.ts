import { describe, it, expect, vi, beforeEach } from 'vitest';

// A chainable stand-in for the service-role PostgREST client. Each table gets a
// scripted reply; every call is recorded so the assertions can read what
// provisioning actually wrote rather than what the source appears to say.
type Reply = { data?: unknown; error?: unknown };

function makeAdmin(script: {
  memberships?: Reply[];
  profile?: Reply;
  rpc?: Reply;
  onboardingProgress?: Reply;
  familyInsert?: Reply;
}) {
  const calls = { rpc: [] as Array<{ name: string; args: Record<string, unknown> }>, upserts: [] as Array<{ table: string; row: Record<string, unknown> }>, inserts: [] as Array<{ table: string; row: unknown }> };
  const memberships = [...(script.memberships ?? [{ data: [], error: null }, { data: [{ family_id: 'fam-1' }], error: null }])];

  function builder(table: string) {
    // Terminal shapes differ per call site; resolving on await lets the same
    // object answer `.limit()`, `.maybeSingle()` and a bare await alike.
    const settle = (): Reply => {
      if (table === 'family_members') return memberships.shift() ?? { data: [], error: null };
      if (table === 'profiles') return script.profile ?? { data: null, error: null };
      if (table === 'onboarding_progress') return script.onboardingProgress ?? { data: null, error: null };
      // The compatibility path reads the new row back from its own insert.
      if (table === 'families') return script.familyInsert ?? { data: { id: 'fam-compat' }, error: null };
      return { data: null, error: null };
    };
    const chain: Record<string, unknown> = {
      select: () => chain, eq: () => chain, order: () => chain,
      limit: () => Promise.resolve(settle()),
      maybeSingle: () => Promise.resolve(settle()),
      single: () => Promise.resolve(settle()),
      upsert: (row: Record<string, unknown>) => { calls.upserts.push({ table, row }); return Promise.resolve({ error: null }); },
      insert: (row: unknown) => { calls.inserts.push({ table, row }); return { select: () => chain, ...chain }; },
      then: (resolve: (value: Reply) => unknown) => Promise.resolve(settle()).then(resolve),
    };
    return chain;
  }

  return {
    calls,
    client: {
      from: (table: string) => builder(table),
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.rpc.push({ name, args });
        return Promise.resolve(script.rpc ?? { data: 'fam-1', error: null });
      },
    },
  };
}

let admin: ReturnType<typeof makeAdmin>;
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => admin.client,
  createServer: () => { throw new Error('provisioning must not use the RLS-scoped client'); },
}));

const { ensureActiveFamily } = await import('@/lib/server/ensure-family');
const anyClient = {} as never;

describe('naming a family space provisioned without the wizard', () => {
  beforeEach(() => { admin = makeAdmin({}); });

  it('does not invent a name for a phone signup that has none', async () => {
    // A phone signup collects a number and nothing else: no name field exists
    // anywhere in that flow, so profiles.full_name is '', user_metadata is
    // empty and auth.users.email is null. Provisioning used to substitute the
    // literal string 'My' for the person and then make it possessive, creating
    // "My's Family" with a single member called "My" — both visible in the
    // sidebar of an account that had done nothing wrong.
    const ok = await ensureActiveFamily(anyClient, { id: 'u1', email: null, user_metadata: {} });
    expect(ok).toBe(true);
    const [{ args }] = admin.calls.rpc;
    expect(args.p_name).toBe('My Family');
    expect(args.p_display_name).toBe('Parent');
  });

  it('uses the auth metadata name when a Google signup supplies one', async () => {
    await ensureActiveFamily(anyClient, { id: 'u2', email: 'ada@example.com', user_metadata: { full_name: 'Ada Lovelace' } });
    const [{ args }] = admin.calls.rpc;
    expect(args.p_name).toBe("Ada Lovelace's Family");
    expect(args.p_display_name).toBe('Ada Lovelace');
  });

  it('prefers the saved profile name over anything on the auth record', async () => {
    admin = makeAdmin({ profile: { data: { display_name: 'Jonas', full_name: null }, error: null } });
    await ensureActiveFamily(anyClient, { id: 'u3', email: 'jj@example.com', user_metadata: { full_name: 'Ignore Me' } });
    const [{ args }] = admin.calls.rpc;
    expect(args.p_name).toBe("Jonas' Family");   // already ends in s
    expect(args.p_display_name).toBe('Jonas');
  });

  it('falls back to the email local-part before giving up on a name', async () => {
    await ensureActiveFamily(anyClient, { id: 'u4', email: 'ada@example.com', user_metadata: {} });
    expect(admin.calls.rpc[0].args.p_name).toBe("ada's Family");
  });

  it('gives the compatibility path the same name the RPC path would get', async () => {
    // Databases without migration 0212 fall through to direct inserts. The two
    // paths disagreeing on the member's name is how an account ends up called
    // one thing in the sidebar and another in the family list.
    admin = makeAdmin({ rpc: { data: null, error: { message: 'function does not exist' } } });
    await ensureActiveFamily(anyClient, { id: 'u5', email: null, user_metadata: {} });
    const familyInsert = admin.calls.inserts.find((c) => c.table === 'families');
    expect((familyInsert?.row as { name: string }).name).toBe('My Family');
    const memberUpsert = admin.calls.upserts.find((c) => c.table === 'family_members');
    expect(memberUpsert?.row.display_name).toBe('Parent');
  });

  it('does nothing when the account already has a family', async () => {
    admin = makeAdmin({ memberships: [{ data: [{ family_id: 'existing' }], error: null }] });
    expect(await ensureActiveFamily(anyClient, { id: 'u6', email: null, user_metadata: {} })).toBe(true);
    expect(admin.calls.rpc).toEqual([]);
  });

  it('reports failure rather than a half-provisioned account', async () => {
    // The confirm read comes back empty: the family was claimed but the
    // membership is not there, so the caller must fall back to the wizard
    // instead of dropping the user on a dashboard with no tenant.
    admin = makeAdmin({ memberships: [{ data: [], error: null }, { data: [], error: null }] });
    expect(await ensureActiveFamily(anyClient, { id: 'u7', email: null, user_metadata: {} })).toBe(false);
  });
});
