// lib/sync/providers/google-adapter.ts — Google conformed to the R9 contract.
//
// Zero behavior change: this wraps the existing, battle-tested google.ts client +
// mappers into a SyncProviderAdapter so the generic engine can drive Google through
// the same interface as every other provider. The Google-specific engine
// (lib/sync/engine/google.ts) stays as-is; new providers use the generic engine.
//
// SERVER ONLY.

import type {
  SyncProviderAdapter, OAuthTokens, NormalizedCalendar, NormalizedTask,
  EventPullResult, LocalEventRow, LocalReminderRow,
} from '@/lib/sync/adapter';
import { SyncApiError } from '@/lib/sync/adapter';
import {
  isGoogleSyncConfigured, googleAuthUrl, exchangeCode, refreshAccessToken, revokeToken,
  getGoogleUserEmail, listCalendars as gListCalendars, pullEvents as gPullEvents,
  insertEvent as gInsertEvent, patchEvent as gPatchEvent, deleteEvent as gDeleteEvent,
  listTasks as gListTasks, insertTask as gInsertTask, patchTask as gPatchTask, deleteTask as gDeleteTask,
  googleEventToRow, rowToGoogleEvent, eventContentHash as gEventHash,
  googleTaskToReminderRow, reminderRowToGoogleTask, reminderContentHash as gReminderHash,
  GoogleApiError,
} from '@/lib/sync/providers/google';

/** Re-wrap a GoogleApiError as the provider-agnostic SyncApiError. */
function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof GoogleApiError) throw new SyncApiError(e.status, e.message, e.body);
    throw e;
  });
}

export const googleAdapter: SyncProviderAdapter = {
  provider: 'google',
  label: 'Google',
  isConfigured: isGoogleSyncConfigured,

  authUrl: googleAuthUrl,
  exchangeCode: (code, redirectUri) => wrap(exchangeCode(code, redirectUri)),
  refreshAccessToken: (refreshToken) => wrap(refreshAccessToken(refreshToken)) as Promise<OAuthTokens>,
  revokeToken,
  getAccountIdentity: getGoogleUserEmail,

  async listCalendars(accessToken): Promise<NormalizedCalendar[]> {
    const cals = await wrap(gListCalendars(accessToken));
    return cals.map((c) => ({
      externalId: c.id, name: c.summary ?? 'Google Calendar',
      primary: c.primary === true, timezone: c.timeZone ?? null, color: c.backgroundColor ?? null,
    }));
  },

  async pullEvents(accessToken, calendarExternalId, cursor): Promise<EventPullResult> {
    let pull = await wrap(gPullEvents(accessToken, calendarExternalId, { syncToken: cursor }));
    if (pull.gone) pull = await wrap(gPullEvents(accessToken, calendarExternalId, {}));
    const events = pull.events
      .map((ev) => {
        const row = googleEventToRow(ev);
        return row ? { ...row, updated_at: ev.updated ?? null } : null;
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
    return { events, nextCursor: pull.nextSyncToken, expired: pull.gone };
  },

  async insertEvent(accessToken, calendarExternalId, body) {
    const ev = await wrap(gInsertEvent(accessToken, calendarExternalId, body));
    return { id: ev.id, etag: ev.etag ?? null };
  },
  async patchEvent(accessToken, calendarExternalId, eventExternalId, body) {
    const ev = await wrap(gPatchEvent(accessToken, calendarExternalId, eventExternalId, body));
    return { id: ev.id, etag: ev.etag ?? null };
  },
  deleteEvent: (accessToken, calendarExternalId, eventExternalId) =>
    wrap(gDeleteEvent(accessToken, calendarExternalId, eventExternalId)),

  async defaultTaskListId(): Promise<string | null> {
    return '@default';
  },
  async listTasks(accessToken, listExternalId): Promise<NormalizedTask[]> {
    const tasks = await wrap(gListTasks(accessToken, listExternalId));
    return tasks.map((t) => ({ ...googleTaskToReminderRow(t), updated_at: t.updated ?? null }));
  },
  async insertTask(accessToken, listExternalId, body) {
    const t = await wrap(gInsertTask(accessToken, listExternalId, body));
    return { id: t.id };
  },
  patchTask: (accessToken, listExternalId, taskExternalId, body) =>
    wrap(gPatchTask(accessToken, listExternalId, taskExternalId, body)).then(() => undefined),
  deleteTask: (accessToken, listExternalId, taskExternalId) =>
    wrap(gDeleteTask(accessToken, listExternalId, taskExternalId)),

  rowToEventBody: (row: LocalEventRow) => rowToGoogleEvent(row),
  rowToTaskBody: (row: LocalReminderRow) => reminderRowToGoogleTask(row),
  eventContentHash: (row: LocalEventRow) => gEventHash(row),
  reminderContentHash: (row: LocalReminderRow) => gReminderHash(row),
};
