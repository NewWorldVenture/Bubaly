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
import { decryptSecret, encryptSecret } from '@/lib/sync/crypto';

type Admin = ReturnType<typeof createServiceClient>;
type Account = { id: string; user_id: string | null; family_id: string; external_id: string | null };

export type RunResult = { imported: number; exported: number; skipped: number; conflicts: number; error?: string };

const REMOTE_META: Json = { origin: 'remote' };
const hashMeta = (h: string): Json => ({ lastHash: h });

/** Redact anything token-shaped from an error before persisting it. */
function redact(msg: string): string {
  return msg.replace(/(ya29|GOCSPX|EwA|1\/\/|ey[A-Za-z0-9_-]{6,})[A-Za-z0-9._-]+/g, '[redacted]').slice(0, 800);
}

/**
 * Provider-agnostic valid-access-token getter. Reads the encrypted token, returns
 * it if still fresh, otherwise refreshes via the ADAPTER and persists the new one.
 */
async function getValidAccessToken(admin: Admin, accountId: string, adapter: SyncProviderAdapter): Promise<string> {
  const { data: tok, error } = await admin
    .from('sync_tokens')
    .select('access_token_enc, refresh_token_enc, expires_at')
    .eq('account_id', accountId)
    .maybeSingle();
  if (error || !tok || !tok.access_token_enc) throw new Error('No stored token for this account — reconnect required.');

  const expiresAt = tok.expires_at ? new Date(tok.expires_at).getTime() : 0;
  if (expiresAt - 120_000 > Date.now()) return decryptSecret(tok.access_token_enc);

  if (!tok.refresh_token_enc) throw new Error('Access token expired and no refresh token — reconnect required.');
  const refreshed = await adapter.refreshAccessToken(decryptSecret(tok.refresh_token_enc));
  const { data: updatedToken, error: tokenError } = await admin.from('sync_tokens').update({
    access_token_enc: encryptSecret(refreshed.accessToken),
    refresh_token_enc: refreshed.refreshToken ? encryptSecret(refreshed.refreshToken) : tok.refresh_token_enc,
    expires_at: new Date(refreshed.expiresAt).toISOString(),
    last_synced_at: new Date().toISOString(),
  }).eq('account_id', accountId).select('account_id').maybeSingle();
  if (tokenError || !updatedToken) throw new Error('Failed to persist the refreshed sync token');
  return refreshed.accessToken;
}

export async function runProviderSync(admin: Admin, account: Account, adapter: SyncProviderAdapter): Promise<RunResult> {
  const provider = adapter.provider;
  const result: RunResult = { imported: 0, exported: 0, skipped: 0, conflicts: 0 };

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
    const accessToken = await getValidAccessToken(admin, account.id, adapter);
    await syncCalendar(admin, account, adapter, accessToken, result);
    await syncTasks(admin, account, adapter, accessToken, result);

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
async function syncCalendar(admin: Admin, account: Account, adapter: SyncProviderAdapter, accessToken: string, result: RunResult) {
  const provider = adapter.provider;
  const calendars = await adapter.listCalendars(accessToken);
  const primary = calendars.find((c) => c.primary) ?? calendars[0];
  if (!primary) return;

  let { data: cal } = await admin
    .from('sync_calendars')
    .select('id, sync_token')
    .eq('family_id', account.family_id).eq('provider', provider).eq('external_id', primary.externalId)
    .maybeSingle();
  if (!cal) {
    const { data: created } = await admin.from('sync_calendars').insert({
      family_id: account.family_id, user_id: account.user_id, account_id: account.id,
      provider, external_id: primary.externalId, name: primary.name,
      timezone: primary.timezone ?? 'UTC', color: primary.color, is_owned_locally: false,
    }).select('id, sync_token').single();
    cal = created;
  }
  if (!cal) return;

  // ── PULL ──
  let pull = await adapter.pullEvents(accessToken, primary.externalId, cal.sync_token);
  if (pull.expired) pull = await adapter.pullEvents(accessToken, primary.externalId, null); // cursor expired → full resync

  for (const row of pull.events) {
    const { data: mapping } = await admin
      .from('sync_external_mappings')
      .select('id, local_id, metadata')
      .eq('account_id', account.id).eq('provider', provider).eq('item_type', 'event').eq('external_id', row.external_id)
      .maybeSingle();

    if (row.cancelled) {
      if (mapping) {
        await admin.from('sync_calendar_events').update({ deleted_at: new Date().toISOString(), sync_status: 'synced', metadata: REMOTE_META }).eq('id', mapping.local_id);
        result.imported++;
      } else result.skipped++;
      continue;
    }

    const remoteHash = adapter.eventContentHash(row);
    if (mapping) {
      const { data: local } = await admin.from('sync_calendar_events').select('content_hash, updated_at, deleted_at').eq('id', mapping.local_id).maybeSingle();
      const baseHash = (mapping.metadata as { lastHash?: string } | null)?.lastHash ?? null;
      const localHash = local?.content_hash ?? null;
      const verdict = detectConflict({ baseHash, localHash, remoteHash, localUpdatedAt: local?.updated_at, remoteUpdatedAt: row.updated_at ?? undefined, remoteDeleted: false, localDeleted: !!local?.deleted_at });
      if (verdict.conflict) {
        await admin.from('sync_conflicts').insert({
          family_id: account.family_id, account_id: account.id, provider, item_type: 'event',
          local_id: mapping.local_id, external_id: row.external_id, conflict_kind: verdict.kind,
          remote_snapshot: row as unknown as Json, status: 'open',
        });
        result.conflicts++;
        continue;
      }
      if (localHash === remoteHash) { result.skipped++; continue; }
      await admin.from('sync_calendar_events').update({
        title: row.title, description: row.description, location: row.location,
        starts_at: row.starts_at, ends_at: row.ends_at, all_day: row.all_day,
        recurrence_rule: row.recurrence_rule, status: row.status, etag: row.etag,
        content_hash: remoteHash, sync_status: 'synced', last_synced_at: new Date().toISOString(), metadata: REMOTE_META,
      }).eq('id', mapping.local_id);
      await admin.from('sync_external_mappings').update({ external_etag: row.etag, metadata: hashMeta(remoteHash), last_synced_at: new Date().toISOString() }).eq('id', mapping.id);
      result.imported++;
    } else {
      const { data: inserted } = await admin.from('sync_calendar_events').insert({
        calendar_id: cal.id, family_id: account.family_id, user_id: account.user_id, provider,
        external_id: row.external_id, uid: row.uid, title: row.title, description: row.description, location: row.location,
        starts_at: row.starts_at, ends_at: row.ends_at, all_day: row.all_day, recurrence_rule: row.recurrence_rule,
        status: row.status, etag: row.etag, content_hash: remoteHash, sync_status: 'synced',
        last_synced_at: new Date().toISOString(), metadata: REMOTE_META,
      }).select('id').single();
      if (inserted) {
        await admin.from('sync_external_mappings').insert({
          family_id: account.family_id, account_id: account.id, provider, item_type: 'event',
          local_id: inserted.id, external_id: row.external_id, external_etag: row.etag, metadata: hashMeta(remoteHash),
          last_synced_at: new Date().toISOString(),
        });
        result.imported++;
      }
    }
  }

  if (!pull.expired && pull.nextCursor) {
    await admin.from('sync_calendars').update({ sync_token: pull.nextCursor, last_synced_at: new Date().toISOString(), sync_status: 'synced' }).eq('id', cal.id);
  }

  // ── PUSH (locally-owned events on this calendar) ──
  const { data: locals } = await admin
    .from('sync_calendar_events')
    .select('id, title, description, location, starts_at, ends_at, all_day, recurrence_rule, timezone, content_hash, deleted_at')
    .eq('calendar_id', cal.id).eq('provider', 'internal').limit(500);

  for (const ev of locals ?? []) {
    const { data: mapping } = await admin
      .from('sync_external_mappings')
      .select('id, external_id, metadata')
      .eq('account_id', account.id).eq('provider', provider).eq('item_type', 'event').eq('local_id', ev.id)
      .maybeSingle();
    const localHash = ev.content_hash ?? adapter.eventContentHash(ev);
    try {
      if (ev.deleted_at && mapping) {
        await adapter.deleteEvent(accessToken, primary.externalId, mapping.external_id);
        await admin.from('sync_external_mappings').delete().eq('id', mapping.id);
        result.exported++;
      } else if (!mapping && !ev.deleted_at) {
        const created = await adapter.insertEvent(accessToken, primary.externalId, adapter.rowToEventBody(ev));
        await admin.from('sync_external_mappings').insert({
          family_id: account.family_id, account_id: account.id, provider, item_type: 'event',
          local_id: ev.id, external_id: created.id, external_etag: created.etag, metadata: hashMeta(localHash), last_synced_at: new Date().toISOString(),
        });
        await admin.from('sync_calendar_events').update({ content_hash: localHash, sync_status: 'synced', last_synced_at: new Date().toISOString() }).eq('id', ev.id);
        result.exported++;
      } else if (mapping && (mapping.metadata as { lastHash?: string } | null)?.lastHash !== localHash) {
        const updated = await adapter.patchEvent(accessToken, primary.externalId, mapping.external_id, adapter.rowToEventBody(ev));
        await admin.from('sync_external_mappings').update({ external_etag: updated.etag, metadata: hashMeta(localHash), last_synced_at: new Date().toISOString() }).eq('id', mapping.id);
        await admin.from('sync_calendar_events').update({ content_hash: localHash, sync_status: 'synced' }).eq('id', ev.id);
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
async function syncTasks(admin: Admin, account: Account, adapter: SyncProviderAdapter, accessToken: string, result: RunResult) {
  const provider = adapter.provider;
  const listId = await adapter.defaultTaskListId(accessToken);
  if (!listId) return;

  let { data: list } = await admin
    .from('sync_reminder_lists')
    .select('id')
    .eq('family_id', account.family_id).eq('provider', provider).eq('external_id', listId)
    .maybeSingle();
  if (!list) {
    const { data: created } = await admin.from('sync_reminder_lists').insert({
      family_id: account.family_id, user_id: account.user_id, account_id: account.id,
      provider, external_id: listId, name: adapter.label + ' Tasks', is_owned_locally: false,
    }).select('id').single();
    list = created;
  }
  if (!list) return;

  // ── PULL ──
  const tasks = await adapter.listTasks(accessToken, listId);
  for (const row of tasks) {
    const { data: mapping } = await admin
      .from('sync_external_mappings')
      .select('id, local_id, metadata')
      .eq('account_id', account.id).eq('provider', provider).eq('item_type', 'reminder').eq('external_id', row.external_id)
      .maybeSingle();

    if (row.deleted) {
      if (mapping) { await admin.from('sync_reminders').update({ deleted_at: new Date().toISOString(), metadata: REMOTE_META }).eq('id', mapping.local_id); result.imported++; }
      else result.skipped++;
      continue;
    }

    const remoteHash = adapter.reminderContentHash(row);
    if (mapping) {
      const { data: local } = await admin.from('sync_reminders').select('content_hash, updated_at, is_completed').eq('id', mapping.local_id).maybeSingle();
      const baseHash = (mapping.metadata as { lastHash?: string } | null)?.lastHash ?? null;
      const verdict = detectConflict({ baseHash, localHash: local?.content_hash ?? null, remoteHash, localUpdatedAt: local?.updated_at, remoteUpdatedAt: row.updated_at ?? undefined, localCompleted: local?.is_completed, remoteCompleted: row.is_completed });
      if (verdict.conflict) {
        await admin.from('sync_conflicts').insert({ family_id: account.family_id, account_id: account.id, provider, item_type: 'reminder', local_id: mapping.local_id, external_id: row.external_id, conflict_kind: verdict.kind, remote_snapshot: row as unknown as Json, status: 'open' });
        result.conflicts++; continue;
      }
      if ((local?.content_hash ?? null) === remoteHash) { result.skipped++; continue; }
      await admin.from('sync_reminders').update({ title: row.title, notes: row.notes, due_at: row.due_at, is_completed: row.is_completed, completed_at: row.completed_at, content_hash: remoteHash, sync_status: 'synced', last_synced_at: new Date().toISOString(), metadata: REMOTE_META }).eq('id', mapping.local_id);
      await admin.from('sync_external_mappings').update({ metadata: hashMeta(remoteHash), last_synced_at: new Date().toISOString() }).eq('id', mapping.id);
      result.imported++;
    } else {
      const { data: inserted } = await admin.from('sync_reminders').insert({
        list_id: list.id, family_id: account.family_id, user_id: account.user_id, provider, external_id: row.external_id,
        title: row.title, notes: row.notes, due_at: row.due_at, is_completed: row.is_completed, completed_at: row.completed_at,
        content_hash: remoteHash, sync_status: 'synced', last_synced_at: new Date().toISOString(), metadata: REMOTE_META,
      }).select('id').single();
      if (inserted) {
        await admin.from('sync_external_mappings').insert({ family_id: account.family_id, account_id: account.id, provider, item_type: 'reminder', local_id: inserted.id, external_id: row.external_id, metadata: hashMeta(remoteHash), last_synced_at: new Date().toISOString() });
        result.imported++;
      }
    }
  }

  // ── PUSH (locally-owned reminders on this list) ──
  const { data: locals } = await admin
    .from('sync_reminders')
    .select('id, title, notes, due_at, is_completed, content_hash, deleted_at')
    .eq('list_id', list.id).eq('provider', 'internal').limit(500);

  for (const rem of locals ?? []) {
    const { data: mapping } = await admin.from('sync_external_mappings').select('id, external_id, metadata').eq('account_id', account.id).eq('provider', provider).eq('item_type', 'reminder').eq('local_id', rem.id).maybeSingle();
    const localHash = rem.content_hash ?? adapter.reminderContentHash(rem);
    try {
      if (rem.deleted_at && mapping) {
        await adapter.deleteTask(accessToken, listId, mapping.external_id);
        await admin.from('sync_external_mappings').delete().eq('id', mapping.id);
        result.exported++;
      } else if (!mapping && !rem.deleted_at) {
        const created = await adapter.insertTask(accessToken, listId, adapter.rowToTaskBody(rem));
        await admin.from('sync_external_mappings').insert({ family_id: account.family_id, account_id: account.id, provider, item_type: 'reminder', local_id: rem.id, external_id: created.id, metadata: hashMeta(localHash), last_synced_at: new Date().toISOString() });
        await admin.from('sync_reminders').update({ content_hash: localHash, sync_status: 'synced' }).eq('id', rem.id);
        result.exported++;
      } else if (mapping && (mapping.metadata as { lastHash?: string } | null)?.lastHash !== localHash) {
        await adapter.patchTask(accessToken, listId, mapping.external_id, adapter.rowToTaskBody(rem));
        await admin.from('sync_external_mappings').update({ metadata: hashMeta(localHash), last_synced_at: new Date().toISOString() }).eq('id', mapping.id);
        await admin.from('sync_reminders').update({ content_hash: localHash, sync_status: 'synced' }).eq('id', rem.id);
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
