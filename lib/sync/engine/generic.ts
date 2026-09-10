// lib/sync/engine/generic.ts — the PROVIDER-AGNOSTIC two-way sync engine (R9).
//
// The payoff of the adapter contract: ONE pull/push/conflict/mapping loop that
// drives ANY provider through SyncProviderAdapter. It mirrors the proven logic of
// engine/google.ts but never imports a provider module — it calls only the adapter.
// New providers (Microsoft today, Apple/CalDAV next) sync with zero engine changes.
//
// Calendar: provider primary calendar <-> sync_calendar_events.
// Reminders: provider default task list <-> sync_reminders.
// Divergent edits become open sync_conflicts (never silently overwritten). Every
// run is recorded in sync_job_runs; failures land in sync_provider_errors redacted.
//
// SERVER ONLY.

import type { createServiceClient } from '@/lib/supabase/server';
import type { Json, SyncProviderEnum } from '@/lib/database.types';
import type { SyncProviderAdapter } from '@/lib/sync/adapter';
import { SyncApiError } from '@/lib/sync/adapter';
import { detectConflict } from '@/lib/sync/conflict';
import { getProviderAccessToken } from '@/lib/sync/access-token';
import { requireSyncWrite } from '@/lib/sync/persistence';
import { loadSyncExecutionPolicy, type SyncExecutionPolicy } from '@/lib/services/sync/policy';
import { refreshOnboardingCalendar } from '@/lib/services/onboarding-calendar';
import { systemScopeForFamily } from '@/lib/services/scope';

type Admin = ReturnType<typeof createServiceClient>;
type Account = { id: string; user_id: string | null; family_id: string; external_id: string | null };

export type RunResult = { imported: number; exported: number; skipped: number; conflicts: number; error?: string };

const REMOTE_META: Json = { origin: 'remote' };
const hashMeta = (h: string): Json => ({ lastHash: h });

/** Redact anything token-shaped from an error before persisting it. */
function redact(msg: string): string {
  return msg.replace(/(ya29|GOCSPX|EwA|1\/\/|ey[A-Za-z0-9_-]{6,})[A-Za-z0-9._-]+/g, '[redacted]').slice(0, 800);
}

export async function runProviderSync(admin: Admin, account: Account, adapter: SyncProviderAdapter): Promise<RunResult> {
  const provider = adapter.provider;
  const result: RunResult = { imported: 0, exported: 0, skipped: 0, conflicts: 0 };
  const permission = await loadSyncExecutionPolicy(admin, account, adapter.provider);
  if (!permission.ok) return { ...result, error: permission.error };
  const policy = permission.data;

  const { data: job, error: jobError } = await admin
    .from('sync_jobs')
    .insert({ family_id: account.family_id, account_id: account.id, provider, kind: 'manual', status: 'running' })
    .select('id').single();
  if (jobError || !job) throw new Error('Sync job could not be created');
  const { data: run, error: runError } = await admin
    .from('sync_job_runs')
    .insert({ job_id: job.id, family_id: account.family_id, provider, status: 'running' })
    .select('id').single();
  if (runError || !run) throw new Error('Sync run could not be created');
  const startedAt = Date.now();

  try {
    if (policy.mode === 'onboarding_import') {
      const scope = await systemScopeForFamily(admin, account.family_id, { userId: account.user_id });
      if (!scope) throw new Error('The calendar import household was unavailable');
      const imported = await refreshOnboardingCalendar(scope, account.id, adapter);
      if (!imported.ok) throw new Error(imported.error);
      Object.assign(result, imported.data);
    } else {
      const accessToken = await getProviderAccessToken(admin, account.id, adapter);
      await syncCalendar(admin, account, adapter, accessToken, result, policy);
      await syncTasks(admin, account, adapter, accessToken, result, policy);
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
    const status = e instanceof SyncApiError ? e.status : null;
    result.error = msg;
    await admin.from('sync_provider_errors').insert({
      family_id: account.family_id, account_id: account.id, provider,
      code: status ? String(status) : 'sync_failed', message_redacted: msg, http_status: status,
      is_fatal: status === 401 || status === 403,
    });
    if (run) await admin.from('sync_job_runs').update({ status: 'failed', sync_status: 'error', error: msg, finished_at: new Date().toISOString(), duration_ms: Date.now() - startedAt }).eq('id', run.id);
    if (job) await admin.from('sync_jobs').update({ status: 'failed', last_error: msg }).eq('id', job.id);
    await admin.from('sync_connections').update({ health: 'error', sync_status: 'error', last_error: msg }).eq('account_id', account.id);
  }

  return result;
}

// ── Calendar ────────────────────────────────────────────────────────────────
async function syncCalendar(admin: Admin, account: Account, adapter: SyncProviderAdapter, accessToken: string, result: RunResult, policy: Extract<SyncExecutionPolicy, { mode: 'standard' }>) {
  const provider = adapter.provider;
  const calendars = await adapter.listCalendars(accessToken);
  const primary = calendars.find((c) => c.primary) ?? calendars[0];
  if (!primary) return;

  let { data: cal, error: calendarReadError } = await admin
    .from('sync_calendars')
    .select('id, sync_token')
    .eq('family_id', account.family_id).eq('provider', provider).eq('external_id', primary.externalId)
    .maybeSingle();
  if (calendarReadError) throw new Error('Sync calendar lookup failed');
  if (!cal) {
    const { data: created, error: createError } = await admin.from('sync_calendars').insert({
      family_id: account.family_id, user_id: account.user_id, account_id: account.id,
      provider, external_id: primary.externalId, name: primary.name,
      timezone: primary.timezone ?? 'UTC', color: primary.color, is_owned_locally: false,
    }).select('id, sync_token').single();
    cal = requireSyncWrite(created, createError, 'calendar creation');
  }
  if (!cal) return;

  // ── PULL ──
  if (policy.pull) {
    let pull = await adapter.pullEvents(accessToken, primary.externalId, cal.sync_token);
    if (pull.expired) pull = await adapter.pullEvents(accessToken, primary.externalId, null); // cursor expired → full resync

    for (const row of pull.events) {
      const { data: mapping, error: mappingError } = await admin
        .from('sync_external_mappings')
        .select('id, local_id, metadata')
        .eq('account_id', account.id).eq('provider', provider).eq('item_type', 'event').eq('external_id', row.external_id)
        .maybeSingle();
      if (mappingError) throw new Error('Sync event mapping lookup failed');

      if (row.cancelled) {
        if (mapping) {
          const { data: deleted, error: deleteError } = await admin.from('sync_calendar_events')
            .update({ deleted_at: new Date().toISOString(), sync_status: 'synced', metadata: REMOTE_META })
            .eq('id', mapping.local_id).select('id').maybeSingle();
          requireSyncWrite(deleted, deleteError, 'cancelled event update');
          result.imported++;
        } else result.skipped++;
        continue;
      }

      const remoteHash = adapter.eventContentHash(row);
      if (mapping) {
        const { data: local, error: localError } = await admin.from('sync_calendar_events').select('content_hash, updated_at, deleted_at').eq('id', mapping.local_id).maybeSingle();
        if (localError || !local) throw new Error('Sync local event lookup failed');
        const baseHash = (mapping.metadata as { lastHash?: string } | null)?.lastHash ?? null;
        const localHash = local?.content_hash ?? null;
        const verdict = detectConflict({ baseHash, localHash, remoteHash, localUpdatedAt: local?.updated_at, remoteUpdatedAt: row.updated_at ?? undefined, remoteDeleted: false, localDeleted: !!local?.deleted_at });
        if (verdict.conflict) {
          const { data: conflict, error: conflictError } = await admin.from('sync_conflicts').insert({
            family_id: account.family_id, account_id: account.id, provider, item_type: 'event',
            local_id: mapping.local_id, external_id: row.external_id, conflict_kind: verdict.kind,
            remote_snapshot: row as unknown as Json, status: 'open',
          }).select('id').maybeSingle();
          requireSyncWrite(conflict, conflictError, 'event conflict persistence');
          result.conflicts++;
          continue;
        }
        if (localHash === remoteHash) { result.skipped++; continue; }
        const { data: updatedEvent, error: eventUpdateError } = await admin.from('sync_calendar_events').update({
          title: row.title, description: row.description, location: row.location,
          starts_at: row.starts_at, ends_at: row.ends_at, all_day: row.all_day,
          recurrence_rule: row.recurrence_rule, status: row.status, etag: row.etag,
          content_hash: remoteHash, sync_status: 'synced', last_synced_at: new Date().toISOString(), metadata: REMOTE_META,
        }).eq('id', mapping.local_id).select('id').maybeSingle();
        requireSyncWrite(updatedEvent, eventUpdateError, 'event update');
        const { data: updatedMapping, error: mappingUpdateError } = await admin.from('sync_external_mappings')
          .update({ external_etag: row.etag, metadata: hashMeta(remoteHash), last_synced_at: new Date().toISOString() })
          .eq('id', mapping.id).select('id').maybeSingle();
        requireSyncWrite(updatedMapping, mappingUpdateError, 'event mapping update');
        result.imported++;
      } else {
        const { data: inserted, error: insertError } = await admin.from('sync_calendar_events').insert({
          calendar_id: cal.id, family_id: account.family_id, user_id: account.user_id, provider,
          external_id: row.external_id, uid: row.uid, title: row.title, description: row.description, location: row.location,
          starts_at: row.starts_at, ends_at: row.ends_at, all_day: row.all_day, recurrence_rule: row.recurrence_rule,
          status: row.status, etag: row.etag, content_hash: remoteHash, sync_status: 'synced',
          last_synced_at: new Date().toISOString(), metadata: REMOTE_META,
        }).select('id').single();
        const event = requireSyncWrite(inserted, insertError, 'event creation');
        {
          const { data: mappingRow, error: mappingInsertError } = await admin.from('sync_external_mappings').insert({
            family_id: account.family_id, account_id: account.id, provider, item_type: 'event',
            local_id: event.id, external_id: row.external_id, external_etag: row.etag, metadata: hashMeta(remoteHash),
            last_synced_at: new Date().toISOString(),
          }).select('id').maybeSingle();
          requireSyncWrite(mappingRow, mappingInsertError, 'exported event mapping creation');
        }
        result.imported++;
      }
    }

    if (!pull.expired && pull.nextCursor) {
      const { data: cursor, error: cursorError } = await admin.from('sync_calendars')
        .update({ sync_token: pull.nextCursor, last_synced_at: new Date().toISOString(), sync_status: 'synced' })
        .eq('id', cal.id).select('id').maybeSingle();
      requireSyncWrite(cursor, cursorError, 'calendar cursor persistence');
    }

  }
  if (!policy.push) return;

  // ── PUSH (locally-owned events on this calendar) ──
  const { data: locals, error: localsError } = await admin
    .from('sync_calendar_events')
    .select('id, title, description, location, starts_at, ends_at, all_day, recurrence_rule, timezone, content_hash, deleted_at')
    .eq('calendar_id', cal.id).eq('provider', 'internal').limit(500);
  if (localsError) throw new Error('Sync local event list failed');

  for (const ev of locals ?? []) {
    const { data: mapping, error: mappingError } = await admin
      .from('sync_external_mappings')
      .select('id, external_id, metadata')
      .eq('account_id', account.id).eq('provider', provider).eq('item_type', 'event').eq('local_id', ev.id)
      .maybeSingle();
    if (mappingError) throw new Error('Sync event mapping lookup failed');
    const localHash = ev.content_hash ?? adapter.eventContentHash(ev);
    try {
      if (ev.deleted_at && mapping) {
        await adapter.deleteEvent(accessToken, primary.externalId, mapping.external_id);
        const { data: removed, error: removeError } = await admin.from('sync_external_mappings').delete()
          .eq('id', mapping.id).select('id').maybeSingle();
        requireSyncWrite(removed, removeError, 'event mapping deletion');
        result.exported++;
      } else if (!mapping && !ev.deleted_at) {
        const created = await adapter.insertEvent(accessToken, primary.externalId, adapter.rowToEventBody(ev));
        const { data: mappingRow, error: mappingInsertError } = await admin.from('sync_external_mappings').insert({
          family_id: account.family_id, account_id: account.id, provider, item_type: 'event',
          local_id: ev.id, external_id: created.id, external_etag: created.etag, metadata: hashMeta(localHash), last_synced_at: new Date().toISOString(),
        }).select('id').maybeSingle();
        requireSyncWrite(mappingRow, mappingInsertError, 'event mapping creation');
        const { data: updatedEvent, error: eventUpdateError } = await admin.from('sync_calendar_events')
          .update({ content_hash: localHash, sync_status: 'synced', last_synced_at: new Date().toISOString() })
          .eq('id', ev.id).select('id').maybeSingle();
        requireSyncWrite(updatedEvent, eventUpdateError, 'exported event update');
        result.exported++;
      } else if (mapping && (mapping.metadata as { lastHash?: string } | null)?.lastHash !== localHash) {
        const updated = await adapter.patchEvent(accessToken, primary.externalId, mapping.external_id, adapter.rowToEventBody(ev));
        const { data: updatedMapping, error: mappingUpdateError } = await admin.from('sync_external_mappings')
          .update({ external_etag: updated.etag, metadata: hashMeta(localHash), last_synced_at: new Date().toISOString() })
          .eq('id', mapping.id).select('id').maybeSingle();
        requireSyncWrite(updatedMapping, mappingUpdateError, 'exported event mapping update');
        const { data: updatedEvent, error: eventUpdateError } = await admin.from('sync_calendar_events')
          .update({ content_hash: localHash, sync_status: 'synced' }).eq('id', ev.id).select('id').maybeSingle();
        requireSyncWrite(updatedEvent, eventUpdateError, 'exported event update');
        result.exported++;
      } else {
        result.skipped++;
      }
    } catch (e) {
      await admin.from('sync_provider_errors').insert({
        family_id: account.family_id, account_id: account.id, provider, code: 'push_event',
        message_redacted: redact(e instanceof Error ? e.message : String(e)),
        http_status: e instanceof SyncApiError ? e.status : null,
      });
      result.skipped++;
    }
  }
}

// ── Reminders (provider default task list <-> sync_reminders) ────────────────
async function syncTasks(admin: Admin, account: Account, adapter: SyncProviderAdapter, accessToken: string, result: RunResult, policy: Extract<SyncExecutionPolicy, { mode: 'standard' }>) {
  const provider = adapter.provider;
  const listId = await adapter.defaultTaskListId(accessToken);
  if (!listId) return;

  let { data: list, error: listError } = await admin
    .from('sync_reminder_lists')
    .select('id')
    .eq('family_id', account.family_id).eq('provider', provider).eq('external_id', listId)
    .maybeSingle();
  if (listError) throw new Error('Sync reminder list lookup failed');
  if (!list) {
    const { data: created, error: createError } = await admin.from('sync_reminder_lists').insert({
      family_id: account.family_id, user_id: account.user_id, account_id: account.id,
      provider, external_id: listId, name: adapter.label + ' Tasks', is_owned_locally: false,
    }).select('id').single();
    list = requireSyncWrite(created, createError, 'reminder list creation');
  }
  if (!list) return;

  // ── PULL ──
  if (policy.pull) {
    const tasks = await adapter.listTasks(accessToken, listId);
    for (const row of tasks) {
      const { data: mapping, error: mappingError } = await admin
        .from('sync_external_mappings')
        .select('id, local_id, metadata')
        .eq('account_id', account.id).eq('provider', provider).eq('item_type', 'reminder').eq('external_id', row.external_id)
        .maybeSingle();
      if (mappingError) throw new Error('Sync reminder mapping lookup failed');

      if (row.deleted) {
        if (mapping) {
          const { data: deleted, error: deleteError } = await admin.from('sync_reminders')
            .update({ deleted_at: new Date().toISOString(), metadata: REMOTE_META })
            .eq('id', mapping.local_id).select('id').maybeSingle();
          requireSyncWrite(deleted, deleteError, 'deleted reminder update');
          result.imported++;
        }
        else result.skipped++;
        continue;
      }

      const remoteHash = adapter.reminderContentHash(row);
      if (mapping) {
        const { data: local, error: localError } = await admin.from('sync_reminders').select('content_hash, updated_at, is_completed').eq('id', mapping.local_id).maybeSingle();
        if (localError || !local) throw new Error('Sync local reminder lookup failed');
        const baseHash = (mapping.metadata as { lastHash?: string } | null)?.lastHash ?? null;
        const verdict = detectConflict({ baseHash, localHash: local?.content_hash ?? null, remoteHash, localUpdatedAt: local?.updated_at, remoteUpdatedAt: row.updated_at ?? undefined, localCompleted: local?.is_completed, remoteCompleted: row.is_completed });
        if (verdict.conflict) {
          const { data: conflict, error: conflictError } = await admin.from('sync_conflicts').insert({ family_id: account.family_id, account_id: account.id, provider, item_type: 'reminder', local_id: mapping.local_id, external_id: row.external_id, conflict_kind: verdict.kind, remote_snapshot: row as unknown as Json, status: 'open' }).select('id').maybeSingle();
          requireSyncWrite(conflict, conflictError, 'reminder conflict persistence');
          result.conflicts++; continue;
        }
        if ((local?.content_hash ?? null) === remoteHash) { result.skipped++; continue; }
        const { data: updatedReminder, error: reminderUpdateError } = await admin.from('sync_reminders').update({ title: row.title, notes: row.notes, due_at: row.due_at, is_completed: row.is_completed, completed_at: row.completed_at, content_hash: remoteHash, sync_status: 'synced', last_synced_at: new Date().toISOString(), metadata: REMOTE_META }).eq('id', mapping.local_id).select('id').maybeSingle();
        requireSyncWrite(updatedReminder, reminderUpdateError, 'reminder update');
        const { data: updatedMapping, error: mappingUpdateError } = await admin.from('sync_external_mappings').update({ metadata: hashMeta(remoteHash), last_synced_at: new Date().toISOString() }).eq('id', mapping.id).select('id').maybeSingle();
        requireSyncWrite(updatedMapping, mappingUpdateError, 'reminder mapping update');
        result.imported++;
      } else {
        const { data: inserted, error: insertError } = await admin.from('sync_reminders').insert({
          list_id: list.id, family_id: account.family_id, user_id: account.user_id, provider, external_id: row.external_id,
          title: row.title, notes: row.notes, due_at: row.due_at, is_completed: row.is_completed, completed_at: row.completed_at,
          content_hash: remoteHash, sync_status: 'synced', last_synced_at: new Date().toISOString(), metadata: REMOTE_META,
        }).select('id').single();
        const reminder = requireSyncWrite(inserted, insertError, 'reminder creation');
        const { data: mappingRow, error: mappingInsertError } = await admin.from('sync_external_mappings').insert({ family_id: account.family_id, account_id: account.id, provider, item_type: 'reminder', local_id: reminder.id, external_id: row.external_id, metadata: hashMeta(remoteHash), last_synced_at: new Date().toISOString() }).select('id').maybeSingle();
        requireSyncWrite(mappingRow, mappingInsertError, 'reminder mapping creation');
        result.imported++;
      }
    }

  }
  if (!policy.push) return;

  // ── PUSH (locally-owned reminders on this list) ──
  const { data: locals, error: localsError } = await admin
    .from('sync_reminders')
    .select('id, title, notes, due_at, is_completed, content_hash, deleted_at')
    .eq('list_id', list.id).eq('provider', 'internal').limit(500);
  if (localsError) throw new Error('Sync local reminder list failed');

  for (const rem of locals ?? []) {
    const { data: mapping, error: mappingError } = await admin.from('sync_external_mappings').select('id, external_id, metadata').eq('account_id', account.id).eq('provider', provider).eq('item_type', 'reminder').eq('local_id', rem.id).maybeSingle();
    if (mappingError) throw new Error('Sync reminder mapping lookup failed');
    const localHash = rem.content_hash ?? adapter.reminderContentHash(rem);
    try {
      if (rem.deleted_at && mapping) {
        await adapter.deleteTask(accessToken, listId, mapping.external_id);
        const { data: removed, error: removeError } = await admin.from('sync_external_mappings').delete().eq('id', mapping.id).select('id').maybeSingle();
        requireSyncWrite(removed, removeError, 'reminder mapping deletion');
        result.exported++;
      } else if (!mapping && !rem.deleted_at) {
        const created = await adapter.insertTask(accessToken, listId, adapter.rowToTaskBody(rem));
        const { data: mappingRow, error: mappingInsertError } = await admin.from('sync_external_mappings').insert({ family_id: account.family_id, account_id: account.id, provider, item_type: 'reminder', local_id: rem.id, external_id: created.id, metadata: hashMeta(localHash), last_synced_at: new Date().toISOString() }).select('id').maybeSingle();
        requireSyncWrite(mappingRow, mappingInsertError, 'exported reminder mapping creation');
        const { data: updatedReminder, error: reminderUpdateError } = await admin.from('sync_reminders').update({ content_hash: localHash, sync_status: 'synced' }).eq('id', rem.id).select('id').maybeSingle();
        requireSyncWrite(updatedReminder, reminderUpdateError, 'exported reminder update');
        result.exported++;
      } else if (mapping && (mapping.metadata as { lastHash?: string } | null)?.lastHash !== localHash) {
        await adapter.patchTask(accessToken, listId, mapping.external_id, adapter.rowToTaskBody(rem));
        const { data: updatedMapping, error: mappingUpdateError } = await admin.from('sync_external_mappings').update({ metadata: hashMeta(localHash), last_synced_at: new Date().toISOString() }).eq('id', mapping.id).select('id').maybeSingle();
        requireSyncWrite(updatedMapping, mappingUpdateError, 'exported reminder mapping update');
        const { data: updatedReminder, error: reminderUpdateError } = await admin.from('sync_reminders').update({ content_hash: localHash, sync_status: 'synced' }).eq('id', rem.id).select('id').maybeSingle();
        requireSyncWrite(updatedReminder, reminderUpdateError, 'exported reminder update');
        result.exported++;
      } else {
        result.skipped++;
      }
    } catch (e) {
      await admin.from('sync_provider_errors').insert({ family_id: account.family_id, account_id: account.id, provider: provider as SyncProviderEnum, code: 'push_task', message_redacted: redact(e instanceof Error ? e.message : String(e)), http_status: e instanceof SyncApiError ? e.status : null });
      result.skipped++;
    }
  }
}
