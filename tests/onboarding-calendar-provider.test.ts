import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { googleAuthUrl, googleCalendarReadAuthUrl, listCalendars } from '@/lib/sync/providers/google';
import { exchangeMicrosoftCalendarReadCode, microsoftAdapter, microsoftCalendarReadAuthUrl } from '@/lib/sync/providers/microsoft';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('@/lib/server/external-fetch', () => ({ fetchExternal: mocks.fetch }));

const CALLBACK = 'https://app.example/api/sync/provider/callback';
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
const scopes = (url: string) => new URL(url).searchParams.get('scope')!.split(/\s+/).sort();
const tokenBody = () => new URLSearchParams(mocks.fetch.mock.calls[0][1].body);

beforeEach(() => {
  mocks.fetch.mockReset();
  vi.stubEnv('GOOGLE_SYNC_CLIENT_ID', 'google-client');
  vi.stubEnv('GOOGLE_SYNC_CLIENT_SECRET', 'google-secret');
  vi.stubEnv('GOOGLE_SYNC_CALENDAR_SCOPES', 'https://www.googleapis.com/auth/calendar.events');
  vi.stubEnv('GOOGLE_SYNC_TASKS_SCOPES', 'https://www.googleapis.com/auth/tasks');
  vi.stubEnv('MICROSOFT_SYNC_CLIENT_ID', 'microsoft-client');
  vi.stubEnv('MICROSOFT_SYNC_CLIENT_SECRET', 'microsoft-secret');
  vi.stubEnv('MICROSOFT_SYNC_SCOPES', 'Calendars.ReadWrite Tasks.ReadWrite User.Read');
});
afterEach(() => vi.unstubAllEnvs());

describe('onboarding calendar consent', () => {
  it('requests only Google calendar read and identity despite configured write scopes', () => {
    const url = googleCalendarReadAuthUrl(CALLBACK, 'bound-state');
    expect(scopes(url)).toEqual(['email', 'https://www.googleapis.com/auth/calendar.readonly', 'openid']);
    expect(new URL(url).searchParams.get('state')).toBe('bound-state');
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(new URL(url).searchParams.get('access_type')).toBe('offline');
    expect(new URL(url).searchParams.has('include_granted_scopes')).toBe(false);
    expect(scopes(googleAuthUrl(CALLBACK, 'standard'))).toContain('https://www.googleapis.com/auth/tasks');
  });

  it('requests Microsoft calendar read and identity without tasks or writes', () => {
    const url = microsoftCalendarReadAuthUrl(CALLBACK, 'bound-state');
    expect(scopes(url)).toEqual(['Calendars.Read', 'User.Read', 'email', 'offline_access', 'openid']);
    expect(new URL(url).searchParams.get('state')).toBe('bound-state');
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(CALLBACK);
    expect(scopes(microsoftAdapter.authUrl(CALLBACK, 'standard'))).toContain('Tasks.ReadWrite');
  });

  it('uses the same Microsoft read grant for code exchange', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ access_token: 'access', refresh_token: 'refresh', scope: 'Calendars.Read User.Read' }));
    await expect(exchangeMicrosoftCalendarReadCode('code', CALLBACK)).resolves.toMatchObject({ accessToken: 'access', refreshToken: 'refresh' });
    expect(tokenBody().get('grant_type')).toBe('authorization_code');
    expect(tokenBody().get('code')).toBe('code');
    expect(tokenBody().get('redirect_uri')).toBe(CALLBACK);
    expect(tokenBody().get('scope')?.split(/\s+/).sort()).toEqual(['Calendars.Read', 'User.Read', 'email', 'offline_access', 'openid']);
  });

  it('refreshes the original Microsoft grant without requesting configured write scopes', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ access_token: 'renewed', scope: 'Calendars.Read User.Read' }));
    await expect(microsoftAdapter.refreshAccessToken('original-refresh')).resolves.toMatchObject({
      accessToken: 'renewed', refreshToken: 'original-refresh', scope: 'Calendars.Read User.Read',
    });
    expect(tokenBody().get('grant_type')).toBe('refresh_token');
    expect(tokenBody().get('refresh_token')).toBe('original-refresh');
    expect(tokenBody().has('scope')).toBe(false);
  });
});

describe('complete provider calendar reads', () => {
  it('finds the Google primary calendar after the first list page', async () => {
    mocks.fetch.mockResolvedValueOnce(json({ items: [{ id: 'shared', summary: 'Shared' }], nextPageToken: 'next-page' }))
      .mockResolvedValueOnce(json({ items: [{ id: 'primary', summary: 'Primary', primary: true }] }));
    const calendars = await listCalendars('access');
    expect(calendars.find((row) => row.primary)?.id).toBe('primary');
    expect(calendars).toHaveLength(2);
    expect(new URL(mocks.fetch.mock.calls[1][0]).searchParams.get('pageToken')).toBe('next-page');
  });

  it('finds the Microsoft primary calendar after the first list page', async () => {
    const next = 'https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=next';
    mocks.fetch.mockResolvedValueOnce(json({ value: [{ id: 'shared', name: 'Shared' }], '@odata.nextLink': next }))
      .mockResolvedValueOnce(json({ value: [{ id: 'primary', name: 'Primary', isDefaultCalendar: true }] }));
    const calendars = await microsoftAdapter.listCalendars('access');
    expect(calendars.find((row) => row.primary)?.externalId).toBe('primary');
    expect(calendars).toHaveLength(2);
    expect(mocks.fetch.mock.calls[1][0]).toBe(next);
  });

  it('rejects a Google calendar list that still has more pages at the cap', async () => {
    mocks.fetch.mockImplementation(async () => json({ items: [{ id: 'shared', summary: 'Shared' }], nextPageToken: 'more' }));
    await expect(listCalendars('access')).rejects.toThrow('Calendar list exceeded the page limit');
    expect(mocks.fetch).toHaveBeenCalledTimes(50);
  });

  it('rejects a Microsoft calendar list that still has more pages at the cap', async () => {
    mocks.fetch.mockImplementation(async () => json({ value: [{ id: 'shared' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars?$skiptoken=more' }));
    await expect(microsoftAdapter.listCalendars('access')).rejects.toThrow('Calendar list exceeded the page limit');
    expect(mocks.fetch).toHaveBeenCalledTimes(50);
  });

  it('rejects a Microsoft event read that still has more pages instead of importing a partial calendar', async () => {
    mocks.fetch.mockImplementation(async () => json({ value: [{ id: 'event', subject: 'Meeting', start: { dateTime: '2026-09-10T12:00:00Z' } }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/primary/events/delta?$skiptoken=more' }));
    await expect(microsoftAdapter.pullEvents('access', 'primary', null)).rejects.toThrow('Calendar read exceeded the page limit');
    expect(mocks.fetch).toHaveBeenCalledTimes(50);
  });
});
