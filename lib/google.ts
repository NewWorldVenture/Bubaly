// Google OAuth helpers for Calendar integration

import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CALENDAR_URL = 'https://www.googleapis.com/calendar/v3';

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
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
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
  const res = await fetchExternal(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
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
  const res = await fetchExternal(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
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

export async function fetchGoogleCalendarEvents(accessToken: string, timeMin: string, timeMax: string) {
  const params = new URLSearchParams({
    calendarId: 'primary',
    timeMin,
    timeMax,
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '250',
  });
  const res = await fetchExternal(`${GOOGLE_CALENDAR_URL}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, 15_000);
  if (!res.ok) throw new Error(`Google Calendar API error: ${res.status}`);
  const data = await readBoundedResponseJson<{ items: GoogleCalendarEvent[] }>(res, 2 * 1024 * 1024);
  return data.items ?? [];
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
