// lib/sync/accounts.ts
//
// Persistence for connected provider accounts + their encrypted tokens. The token
// store (sync_tokens) is service-role only by RLS, so everything here uses the
// service client. Tokens are AES-256-GCM encrypted (lib/sync/crypto.ts) before
// they touch a column.
//
// SERVER ONLY.

import type { createServiceClient } from '@/lib/supabase/server';
import type { SyncProviderEnum } from '@/lib/database.types';
import { encryptSecret, decryptSecret, encryptNullable } from '@/lib/sync/crypto';
import { refreshAccessToken, type OAuthTokens } from '@/lib/sync/providers/google';

type Admin = ReturnType<typeof createServiceClient>;

export type ConnectInput = {
  userId: string;
  familyId: string;
  provider: SyncProviderEnum;
  externalId: string; // provider account id / email
  displayName?: string | null;
  scope?: string | null;
  tokens: OAuthTokens;
};

/**
 * Upserts the account + its encrypted tokens. Idempotent on (user, provider,
 * external_id). If a re-connect omits a refresh token (Google only returns it on
 * first consent), the previously stored refresh token is preserved.
 */
export async function connectAccount(admin: Admin, input: ConnectInput): Promise<string> {
  const { data: account, error: accErr } = await admin
    .from('sync_accounts')
    .upsert(
      {
        user_id: input.userId,
        family_id: input.familyId,
        provider: input.provider,
        external_id: input.externalId,
        display_name: input.displayName ?? input.externalId,
        sync_status: 'synced',
        scopes: input.scope ? input.scope.split(' ') : [],
        created_by: input.userId,
        updated_by: input.userId,
      },
      { onConflict: 'user_id,provider,external_id' },
    )
    .select('id')
    .single();
  if (accErr || !account) throw new Error(`Failed to upsert sync account: ${accErr?.message}`);

  // Preserve an existing refresh token when this consent didn't return a new one.
  let refreshEnc = encryptNullable(input.tokens.refreshToken);
  if (!refreshEnc) {
    const { data: existing } = await admin
      .from('sync_tokens')
      .select('refresh_token_enc')
      .eq('account_id', account.id)
      .maybeSingle();
    refreshEnc = existing?.refresh_token_enc ?? null;
  }

  const { error: tokErr } = await admin.from('sync_tokens').upsert(
    {
      account_id: account.id,
      user_id: input.userId,
      family_id: input.familyId,
      provider: input.provider,
      external_id: input.externalId,
      access_token_enc: encryptSecret(input.tokens.accessToken),
      refresh_token_enc: refreshEnc,
      token_type: input.tokens.tokenType ?? 'Bearer',
      scope: input.tokens.scope ?? input.scope ?? null,
      expires_at: new Date(input.tokens.expiresAt).toISOString(),
      sync_status: 'synced',
    },
    { onConflict: 'account_id' },
  );
  if (tokErr) throw new Error(`Failed to store tokens: ${tokErr.message}`);

  // Ensure a connection row exists for health/UI.
  await admin.from('sync_connections').upsert(
    {
      account_id: account.id,
      user_id: input.userId,
      family_id: input.familyId,
      provider: input.provider,
      external_id: input.externalId,
      item_types: ['calendar', 'reminder'],
      sync_status: 'synced',
      health: 'healthy',
      created_by: input.userId,
      updated_by: input.userId,
    },
    { onConflict: 'account_id' },
  );

  return account.id;
}

/**
 * Returns a valid access token for an account, refreshing (and re-persisting) it
 * when it is within 2 minutes of expiry. Throws if no refresh token is available.
 */
export async function getValidAccessToken(admin: Admin, accountId: string): Promise<string> {
  const { data: tok, error } = await admin
    .from('sync_tokens')
    .select('access_token_enc, refresh_token_enc, expires_at')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !tok || !tok.access_token_enc) throw new Error('No stored token for this account — reconnect required.');

  const expiresAt = tok.expires_at ? new Date(tok.expires_at).getTime() : 0;
  if (expiresAt - 120_000 > Date.now()) {
    return decryptSecret(tok.access_token_enc);
  }

  if (!tok.refresh_token_enc) throw new Error('Access token expired and no refresh token — reconnect required.');
  const refreshed = await refreshAccessToken(decryptSecret(tok.refresh_token_enc));

  await admin
    .from('sync_tokens')
    .update({
      access_token_enc: encryptSecret(refreshed.accessToken),
      expires_at: new Date(refreshed.expiresAt).toISOString(),
      last_synced_at: new Date().toISOString(),
    })
    .eq('account_id', accountId);

  return refreshed.accessToken;
}

/** Loads the decrypted refresh token (for revoke-on-disconnect). */
export async function getRefreshToken(admin: Admin, accountId: string): Promise<string | null> {
  const { data } = await admin.from('sync_tokens').select('refresh_token_enc').eq('account_id', accountId).maybeSingle();
  return data?.refresh_token_enc ? decryptSecret(data.refresh_token_enc) : null;
}
