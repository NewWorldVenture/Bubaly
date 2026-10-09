import 'server-only';
import type { Json, SyncProviderEnum } from '@/lib/database.types';
import type { createServiceClient } from '@/lib/supabase/server';

type Admin = ReturnType<typeof createServiceClient>;
type Account = { id: string; family_id: string; user_id: string | null };
type Kind = 'event' | 'reminder';
export type PullMapping = { id: string; family_id: string; local_id: string; external_id: string; metadata: Json };
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

// Production applies held SQL by hand. Until supabase/reserved/0494_sync_atomic_pull.sql
// is applied, ensure_sync_pull_container / create_sync_pull_item do not exist and
// the pull takes the previous production path: the direct container lookup/insert
// and the separate item + mapping inserts. Only PostgREST's exact missing-function
// answer naming the RPC selects it; any other failure (permission, lock, network,
// constraint, a missing helper inside the RPC) still fails the run.
const ATOMIC_PULL_MIGRATION = '0494_sync_atomic_pull.sql';
const REMOTE_META: Json = { origin: 'remote' };
const warned = new Set<string>();

/** True only when `error` says that exactly the RPC `name` does not exist. */
export function isMissingSyncPullRpc(error: unknown, name: string): boolean {
  const err = record(error);
  if (!err || (err.code !== 'PGRST202' && err.code !== '42883')) return false;
  const named = new RegExp(`(?:^|[^A-Za-z0-9_.]|(?<![A-Za-z0-9_])public\\.)${name}(?![A-Za-z0-9_])`);
  return [err.message, err.details, err.hint].some(text => typeof text === 'string' && named.test(text));
}

function fellBackForMissingRpc(error: unknown, name: string): boolean {
  if (!isMissingSyncPullRpc(error, name)) return false;
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`[sync] function public.${name} is missing: migration ${ATOMIC_PULL_MIGRATION} has not been applied to this database. Using the previous separate sync writes.`);
  }
  return true;
}

/** Test seam: forget which warnings were already printed. */
export function resetSyncPullMigrationWarnings(): void {
  warned.clear();
}

/** The database rechecks persisted identity, direction and active ownership.
 * Without 0494 the previous direct mirror lookup/insert applies; its receipt is
 * marked `legacy` so the engine keeps that build's cursor order too. */
export async function ensureSyncPullContainer(admin: Admin, account: Account, provider: SyncProviderEnum,
  kind: Kind, externalId: string, name: string, timezone = 'UTC', color: string | null = null,
): Promise<{ id: string; sync_token: string | null; legacy?: true }> {
  if (!account.user_id) throw new Error('Sync owner unavailable');
  const { data, error } = await admin.rpc('ensure_sync_pull_container', {
    p_account: account.id, p_family: account.family_id, p_user: account.user_id,
    p_provider: provider, p_kind: kind, p_external: externalId, p_name: name, p_timezone: timezone, p_color: color,
  });
  if (fellBackForMissingRpc(error, 'ensure_sync_pull_container')) {
    return { ...await ensureLegacyContainer(admin, account, provider, kind, externalId, name, timezone, color), legacy: true };
  }
  const row = record(requireSyncWrite(data, error, `${kind} container admission`));
  if (!row || typeof row.id !== 'string' || !row.id
    || (row.sync_token !== null && typeof row.sync_token !== 'string')) throw new Error('Sync container receipt unavailable');
  return { id: row.id, sync_token: row.sync_token };
}

/** A retry can find the already committed pair. Its caller must retain the
 * usual conflict/update path for that mapping rather than count it as new.
 * Without 0494 the item and its mapping are inserted separately, as before. */
export async function createSyncPullItem(admin: Admin, account: Account, provider: SyncProviderEnum,
  kind: Kind, containerId: string, externalId: string, fields: Json, hash: string,
): Promise<{ created: boolean; mapping: PullMapping }> {
  if (!account.user_id) throw new Error('Sync owner unavailable');
  const { data, error } = await admin.rpc('create_sync_pull_item', {
    p_account: account.id, p_family: account.family_id, p_user: account.user_id,
    p_provider: provider, p_kind: kind, p_container: containerId, p_external: externalId, p_fields: fields, p_hash: hash,
  });
  if (fellBackForMissingRpc(error, 'create_sync_pull_item')) {
    return createLegacyItem(admin, account, provider, kind, containerId, externalId, fields, hash);
  }
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

/** The previous production mirror: found by household/provider/remote id, else inserted. */
async function ensureLegacyContainer(admin: Admin, account: Account, provider: SyncProviderEnum,
  kind: Kind, externalId: string, name: string, timezone: string, color: string | null,
): Promise<{ id: string; sync_token: string | null }> {
  if (kind === 'event') {
    const { data: cal, error: calendarReadError } = await admin
      .from('sync_calendars')
      .select('id, sync_token')
      .eq('family_id', account.family_id).eq('provider', provider).eq('external_id', externalId)
      .maybeSingle();
    if (calendarReadError) throw new Error('Sync calendar lookup failed');
    if (cal) return cal;
    const { data: created, error: createError } = await admin.from('sync_calendars').insert({
      family_id: account.family_id, user_id: account.user_id, account_id: account.id,
      provider, external_id: externalId, name, timezone, color, is_owned_locally: false,
    }).select('id, sync_token').single();
    return requireSyncWrite(created, createError, 'calendar creation');
  }
  const { data: list, error: listError } = await admin
    .from('sync_reminder_lists')
    .select('id')
    .eq('family_id', account.family_id).eq('provider', provider).eq('external_id', externalId)
    .maybeSingle();
  if (listError) throw new Error('Sync reminder list lookup failed');
  if (list) return { id: list.id, sync_token: null };
  const { data: created, error: createError } = await admin.from('sync_reminder_lists').insert({
    family_id: account.family_id, user_id: account.user_id, account_id: account.id,
    provider, external_id: externalId, name, is_owned_locally: false,
  }).select('id').single();
  return { id: requireSyncWrite(created, createError, 'reminder list creation').id, sync_token: null };
}

/** The previous production item creation: the mirror row, then its mapping. */
async function createLegacyItem(admin: Admin, account: Account, provider: SyncProviderEnum,
  kind: Kind, containerId: string, externalId: string, fields: Json, hash: string,
): Promise<{ created: true; mapping: PullMapping }> {
  const row = record(fields) ?? {};
  const now = () => new Date().toISOString();
  let localId: string;
  if (kind === 'event') {
    const event = row as { uid?: string | null; title: string; description?: string | null; location?: string | null;
      starts_at: string; ends_at?: string | null; all_day?: boolean; recurrence_rule?: string | null; status?: string; etag?: string | null };
    const { data: inserted, error: insertError } = await admin.from('sync_calendar_events').insert({
      calendar_id: containerId, family_id: account.family_id, user_id: account.user_id, provider,
      external_id: externalId, uid: event.uid, title: event.title, description: event.description, location: event.location,
      starts_at: event.starts_at, ends_at: event.ends_at, all_day: event.all_day, recurrence_rule: event.recurrence_rule,
      status: event.status, etag: event.etag, content_hash: hash, sync_status: 'synced',
      last_synced_at: now(), metadata: REMOTE_META,
    }).select('id').single();
    localId = requireSyncWrite(inserted, insertError, 'event creation').id;
  } else {
    const reminder = row as { title: string; notes?: string | null; due_at?: string | null; is_completed?: boolean; completed_at?: string | null };
    const { data: inserted, error: insertError } = await admin.from('sync_reminders').insert({
      list_id: containerId, family_id: account.family_id, user_id: account.user_id, provider, external_id: externalId,
      title: reminder.title, notes: reminder.notes, due_at: reminder.due_at, is_completed: reminder.is_completed, completed_at: reminder.completed_at,
      content_hash: hash, sync_status: 'synced', last_synced_at: now(), metadata: REMOTE_META,
    }).select('id').single();
    localId = requireSyncWrite(inserted, insertError, 'reminder creation').id;
  }
  const metadata: Json = { lastHash: hash };
  const { data: mappingRow, error: mappingInsertError } = await admin.from('sync_external_mappings').insert({
    family_id: account.family_id, account_id: account.id, provider, item_type: kind, local_id: localId, external_id: externalId,
    ...(kind === 'event' ? { external_etag: (row as { etag?: string | null }).etag } : {}),
    metadata, last_synced_at: now(),
  }).select('id').maybeSingle();
  const mapping = requireSyncWrite(mappingRow, mappingInsertError, `${kind} mapping creation`);
  return { created: true, mapping: { id: mapping.id, family_id: account.family_id, local_id: localId, external_id: externalId, metadata } };
}

/** Without 0494, the previous production cursor write: as soon as the calendar
 * pull succeeds, keyed by the mirror id the direct lookup found. */
export async function commitLegacyCalendarCursor(admin: Admin, calendarId: string, cursor: string): Promise<void> {
  const { data, error } = await admin.from('sync_calendars')
    .update({ sync_token: cursor, last_synced_at: new Date().toISOString(), sync_status: 'synced' })
    .eq('id', calendarId).select('id').maybeSingle();
  requireSyncWrite(data, error, 'calendar cursor persistence');
}

/** Require a durable sync row before the engine reports a state transition. */
export function requireSyncWrite<T>(data: T | null | undefined, error: unknown, operation: string): T {
  if (error || data == null) throw new Error(`Sync ${operation} failed`);
  return data;
}
