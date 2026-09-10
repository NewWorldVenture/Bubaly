import 'server-only';
import type { Json } from '@/lib/database.types';
import type { NormalizedEvent, SyncProviderAdapter } from '@/lib/sync/adapter';
import type { BriefEvent } from '@/lib/onboarding/first-brief';
import { getTranslations } from '@/lib/i18n/server';
import { getProviderAccessToken } from '@/lib/sync/access-token';
import { onboardingRunKey } from '@/lib/onboarding/idempotency';
import { sealCalendarPreview, type CalendarPreviewReceipt } from '@/lib/onboarding/calendar-state';
import { fail, ok, SERVICE_CODES, type ServiceResult, type ServiceScope } from '@/lib/services/types';
import { dayKeyInTz, zonedDayBoundsMs } from '@/lib/services/scope';
import { assertOnboardingCalendarAccess } from './access';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
async function unavailable() { return fail((await getTranslations())('connectedCalendar.unavailable'), { code: SERVICE_CODES.db, retryable: true }); }
function report(error: unknown) { console.error('[onboarding-calendar] operation failed', { kind: error instanceof Error ? error.name : 'unavailable' }); }
export const connectedEventKey = (accountId: string, calendarId: string, externalId: string) => onboardingRunKey(accountId, { kind: 'connected_calendar_event', calendarId, externalId });

async function ownedAccount(scope: ServiceScope, accountId: string) {
  if (!scope.userId || scope.actorKind === 'ai') throw new Error('Calendar ownership unavailable');
  const [account, member] = await Promise.all([
    scope.db.from('sync_accounts').select('id, updated_at, user_id, family_id, provider, metadata, sync_direction').eq('id', accountId).eq('user_id', scope.userId).eq('family_id', scope.familyId).maybeSingle(),
    scope.db.from('family_members').select('id, role').eq('user_id', scope.userId).eq('family_id', scope.familyId).eq('is_active', true).maybeSingle(),
  ]);
  if (account.error || !account.data || member.error || member.data?.role !== 'parent') throw new Error('Calendar ownership unavailable');
  const marker = object(object(account.data.metadata).onboardingCalendar);
  if (marker.version !== 1 || !['preview', 'import'].includes(String(marker.state)) ||
    (marker.state === 'preview' ? account.data.sync_direction !== 'manual' : account.data.sync_direction !== 'import')) throw new Error('Calendar connection is not available for import');
  await assertOnboardingCalendarAccess(scope);
  return { account: account.data, marker };
}

function normalizeEvent(row: NormalizedEvent, untitled: string): BriefEvent {
  const start = Date.parse(row.starts_at);
  const end = row.ends_at ? Date.parse(row.ends_at) : null;
  if (!row.external_id || !Number.isFinite(start) || (end !== null && (!Number.isFinite(end) || end < start))) throw new Error('Calendar event timing unavailable');
  return { title: (row.title.trim() || untitled).slice(0, 200), start: new Date(start).toISOString(),
    end: end === null ? null : new Date(end).toISOString(), allDay: row.all_day,
    location: row.location?.slice(0, 200) ?? null, recurring: !!row.recurrence_rule };
}
type ImportRow = { key: string; event: BriefEvent; cancelled: boolean };
async function pullCalendar(scope: ServiceScope, accountId: string, adapter: SyncProviderAdapter, calendarId?: string) {
  const token = await getProviderAccessToken(scope.db, accountId, adapter);
  const calendars = await adapter.listCalendars(token);
  // The UI explicitly offers the primary calendar. Never silently substitute
  // another calendar if the selected/primary one cannot be identified.
  const calendar = calendarId ? calendars.find((row) => row.externalId === calendarId) : calendars.find((row) => row.primary);
  if (!calendar) throw new Error('Primary calendar unavailable');
  if (!adapter.pullCalendarWindow) throw new Error('Calendar window unavailable');
  // Validate before the shared date helpers, whose general-purpose fallback is
  // unsuitable for a provider import that promises a specific family-local day.
  new Intl.DateTimeFormat('en-US', { timeZone: scope.tz });
  const firstDay = dayKeyInTz(scope.now ?? new Date(), scope.tz);
  const finalDay = new Date(Date.parse(`${firstDay}T12:00:00Z`) + 30 * 86400_000).toISOString().slice(0, 10);
  const from = new Date(zonedDayBoundsMs(firstDay, scope.tz).start).toISOString();
  const to = new Date(zonedDayBoundsMs(finalDay, scope.tz).start).toISOString();
  const events = await adapter.pullCalendarWindow(token, calendar.externalId, from, to);
  const seen = new Set<string>();
  const rows: ImportRow[] = [];
  const untitled = (await getTranslations())('inboxQueue.untitled');
  for (const row of events) {
    if (typeof row.external_id !== 'string' || !row.external_id.trim()) throw new Error('Calendar event identity unavailable');
    const key = connectedEventKey(accountId, calendar.externalId, row.external_id);
    if (seen.has(key)) throw new Error('Calendar returned duplicate event identities');
    seen.add(key);
    // Tombstones often omit dates; a cancellation only needs its stable key.
    rows.push({ key, cancelled: row.cancelled, event: row.cancelled ? { title: '', start: '' } : normalizeEvent(row, untitled) });
  }
  if (rows.filter((row) => !row.cancelled).length > 1000) throw new Error('Calendar preview is too large');
  return { calendar, rows };
}

/** Read-only provider preview. No calendar rows or sync cursors are written. */
export async function previewConnectedCalendar(scope: ServiceScope, accountId: string, adapter: SyncProviderAdapter): Promise<ServiceResult<{ events: BriefEvent[]; receipt: string; calendarName: string }>> {
  try {
    const { account, marker } = await ownedAccount(scope, accountId);
    if (marker.state !== 'preview' || account.provider !== adapter.provider || !['google', 'microsoft'].includes(adapter.provider)) throw new Error('Calendar preview unavailable');
    const { calendar, rows } = await pullCalendar(scope, accountId, adapter);
    await assertOnboardingCalendarAccess(scope);
    const active = rows.filter((row) => !row.cancelled);
    const events = active.map((row) => row.event);
    return ok({ events, calendarName: calendar.name, receipt: sealCalendarPreview({ userId: scope.userId!, familyId: scope.familyId,
      accountId, provider: adapter.provider as 'google' | 'microsoft', calendarExternalId: calendar.externalId, eventKeys: active.map((row) => row.key) }, events, scope.now?.getTime()) });
  } catch (error) { report(error); return unavailable(); }
}

type ImportCounts = { imported: number; exported: 0; skipped: number; conflicts: number };
const fields = (event: BriefEvent) => ({ title: event.title, starts_at: event.start, ends_at: event.end ?? null, all_day: !!event.allDay, location: event.location ?? null });
const eventHash = (row: ReturnType<typeof fields>) => onboardingRunKey('connected-calendar', {
  title: row.title, all_day: row.all_day, location: row.location,
  starts_at: new Date(row.starts_at).toISOString(), ends_at: row.ends_at ? new Date(row.ends_at).toISOString() : null,
});
const managedFields = new Set(['title', 'starts_at', 'ends_at', 'all_day', 'location', 'created_at', 'updated_at']);
const localFieldsHash = (row: Record<string, unknown>) => onboardingRunKey('connected-calendar-local-fields',
  Object.fromEntries(Object.entries(row).filter(([key]) => !managedFields.has(key))));

/** Single canonical materializer shared by Finish and future import-only runs.
 * Imported rows live in calendar_events. Mapping hashes preserve local edits. */
async function writeEvents(scope: ServiceScope, accountId: string, provider: 'google' | 'microsoft', rows: ImportRow[]): Promise<ImportCounts> {
  // Refresh may have waited on the provider since its initial access proof.
  await assertOnboardingCalendarAccess(scope);
  const result: ImportCounts = { imported: 0, exported: 0, skipped: 0, conflicts: 0 };
  for (const row of rows) {
    const mapping = await scope.db.from('sync_external_mappings').select('id, local_id, metadata')
      .eq('family_id', scope.familyId).eq('account_id', accountId).eq('provider', provider).eq('item_type', 'event').eq('external_id', row.key).maybeSingle();
    if (mapping.error) throw mapping.error;
    const existing = await scope.db.from('calendar_events').select('*')
      .eq('family_id', scope.familyId).eq('onboarding_key', row.key).maybeSingle();
    if (existing.error) throw existing.error;
    const prior = object(mapping.data?.metadata);
    if (mapping.data && (prior.sourceTable !== 'calendar_events' || (existing.data && mapping.data.local_id !== existing.data.id))) throw new Error('Calendar mapping unavailable');
    const incomingHash = row.cancelled ? null : eventHash(fields(row.event));
    // Repair a partial previous write only when the row already matches this
    // exact remote version. Different local edits and deletions are preserved.
    if (mapping.data && !existing.data) {
      if (row.cancelled) {
        if (prior.cancelled !== true) {
          const repaired = await scope.db.from('sync_external_mappings').update({ metadata: { ...prior, cancelled: true } as Json })
            .eq('id', mapping.data.id).eq('family_id', scope.familyId).select('id').maybeSingle();
          if (repaired.error || !repaired.data) throw repaired.error ?? new Error('Calendar cancellation receipt unavailable');
        }
        result.skipped++; continue;
      }
      result.conflicts++; continue;
    }
    if (mapping.data && existing.data && prior.lastHash !== eventHash(existing.data) && incomingHash !== eventHash(existing.data)) { result.conflicts++; continue; }
    if (row.cancelled) {
      if (!existing.data) { result.skipped++; continue; }
      if (!mapping.data) { result.conflicts++; continue; }
      // A cancellation deletes the whole row, including fields the importer
      // never updates. Preserve category, notes, attendance and any other local
      // edits as well as the managed content fields checked above.
      if (prior.localFieldsHash !== localFieldsHash(existing.data)) { result.conflicts++; continue; }
      const deleted = await scope.db.from('calendar_events').delete().eq('id', existing.data.id).eq('family_id', scope.familyId).eq('updated_at', existing.data.updated_at).select('id').maybeSingle();
      if (deleted.error) throw deleted.error;
      if (!deleted.data) { result.conflicts++; continue; }
      const marked = await scope.db.from('sync_external_mappings').update({ metadata: { ...prior, cancelled: true } as Json })
        .eq('id', mapping.data!.id).eq('family_id', scope.familyId).select('id').maybeSingle();
      if (marked.error || !marked.data) throw marked.error ?? new Error('Calendar cancellation receipt unavailable');
      result.imported++; continue;
    }
    const values = fields(row.event);
    const hash = eventHash(values);
    let eventId = existing.data?.id;
    let savedRow: Record<string, unknown> | null = existing.data;
    if (existing.data) {
      if (eventHash(existing.data) === hash) { result.skipped++; }
      else if (!mapping.data) { result.conflicts++; continue; }
      else {
        const updated = await scope.db.from('calendar_events').update(values).eq('id', existing.data.id).eq('family_id', scope.familyId).eq('updated_at', existing.data.updated_at).select('*').maybeSingle();
        if (updated.error) throw updated.error;
        if (!updated.data) { result.conflicts++; continue; }
        savedRow = updated.data;
        result.imported++;
      }
    } else {
      const inserted = await scope.db.from('calendar_events').insert({ ...values, family_id: scope.familyId, created_by: scope.userId,
        category: 'general', recurrence: 'none', onboarding_key: row.key }).select('*').maybeSingle();
      if (inserted.error || !inserted.data) throw inserted.error ?? new Error('Calendar event was not saved');
      eventId = inserted.data.id;
      savedRow = inserted.data;
      result.imported++;
    }
    const savedMapping = await scope.db.from('sync_external_mappings').upsert({ family_id: scope.familyId, user_id: scope.userId,
      account_id: accountId, provider, item_type: 'event', external_id: row.key, local_id: eventId!, sync_direction: 'import',
      // An orphaned row may have been edited after our first insert but before
      // a failed mapping write. Repair the identity, but never adopt its current
      // local fields as proof that a later remote deletion is safe.
      metadata: { sourceTable: 'calendar_events', lastHash: hash,
        ...(mapping.data ? typeof prior.localFieldsHash === 'string' ? { localFieldsHash: prior.localFieldsHash } : {}
          : existing.data ? {} : { localFieldsHash: localFieldsHash(savedRow!) }) }, last_synced_at: new Date().toISOString(),
    }, { onConflict: 'provider,item_type,external_id,account_id' }).select('id').maybeSingle();
    if (savedMapping.error || !savedMapping.data) throw savedMapping.error ?? new Error('Calendar mapping was not saved');
  }
  return result;
}

export async function finishConnectedCalendar(scope: ServiceScope, receipt: CalendarPreviewReceipt, events: BriefEvent[]): Promise<ServiceResult<ImportCounts>> {
  try {
    const { account, marker } = await ownedAccount(scope, receipt.accountId);
    if (account.provider !== receipt.provider || receipt.familyId !== scope.familyId || receipt.userId !== scope.userId ||
      receipt.eventKeys.length !== events.length || receipt.digest !== onboardingRunKey(scope.userId!, events) ||
      (marker.state === 'import' && marker.calendarExternalId !== receipt.calendarExternalId)) throw new Error('Calendar preview ownership changed');
    const result = await writeEvents(scope, account.id, receipt.provider, events.map((event, index) => ({ event, key: receipt.eventKeys[index], cancelled: false })));
    if (result.conflicts > 0) return fail((await getTranslations())('connectedCalendar.localChanges'), { code: SERVICE_CODES.invalidInput });
    return ok(result);
  } catch (error) { report(error); return unavailable(); }
}

export async function validateConnectedCalendarReceipt(scope: ServiceScope, receipt: CalendarPreviewReceipt): Promise<ServiceResult<undefined>> {
  try {
    const { account } = await ownedAccount(scope, receipt.accountId);
    if (receipt.familyId !== scope.familyId || receipt.userId !== scope.userId || receipt.provider !== account.provider) throw new Error('Calendar preview ownership changed');
    const [prefs, progress] = await Promise.all([
      scope.db.from('user_preferences').select('active_family_id').eq('user_id', scope.userId!).maybeSingle(),
      scope.db.from('onboarding_progress').select('family_id, source, status').eq('user_id', scope.userId!).maybeSingle(),
    ]);
    if (prefs.error || prefs.data?.active_family_id !== scope.familyId || progress.error || progress.data?.family_id !== scope.familyId ||
      progress.data.source !== 'wizard' || !['in_progress', 'completed'].includes(progress.data.status)) throw new Error('Calendar setup context changed');
    return ok(undefined);
  } catch (error) { report(error); return unavailable(); }
}

/** Enable imports only after every required Finish write succeeds. */
export async function enableConnectedCalendar(scope: ServiceScope, receipt: CalendarPreviewReceipt): Promise<ServiceResult<undefined>> {
  try {
    const { account, marker } = await ownedAccount(scope, receipt.accountId);
    const progress = await scope.db.from('onboarding_progress').select('family_id, source, status').eq('user_id', scope.userId!).maybeSingle();
    if (progress.error || progress.data?.family_id !== scope.familyId || progress.data.source !== 'wizard' || progress.data.status !== 'completed') throw new Error('Calendar setup completion is not saved');
    if (receipt.familyId !== scope.familyId || receipt.userId !== scope.userId || receipt.provider !== account.provider) throw new Error('Calendar preview ownership changed');
    if (marker.state === 'import' && marker.calendarExternalId !== receipt.calendarExternalId) throw new Error('Calendar selection changed');
    const metadata = { ...object(account.metadata), onboardingCalendar: { version: 1, state: 'import', calendarExternalId: receipt.calendarExternalId } } as Json;
    await assertOnboardingCalendarAccess(scope);
    const saved = await scope.db.from('sync_accounts').update({ sync_direction: 'import', sync_status: 'synced', metadata }).eq('id', account.id).eq('family_id', scope.familyId)
      .eq('user_id', scope.userId!).eq('sync_direction', account.sync_direction).eq('updated_at', account.updated_at).select('id').maybeSingle();
    if (saved.error || !saved.data) throw saved.error ?? new Error('Calendar import could not be enabled');
    return ok(undefined);
  } catch (error) { report(error); return unavailable(); }
}

export async function refreshOnboardingCalendar(scope: ServiceScope, accountId: string, adapter: SyncProviderAdapter): Promise<ServiceResult<ImportCounts>> {
  try {
    const { account, marker } = await ownedAccount(scope, accountId);
    if (marker.state !== 'import' || typeof marker.calendarExternalId !== 'string' || !marker.calendarExternalId || account.provider !== adapter.provider || !['google', 'microsoft'].includes(adapter.provider)) throw new Error('Calendar import unavailable');
    const { rows } = await pullCalendar(scope, accountId, adapter, marker.calendarExternalId);
    return ok(await writeEvents(scope, accountId, adapter.provider as 'google' | 'microsoft', rows));
  } catch (error) { report(error); return unavailable(); }
}
