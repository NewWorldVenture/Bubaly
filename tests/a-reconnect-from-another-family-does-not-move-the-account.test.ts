import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { AccountConnectedElsewhereError, connectAccount } from '@/lib/sync/accounts';

// A user in families A and B connects the same Google account while B is
// active. The normal (non-onboarding) branch upserted on (user, provider,
// external_id) with family_id = B, so the account, its tokens and its
// connection moved out of A while A's calendars still pointed at it.
const userId = '10000000-0000-4000-8000-000000000001';
const familyA = '20000000-0000-4000-8000-00000000000a';
const familyB = '20000000-0000-4000-8000-00000000000b';
const accountId = '30000000-0000-4000-8000-000000000001';

let db: InMemorySupabase;
const tokens = { accessToken: 'access', refreshToken: 'refresh', expiresAt: Date.now() + 3600_000 };

beforeEach(() => {
  vi.stubEnv('SYNC_TOKEN_KEY', '12'.repeat(32));
  db = createInMemorySupabase({ uniques: { sync_accounts: [['user_id', 'provider', 'external_id']], sync_tokens: [['account_id']], sync_connections: [['account_id']] } });
  db.seed('sync_accounts', [{ id: accountId, user_id: userId, family_id: familyA, provider: 'google', external_id: 'me@example.test', sync_direction: 'two_way' }]);
  db.seed('sync_tokens', [{ account_id: accountId, user_id: userId, family_id: familyA, provider: 'google', external_id: 'me@example.test', access_token_enc: 'old' }]);
  db.seed('sync_connections', [{ account_id: accountId, user_id: userId, family_id: familyA, provider: 'google', external_id: 'me@example.test' }]);
  // The user belongs to both families.
  db.seed('family_members', [
    { id: 'm-a', user_id: userId, family_id: familyA, is_active: true },
    { id: 'm-b', user_id: userId, family_id: familyB, is_active: true },
  ]);
});

describe('connecting an account another family already holds', () => {
  it('refuses rather than moving the account, its tokens and its connection', async () => {
    await expect(connectAccount(db as never, {
      userId, familyId: familyB, provider: 'google', externalId: 'me@example.test', tokens,
    })).rejects.toThrow(/another family/);
    expect(db.table('sync_accounts')[0]).toMatchObject({ id: accountId, family_id: familyA });
    expect(db.table('sync_tokens')[0]).toMatchObject({ family_id: familyA, access_token_enc: 'old' });
    expect(db.table('sync_connections')[0]).toMatchObject({ family_id: familyA });
  });

  it('still reconnects in the family that holds it (not over-tightened)', async () => {
    const id = await connectAccount(db as never, { userId, familyId: familyA, provider: 'google', externalId: 'me@example.test', tokens });
    expect(id).toBe(accountId);
    expect(db.table('sync_accounts')).toHaveLength(1);
    expect(db.table('sync_tokens')[0].access_token_enc).not.toBe('old');
  });

  it('refuses an account with no identity instead of keying it on something shared', async () => {
    await expect(connectAccount(db as never, { userId, familyId: familyA, provider: 'google', externalId: '', tokens })).rejects.toThrow();
  });
});

describe('the OAuth callbacks never key an account on the user id', () => {
  // `identity ?? ctx.user.id` made every account whose identity lookup failed
  // share one key, so a second account overwrote the first one's tokens.
  for (const file of ['app/api/sync/[provider]/callback/route.ts', 'app/api/sync/google/callback/route.ts']) {
    it(file, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/externalId:\s*\w+\s*\?\?\s*ctx\.user\.id/);
      expect(src).toMatch(/if \(!(identity|email)\) return redirect\('error=connect_failed'\)/);
    });
  }
});

// The refusal above locked a user out for good once they had LEFT family A: the
// disconnect routes only look in the active family, so the A-bound row could
// never be removed, and every connect in B failed with a generic error.
describe('a user who left the family holding the account is not locked out', () => {
  it('releases the stale connection and connects the account in the new family', async () => {
    db.table('family_members').find((m) => m.id === 'm-a')!.is_active = false;
    const id = await connectAccount(db as never, { userId, familyId: familyB, provider: 'google', externalId: 'me@example.test', tokens });
    const accounts = db.table('sync_accounts');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id, family_id: familyB, external_id: 'me@example.test' });
    expect(id).not.toBe(accountId);
  });

  it('a member of both still gets the specific refusal the callbacks can explain', async () => {
    const err = await connectAccount(db as never, { userId, familyId: familyB, provider: 'google', externalId: 'me@example.test', tokens }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountConnectedElsewhereError);
    expect(db.table('sync_accounts')[0]).toMatchObject({ id: accountId, family_id: familyA });
  });

  for (const file of ['app/api/sync/[provider]/callback/route.ts', 'app/api/sync/google/callback/route.ts']) {
    it(`${file} says why instead of a generic connect_failed`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(/if \(err instanceof AccountConnectedElsewhereError\) return redirect\('error=connected_elsewhere'\)/);
    });
  }

  it('the provider page has words for that error', () => {
    const src = readFileSync('app/(app)/dashboard/sync/accounts/[provider]/page.tsx', 'utf8');
    expect(src).toContain("'error=connected_elsewhere'");
  });
});
