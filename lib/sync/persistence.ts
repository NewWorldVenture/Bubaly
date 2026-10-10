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
// answer naming the RPC in its message selects it; any other failure (permission,
// lock, network, constraint, a missing helper inside the RPC) still fails the run.
// PostgREST gives that same answer when the function exists with another
// signature, so a mismatched 0494 is also treated as absent.
const ATOMIC_PULL_MIGRATION = '0494_sync_atomic_pull.sql';
const REMOTE_META: Json = { origin: 'remote' };
// A known-absent RPC is not asked again for a short while, so the old schema
// does not pay a failed round trip per pulled item; once 0494 is applied the
// RPC is used again after at most this long (the direct writes stay valid).
const ABSENT_RETRY_MS = 60_000;
const warned = new Set<string>();
const absentUntil = new Map<string, number>();

/** True only when `error` says that exactly the RPC `name` does not exist. */
export function isMissingSyncPullRpc(error: unknown, name: string): boolean {
  const err = record(error);
  if (!err || typeof err.message !== 'string') return false;
  const fn = `public\\.${name}\\(`;
  if (err.code === 'PGRST202') return new RegExp(`^Could not find the function ${fn}`).test(err.message);
  return err.code === '42883' && new RegExp(`^function ${fn}[^)]*\\) does not exist$`).test(err.message);
}

function knownAbsent(name: string): boolean {
  const until = absentUntil.get(name);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  absentUntil.delete(name);
  return false;
}

function fellBackForMissingRpc(error: unknown, name: string): boolean {
  if (!isMissingSyncPullRpc(error, name)) return false;
  absentUntil.set(name, Date.now() + ABSENT_RETRY_MS);
  if (!warned.has(name)) {
    warned.add(name);
    console.warn(`[sync] function public.${name} is missing: migration ${ATOMIC_PULL_MIGRATION} has not been applied to this database. Using the previous separate sync writes.`);
  }
  return true;
}

/** Test seam: forget which warnings were already printed and which RPCs were absent. */
export function resetSyncPullMigrationWarnings(): void {
  warned.clear();
  absentUntil.clear();
}

/** The database rechecks persisted identity, direction and active ownership.
 * Without 0494 the previous direct mirror lookup/insert applies; its receipt is
 * marked `legacy` so the engine keeps that build's cursor order too. */
export async function ensureSyncPullContainer(admin: Admin, account: Account, provider: SyncProviderEnum,
  kind: Kind, externalId: string, name: string, timezone = 'UTC', color: string | null = null,
): Promise<{ id: string; sync_token: string | null; legacy?: true }> {
  if (!account.user_id) throw new Error('Sync owner unavailable');
  if (knownAbsent('ensure_sync_pull_container')) {
    return { ...await ensureLegacyContainer(admin, account, provider, kind, externalId, name, timezone, color), legacy: true };
  }
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
  if (knownAbsent('create_sync_pull_item')) {
    return createLegacyItem(admin, account, provider, kind, containerId, externalId, fields, hash);
  }
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

/** The previous production mirror lookup/insert, scoped as 0494 scopes it: by
 * the provider account, not only the household. A remote id such as Google's
 * '@default' task list is the same for every account, so a household-wide
 * lookup let a second account adopt the first account's mirror and export its
 * local items. A match naming another household or owner, or more than one
 * match, fails closed. */
async function ensureLegacyContainer(admin: Admin, account: Account, provider: SyncProviderEnum,
  kind: Kind, externalId: string, name: string, timezone: string, color: string | null,
): Promise<{ id: string; sync_token: string | null }> {
  const inScope = (row: { family_id: string; user_id: string | null }) =>
    row.family_id === account.family_id && row.user_id === account.user_id;
  if (kind === 'event') {
    const { data: cal, error: calendarReadError } = await admin
      .from('sync_calendars')
      .select('id, sync_token, family_id, user_id')
      .eq('account_id', account.id).eq('provider', provider).eq('external_id', externalId)
      .maybeSingle();
    if (calendarReadError) throw new Error('Sync calendar lookup failed');
    if (cal) {
      if (!inScope(cal)) throw new Error('Sync calendar scope unavailable');
      return { id: cal.id, sync_token: cal.sync_token };
    }
    const { data: created, error: createError } = await admin.from('sync_calendars').insert({
      family_id: account.family_id, user_id: account.user_id, account_id: account.id,
      provider, external_id: externalId, name, timezone, color, is_owned_locally: false,
    }).select('id, sync_token').single();
    return requireSyncWrite(created, createError, 'calendar creation');
  }
  const { data: list, error: listError } = await admin
    .from('sync_reminder_lists')
    .select('id, family_id, user_id')
    .eq('account_id', account.id).eq('provider', provider).eq('external_id', externalId)
    .maybeSingle();
  if (listError) throw new Error('Sync reminder list lookup failed');
  if (list) {
    if (!inScope(list)) throw new Error('Sync reminder list scope unavailable');
    return { id: list.id, sync_token: null };
  }
  const { data: created, error: createError } = await admin.from('sync_reminder_lists').insert({
    family_id: account.family_id, user_id: account.user_id, account_id: account.id,
    provider, external_id: externalId, name, is_owned_locally: false,
  }).select('id').single();
  return { id: requireSyncWrite(created, createError, 'reminder list creation').id, sync_token: null };
}

/** The previous production item creation: the mirror row, then its mapping.
 * The writes are separate, so a failure between them must not leave a state a
 * retry duplicates or cannot read. A failed mapping write keeps the item: the
 * client can report an error for an INSERT that committed, and removing the
 * item then would leave a mapping naming a missing row, which wedges every
 * later pull. If the mapping did commit, the next run finds it; if it did not,
 * the next run finds the unmapped item for this remote id in this account's
 * mirror and adopts it (live, as the RPC inserts it; see adoptLegacyItem)
 * instead of inserting a second one. An item another mapping already claims,
 * one owned by someone else, or more than one candidate, fails closed. */
async function createLegacyItem(admin: Admin, account: Account, provider: SyncProviderEnum,
  kind: Kind, containerId: string, externalId: string, fields: Json, hash: string,
): Promise<{ created: true; mapping: PullMapping }> {
  const row = record(fields) ?? {};
  const now = () => new Date().toISOString();
  const metadata: Json = { lastHash: hash };
  const mappingFields = {
    ...(kind === 'event' ? { external_etag: (row as { etag?: string | null }).etag } : {}), metadata, last_synced_at: now(),
  };
  const orphan = await findUnmappedLegacyItem(admin, account, provider, kind, containerId, externalId);
  const adopted = (mappingId: string) => ({ created: true as const,
    mapping: { id: mappingId, family_id: account.family_id, local_id: orphan!.id, external_id: externalId, metadata } });
  let localId: string;
  if (kind === 'event') {
    const event = row as { uid?: string | null; title: string; description?: string | null; location?: string | null;
      starts_at: string; ends_at?: string | null; all_day?: boolean; recurrence_rule?: string | null; status?: string; etag?: string | null };
    const content = {
      uid: event.uid, title: event.title, description: event.description, location: event.location,
      starts_at: event.starts_at, ends_at: event.ends_at, all_day: event.all_day, recurrence_rule: event.recurrence_rule,
      status: event.status, etag: event.etag, content_hash: hash, sync_status: 'synced' as const,
      last_synced_at: now(), metadata: REMOTE_META,
    };
    if (orphan) {
      return adopted(await adoptLegacyItem(admin, account, provider, kind, externalId, orphan, mappingFields, async fence =>
        admin.from('sync_calendar_events').update({ ...content, deleted_at: null })
          .match({ ...fence, calendar_id: containerId }).select('id').maybeSingle()));
    }
    const { data: written, error: writeError } = await admin.from('sync_calendar_events').insert({
      calendar_id: containerId, family_id: account.family_id, user_id: account.user_id, provider,
      external_id: externalId, ...content,
    }).select('id').single();
    localId = requireSyncWrite(written, writeError, 'event creation').id;
  } else {
    const reminder = row as { title: string; notes?: string | null; due_at?: string | null; is_completed?: boolean; completed_at?: string | null };
    const content = {
      title: reminder.title, notes: reminder.notes, due_at: reminder.due_at, is_completed: reminder.is_completed, completed_at: reminder.completed_at,
      content_hash: hash, sync_status: 'synced' as const, last_synced_at: now(), metadata: REMOTE_META,
    };
    if (orphan) {
      return adopted(await adoptLegacyItem(admin, account, provider, kind, externalId, orphan, mappingFields, async fence =>
        admin.from('sync_reminders').update({ ...content, deleted_at: null })
          .match({ ...fence, list_id: containerId }).select('id').maybeSingle()));
    }
    const { data: written, error: writeError } = await admin.from('sync_reminders').insert({
      list_id: containerId, family_id: account.family_id, user_id: account.user_id, provider, external_id: externalId, ...content,
    }).select('id').single();
    localId = requireSyncWrite(written, writeError, 'reminder creation').id;
  }
  const { data: mappingRow, error: mappingInsertError } = await admin.from('sync_external_mappings').insert({
    family_id: account.family_id, account_id: account.id, provider, item_type: kind, local_id: localId, external_id: externalId,
    ...mappingFields,
  }).select('id').maybeSingle();
  const mapping = requireSyncWrite(mappingRow, mappingInsertError, `${kind} mapping creation`);
  return { created: true, mapping: { id: mapping.id, family_id: account.family_id, local_id: localId, external_id: externalId, metadata } };
}

type Orphan = { id: string; updated_at: string | null };
type Fence = { id: string; family_id: string; user_id: string; provider: SyncProviderEnum; external_id: string; updated_at?: string };

/** An adoption claim is published before its item is refreshed, so until it is
 * completed it is not a sync receipt: it carries no lastHash, and its state is
 * kept both in the row's sync_status (so writes can be conditional on it) and
 * in its metadata (which every reader returns, 0494's receipt included).
 * 'pending' is the claim as adoptLegacyItem published it; 'syncing' is a claim
 * the mapped pull path took over to finish. A completed mapping has neither. */
export type PendingAdoption = 'pending' | 'syncing';
const pendingMeta = (state: PendingAdoption): Json => ({ adoption: state });

/** The unfinished-adoption state of a mapping, or null for a completed one. */
export function pendingAdoption(metadata: Json | null | undefined): PendingAdoption | null {
  const state = record(metadata)?.adoption;
  return state === 'pending' || state === 'syncing' ? state : null;
}

/** The mapped pull path met an unfinished adoption. It must refresh the item
 * from the remote snapshot and then complete the mapping (sync_status 'synced'
 * and the real lastHash), never read it as a receipt. It first takes the
 * claim over, conditionally on the state it read, so the claimant's release
 * (which deletes only a row still 'pending') can no longer remove it. A taker
 * that stops leaves 'syncing', which the next pull takes over again; two pulls
 * that both read 'syncing' race as two ordinary mapped pulls of one item do. */
export async function takeOverPendingAdoption(admin: Admin, account: Account, provider: SyncProviderEnum, kind: Kind,
  mapping: PullMapping, state: PendingAdoption,
): Promise<{ user_id: string; provider: SyncProviderEnum; external_id: string }> {
  if (!account.user_id) throw new Error('Sync owner unavailable');
  const { data, error } = await admin.from('sync_external_mappings')
    .update({ sync_status: 'syncing', metadata: pendingMeta('syncing') })
    .match({ id: mapping.id, family_id: account.family_id, account_id: account.id, provider, item_type: kind,
      local_id: mapping.local_id, external_id: mapping.external_id, sync_status: state })
    .select('id').maybeSingle();
  requireSyncWrite(data, error, `${kind} adoption takeover`);
  // The item refresh that follows is fenced like the adoption's own: still in
  // this account's mirror and still owned by the account owner.
  return { user_id: account.user_id, provider, external_id: mapping.external_id };
}

/** Adopt an orphan claim-first. Two pulls of this account can both read the
 * orphan as unmapped, so neither may write it on that reading alone. Each
 * first inserts this account's mapping for the remote id; 0018's
 * unique (provider, item_type, external_id, account_id) lets exactly one of
 * them commit (and unique (provider, item_type, local_id, account_id) refuses
 * a second mapping of this account naming the same item). The claim is
 * published PENDING (see pendingAdoption): a pull that meets it on the mapped
 * path refreshes the item and completes it instead of taking the unrefreshed
 * item for the snapshot it names, so an interrupted adoption is never consumed
 * as a completed synchronization. Only the winner refreshes the item, and only
 * while it is still in this account's mirror, still owned by the account
 * owner, and unchanged since the lookup (updated_at, which set_updated_at
 * moves on every write), so a newer snapshot or a concurrent edit is never
 * overwritten. It then completes the mapping, only while it is still its own
 * pending claim. The loser changes nothing and the run fails.
 * The mapping id is chosen here, so a claim whose answer is lost after it
 * committed is recognised as ours instead of wedging. If the refresh does not
 * apply, the claim is released only while it is still pending: once another
 * pull has taken it over or completed it, it is that pull's association and
 * stays. The item is never deleted. A completion that does not apply leaves
 * the claim unfinished and the run fails; the next pull refreshes the item
 * and completes the mapping. */
async function adoptLegacyItem(admin: Admin, account: Account, provider: SyncProviderEnum, kind: Kind,
  externalId: string, orphan: Orphan, mappingFields: { metadata: Json; last_synced_at: string; external_etag?: string | null },
  refresh: (fence: Fence) => PromiseLike<{ data: { id: string } | null; error: unknown }>,
): Promise<string> {
  const ours = { id: crypto.randomUUID(), family_id: account.family_id, account_id: account.id, provider, item_type: kind,
    local_id: orphan.id, external_id: externalId };
  const stillPending = { ...ours, sync_status: 'pending' as const };
  const { error: claimError } = await admin.from('sync_external_mappings')
    .insert({ ...stillPending, metadata: pendingMeta('pending') });
  if (claimError) {
    const { data: committed, error: recheckError } = await admin.from('sync_external_mappings').select('id').match(ours).maybeSingle();
    if (recheckError || !committed) throw new Error(`Sync ${kind} mapping creation failed`);
  }
  const { data: refreshed, error: refreshError } = await refresh({
    id: orphan.id, family_id: account.family_id, user_id: account.user_id as string, provider, external_id: externalId,
    ...(orphan.updated_at ? { updated_at: orphan.updated_at } : {}),
  });
  if (refreshError || !refreshed) {
    // Zero rows released is an answer too: another pull took the claim over or
    // completed it, and it is that pull's association now.
    const { error: releaseError } = await admin.from('sync_external_mappings').delete().match(stillPending).select('id');
    throw new Error(releaseError ? `Sync ${kind} adoption release failed` : `Sync ${kind} retry scope unavailable`);
  }
  const { data: completed, error: completeError } = await admin.from('sync_external_mappings')
    .update({ ...mappingFields, sync_status: 'synced' }).match(stillPending).select('id').maybeSingle();
  requireSyncWrite(completed, completeError, `${kind} mapping completion`);
  return ours.id;
}

/** An item a failed earlier attempt left in this account's mirror without its
 * mapping. The caller only gets here when this account had no mapping for the
 * remote id, so any mapping that names the item belongs to something else.
 * This is only a reading: adoptLegacyItem claims the item before writing it. */
async function findUnmappedLegacyItem(admin: Admin, account: Account, provider: SyncProviderEnum,
  kind: Kind, containerId: string, externalId: string,
): Promise<Orphan | null> {
  const { data: found, error: findError } = kind === 'event'
    ? await admin.from('sync_calendar_events').select('id, user_id, updated_at')
      .eq('calendar_id', containerId).eq('family_id', account.family_id).eq('provider', provider).eq('external_id', externalId).limit(2)
    : await admin.from('sync_reminders').select('id, user_id, updated_at')
      .eq('list_id', containerId).eq('family_id', account.family_id).eq('provider', provider).eq('external_id', externalId).limit(2);
  if (findError || !found) throw new Error(`Sync ${kind} retry lookup failed`);
  if (found.length === 0) return null;
  // This path always inserts with the account owner; an item naming another
  // owner (or none) is not one of its partial writes.
  if (found.length > 1 || found[0].user_id !== account.user_id) throw new Error(`Sync ${kind} retry scope unavailable`);
  const { data: claims, error: claimError } = await admin.from('sync_external_mappings').select('id')
    .eq('item_type', kind).eq('local_id', found[0].id).limit(1);
  if (claimError || !claims) throw new Error(`Sync ${kind} retry lookup failed`);
  if (claims.length > 0) throw new Error(`Sync ${kind} retry scope unavailable`);
  // updated_at is NOT NULL in the schema; a row without one only gets the ownership fence.
  return { id: found[0].id, updated_at: typeof found[0].updated_at === 'string' ? found[0].updated_at : null };
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
