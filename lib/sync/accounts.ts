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
  /** Onboarding consent authorizes a private preview; activation happens at Finish. */
  onboardingCalendar?: boolean;
};

/**
 * Upserts the account + its encrypted tokens. Idempotent on (user, provider,
 * external_id). If a re-connect omits a refresh token (Google only returns it on
 * first consent), the previously stored refresh token is preserved.
 */
export async function connectAccount(admin: Admin, input: ConnectInput): Promise<string> {
  let onboardingMetadata: Record<string, unknown> | undefined;
  let onboardingExisting: { id: string; updated_at: string } | null = null;
  if (input.onboardingCalendar) {
    const existing = await admin.from('sync_accounts').select('id, updated_at, family_id, sync_direction, metadata')
      .eq('user_id', input.userId).eq('provider', input.provider).eq('external_id', input.externalId).maybeSingle();
    if (existing.error) throw new Error('Could not check the existing calendar connection');
    const metadata = existing.data?.metadata && typeof existing.data.metadata === 'object' && !Array.isArray(existing.data.metadata) ? existing.data.metadata : {};
    const marker = metadata.onboardingCalendar;
    if (existing.data && (existing.data.family_id !== input.familyId || existing.data.sync_direction !== 'manual' ||
      !marker || typeof marker !== 'object' || Array.isArray(marker) || marker.version !== 1 || marker.state !== 'preview')) throw new Error('This calendar is already connected outside this setup');
    onboardingMetadata = { ...metadata, onboardingCalendar: { version: 1, state: 'preview' } };
    onboardingExisting = existing.data;
  }
  const values = {
        user_id: input.userId,
        family_id: input.familyId,
        provider: input.provider,
        external_id: input.externalId,
        display_name: input.displayName ?? input.externalId,
        sync_status: input.onboardingCalendar ? 'pending' as const : 'synced' as const,
        scopes: input.scope ? input.scope.split(' ') : [],
        created_by: input.userId,
        updated_by: input.userId,
        ...(onboardingMetadata ? { sync_direction: 'manual' as const, metadata: onboardingMetadata as import('@/lib/database.types').Json } : {}),
      };
  // The dormant marker is part of the first account write. An onboarding
  // reconnect must not overwrite a concurrently activated normal connection.
  const { data: account, error: accErr } = input.onboardingCalendar
    ? onboardingExisting
      ? await admin.from('sync_accounts').update({ display_name: values.display_name, sync_status: values.sync_status, scopes: values.scopes,
        updated_by: input.userId, sync_direction: 'manual', metadata: values.metadata }).eq('id', onboardingExisting.id).eq('family_id', input.familyId)
        .eq('user_id', input.userId).eq('sync_direction', 'manual').eq('updated_at', onboardingExisting.updated_at).select('id').single()
      : await admin.from('sync_accounts').insert(values).select('id').single()
    : await admin.from('sync_accounts').upsert(values, { onConflict: 'user_id,provider,external_id' }).select('id').single();
  if (accErr || !account) throw new Error('Failed to upsert sync account');

  // Preserve an existing refresh token when this consent didn't return a new one.
  let refreshEnc = encryptNullable(input.tokens.refreshToken);
  if (!refreshEnc) {
    const { data: existing, error: existingError } = await admin
      .from('sync_tokens')
      .select('refresh_token_enc')
      .eq('account_id', account.id)
      .maybeSingle();
    if (existingError) throw new Error('Failed to read the stored refresh token');
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
      sync_status: input.onboardingCalendar ? 'pending' : 'synced',
      ...(input.onboardingCalendar ? { sync_direction: 'manual' as const } : {}),
    },
    { onConflict: 'account_id' },
  );
  if (tokErr) throw new Error('Failed to store sync tokens');

  // Ensure a connection row exists for health/UI.
  const { data: connection, error: connectionError } = await admin.from('sync_connections').upsert(
    {
      account_id: account.id,
      user_id: input.userId,
      family_id: input.familyId,
      provider: input.provider,
      external_id: input.externalId,
      item_types: ['calendar', 'reminder'],
      sync_status: input.onboardingCalendar ? 'pending' : 'synced',
      health: 'healthy',
      created_by: input.userId,
      updated_by: input.userId,
      ...(input.onboardingCalendar ? { sync_direction: 'manual' as const, item_types: ['calendar' as const] } : {}),
    },
    { onConflict: 'account_id' },
  ).select('account_id').maybeSingle();
  if (connectionError || !connection) throw new Error('Failed to persist the sync connection');

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

  const { data: updated, error: updateError } = await admin
    .from('sync_tokens')
    .update({
      access_token_enc: encryptSecret(refreshed.accessToken),
      expires_at: new Date(refreshed.expiresAt).toISOString(),
      last_synced_at: new Date().toISOString(),
    })
    .eq('account_id', accountId).select('account_id').maybeSingle();
  if (updateError || !updated) throw new Error('Failed to persist the refreshed sync token');

  return refreshed.accessToken;
}

/** Loads the decrypted refresh token (for revoke-on-disconnect). */
export async function getRefreshToken(admin: Admin, accountId: string): Promise<string | null> {
  const { data, error } = await admin.from('sync_tokens').select('refresh_token_enc').eq('account_id', accountId).maybeSingle();
  if (error) throw new Error('Failed to read the stored refresh token');
  return data?.refresh_token_enc ? decryptSecret(data.refresh_token_enc) : null;
}
