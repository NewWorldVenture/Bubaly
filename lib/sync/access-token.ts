import 'server-only';
import type { createServiceClient } from '@/lib/supabase/server';
import type { SyncProviderAdapter } from '@/lib/sync/adapter';
import { decryptSecret, encryptSecret } from '@/lib/sync/crypto';

/** Caller must verify account ownership before asking for its server-only token. */
export async function getProviderAccessToken(admin: ReturnType<typeof createServiceClient>, accountId: string, adapter: SyncProviderAdapter): Promise<string> {
  const { data: token, error } = await admin.from('sync_tokens')
    .select('access_token_enc, refresh_token_enc, expires_at').eq('account_id', accountId).maybeSingle();
  if (error || !token?.access_token_enc) throw new Error('The calendar connection needs to be renewed');
  const expiry = token.expires_at ? Date.parse(token.expires_at) : 0;
  if (expiry - 120_000 > Date.now()) return decryptSecret(token.access_token_enc);
  if (!token.refresh_token_enc) throw new Error('The calendar connection needs to be renewed');
  const refreshed = await adapter.refreshAccessToken(decryptSecret(token.refresh_token_enc));
  const result = await admin.from('sync_tokens').update({
    access_token_enc: encryptSecret(refreshed.accessToken),
    refresh_token_enc: refreshed.refreshToken ? encryptSecret(refreshed.refreshToken) : token.refresh_token_enc,
    expires_at: new Date(refreshed.expiresAt).toISOString(), last_synced_at: new Date().toISOString(),
  }).eq('account_id', accountId).select('account_id').maybeSingle();
  if (result.error || !result.data) throw new Error('The refreshed calendar connection could not be saved');
  return refreshed.accessToken;
}
