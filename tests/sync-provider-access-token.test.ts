import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getProviderAccessToken } from '@/lib/sync/access-token';
import { decryptSecret, encryptSecret } from '@/lib/sync/crypto';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import type { SyncProviderAdapter } from '@/lib/sync/adapter';

beforeEach(() => vi.stubEnv('SYNC_TOKEN_KEY', '12'.repeat(32)));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
describe('provider-owned access-token refresh', () => {
  it('uses the selected provider and returns a token only after its encrypted replacement is saved', async () => {
    const db = createInMemorySupabase();
    db.seed('sync_tokens', [{ account_id: 'account', access_token_enc: encryptSecret('expired'), refresh_token_enc: encryptSecret('refresh'), expires_at: '2020-01-01' }]);
    const adapter = { refreshAccessToken: vi.fn(async () => ({ accessToken: 'renewed', refreshToken: null, expiresAt: Date.now() + 3600000 })) } as unknown as SyncProviderAdapter;
    expect(await getProviderAccessToken(db as never, 'account', adapter)).toBe('renewed');
    expect(adapter.refreshAccessToken).toHaveBeenCalledWith('refresh');
    expect(decryptSecret(db.table('sync_tokens')[0].access_token_enc as string)).toBe('renewed');
    expect(decryptSecret(db.table('sync_tokens')[0].refresh_token_enc as string)).toBe('refresh');
  });
  it('does not proceed with a refreshed token if persistence fails', async () => {
    const db = createInMemorySupabase();
    db.seed('sync_tokens', [{ account_id: 'account', access_token_enc: encryptSecret('expired'), refresh_token_enc: encryptSecret('refresh'), expires_at: '2020-01-01' }]);
    const original = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = original(table);
      vi.spyOn(query, 'update').mockImplementation(() => { throw new Error('write unavailable'); });
      return query;
    });
    const adapter = { refreshAccessToken: vi.fn(async () => ({ accessToken: 'renewed', refreshToken: null, expiresAt: Date.now() + 3600000 })) } as unknown as SyncProviderAdapter;
    await expect(getProviderAccessToken(db as never, 'account', adapter)).rejects.toThrow('write unavailable');
    expect(decryptSecret(db.table('sync_tokens')[0].access_token_enc as string)).toBe('expired');
  });
});
