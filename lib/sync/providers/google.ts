// lib/sync/providers/google.ts
//
// Google Calendar + Google Tasks client for the sync platform. Distinct from the
// older read-only lib/google.ts: this requests read/WRITE scopes + offline access
// (persistent refresh token) and powers genuine two-way sync. The pure mapping
// and hashing helpers at the bottom are exported for unit tests.
//
// SERVER ONLY.

import { createHash } from 'node:crypto';
import { readBoundedResponseJson, readBoundedResponseText } from '@/lib/server/bounded-response-body';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const CAL_BASE = 'https://www.googleapis.com/calendar/v3';
const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';

// Default scopes if none are configured via env. calendar.events (read/write
// events) + calendar.readonly (read the calendar list) + tasks. These are
// "sensitive" scopes: in a Testing OAuth app only added test users can consent.
const DEFAULT_SCOPES =
  'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks';

// Credentials + config. A dedicated sync client (GOOGLE_SYNC_*) is preferred;
// falls back to the legacy GOOGLE_* pair so a single-client setup still works.
export function googleSyncClientId(): string {
  return process.env.GOOGLE_SYNC_CLIENT_ID ?? process.env.GOOGLE_CLIENT_ID ?? '';
}
export function googleSyncClientSecret(): string {
  return process.env.GOOGLE_SYNC_CLIENT_SECRET ?? process.env.GOOGLE_CLIENT_SECRET ?? '';
}
export function isGoogleSyncConfigured(): boolean {
  return !!(googleSyncClientId() && googleSyncClientSecret());
}
/** Redirect URI must be identical in the auth request and the token exchange. */
export function googleSyncRedirectUri(origin: string): string {
  return process.env.GOOGLE_SYNC_REDIRECT_URI ?? `${origin}/api/sync/google/callback`;
}
/** Scopes assembled from env (calendar + readonly + tasks), plus identity. */
export function googleSyncScopes(): string {
  const configured = [
    process.env.GOOGLE_SYNC_CALENDAR_SCOPES,
    process.env.GOOGLE_SYNC_CALENDAR_READONLY_SCOPE,
    process.env.GOOGLE_SYNC_TASKS_SCOPES,
  ].filter(Boolean).join(' ').trim();
  return `${configured || DEFAULT_SCOPES} openid email`.trim();
}

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch ms
  scope?: string;
  tokenType?: string;
};

export class GoogleApiError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------
export function googleAuthUrl(redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: googleSyncClientId(),
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: googleSyncScopes(),
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent', // force a refresh_token even on re-consent
    state,
  });
  return `${AUTH_URL}?${params}`;
}

export async function exchangeCode(code: string, redirectUri: string): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: googleSyncClientId(),
      client_secret: googleSyncClientSecret(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const data = await readBoundedResponseJson<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; token_type?: string; error?: string }>(res, 64 * 1024);
  if (!res.ok) throw new GoogleApiError(res.status, `Token exchange failed: ${data.error ?? res.status}`);
  if (!data.access_token) throw new GoogleApiError(res.status, 'Token exchange response missing access token');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope,
    tokenType: data.token_type,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: googleSyncClientId(),
      client_secret: googleSyncClientSecret(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await readBoundedResponseJson<{ access_token?: string; expires_in?: number; scope?: string; token_type?: string; error?: string }>(res, 64 * 1024);
  if (!res.ok) throw new GoogleApiError(res.status, `Token refresh failed: ${data.error ?? res.status}`);
  if (!data.access_token) throw new GoogleApiError(res.status, 'Token refresh response missing access token');
  return {
    accessToken: data.access_token,
    refreshToken, // Google does not re-send the refresh token on refresh
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    scope: data.scope,
    tokenType: data.token_type,
  };
}

export async function revokeToken(token: string): Promise<void> {
  // Best-effort; ignore failures (token may already be invalid).
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
}

/** The connected account's email, for display + as the account's external_id. */
export async function getGoogleUserEmail(accessToken: string): Promise<string | null> {
  try {
    const data = await gfetch<{ email?: string }>('https://www.googleapis.com/oauth2/v2/userinfo', accessToken);
    return data.email ?? null;
  } catch {
    return null;
  }
}

async function gfetch<T>(url: string, accessToken: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (res.status === 204) return undefined as T;
  const bounded = await readBoundedResponseText(res, 2 * 1024 * 1024);
  if (!bounded.ok) throw new GoogleApiError(res.status, `Google API ${res.status} response too large`, '[provider response exceeded 2 MiB]');
  const text = bounded.text;
  if (!res.ok) {
    throw new GoogleApiError(res.status, `Google API ${res.status} for ${url}`, text.slice(0, 500));
  }
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

// ---------------------------------------------------------------------------
// Calendar API
// ---------------------------------------------------------------------------
export type GCalendar = { id: string; summary: string; primary?: boolean; backgroundColor?: string; timeZone?: string };
export type GEvent = {
  id: string;
  iCalUID?: string;
  status?: string; // confirmed | tentative | cancelled
  summary?: string;
  description?: string;
  location?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  recurrence?: string[];
  etag?: string;
  updated?: string;
};

export async function listCalendars(accessToken: string): Promise<GCalendar[]> {
  const data = await gfetch<{ items?: GCalendar[] }>(`${CAL_BASE}/users/me/calendarList`, accessToken);
  return data.items ?? [];
}

/**
 * Pull every event page for a calendar. Uses an incremental syncToken when given;
 * on HTTP 410 (token expired) it signals a required full resync via `gone: true`.
 * Returns the events plus the nextSyncToken to persist for next time.
 */
export async function pullEvents(
  accessToken: string,
  calendarId: string,
  opts: { syncToken?: string | null; timeMin?: string } = {},
): Promise<{ events: GEvent[]; nextSyncToken: string | null; gone: boolean }> {
  const events: GEvent[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;

  do {
    const params = new URLSearchParams({ showDeleted: 'true', maxResults: '250', singleEvents: 'false' });
    if (opts.syncToken) params.set('syncToken', opts.syncToken);
    else params.set('timeMin', opts.timeMin ?? new Date(Date.now() - 30 * 86400_000).toISOString());
    if (pageToken) params.set('pageToken', pageToken);

    let data: { items?: GEvent[]; nextPageToken?: string; nextSyncToken?: string };
    try {
      data = await gfetch(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, accessToken);
    } catch (e) {
      if (e instanceof GoogleApiError && e.status === 410) {
        return { events: [], nextSyncToken: null, gone: true };
      }
      throw e;
    }
    events.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
    if (data.nextSyncToken) nextSyncToken = data.nextSyncToken;
  } while (pageToken);

  return { events, nextSyncToken, gone: false };
}

export function insertEvent(accessToken: string, calendarId: string, body: Record<string, unknown>) {
  return gfetch<GEvent>(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events`, accessToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function patchEvent(accessToken: string, calendarId: string, eventId: string, body: Record<string, unknown>) {
  return gfetch<GEvent>(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, accessToken, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteEvent(accessToken: string, calendarId: string, eventId: string) {
  return gfetch<void>(`${CAL_BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, accessToken, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// Tasks API
// ---------------------------------------------------------------------------
export type GTaskList = { id: string; title: string };
export type GTask = {
  id: string;
  title?: string;
  notes?: string;
  status?: string; // needsAction | completed
  due?: string;
  completed?: string;
  deleted?: boolean;
  updated?: string;
};

export async function listTaskLists(accessToken: string): Promise<GTaskList[]> {
  const data = await gfetch<{ items?: GTaskList[] }>(`${TASKS_BASE}/users/@me/lists`, accessToken);
  return data.items ?? [];
}

export async function listTasks(accessToken: string, taskListId: string): Promise<GTask[]> {
  const tasks: GTask[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({ showCompleted: 'true', showHidden: 'true', maxResults: '100' });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await gfetch<{ items?: GTask[]; nextPageToken?: string }>(
      `${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks?${params}`,
      accessToken,
    );
    tasks.push(...(data.items ?? []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return tasks;
}

export function insertTask(accessToken: string, taskListId: string, body: Record<string, unknown>) {
  return gfetch<GTask>(`${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks`, accessToken, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function patchTask(accessToken: string, taskListId: string, taskId: string, body: Record<string, unknown>) {
  return gfetch<GTask>(`${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`, accessToken, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export function deleteTask(accessToken: string, taskListId: string, taskId: string) {
  return gfetch<void>(`${TASKS_BASE}/lists/${encodeURIComponent(taskListId)}/tasks/${encodeURIComponent(taskId)}`, accessToken, {
    method: 'DELETE',
  });
}

// ---------------------------------------------------------------------------
// Pure mappers + content hashing (unit-tested in tests/sync-google-map.test.ts)
// ---------------------------------------------------------------------------
export type MappedEvent = {
  external_id: string;
  uid: string | null;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  all_day: boolean;
  recurrence_rule: string | null;
  status: string;
  etag: string | null;
  cancelled: boolean;
};

/** Google event -> normalized row fields. Returns null if it lacks a usable start. */
export function googleEventToRow(ev: GEvent): MappedEvent | null {
  const startRaw = ev.start?.dateTime ?? ev.start?.date;
  if (!startRaw) return null;
  const allDay = !ev.start?.dateTime;
  const toIso = (v?: string) => (v ? new Date(v).toISOString() : null);
  return {
    external_id: ev.id,
    uid: ev.iCalUID ?? null,
    title: ev.summary ?? '(no title)',
    description: ev.description ?? null,
    location: ev.location ?? null,
    starts_at: new Date(startRaw).toISOString(),
    ends_at: toIso(ev.end?.dateTime ?? ev.end?.date),
    all_day: allDay,
    recurrence_rule: ev.recurrence?.find((r) => r.startsWith('RRULE:'))?.replace('RRULE:', '') ?? null,
    status: ev.status ?? 'confirmed',
    etag: ev.etag ?? null,
    cancelled: ev.status === 'cancelled',
  };
}

/** Normalized row fields -> Google event request body. */
export function rowToGoogleEvent(row: {
  title: string; description?: string | null; location?: string | null;
  starts_at: string; ends_at?: string | null; all_day?: boolean;
  recurrence_rule?: string | null; timezone?: string | null;
}): Record<string, unknown> {
  const tz = row.timezone || 'UTC';
  const body: Record<string, unknown> = {
    summary: row.title,
    description: row.description ?? undefined,
    location: row.location ?? undefined,
  };
  if (row.all_day) {
    body.start = { date: row.starts_at.slice(0, 10) };
    body.end = { date: (row.ends_at ?? row.starts_at).slice(0, 10) };
  } else {
    body.start = { dateTime: new Date(row.starts_at).toISOString(), timeZone: tz };
    body.end = { dateTime: new Date(row.ends_at ?? row.starts_at).toISOString(), timeZone: tz };
  }
  if (row.recurrence_rule) body.recurrence = [`RRULE:${row.recurrence_rule}`];
  return body;
}

export type MappedTask = {
  external_id: string;
  title: string;
  notes: string | null;
  due_at: string | null;
  is_completed: boolean;
  completed_at: string | null;
  deleted: boolean;
};

export function googleTaskToReminderRow(task: GTask): MappedTask {
  return {
    external_id: task.id,
    title: task.title ?? '(no title)',
    notes: task.notes ?? null,
    due_at: task.due ? new Date(task.due).toISOString() : null,
    is_completed: task.status === 'completed',
    completed_at: task.completed ? new Date(task.completed).toISOString() : null,
    deleted: task.deleted === true,
  };
}

export function reminderRowToGoogleTask(row: {
  title: string; notes?: string | null; due_at?: string | null; is_completed?: boolean;
}): Record<string, unknown> {
  return {
    title: row.title,
    notes: row.notes ?? undefined,
    due: row.due_at ? new Date(row.due_at).toISOString() : undefined,
    status: row.is_completed ? 'completed' : 'needsAction',
  };
}

/** Stable digest for change detection. Order-fixed; null-safe. */
export function eventContentHash(r: {
  title: string; description?: string | null; location?: string | null;
  starts_at: string; ends_at?: string | null; all_day?: boolean; recurrence_rule?: string | null;
}): string {
  const parts = [r.title, r.description ?? '', r.location ?? '', r.starts_at, r.ends_at ?? '', r.all_day ? '1' : '0', r.recurrence_rule ?? ''];
  return createHash('sha256').update(parts.join('')).digest('hex');
}

export function reminderContentHash(r: {
  title: string; notes?: string | null; due_at?: string | null; is_completed?: boolean;
}): string {
  const parts = [r.title, r.notes ?? '', r.due_at ?? '', r.is_completed ? '1' : '0'];
  return createHash('sha256').update(parts.join('')).digest('hex');
}
