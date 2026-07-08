import { describe, it, expect } from 'vitest';
import { planSync, type SyncAdapter, type PlannableConnection } from '@/lib/connections/adapter';
import { adapterFor, syncableProviderIds } from '@/lib/connections/adapters';
import { googleCalendarAdapter } from '@/lib/connections/adapters/google-calendar';
import { gmailAdapter } from '@/lib/connections/adapters/gmail';

const configuredEnv = {
  GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
} as unknown as NodeJS.ProcessEnv;
const emptyEnv = {} as NodeJS.ProcessEnv;

const connected = (last: string | null = null): PlannableConnection => ({ status: 'connected', last_synced_at: last });

describe('registry', () => {
  it('resolves registered adapters and nulls the rest', () => {
    expect(adapterFor('google_calendar')).toBe(googleCalendarAdapter);
    expect(adapterFor('gmail')).toBe(gmailAdapter);
    expect(adapterFor('smartthings')).toBeNull();
  });
  it('lists syncable provider ids', () => {
    expect(syncableProviderIds()).toEqual(expect.arrayContaining(['google_calendar', 'gmail']));
  });
});

describe('adapters declare capabilities + stay inert without keys', () => {
  it('google calendar is two-way events', () => {
    expect(googleCalendarAdapter.capabilities).toEqual([{ resource: 'events', direction: 'two_way' }]);
    expect(googleCalendarAdapter.isConfigured(emptyEnv)).toBe(false);
    expect(googleCalendarAdapter.isConfigured(configuredEnv)).toBe(true);
  });
  it('gmail is pull-only messages', () => {
    expect(gmailAdapter.capabilities).toEqual([{ resource: 'messages', direction: 'pull' }]);
  });
  it('pull returns a clean not-connected error when credentials are absent', async () => {
    const res = await googleCalendarAdapter.pullEvents!({ familyId: 'f', externalAccountId: 'a', credentials: null });
    expect(res.items).toEqual([]);
    expect(res.errors[0]).toMatch(/not connected/i);
  });
  it('push is a no-op (0 pushed) without credentials', async () => {
    const res = await googleCalendarAdapter.pushEvents!(
      { familyId: 'f', externalAccountId: 'a', credentials: null },
      [{ externalId: 'e1', title: 'Game', startsAt: '2026-07-01T17:00:00Z' }],
    );
    expect(res.pushed).toBe(0);
    expect(res.errors).toHaveLength(1);
  });
});

describe('planSync', () => {
  it('blocks when the provider is not configured', () => {
    const p = planSync(googleCalendarAdapter, connected(), emptyEnv);
    expect(p.runnable).toBe(false);
    expect(p.blockedReason).toBe('needs_setup');
  });
  it('blocks when the family has not connected the account', () => {
    const p = planSync(googleCalendarAdapter, null, configuredEnv);
    expect(p.runnable).toBe(false);
    expect(p.blockedReason).toBe('not_connected');
    const d = planSync(googleCalendarAdapter, { status: 'disconnected', last_synced_at: null }, configuredEnv);
    expect(d.blockedReason).toBe('not_connected');
  });
  it('runs a first (full) sync when there is no prior cursor', () => {
    const p = planSync(googleCalendarAdapter, connected(null), configuredEnv);
    expect(p.runnable).toBe(true);
    expect(p.incremental).toBe(false);
    expect(p.since).toBeNull();
    expect(p.summary).toMatch(/first sync/i);
  });
  it('runs an incremental sync from the last cursor', () => {
    const last = '2026-07-01T00:00:00Z';
    const p = planSync(googleCalendarAdapter, connected(last), configuredEnv);
    expect(p.runnable).toBe(true);
    expect(p.incremental).toBe(true);
    expect(p.since).toBe(last);
  });
  it('carries the adapter capabilities onto the plan', () => {
    const p = planSync(gmailAdapter, connected(), configuredEnv);
    expect(p.resources).toEqual([{ resource: 'messages', direction: 'pull' }]);
    expect(p.summary).toMatch(/email/i);
  });
  it('blocks an adapter with no capabilities as unsupported', () => {
    const empty: SyncAdapter = { providerId: 'x', category: 'smart_home', capabilities: [], isConfigured: () => true };
    const p = planSync(empty, connected(), configuredEnv);
    expect(p.runnable).toBe(false);
    expect(p.blockedReason).toBe('unsupported');
  });
});
