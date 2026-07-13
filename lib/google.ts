// Google OAuth helpers for Calendar integration

import { readBoundedResponseJson } from '@/lib/server/bounded-response-body';
import { fetchExternal } from '@/lib/server/external-fetch';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_CALENDAR_URL = 'https://www.googleapis.com/calendar/v3';

export function getGoogleOAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID!,
    redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/google/calendar/callback`,
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/calendar.readonly',
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleToken> {
  const res = await fetchExternal(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID!,
      client_secret: process.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${process.env.NEXT_PUBLIC_APP_URL}/api/google/calendar/callback`,
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
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status}`);
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
  if (!token.refreshToken) throw new Error('No refresh token — user must reconnect Google');
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
