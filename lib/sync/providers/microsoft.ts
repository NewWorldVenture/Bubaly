// lib/sync/providers/microsoft.ts — Microsoft Graph adapter (R9 proof-of-generalization).
//
// The second provider that proves the R9 contract is real: Outlook Calendar (Graph
// /me/calendars/events + delta) <-> sync_calendar_events, and Microsoft To Do
// (/me/todo) <-> sync_reminders. Implements the exact same SyncProviderAdapter the
// generic engine drives — no engine changes needed to add it.
//
// Key-gated: isConfigured() is false until MICROSOFT_SYNC_CLIENT_ID/SECRET are set
// (owner-provisioned, decision B3), so the network methods never fire in prod until
// then. The PURE mappers/hashers below are provider-neutral and fully unit-tested
// (tests/sync-adapter.test.ts), so the mapping logic is verified now, offline.
//
// SERVER ONLY.

import type {
  SyncProviderAdapter, OAuthTokens, NormalizedCalendar, NormalizedEvent, NormalizedTask,
  NormalizedTaskList, EventPullResult, LocalEventRow, LocalReminderRow,
} from '@/lib/sync/adapter';
import { SyncApiError } from '@/lib/sync/adapter';
import { eventContentHash, reminderContentHash } from '@/lib/sync/hash';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

const TENANT = process.env.MICROSOFT_SYNC_TENANT || 'common';
const AUTHORITY = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;
const GRAPH = 'https://graph.microsoft.com/v1.0';
const DEFAULT_SCOPES = 'Calendars.ReadWrite Tasks.ReadWrite User.Read';

export function microsoftClientId(): string {
  return process.env.MICROSOFT_SYNC_CLIENT_ID ?? '';
}
export function microsoftClientSecret(): string {
  return process.env.MICROSOFT_SYNC_CLIENT_SECRET ?? '';
}
export function isMicrosoftSyncConfigured(): boolean {
  return !!(microsoftClientId() && microsoftClientSecret());
}
export function microsoftRedirectUri(origin: string): string {
  return process.env.MICROSOFT_SYNC_REDIRECT_URI ?? `${origin}/api/sync/microsoft/callback`;
}
/** offline_access → persistent refresh token; openid/email → identity. */
export function microsoftScopes(): string {
  const configured = process.env.MICROSOFT_SYNC_SCOPES || DEFAULT_SCOPES;
  return `${configured} offline_access openid email`.trim();
}

// ── OAuth ─────────────────────────────────────────────────────────────────────
function authUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: microsoftClientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: microsoftScopes(),
    state,
  });
  return `${AUTHORITY}/authorize?${params}`;
}

const CALENDAR_READ_SCOPES = 'Calendars.Read User.Read offline_access openid email';
export function microsoftCalendarReadAuthUrl(redirectUri: string, state: string): string {
  const url = new URL(authUrl(redirectUri, state));
  url.searchParams.set('scope', CALENDAR_READ_SCOPES);
  return url.toString();
}

async function tokenRequest(body: Record<string, string>): Promise<OAuthTokens> {
  const res = await fetchExternal(`${AUTHORITY}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: microsoftClientId(),
      client_secret: microsoftClientSecret(),
      // A refresh preserves the original grant; requesting the default write
      // scopes here would escalate an onboarding calendar-read connection.
      ...(body.grant_type === 'refresh_token' ? {} : { scope: microsoftScopes() }),
      ...body,
    }),
  }, 15_000);
  const data = await readBoundedResponseJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string; error?: string }>(res, 64 * 1024);
  if (!res.ok) throw new SyncApiError(res.status, `Microsoft token request failed: ${data.error ?? res.status}`);
  if (!data.access_token) throw new SyncApiError(res.status, 'Microsoft token response missing access token');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope,
    tokenType: data.token_type,
  };
}

const exchangeCode = (code: string, redirectUri: string) =>
  tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
export const exchangeMicrosoftCalendarReadCode = (code: string, redirectUri: string) =>
  tokenRequest({ code, redirect_uri: redirectUri, grant_type: 'authorization_code', scope: CALENDAR_READ_SCOPES });

async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  const t = await tokenRequest({ refresh_token: refreshToken, grant_type: 'refresh_token' });
  // Graph may or may not re-issue a refresh token; preserve the old one if not.
  return { ...t, refreshToken: t.refreshToken ?? refreshToken };
}

async function revokeToken(): Promise<void> {
  // Graph has no standalone revoke endpoint; disconnect just drops stored tokens.
}

async function gfetch<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetchExternal(url.startsWith('http') ? url : `${GRAPH}${url}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  }, 15_000);
  if (res.status === 204) return undefined as T;
  const bounded = await readBoundedResponseText(res, 2 * 1024 * 1024);
  if (!bounded.ok) throw new SyncApiError(res.status, `Microsoft Graph ${res.status} response too large`, '[provider response exceeded 2 MiB]');
  const text = bounded.text;
  if (!res.ok) throw new SyncApiError(res.status, `Microsoft Graph ${res.status} for ${url}`, text.slice(0, 500));
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

async function getAccountIdentity(accessToken: string): Promise<string | null> {
  try {
    const me = await gfetch<{ mail?: string; userPrincipalName?: string }>('/me', accessToken);
    return me.mail ?? me.userPrincipalName ?? null;
  } catch {
    return null;
  }
}

// ── Graph types ─────────────────────────────────────────────────────────────
type MsCalendar = { id: string; name?: string; isDefaultCalendar?: boolean; color?: string };
type MsDateTime = { dateTime?: string; timeZone?: string };
type MsEvent = {
  id: string;
  '@removed'?: { reason?: string };
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  body?: { content?: string };
  location?: { displayName?: string };
  start?: MsDateTime;
  end?: MsDateTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  originalStartTimeZone?: string;
  originalEndTimeZone?: string;
  recurrence?: unknown;
  changeKey?: string;
  lastModifiedDateTime?: string;
};
type MsList = { id: string; displayName?: string; wellknownListName?: string };
type MsTask = {
  id: string;
  '@removed'?: { reason?: string };
  title?: string;
  body?: { content?: string };
  status?: string; // notStarted | inProgress | completed
  dueDateTime?: MsDateTime;
  completedDateTime?: MsDateTime;
  lastModifiedDateTime?: string;
};

// ── Calendar API ──────────────────────────────────────────────────────────────
async function listCalendars(accessToken: string): Promise<NormalizedCalendar[]> {
  const calendars: MsCalendar[] = [];
  let url = '/me/calendars';
  for (let page = 0; page < 50; page++) {
    const data = await gfetch<{ value?: MsCalendar[]; '@odata.nextLink'?: string }>(url, accessToken);
    calendars.push(...(data.value ?? []));
    if (!data['@odata.nextLink']) break;
    if (page === 49) throw new SyncApiError(502, 'Calendar list exceeded the page limit');
    url = data['@odata.nextLink'];
  }
  return calendars.map((c) => ({
    externalId: c.id,
    name: c.name ?? 'Outlook Calendar',
    primary: c.isDefaultCalendar === true,
    timezone: null,
    color: c.color ?? null,
  }));
}

async function pullEvents(accessToken: string, calendarExternalId: string, cursor: string | null): Promise<EventPullResult> {
  const events: NormalizedEvent[] = [];
  // A stored deltaLink resumes incrementally; otherwise start a fresh delta.
  let url = cursor ?? `/me/calendars/${encodeURIComponent(calendarExternalId)}/events/delta`;
  let nextCursor: string | null = null;

  try {
    // Follow nextLink pages; the final page carries a deltaLink to persist.
    for (let guard = 0; guard < 50; guard++) {
      const page = await gfetch<{ value?: MsEvent[]; '@odata.nextLink'?: string; '@odata.deltaLink'?: string }>(url, accessToken);
      for (const ev of page.value ?? []) events.push(msEventToRow(ev));
      if (page['@odata.nextLink']) {
        if (guard === 49) throw new SyncApiError(502, 'Calendar read exceeded the page limit');
        url = page['@odata.nextLink']; continue;
      }
      nextCursor = page['@odata.deltaLink'] ?? null;
      break;
    }
  } catch (e) {
    // 410 Gone → stored delta token expired; caller should retry with cursor=null.
    if (e instanceof SyncApiError && e.status === 410) return { events: [], nextCursor: null, expired: true };
    throw e;
  }
  return { events, nextCursor, expired: false };
}

/** Graph calendarView expands series into occurrences in the requested window. */
async function pullCalendarWindow(accessToken: string, calendarExternalId: string, from: string, to: string): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  let allDayReads = 0;
  const query = new URLSearchParams({ startDateTime: from, endDateTime: to, '$top': '250' });
  let url = `/me/calendars/${encodeURIComponent(calendarExternalId)}/calendarView?${query}`;
  for (let page = 0; page < 50; page++) {
    const data = await gfetch<{ value?: MsEvent[]; '@odata.nextLink'?: string }>(url, accessToken, { headers: { Prefer: 'outlook.timezone="UTC"' } });
    for (let event of data.value ?? []) {
      if (!event['@removed'] && event.isCancelled !== true && event.isAllDay) {
        if (++allDayReads > 1000) throw new SyncApiError(502, 'Calendar all-day read exceeded the limit');
        event = await readFloatingAllDay(accessToken, event);
      }
      if (!event['@removed'] && event.isCancelled !== true && !event.start?.dateTime) throw new SyncApiError(502, 'Calendar event timing unavailable');
      events.push({ ...msEventToRow(event), title: event.subject ?? '' });
    }
    if (!data['@odata.nextLink']) return events;
    url = data['@odata.nextLink'];
  }
  throw new SyncApiError(502, 'Calendar window exceeded the page limit');
}

/** UTC calendarView times lose an all-day event's civil date. Ask Graph to
 * resolve its original (often Windows-named) zone, then preserve the midnight
 * dates as floating dates. Never guess a zone or shift an all-day appointment. */
async function readFloatingAllDay(accessToken: string, event: MsEvent): Promise<MsEvent> {
  const zone = event.originalStartTimeZone;
  if (!event.id || !zone || !/^[A-Za-z0-9._+:/ -]{1,100}$/.test(zone) || event.originalEndTimeZone !== zone) throw new SyncApiError(502, 'Calendar all-day source timezone unavailable');
  const source = await gfetch<MsEvent>(`/me/events/${encodeURIComponent(event.id)}`, accessToken, { headers: { Prefer: `outlook.timezone="${zone}"` } });
  if (source.id !== event.id) throw new SyncApiError(502, 'Calendar all-day identity unavailable');
  if (source.isCancelled || source['@removed']) return source;
  if (!source.isAllDay) throw new SyncApiError(502, 'Calendar all-day timing changed');
  const floating = (value: MsDateTime | undefined): MsDateTime => {
    const match = value?.dateTime?.match(/^(\d{4}-\d{2}-\d{2})T00:00:00(?:\.0+)?$/);
    if (!match || value?.timeZone !== zone) throw new SyncApiError(502, 'Calendar all-day source timing unavailable');
    const iso = `${match[1]}T00:00:00Z`;
    if (new Date(iso).toISOString().slice(0, 10) !== match[1]) throw new SyncApiError(502, 'Calendar all-day source timing unavailable');
    return { dateTime: iso, timeZone: 'UTC' };
  };
  return { ...source, start: floating(source.start), end: floating(source.end) };
}

async function insertEvent(accessToken: string, calendarExternalId: string, body: Record<string, unknown>) {
  const ev = await gfetch<MsEvent>(`/me/calendars/${encodeURIComponent(calendarExternalId)}/events`, accessToken, {
    method: 'POST', body: JSON.stringify(body),
  });
  return { id: ev.id, etag: ev.changeKey ?? null };
}
async function patchEvent(accessToken: string, _calendarExternalId: string, eventExternalId: string, body: Record<string, unknown>) {
  const ev = await gfetch<MsEvent>(`/me/events/${encodeURIComponent(eventExternalId)}`, accessToken, {
    method: 'PATCH', body: JSON.stringify(body),
  });
  return { id: ev.id, etag: ev.changeKey ?? null };
}
function deleteEvent(accessToken: string, _calendarExternalId: string, eventExternalId: string) {
  return gfetch<void>(`/me/events/${encodeURIComponent(eventExternalId)}`, accessToken, { method: 'DELETE' });
}

// ── To Do API ───────────────────────────────────────────────────────────────
async function defaultTaskListId(accessToken: string): Promise<string | null> {
  const data = await gfetch<{ value?: MsList[] }>('/me/todo/lists', accessToken);
  const lists = data.value ?? [];
  return (lists.find((l) => l.wellknownListName === 'defaultList') ?? lists[0])?.id ?? null;
}
async function listTasks(accessToken: string, listExternalId: string): Promise<NormalizedTask[]> {
  const tasks: NormalizedTask[] = [];
  let url: string | null = `/me/todo/lists/${encodeURIComponent(listExternalId)}/tasks`;
  for (let guard = 0; url && guard < 50; guard++) {
    const page: { value?: MsTask[]; '@odata.nextLink'?: string } = await gfetch(url, accessToken);
    for (const t of page.value ?? []) tasks.push(msTaskToRow(t));
    url = page['@odata.nextLink'] ?? null;
  }
  return tasks;
}
async function insertTask(accessToken: string, listExternalId: string, body: Record<string, unknown>) {
  const t = await gfetch<MsTask>(`/me/todo/lists/${encodeURIComponent(listExternalId)}/tasks`, accessToken, {
    method: 'POST', body: JSON.stringify(body),
  });
  return { id: t.id };
}
function patchTask(accessToken: string, listExternalId: string, taskExternalId: string, body: Record<string, unknown>) {
  return gfetch<void>(`/me/todo/lists/${encodeURIComponent(listExternalId)}/tasks/${encodeURIComponent(taskExternalId)}`, accessToken, {
    method: 'PATCH', body: JSON.stringify(body),
  }).then(() => undefined);
}
function deleteTask(accessToken: string, listExternalId: string, taskExternalId: string) {
  return gfetch<void>(`/me/todo/lists/${encodeURIComponent(listExternalId)}/tasks/${encodeURIComponent(taskExternalId)}`, accessToken, {
    method: 'DELETE',
  });
}

// ── Pure mappers (unit-tested) ──────────────────────────────────────────────
/** Graph event → normalized row. Graph gives naive datetimes + an explicit tz. */
export function msEventToRow(ev: MsEvent): NormalizedEvent {
  const removed = !!ev['@removed'] || ev.isCancelled === true;
  const toIso = (d?: MsDateTime): string | null => {
    if (!d?.dateTime) return null;
    // Graph datetimes are timezone-naive; treat a bare value as UTC.
    const raw = /[zZ]|[+-]\d\d:?\d\d$/.test(d.dateTime) ? d.dateTime : `${d.dateTime}Z`;
    return new Date(raw).toISOString();
  };
  const starts = toIso(ev.start);
  return {
    external_id: ev.id,
    uid: ev.iCalUId ?? null,
    title: ev.subject ?? '(no title)',
    description: ev.body?.content ?? ev.bodyPreview ?? null,
    location: ev.location?.displayName ?? null,
    starts_at: starts ?? new Date(0).toISOString(),
    ends_at: toIso(ev.end),
    all_day: ev.isAllDay === true,
    recurrence_rule: null, // Graph uses a structured recurrence object; RRULE mapping is a follow-up
    status: removed ? 'cancelled' : 'confirmed',
    etag: ev.changeKey ?? null,
    updated_at: ev.lastModifiedDateTime ?? null,
    cancelled: removed,
  };
}

/** Normalized local row → Graph event request body. */
export function rowToMsEvent(row: LocalEventRow): Record<string, unknown> {
  const tz = row.timezone || 'UTC';
  const body: Record<string, unknown> = {
    subject: row.title,
    body: { contentType: 'text', content: row.description ?? '' },
    isAllDay: row.all_day === true,
  };
  if (row.location) body.location = { displayName: row.location };
  if (row.all_day) {
    body.start = { dateTime: `${row.starts_at.slice(0, 10)}T00:00:00`, timeZone: tz };
    body.end = { dateTime: `${(row.ends_at ?? row.starts_at).slice(0, 10)}T00:00:00`, timeZone: tz };
  } else {
    body.start = { dateTime: new Date(row.starts_at).toISOString().replace('Z', ''), timeZone: 'UTC' };
    body.end = { dateTime: new Date(row.ends_at ?? row.starts_at).toISOString().replace('Z', ''), timeZone: 'UTC' };
  }
  return body;
}

/** Graph To Do task → normalized reminder row. */
export function msTaskToRow(task: MsTask): NormalizedTask {
  const toIso = (d?: MsDateTime): string | null => (d?.dateTime ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(d.dateTime) ? d.dateTime : `${d.dateTime}Z`).toISOString() : null);
  return {
    external_id: task.id,
    title: task.title ?? '(no title)',
    notes: task.body?.content ?? null,
    due_at: toIso(task.dueDateTime),
    is_completed: task.status === 'completed',
    completed_at: toIso(task.completedDateTime),
    updated_at: task.lastModifiedDateTime ?? null,
    deleted: !!task['@removed'],
  };
}

/** Normalized local row → Graph To Do task request body. */
export function rowToMsTask(row: LocalReminderRow): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: row.title,
    status: row.is_completed ? 'completed' : 'notStarted',
  };
  if (row.notes) body.body = { contentType: 'text', content: row.notes };
  if (row.due_at) body.dueDateTime = { dateTime: new Date(row.due_at).toISOString().replace('Z', ''), timeZone: 'UTC' };
  return body;
}

export const microsoftAdapter: SyncProviderAdapter = {
  provider: 'microsoft',
  label: 'Microsoft / Outlook',
  isConfigured: isMicrosoftSyncConfigured,
  authUrl,
  exchangeCode,
  refreshAccessToken,
  revokeToken,
  getAccountIdentity,
  listCalendars,
  pullEvents,
  pullCalendarWindow,
  insertEvent,
  patchEvent,
  deleteEvent,
  defaultTaskListId,
  listTasks,
  insertTask,
  patchTask,
  deleteTask,
  rowToEventBody: rowToMsEvent,
  rowToTaskBody: rowToMsTask,
  eventContentHash,
  reminderContentHash,
};

export type { MsEvent, MsTask, NormalizedTaskList };
