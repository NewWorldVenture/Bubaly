// lib/sync/engine/google.ts
//
// Two-way Google sync: Calendar primary <-> sync_calendar_events, and the default
// Google Tasks list <-> sync_reminders. Uses sync_external_mappings as the
// local<->remote backbone and content hashes for change detection; divergent
// edits become open rows in sync_conflicts (never silently overwritten). Every
// run is recorded in sync_job_runs; failures land in sync_provider_errors with
// the message redacted.
//
// SERVER ONLY.

import type { createServiceClient } from '@/lib/supabase/server';
import type { Json } from '@/lib/database.types';
import { getValidAccessToken } from '@/lib/sync/accounts';
import { detectConflict } from '@/lib/sync/conflict';
import {
  listCalendars, pullEvents, insertEvent, patchEvent, deleteEvent,
  listTasks, insertTask, patchTask, deleteTask,
  googleEventToRow, rowToGoogleEvent, eventContentHash,
  googleTaskToReminderRow, reminderRowToGoogleTask, reminderContentHash,
  GoogleApiError,
} from '@/lib/sync/providers/google';
import {
  cancelPendingAdoption, commitLegacyCalendarCursor, completePendingAdoption, createSyncPullItem, ensureSyncPullContainer,
  pendingAdoption, requireSyncWrite, takeOverPendingAdoption,
} from '@/lib/sync/persistence';
import { loadSyncExecutionPolicy, type SyncExecutionPolicy } from '@/lib/services/sync/policy';
import { refreshOnboardingCalendar } from '@/lib/services/onboarding-calendar';
import { systemScopeForFamily } from '@/lib/services/scope';
import { googleAdapter } from '@/lib/sync/providers/google-adapter';
import { logSyncProviderError, recordSyncFailure } from '@/lib/sync/audit';

type Admin = ReturnType<typeof createServiceClient>;
type Account = { id: string; user_id: string | null; family_id: string; external_id: string | null };

export type RunResult = {
  imported: number;
  exported: number;
  skipped: number;
  conflicts: number;
  error?: string;
};

const REMOTE_META: Json = { origin: 'remote' };
const hashMeta = (h: string): Json => ({ lastHash: h });

/** Redact anything token-shaped from an error before persisting it. */
function redact(msg: string): string {
  return msg.replace(/(ya29|GOCSPX|1\/\/|ey[A-Za-z0-9_-]{6,})[A-Za-z0-9._-]+/g, '[redacted]').slice(0, 800);
}

export async function runGoogleSync(admin: Admin, account: Account): Promise<RunResult> {
  const result: RunResult = { imported: 0, exported: 0, skipped: 0, conflicts: 0 };
  const permission = await loadSyncExecutionPolicy(admin, account, 'google');
  if (!permission.ok) return { ...result, error: permission.error };
  const policy = permission.data;

  const { data: job, error: jobError } = await admin
    .from('sync_jobs')
    .insert({ family_id: account.family_id, account_id: account.id, provider: 'google', kind: 'manual', status: 'running' })
    .select('id')
    .single();
  if (jobError || !job) throw new Error('Sync job could not be created');

  const { data: run, error: runError } = await admin
    .from('sync_job_runs')
    .insert({ job_id: job.id, family_id: account.family_id, provider: 'google', status: 'running' })
    .select('id')
    .single();
  if (runError || !run) throw new Error('Sync run could not be created');
  const startedAt = Date.now();

  try {
    if (policy.mode === 'onboarding_import') {
      const scope = await systemScopeForFamily(admin, account.family_id, { userId: account.user_id });
      if (!scope) throw new Error('The calendar import household was unavailable');
      const imported = await refreshOnboardingCalendar(scope, account.id, googleAdapter);
      if (!imported.ok) throw new Error(imported.error);
      Object.assign(result, imported.data);
    } else {
      const accessToken = await getValidAccessToken(admin, account.id);
      const commitCalendarCursor = await syncCalendar(admin, account, accessToken, result, policy);
      await syncTasks(admin, account, accessToken, result, policy);
      await commitCalendarCursor?.();
    }

    const { data: finishedRun, error: runFinishError } = await admin.from('sync_job_runs').update({
        status: 'succeeded', sync_status: 'synced',
        items_imported: result.imported, items_exported: result.exported,
        items_skipped: result.skipped, conflicts_found: result.conflicts,
        finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt,
      }).eq('id', run.id).select('id').maybeSingle();
    if (runFinishError || !finishedRun) throw new Error('Sync run finalization failed');
    const { data: finishedJob, error: jobFinishError } = await admin.from('sync_jobs')
      .update({ status: 'succeeded', last_synced_at: new Date().toISOString() })
      .eq('id', job.id).select('id').maybeSingle();
    if (jobFinishError || !finishedJob) throw new Error('Sync job finalization failed');
    const { data: connection, error: connectionError } = await admin.from('sync_connections')
      .update({ health: 'healthy', sync_status: 'synced', last_error: null, last_synced_at: new Date().toISOString() })
      .eq('account_id', account.id).select('account_id').maybeSingle();
    if (connectionError || !connection) throw new Error('Sync connection finalization failed');
    const { data: accountRow, error: accountError } = await admin.from('sync_accounts')
      .update({ sync_status: 'synced', last_synced_at: new Date().toISOString() })
      .eq('id', account.id).select('id').maybeSingle();
    if (accountError || !accountRow) throw new Error('Sync account finalization failed');
  } catch (e) {
    const msg = redact(e instanceof Error ? e.message : String(e));
    const status = e instanceof GoogleApiError ? e.status : null;
    result.error = msg;
    await logSyncProviderError(admin, {
      family_id: account.family_id, account_id: account.id, provider: 'google',
      code: status ? String(status) : 'sync_failed', message_redacted: msg, http_status: status,
      is_fatal: status === 401 || status === 403,
    });
    // Confirmed and logged, never raised — see recordSyncFailure. Audit C1-S9-68.
    await recordSyncFailure(admin, { runId: run?.id ?? null, jobId: job?.id ?? null, accountId: account.id, message: msg, startedAt });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------
async function syncCalendar(admin: Admin, account: Account, accessToken: string, result: RunResult, policy: Extract<SyncExecutionPolicy, { mode: 'standard' }>) {
  const calendars = await listCalendars(accessToken);
  const primary = calendars.find((c) => c.primary) ?? calendars[0];
  if (!primary) return;

  // Ensure a local sync_calendar mirror exists for the Google primary calendar.
  const cal = await ensureSyncPullContainer(admin, account, 'google', 'event', primary.id, primary.summary ?? 'Google Calendar',
    primary.timeZone ?? 'UTC', primary.backgroundColor ?? null);

  // Commit the cursor only after this account's calendar and task processing
  // succeeds. A rejected scope or unconfirmed write must remain replayable.
  let nextCursor: string | null = null;
  // ----- PULL -----
  if (policy.pull) {
    let pull = await pullEvents(accessToken, primary.id, { syncToken: cal.sync_token });
    if (pull.gone) pull = await pullEvents(accessToken, primary.id, {}); // token expired -> full resync

    for (const ev of pull.events) {
      const row = googleEventToRow(ev);
      if (!row) { result.skipped++; continue; }

      let { data: mapping, error: mappingError } = await admin
        .from('sync_external_mappings')
        .select('id, family_id, local_id, external_id, metadata')
        .eq('account_id', account.id).eq('provider', 'google').eq('item_type', 'event').eq('external_id', row.external_id)
        .maybeSingle();
      if (mappingError) throw new Error('Sync event mapping lookup failed');
    if (mapping && mapping.family_id !== account.family_id) throw new Error('Sync event mapping scope unavailable');

      if (row.cancelled) {
        // A cancellation of an unfinished adoption takes the claim over first,
        // so the claimant can neither release this association nor revive the
        // item afterwards (see cancelPendingAdoption).
        const unfinished = mapping ? pendingAdoption(mapping.metadata) : null;
        if (mapping && unfinished) {
          await cancelPendingAdoption(admin, account, 'google', 'event', cal.id, mapping, unfinished,
            { deleted_at: new Date().toISOString(), sync_status: 'synced', metadata: REMOTE_META });
          result.imported++;
        } else if (mapping) {
          const { data: deleted, error: deleteError } = await admin.from('sync_calendar_events')
            .update({ deleted_at: new Date().toISOString(), sync_status: 'synced', metadata: REMOTE_META })
            .eq('id', mapping.local_id).eq('family_id', account.family_id)
            .eq('calendar_id', cal.id).select('id').maybeSingle();
          requireSyncWrite(deleted, deleteError, 'cancelled event update');
          result.imported++;
        } else result.skipped++;
        continue;
      }

      const remoteHash = eventContentHash(row);
      if (!mapping) {
        const admitted = await createSyncPullItem(admin, account, 'google', 'event', cal.id, row.external_id, {
          uid: row.uid, title: row.title, description: row.description, location: row.location,
          starts_at: row.starts_at, ends_at: row.ends_at, all_day: row.all_day, recurrence_rule: row.recurrence_rule,
          status: row.status, etag: row.etag
        }, remoteHash);
        if (admitted.created) { result.imported++; continue; }
        mapping = admitted.mapping;
      }

      if (mapping) {
        // An unfinished adoption is not a sync receipt: take it over, refresh
        // the item from this snapshot and complete the mapping (see persistence).
        const adopting = pendingAdoption(mapping.metadata);
        const claim = adopting ? await takeOverPendingAdoption(admin, account, 'google', 'event', cal.id, mapping, adopting) : null;
        const { data: local, error: localError } = await admin.from('sync_calendar_events').select('content_hash, updated_at, deleted_at').eq('id', mapping.local_id).eq('family_id', account.family_id).eq('calendar_id', cal.id).maybeSingle();
        if (localError || !local) throw new Error('Sync local event lookup failed');
        const baseHash = (mapping.metadata as { lastHash?: string } | null)?.lastHash ?? null;
        const localHash = local?.content_hash ?? null;
        const verdict = detectConflict({ baseHash, localHash, remoteHash, localUpdatedAt: local?.updated_at, remoteUpdatedAt: ev.updated, remoteDeleted: false, localDeleted: !!local?.deleted_at });
        if (!adopting && verdict.conflict) {
          const { data: conflict, error: conflictError } = await admin.from('sync_conflicts').insert({
            family_id: account.family_id, account_id: account.id, provider: 'google', item_type: 'event',
            local_id: mapping.local_id, external_id: row.external_id, conflict_kind: verdict.kind,
            remote_snapshot: row as unknown as Json, status: 'open',
          }).select('id').maybeSingle();
          requireSyncWrite(conflict, conflictError, 'event conflict persistence');
          result.conflicts++;
          continue;
        }
        if (!adopting && localHash === remoteHash) { result.skipped++; continue; }
        // In two-way sync an unchanged remote snapshot must not erase a local
        // edit. Keep its base hash so the existing push path can export it.
        if (!adopting && policy.push && baseHash === remoteHash) { result.skipped++; continue; }
        const { data: updatedEvent, error: eventUpdateError } = await admin.from('sync_calendar_events').update({
          title: row.title, description: row.description, location: row.location,
          starts_at: row.starts_at, ends_at: row.ends_at, all_day: row.all_day,
          recurrence_rule: row.recurrence_rule, status: row.status, etag: row.etag,
          content_hash: remoteHash, sync_status: 'synced', last_synced_at: new Date().toISOString(), metadata: REMOTE_META,
          ...(adopting ? { deleted_at: null } : {}),
        }).eq('id', mapping.local_id).eq('family_id', account.family_id).eq('calendar_id', cal.id).match(claim?.fence ?? {}).select('id').maybeSingle();
        requireSyncWrite(updatedEvent, eventUpdateError, 'event update');
        if (claim) {
          await completePendingAdoption(admin, account, 'google', 'event', mapping, claim,
            { external_etag: row.etag, metadata: hashMeta(remoteHash), last_synced_at: new Date().toISOString() });
          result.imported++;
          continue;
        }
        const { data: updatedMapping, error: mappingUpdateError } = await admin.from('sync_external_mappings')
          .update({ external_etag: row.etag, metadata: hashMeta(remoteHash), last_synced_at: new Date().toISOString() })
          .eq('id', mapping.id).eq('family_id', account.family_id).eq('account_id', account.id).eq('provider', 'google').eq('item_type', 'event').eq('local_id', mapping.local_id).eq('external_id', mapping.external_id).select('id').maybeSingle();
        requireSyncWrite(updatedMapping, mappingUpdateError, 'event mapping update');
        result.imported++;
      }
    }

    if (!pull.gone && pull.nextSyncToken) nextCursor = pull.nextSyncToken;
    // Without 0494 the previous production order applies: the cursor advances
    // as soon as this calendar's pull succeeds.
    if (cal.legacy && nextCursor) { await commitLegacyCalendarCursor(admin, cal.id, nextCursor); nextCursor = null; }
  }
  const commitCursor = async () => {
    if (nextCursor) {
      const { data: cursor, error: cursorError } = await admin.from('sync_calendars')
        .update({ sync_token: nextCursor, last_synced_at: new Date().toISOString(), sync_status: 'synced' })
        .eq('id', cal.id).eq('family_id', account.family_id).eq('account_id', account.id)
        .eq('provider', 'google').eq('external_id', primary.id).select('id').maybeSingle();
      requireSyncWrite(cursor, cursorError, 'calendar cursor persistence');
    }
  };
  if (!policy.push) return commitCursor;

  // ----- PUSH (locally-owned events on this calendar) -----
  const { data: locals, error: localsError } = await admin
    .from('sync_calendar_events')
    .select('id, title, description, location, starts_at, ends_at, all_day, recurrence_rule, timezone, content_hash, deleted_at')
    .eq('family_id', account.family_id).eq('calendar_id', cal.id).eq('provider', 'internal').limit(500);
  if (localsError) throw new Error('Sync local event list failed');

  for (const ev of locals ?? []) {
    const { data: mapping, error: mappingError } = await admin
      .from('sync_external_mappings')
      .select('id, family_id, local_id, external_id, metadata')
      .eq('account_id', account.id).eq('provider', 'google').eq('item_type', 'event').eq('local_id', ev.id)
      .maybeSingle();
    if (mappingError) throw new Error('Sync event mapping lookup failed');
    if (mapping && mapping.family_id !== account.family_id) throw new Error('Sync event mapping scope unavailable');
    const localHash = ev.content_hash ?? eventContentHash(ev);

    try {
      if (ev.deleted_at && mapping) {
        await deleteEvent(accessToken, primary.id, mapping.external_id);
        const { data: removed, error: removeError } = await admin.from('sync_external_mappings').delete()
          .eq('id', mapping.id).eq('family_id', account.family_id).eq('account_id', account.id).eq('provider', 'google').eq('item_type', 'event').eq('local_id', mapping.local_id).eq('external_id', mapping.external_id).select('id').maybeSingle();
        requireSyncWrite(removed, removeError, 'event mapping deletion');
        result.exported++;
      } else if (!mapping && !ev.deleted_at) {
        const created = await insertEvent(accessToken, primary.id, rowToGoogleEvent(ev));
        const { data: mappingRow, error: mappingInsertError } = await admin.from('sync_external_mappings').insert({
          family_id: account.family_id, account_id: account.id, provider: 'google', item_type: 'event',
          local_id: ev.id, external_id: created.id, external_etag: created.etag, metadata: hashMeta(localHash), last_synced_at: new Date().toISOString(),
        }).select('id').maybeSingle();
        requireSyncWrite(mappingRow, mappingInsertError, 'exported event mapping creation');
        const { data: updatedEvent, error: eventUpdateError } = await admin.from('sync_calendar_events')
          .update({ content_hash: localHash, sync_status: 'synced', last_synced_at: new Date().toISOString() })
          .eq('id', ev.id).eq('family_id', account.family_id).eq('calendar_id', cal.id).select('id').maybeSingle();
        requireSyncWrite(updatedEvent, eventUpdateError, 'exported event update');
        result.exported++;
      } else if (mapping && (mapping.metadata as { lastHash?: string } | null)?.lastHash !== localHash) {
        const updated = await patchEvent(accessToken, primary.id, mapping.external_id, rowToGoogleEvent(ev));
        const { data: updatedMapping, error: mappingUpdateError } = await admin.from('sync_external_mappings')
          .update({ external_etag: updated.etag, metadata: hashMeta(localHash), last_synced_at: new Date().toISOString() })
          .eq('id', mapping.id).eq('family_id', account.family_id).eq('account_id', account.id).eq('provider', 'google').eq('item_type', 'event').eq('local_id', mapping.local_id).eq('external_id', mapping.external_id).select('id').maybeSingle();
        requireSyncWrite(updatedMapping, mappingUpdateError, 'exported event mapping update');
        const { data: updatedEvent, error: eventUpdateError } = await admin.from('sync_calendar_events')
          .update({ content_hash: localHash, sync_status: 'synced' }).eq('id', ev.id).eq('family_id', account.family_id).eq('calendar_id', cal.id).select('id').maybeSingle();
        requireSyncWrite(updatedEvent, eventUpdateError, 'exported event update');
        result.exported++;
      } else {
        result.skipped++;
      }
    } catch (e) {
      // Provider item failures retain their existing recorded/continue path;
      // database or scope failures must fail the run and retain its cursor.
      if (!(e instanceof GoogleApiError)) throw e;
      // Per-item failure: record and continue so one bad event can't abort the run.
      await logSyncProviderError(admin, {
        family_id: account.family_id, account_id: account.id, provider: 'google', code: 'push_event',
        message_redacted: redact(e instanceof Error ? e.message : String(e)),
        http_status: e instanceof GoogleApiError ? e.status : null,
      });
      result.skipped++;
    }
  }
  return commitCursor;
}

// ---------------------------------------------------------------------------
// Tasks  (Google Tasks default list <-> sync_reminders)
// ---------------------------------------------------------------------------
async function syncTasks(admin: Admin, account: Account, accessToken: string, result: RunResult, policy: Extract<SyncExecutionPolicy, { mode: 'standard' }>) {
  const listId = '@default';

  const list = await ensureSyncPullContainer(admin, account, 'google', 'reminder', listId, 'Google Tasks');

  // ----- PULL -----
  if (policy.pull) {
    const tasks = await listTasks(accessToken, listId);
    for (const task of tasks) {
      const row = googleTaskToReminderRow(task);
      let { data: mapping, error: mappingError } = await admin
        .from('sync_external_mappings')
        .select('id, family_id, local_id, external_id, metadata')
        .eq('account_id', account.id).eq('provider', 'google').eq('item_type', 'reminder').eq('external_id', row.external_id)
        .maybeSingle();
      if (mappingError) throw new Error('Sync reminder mapping lookup failed');
    if (mapping && mapping.family_id !== account.family_id) throw new Error('Sync reminder mapping scope unavailable');

      if (row.deleted) {
        // As for a cancelled event: an unfinished adoption is taken over first.
        const unfinished = mapping ? pendingAdoption(mapping.metadata) : null;
        if (mapping && unfinished) {
          await cancelPendingAdoption(admin, account, 'google', 'reminder', list.id, mapping, unfinished,
            { deleted_at: new Date().toISOString(), metadata: REMOTE_META });
          result.imported++;
        } else if (mapping) {
          const { data: deleted, error: deleteError } = await admin.from('sync_reminders')
            .update({ deleted_at: new Date().toISOString(), metadata: REMOTE_META })
            .eq('id', mapping.local_id).eq('family_id', account.family_id).eq('list_id', list.id).select('id').maybeSingle();
          requireSyncWrite(deleted, deleteError, 'deleted reminder update');
          result.imported++;
        }
        else result.skipped++;
        continue;
      }

      const remoteHash = reminderContentHash(row);
      if (!mapping) {
        const admitted = await createSyncPullItem(admin, account, 'google', 'reminder', list.id, row.external_id, {
          title: row.title, notes: row.notes, due_at: row.due_at, is_completed: row.is_completed, completed_at: row.completed_at
        }, remoteHash);
        if (admitted.created) { result.imported++; continue; }
        mapping = admitted.mapping;
      }
      if (mapping) {
        // An unfinished adoption is not a sync receipt: take it over, refresh
        // the item from this snapshot and complete the mapping (see persistence).
        const adopting = pendingAdoption(mapping.metadata);
        const claim = adopting ? await takeOverPendingAdoption(admin, account, 'google', 'reminder', list.id, mapping, adopting) : null;
        const { data: local, error: localError } = await admin.from('sync_reminders').select('content_hash, updated_at, is_completed').eq('id', mapping.local_id).eq('family_id', account.family_id).eq('list_id', list.id).maybeSingle();
        if (localError || !local) throw new Error('Sync local reminder lookup failed');
        const baseHash = (mapping.metadata as { lastHash?: string } | null)?.lastHash ?? null;
        const verdict = detectConflict({ baseHash, localHash: local?.content_hash ?? null, remoteHash, localUpdatedAt: local?.updated_at, remoteUpdatedAt: task.updated, localCompleted: local?.is_completed, remoteCompleted: row.is_completed });
        if (!adopting && verdict.conflict) {
          const { data: conflict, error: conflictError } = await admin.from('sync_conflicts').insert({ family_id: account.family_id, account_id: account.id, provider: 'google', item_type: 'reminder', local_id: mapping.local_id, external_id: row.external_id, conflict_kind: verdict.kind, remote_snapshot: row as unknown as Json, status: 'open' }).select('id').maybeSingle();
          requireSyncWrite(conflict, conflictError, 'reminder conflict persistence');
          result.conflicts++; continue;
        }
        if (!adopting && (local?.content_hash ?? null) === remoteHash) { result.skipped++; continue; }
        if (!adopting && policy.push && baseHash === remoteHash) { result.skipped++; continue; }
        const { data: updatedReminder, error: reminderUpdateError } = await admin.from('sync_reminders').update({ title: row.title, notes: row.notes, due_at: row.due_at, is_completed: row.is_completed, completed_at: row.completed_at, content_hash: remoteHash, sync_status: 'synced', last_synced_at: new Date().toISOString(), metadata: REMOTE_META, ...(adopting ? { deleted_at: null } : {}) }).eq('id', mapping.local_id).eq('family_id', account.family_id).eq('list_id', list.id).match(claim?.fence ?? {}).select('id').maybeSingle();
        requireSyncWrite(updatedReminder, reminderUpdateError, 'reminder update');
        if (claim) {
          await completePendingAdoption(admin, account, 'google', 'reminder', mapping, claim, { metadata: hashMeta(remoteHash), last_synced_at: new Date().toISOString() });
          result.imported++;
          continue;
        }
        const { data: updatedMapping, error: mappingUpdateError } = await admin.from('sync_external_mappings').update({ metadata: hashMeta(remoteHash), last_synced_at: new Date().toISOString() }).eq('id', mapping.id).eq('family_id', account.family_id).eq('account_id', account.id).eq('provider', 'google').eq('item_type', 'reminder').eq('local_id', mapping.local_id).eq('external_id', mapping.external_id).select('id').maybeSingle();
        requireSyncWrite(updatedMapping, mappingUpdateError, 'reminder mapping update');
        result.imported++;
      }
    }

  }
  if (!policy.push) return;

  // ----- PUSH (locally-owned reminders on this list) -----
  const { data: locals, error: localsError } = await admin
    .from('sync_reminders')
    .select('id, title, notes, due_at, is_completed, content_hash, deleted_at')
    .eq('family_id', account.family_id).eq('list_id', list.id).eq('provider', 'internal').limit(500);
  if (localsError) throw new Error('Sync local reminder list failed');

  for (const rem of locals ?? []) {
    const { data: mapping, error: mappingError } = await admin.from('sync_external_mappings').select('id, family_id, local_id, external_id, metadata').eq('account_id', account.id).eq('provider', 'google').eq('item_type', 'reminder').eq('local_id', rem.id).maybeSingle();
    if (mappingError) throw new Error('Sync reminder mapping lookup failed');
    if (mapping && mapping.family_id !== account.family_id) throw new Error('Sync reminder mapping scope unavailable');
    const localHash = rem.content_hash ?? reminderContentHash(rem);
    try {
      if (rem.deleted_at && mapping) {
        await deleteTask(accessToken, listId, mapping.external_id);
        const { data: removed, error: removeError } = await admin.from('sync_external_mappings').delete().eq('id', mapping.id).eq('family_id', account.family_id).eq('account_id', account.id).eq('provider', 'google').eq('item_type', 'reminder').eq('local_id', mapping.local_id).eq('external_id', mapping.external_id).select('id').maybeSingle();
        requireSyncWrite(removed, removeError, 'reminder mapping deletion');
        result.exported++;
      } else if (!mapping && !rem.deleted_at) {
        const created = await insertTask(accessToken, listId, reminderRowToGoogleTask(rem));
        const { data: mappingRow, error: mappingInsertError } = await admin.from('sync_external_mappings').insert({ family_id: account.family_id, account_id: account.id, provider: 'google', item_type: 'reminder', local_id: rem.id, external_id: created.id, metadata: hashMeta(localHash), last_synced_at: new Date().toISOString() }).select('id').maybeSingle();
        requireSyncWrite(mappingRow, mappingInsertError, 'exported reminder mapping creation');
        const { data: updatedReminder, error: reminderUpdateError } = await admin.from('sync_reminders').update({ content_hash: localHash, sync_status: 'synced' }).eq('id', rem.id).eq('family_id', account.family_id).eq('list_id', list.id).select('id').maybeSingle();
        requireSyncWrite(updatedReminder, reminderUpdateError, 'exported reminder update');
        result.exported++;
      } else if (mapping && (mapping.metadata as { lastHash?: string } | null)?.lastHash !== localHash) {
        await patchTask(accessToken, listId, mapping.external_id, reminderRowToGoogleTask(rem));
        const { data: updatedMapping, error: mappingUpdateError } = await admin.from('sync_external_mappings').update({ metadata: hashMeta(localHash), last_synced_at: new Date().toISOString() }).eq('id', mapping.id).eq('family_id', account.family_id).eq('account_id', account.id).eq('provider', 'google').eq('item_type', 'reminder').eq('local_id', mapping.local_id).eq('external_id', mapping.external_id).select('id').maybeSingle();
        requireSyncWrite(updatedMapping, mappingUpdateError, 'exported reminder mapping update');
        const { data: updatedReminder, error: reminderUpdateError } = await admin.from('sync_reminders').update({ content_hash: localHash, sync_status: 'synced' }).eq('id', rem.id).eq('family_id', account.family_id).eq('list_id', list.id).select('id').maybeSingle();
        requireSyncWrite(updatedReminder, reminderUpdateError, 'exported reminder update');
        result.exported++;
      } else {
        result.skipped++;
      }
    } catch (e) {
      if (!(e instanceof GoogleApiError)) throw e;
      await logSyncProviderError(admin, { family_id: account.family_id, account_id: account.id, provider: 'google', code: 'push_task', message_redacted: redact(e instanceof Error ? e.message : String(e)), http_status: e instanceof GoogleApiError ? e.status : null });
      result.skipped++;
    }
  }
}
