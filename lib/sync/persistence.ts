import 'server-only';
import type { Json, SyncProviderEnum } from '@/lib/database.types';
import type { createServiceClient } from '@/lib/supabase/server';

type Admin = ReturnType<typeof createServiceClient>;
type Account = { id: string; family_id: string; user_id: string | null };
type Kind = 'event' | 'reminder';
export type PullMapping = { id: string; family_id: string; local_id: string; external_id: string; metadata: Json };
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** The database rechecks persisted identity, direction and active ownership.
 * Missing/older RPCs fail visibly; separate raw inserts cannot provide this contract. */
export async function ensureSyncPullContainer(admin: Admin, account: Account, provider: SyncProviderEnum,
  kind: Kind, externalId: string, name: string, timezone = 'UTC', color: string | null = null,
): Promise<{ id: string; sync_token: string | null }> {
  if (!account.user_id) throw new Error('Sync owner unavailable');
  const { data, error } = await admin.rpc('ensure_sync_pull_container', {
    p_account: account.id, p_family: account.family_id, p_user: account.user_id,
    p_provider: provider, p_kind: kind, p_external: externalId, p_name: name, p_timezone: timezone, p_color: color,
  });
  const row = record(requireSyncWrite(data, error, `${kind} container admission`));
  if (!row || typeof row.id !== 'string' || !row.id
    || (row.sync_token !== null && typeof row.sync_token !== 'string')) throw new Error('Sync container receipt unavailable');
  return { id: row.id, sync_token: row.sync_token };
}

/** A retry can find the already committed pair. Its caller must retain the
 * usual conflict/update path for that mapping rather than count it as new. */
export async function createSyncPullItem(admin: Admin, account: Account, provider: SyncProviderEnum,
  kind: Kind, containerId: string, externalId: string, fields: Json, hash: string,
): Promise<{ created: boolean; mapping: PullMapping }> {
  if (!account.user_id) throw new Error('Sync owner unavailable');
  const { data, error } = await admin.rpc('create_sync_pull_item', {
    p_account: account.id, p_family: account.family_id, p_user: account.user_id,
    p_provider: provider, p_kind: kind, p_container: containerId, p_external: externalId, p_fields: fields, p_hash: hash,
  });
  const receipt = record(requireSyncWrite(data, error, `${kind} and mapping creation`));
  const mapping = record(receipt?.mapping);
  if (!receipt || typeof receipt.created !== 'boolean' || !mapping
    || typeof mapping.id !== 'string' || !mapping.id || typeof mapping.local_id !== 'string' || !mapping.local_id
    || mapping.family_id !== account.family_id || mapping.external_id !== externalId || !record(mapping.metadata)) {
    throw new Error('Sync item receipt scope unavailable');
  }
  return { created: receipt.created, mapping: {
    id: mapping.id, local_id: mapping.local_id, family_id: account.family_id, external_id: externalId,
    metadata: mapping.metadata as Json,
  } };
}

/** Require a durable sync row before the engine reports a state transition. */
export function requireSyncWrite<T>(data: T | null | undefined, error: unknown, operation: string): T {
  if (error || data == null) throw new Error(`Sync ${operation} failed`);
  return data;
}
