// Google OAuth helpers for Calendar integration

import { validDay } from '@/lib/onboarding/ics-time';
import { readBoundedResponseText, readBoundedResponseJson } from '@/lib/server/bounded-response-body';
import { fetchWithDeadline } from '@/lib/server/fetch-with-deadline';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CALENDAR_URL = 'https://www.googleapis.com/calendar/v3';

/** The read-only calendar client's credentials, trimmed at the single point of use. */
export function googleClientId(): string {
  return process.env.GOOGLE_CLIENT_ID?.trim() || '';
}
export function googleClientSecret(): string {
  return process.env.GOOGLE_CLIENT_SECRET?.trim() || '';
}

/**
 * The `redirect_uri` for the Calendar OAuth flow.
 *
 * Both the authorization request and the token exchange must send the SAME
 * value — Google rejects the exchange otherwise — so both go through here
 * rather than building the string twice.
 *
 * This used to be `${process.env.NEXT_PUBLIC_APP_URL}/api/...` with no
 * fallback: the only two sites in the codebase interpolating that variable
 * bare. Unset, it produced the literal string
 * `undefined/api/google/calendar/callback`, and Google answers a malformed
 * redirect_uri with the consent screen replaced by:
 *
 *   Access blocked: Authorization Error
 *   Error 400: invalid_request
 *
 * Order: an explicit override first (it must match what is registered in the
 * Google Cloud console, which the request's own origin need not); then the
 * configured app URL, and only if that is missing or unusable, the origin the
 * request actually arrived on. The last step cannot produce `undefined`, which
 * is the whole point — a preview or a fresh environment degrades to a working
 * flow instead of a blocked one.
 */
export function googleCalendarRedirectUri(origin: string): string {
  const override = process.env.GOOGLE_CALENDAR_REDIRECT_URI?.trim();
  if (override) return override;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const base = appUrl && /^https?:\/\/\S+$/.test(appUrl) ? appUrl : origin;
  return `${base.replace(/\/+$/, '')}/api/google/calendar/callback`;
}

export function getGoogleOAuthUrl(state: string, origin: string): string {
  // `process.env.GOOGLE_CLIENT_ID!` used to reach Google as the string
  // "undefined" and come back as the same opaque Error 400 as a bad
  // redirect_uri. Failing here names the missing variable instead.
  const clientId = googleClientId();
  if (!clientId) {
    throw new Error(
      'GOOGLE_CLIENT_ID is not set, so the consent request would be rejected as Error 400: invalid_request.',
    );
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleCalendarRedirectUri(origin),
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

/**
 * `redirectUri` is REQUIRED and must be the same value the consent request
 * sent — Google compares them and rejects a mismatch. Passing it in rather than
 * rebuilding it here is what makes that guarantee structural: one call to
 * googleCalendarRedirectUri per flow, not two that can disagree.
 */
export async function exchangeGoogleCode(code: string, redirectUri: string): Promise<GoogleToken> {
  const res = await fetchWithDeadline(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      // Trimmed: pasted into a hosting dashboard, a trailing newline rides along
      // and Google answers `invalid_client`, which names nothing.
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  }, 15_000);
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
  const data = await readBoundedResponseJson<{ access_token: string; refresh_token?: string; expires_in: number }>(res, 64 * 1024);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/**
 * The grant is gone: the refresh token was expired, revoked, or issued to a
 * different client. No retry brings it back — only the user re-consenting.
 *
 * This is NOT an exotic case. While the OAuth app's publishing status is
 * "Testing", Google expires refresh tokens after SEVEN DAYS, so every connected
 * calendar lands here weekly until the app is verified and published. A user
 * also reaches it by revoking access from their Google account page.
 *
 * Kept distinct from an ordinary failure for the same reason a session is:
 * a rate limit, a 5xx or a dropped connection must not read as "disconnected".
 */
export class GoogleReconnectRequired extends Error {
  constructor(message = 'Google access needs to be reconnected') {
    super(message);
    this.name = 'GoogleReconnectRequired';
  }
}

/** True only for a definitive revoked/expired grant. */
export function isGoogleReconnectRequired(error: unknown): boolean {
  if (error instanceof GoogleReconnectRequired) return true;
  return typeof error === 'object' && error !== null
    && (error as { name?: unknown }).name === 'GoogleReconnectRequired';
}

export async function refreshGoogleToken(refreshToken: string): Promise<GoogleToken> {
  const res = await fetchWithDeadline(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: googleClientId(),
      client_secret: googleClientSecret(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  }, 15_000);
  if (!res.ok) {
    // Google answers a dead grant with 400 + `error: "invalid_grant"`. That is
    // the only shape that means reconnect; everything else is a failure to be
    // retried, not a disconnection.
    const body = await res.text().catch(() => '');
    if (res.status === 400 && /invalid_grant/.test(body)) throw new GoogleReconnectRequired();
    throw new Error(`Google token refresh failed: ${res.status}`);
  }
  const data = await readBoundedResponseJson<{ access_token: string; expires_in: number }>(res, 64 * 1024);
  return {
    accessToken: data.access_token,
    refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function getValidAccessToken(token: GoogleToken): Promise<{ token: GoogleToken; accessToken: string }> {
  if (token.expiresAt - 60_000 > Date.now()) {
    return { token, accessToken: token.accessToken };
  }
  if (!token.refreshToken) throw new GoogleReconnectRequired('No refresh token stored');
  const refreshed = await refreshGoogleToken(token.refreshToken);
  return { token: refreshed, accessToken: refreshed.accessToken };
}

/** Provider pages are not a snapshot transaction. Refuse any ambiguous/incomplete
 * collection before the caller can publish native copies. */
export const GOOGLE_CALENDAR_READ_LIMITS = { page: 250, events: 10_000, pages: 1000, pageBytes: 2 * 1024 * 1024, bytes: 16 * 1024 * 1024 } as const;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function calendarInstant(value: unknown): value is string {
  if(typeof value !== 'string')return false;
  const match=/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  return !!match && validDay(match[1]) && +match[2]<24 && +match[3]<60 && +match[4]<60
    && (match[5]==='Z'||+match[5].slice(1,3)<24&&+match[5].slice(4,6)<60) && Number.isFinite(Date.parse(value));
}
function calendarEvent(value: unknown): value is GoogleCalendarEvent {
  if(!record(value)||typeof value.id!=='string'||!value.id.trim()||value.id.length>1024
    ||!record(value.start)||!record(value.end))return false;
  for(const field of ['summary','description','location'])if(value[field]!==undefined&&typeof value[field]!=='string')return false;
  // Cancelled/unknown provider records cannot become active native copies.
  if(value.status!==undefined&&value.status!=='confirmed'&&value.status!=='tentative')return false;
  const start=value.start, end=value.end;
  if(start.date!==undefined)return typeof start.date==='string'&&validDay(start.date)
    && typeof end.date==='string'&&validDay(end.date)&&end.date>start.date&&start.dateTime===undefined&&end.dateTime===undefined;
  return start.date===undefined&&end.date===undefined&&calendarInstant(start.dateTime)&&calendarInstant(end.dateTime)
    && Date.parse(end.dateTime)>=Date.parse(start.dateTime);
}

export async function fetchGoogleCalendarEvents(accessToken: string, timeMin: string, timeMax: string): Promise<GoogleCalendarEvent[]> {
  if(!calendarInstant(timeMin)||!calendarInstant(timeMax)||Date.parse(timeMin)>=Date.parse(timeMax))throw new Error('Invalid Google calendar window');
  const params = new URLSearchParams({ calendarId: 'primary', timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: String(GOOGLE_CALENDAR_READ_LIMITS.page) });
  const events:GoogleCalendarEvent[]=[], ids=new Set<string>(), tokens=new Set<string>();
  const deadline=AbortSignal.timeout(60_000);
  let bytes=0;
  for(let page=0;page<GOOGLE_CALENDAR_READ_LIMITS.pages;page++){
    deadline.throwIfAborted();
    const res = await fetchWithDeadline(`${GOOGLE_CALENDAR_URL}/calendars/primary/events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.any([deadline,AbortSignal.timeout(15_000)]),
    }, 15_000);
    if (!res.ok) throw new Error(`Google Calendar API error: ${res.status}`);
    const bounded=await readBoundedResponseText(res,Math.min(GOOGLE_CALENDAR_READ_LIMITS.pageBytes,GOOGLE_CALENDAR_READ_LIMITS.bytes-bytes));
    deadline.throwIfAborted();
    if(!bounded.ok)throw new Error('Google calendar response exceeded its read budget or was unreadable');
    bytes+=new TextEncoder().encode(bounded.text).byteLength;
    const data:unknown=JSON.parse(bounded.text);
    if(!record(data)||data.kind!=='calendar#events'||'error' in data||data.items!==undefined&&!Array.isArray(data.items))throw new Error('Malformed Google calendar page');
    const items=data.items??[];
    if(!Array.isArray(items)||items.length>GOOGLE_CALENDAR_READ_LIMITS.page||events.length+items.length>GOOGLE_CALENDAR_READ_LIMITS.events)throw new Error('Google calendar event bound exceeded');
    for(const event of items){
      if(!calendarEvent(event)||ids.has(event.id))throw new Error('Malformed or repeated Google calendar event');
      ids.add(event.id);events.push(event);
    }
    const token=data.nextPageToken;
    if(token===undefined)return events;
    if(typeof token!=='string'||!token.trim()||token.length>4096||tokens.has(token))throw new Error('Malformed or repeated Google calendar page token');
    tokens.add(token);params.set('pageToken',token);
  }
  throw new Error('Google calendar page bound exceeded');
}

export type GoogleToken = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
};

export type GoogleCalendarEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string };
  end: { dateTime?: string; date?: string };
};
