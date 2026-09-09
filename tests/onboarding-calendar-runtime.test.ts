import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { calendarContinuationCookie, sealCalendarContinuation } from '@/lib/onboarding/calendar-state';
import { syncOAuthStateCookie } from '@/lib/sync/oauth-state';
import { buildFinalizePayload, emptyDraft } from '@/lib/onboarding/flow';

const mock = vi.hoisted(() => ({ db: null as unknown, cookies: new Map<string, string>(), saveProfile: vi.fn(), exchange: vi.fn(), identity: vi.fn(), legacyContext: vi.fn(),
  adapter: null as unknown, context: vi.fn(), sendEmail: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: (name: string, value: string) => mock.cookies.set(name, value), get: (name: string) => mock.cookies.has(name) ? { value: mock.cookies.get(name) } : undefined }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mock.db, createServiceClient: () => mock.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mock.legacyContext, getUserContext: mock.context }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); }, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/i18n/server', async () => {
  const { SOURCE_MESSAGES, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(SOURCE_MESSAGES, key) };
});
vi.mock('@/lib/sync/registry', () => ({ getAdapter: () => mock.adapter }));
vi.mock('@/lib/sync/providers/google', async (original) => ({ ...await original<typeof import('@/lib/sync/providers/google')>(), exchangeCode: mock.exchange }));
vi.mock('@/lib/sync/providers/microsoft', async (original) => ({ ...await original<typeof import('@/lib/sync/providers/microsoft')>(), exchangeMicrosoftCalendarReadCode: mock.exchange }));
vi.mock('@/lib/sync/access-token', () => ({ getProviderAccessToken: async () => 'private-server-token' }));
vi.mock('@/lib/server/profiles', () => ({ saveUserProfile: mock.saveProfile }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('@/lib/server/email', () => ({ sendEmail: mock.sendEmail }));
vi.mock('@/lib/email', () => ({ APP_URL: 'https://bubaly.test', sendReactEmail: async () => {} }));
vi.mock('@/lib/emails/welcome', () => ({ WelcomeEmail: () => null }));
vi.mock('@/lib/marketing/automation-events', () => ({ fireAutomationEvent: async () => {} }));
vi.mock('@/lib/marketing/onboarding-contact', () => ({ upsertOnboardingContact: async () => {} }));
vi.mock('@/lib/referrals/signup', () => ({ captureSignupReferral: async () => {} }));
vi.mock('@/lib/onboarding/remember', () => ({ rememberOnboardingFacts: async () => {} }));

const { startCalendarConnectionAction, previewConnectedCalendarAction } = await import('@/app/onboarding/calendar-actions');
const { finalizeOnboardingAction } = await import('@/app/onboarding/actions');
const { default: OnboardingLayout } = await import('@/app/onboarding/layout');
const { GET: googleStart } = await import('@/app/api/sync/google/auth/route');
const { GET: googleFinish } = await import('@/app/api/sync/google/callback/route');
const { GET: providerFinish } = await import('@/app/api/sync/[provider]/callback/route');
const userId = '10000000-0000-4000-8000-000000000001';
const familyId = '20000000-0000-4000-8000-000000000001';
const otherUser = '10000000-0000-4000-8000-000000000002';
let db: InMemorySupabase;
beforeEach(() => {
  vi.stubEnv('SYNC_TOKEN_KEY', '12'.repeat(32));
  vi.stubEnv('GOOGLE_SYNC_CLIENT_ID', 'configured-client');
  vi.stubEnv('MICROSOFT_SYNC_CLIENT_ID', 'configured-client');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mock.cookies.clear(); mock.legacyContext.mockReset();
  mock.sendEmail.mockReset().mockResolvedValue(undefined);
  mock.context.mockReset().mockResolvedValue({ user: { id: userId }, active: { familyId, member: { id: 'owner-member' }, role: 'parent', family: { timezone: 'UTC' } } });
  mock.saveProfile.mockReset().mockResolvedValue({ ok: true });
  mock.exchange.mockReset().mockResolvedValue({ accessToken: 'private-access', refreshToken: 'private-refresh', expiresAt: Date.now() + 3600_000 });
  mock.identity.mockReset().mockResolvedValue('ada@example.test');
  db = createInMemorySupabase({ userId, uniques: { family_members: [['family_id', 'user_id']], user_preferences: [['user_id']],
    onboarding_progress: [['user_id']], invites: [['family_id', 'onboarding_key']], sync_accounts: [['user_id', 'provider', 'external_id']], calendar_events: [['family_id', 'onboarding_key']],
    onboarding_imports: [['family_id', 'onboarding_key']], sync_external_mappings: [['provider', 'item_type', 'external_id', 'account_id']] },
  defaults: { sync_accounts: { updated_at: '2026-09-09T00:00:00Z' }, calendar_events: { updated_at: '2026-09-09T00:00:00Z' } },
  rpc: { onboarding_claim_family: () => [{ family_id: familyId, created: false }] } });
  mock.db = db;
  db.seed('families', [{ id: familyId, created_by: userId, name: 'Ada family', timezone: 'UTC' }]);
  db.seed('family_members', [{ id: 'owner-member', user_id: userId, family_id: familyId, role: 'parent', is_active: true, created_at: '2026-09-09' }]);
  db.seed('user_preferences', [{ user_id: userId, active_family_id: familyId, notification_prefs: { keep: true } }]);
  db.seed('onboarding_progress', [{ user_id: userId, family_id: familyId, source: 'wizard', status: 'in_progress', updated_at: '2026-09-09T00:00:00Z' }]);
  mock.adapter = { provider: 'google', isConfigured: () => true, getAccountIdentity: mock.identity,
    listCalendars: async () => [{ externalId: 'primary', primary: true, name: 'Ada calendar', timezone: 'UTC', color: null }],
    pullCalendarWindow: async () => [{ external_id: 'school', title: 'School meeting', starts_at: '2026-09-10T10:00:00Z', ends_at: '2026-09-10T11:00:00Z',
      location: 'School', all_day: false, recurrence_rule: null, cancelled: false }] };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function request(path: string, values = mock.cookies) {
  return new NextRequest(`https://bubaly.test${path}`, { headers: { cookie: [...values].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; ') } });
}
async function connected() {
  const start = await startCalendarConnectionAction({ provider: 'google', family: { name: 'Ada family', timezone: 'UTC' }, displayName: 'Ada' });
  if (!start.ok) throw new Error(start.error);
  const response = await googleStart(request(start.url));
  const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
  mock.cookies.set(syncOAuthStateCookie('google'), response.cookies.get(syncOAuthStateCookie('google'))!.value);
  const done = await googleFinish(request(`/api/sync/google/callback?code=approved&state=${state}`));
  const accountId = new URL(done.headers.get('location')!).searchParams.get('calendarAccount');
  if (!accountId) throw new Error(done.headers.get('location')!);
  const preview = await previewConnectedCalendarAction(accountId);
  if (!preview.ok) throw new Error(preview.error);
  return { accountId, preview: preview.data };
}

describe('onboarding OAuth routes and Finish integration', () => {
  it('keeps the connection dormant through consent and preview, then imports once into the named family on Finish', async () => {
    const { accountId, preview } = await connected();
    expect(mock.legacyContext).not.toHaveBeenCalled();
    expect(db.table('sync_accounts')[0]).toMatchObject({ sync_direction: 'manual', sync_status: 'pending', family_id: familyId });
    expect(db.table('sync_connections')[0].sync_status).toBe('pending');
    expect(db.table('calendar_events')).toHaveLength(0);
    const payload = buildFinalizePayload(emptyDraft({ name: 'Ada', familyName: 'Ada family', timezone: 'UTC',
      importedEvents: preview.events, importSource: 'url', calendarReceipt: preview.receipt }));
    const result = await finalizeOnboardingAction(payload);
    expect(result).toMatchObject({ ok: true, data: { familyId } });
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('sync_calendar_events')).toHaveLength(0);
    expect(db.table('onboarding_imports')).toHaveLength(1);
    expect(db.table('onboarding_imports')[0]).toMatchObject({ source: 'url', event_count: 1, brief: { calendarConnection: { accountId, provider: 'google' } } });
    expect(db.table('sync_accounts')[0]).toMatchObject({ sync_direction: 'import', metadata: { onboardingCalendar: { state: 'import' } } });
    expect(await finalizeOnboardingAction(payload)).toMatchObject({ ok: true });
    expect(db.table('families')).toHaveLength(1);
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('onboarding_imports')).toHaveLength(1);
  });

  it('refuses tampered preview events before profile or household writes', async () => {
    const { preview } = await connected();
    const payload = buildFinalizePayload(emptyDraft({ name: 'Ada', familyName: 'Ada family', importedEvents: [{ ...preview.events[0], title: 'Different event' }],
      importSource: 'url', calendarReceipt: preview.receipt }));
    expect(await finalizeOnboardingAction(payload)).toMatchObject({ ok: false });
    expect(mock.saveProfile).not.toHaveBeenCalled();
    expect(db.table('calendar_events')).toHaveLength(0);
    expect(db.table('sync_accounts')[0].sync_direction).toBe('manual');
  });

  it.each(['onboarding_imports', 'onboarding_progress', 'sync_accounts'] as const)('keeps a failed %s Finish retryable without duplicate canonical events', async (failedTable) => {
    const { preview, accountId } = await connected();
    const payload = buildFinalizePayload(emptyDraft({ name: 'Ada', familyName: 'Ada family', timezone: 'UTC', importedEvents: preview.events, importSource: 'url', calendarReceipt: preview.receipt }));
    const original = db.from.bind(db);
    let failed = false;
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = original(table);
      if (table === failedTable && !failed) {
        const method = table === 'sync_accounts' ? 'update' : 'upsert';
        const write = query[method].bind(query) as typeof query.upsert;
        vi.spyOn(query, method).mockImplementation((value, options) => {
          if (failed || (table === 'onboarding_progress' && (value as { status?: string }).status !== 'completed')) return write(value, options);
          failed = true; throw new Error('required write unavailable');
        });
      }
      return query;
    });
    expect(await finalizeOnboardingAction(payload)).toMatchObject({ ok: false });
    expect(failed).toBe(true);
    expect(db.table('sync_accounts')[0].sync_direction).toBe('manual');
    // A page reload loses the private receipt, so both the layout and a fresh
    // owned preview must remain reachable even after completion was recorded.
    await expect(OnboardingLayout({ children: null })).resolves.toBeDefined();
    const reloaded = await previewConnectedCalendarAction(accountId);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) throw new Error(reloaded.error);
    expect(await finalizeOnboardingAction({ ...payload, calendarImport: { source: 'url', events: reloaded.data.events, receipt: reloaded.data.receipt } })).toMatchObject({ ok: true });
    expect(db.table('sync_accounts')[0].sync_direction).toBe('import');
    expect(db.table('families')).toHaveLength(1);
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('onboarding_imports')).toHaveLength(1);
    await expect(OnboardingLayout({ children: null })).rejects.toThrow('redirect:/dashboard');
  });

  it('keeps managed members and invitations stable after a partial Finish and a changed provider preview', async () => {
    const { preview, accountId } = await connected();
    const payload = { ...buildFinalizePayload(emptyDraft({ name: 'Ada', familyName: 'Ada family', timezone: 'UTC', importedEvents: preview.events, importSource: 'url', calendarReceipt: preview.receipt })),
      members: [{ kind: 'local' as const, name: 'Child', role: 'child' as const }, { kind: 'invite' as const, email: 'parent@example.test', role: 'adult' as const }] };
    const original = db.from.bind(db); let failed = false;
    vi.spyOn(db, 'from').mockImplementation((table) => {
      const query = original(table);
      if (table === 'onboarding_imports' && !failed) vi.spyOn(query, 'upsert').mockImplementation(() => { failed = true; throw new Error('import record unavailable'); });
      return query;
    });
    expect(await finalizeOnboardingAction(payload)).toMatchObject({ ok: false });
    const adapter = mock.adapter as { pullCalendarWindow: () => Promise<Record<string, unknown>[]> };
    const read = adapter.pullCalendarWindow;
    adapter.pullCalendarWindow = async () => (await read()).map((event) => ({ ...event, title: 'Changed school meeting' }));
    const reloaded = await previewConnectedCalendarAction(accountId);
    if (!reloaded.ok) throw new Error(reloaded.error);
    expect(await finalizeOnboardingAction({ ...payload, calendarImport: { source: 'url', events: reloaded.data.events, receipt: reloaded.data.receipt } })).toMatchObject({ ok: true });
    expect(db.table('family_members').filter((row) => row.role === 'child')).toHaveLength(1);
    expect(db.table('invites')).toHaveLength(1);
    expect(mock.sendEmail).toHaveBeenCalledTimes(1);
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('calendar_events')[0].title).toBe('Changed school meeting');
  });

  it('claims a new family once and resumes its wizard after consent returns', async () => {
    db.replace('families', []); db.replace('family_members', []); db.replace('onboarding_progress', []); db.replace('user_preferences', []);
    vi.spyOn(db, 'rpc').mockImplementation(async (name, args = {}) => {
      expect(name).toBe('onboarding_claim_family');
      if (!db.table('families').length) {
        db.seed('families', [{ id: familyId, created_by: userId, name: args.p_name, timezone: args.p_timezone }]);
        db.seed('onboarding_progress', [{ user_id: userId, family_id: familyId, source: 'wizard', status: 'in_progress', updated_at: '2026-09-09T00:00:00Z' }]);
      }
      return { data: [{ family_id: familyId, created: true }], error: null } as never;
    });
    await connected();
    await expect(OnboardingLayout({ children: null })).resolves.toBeDefined();
    expect(db.table('families')).toHaveLength(1);
    expect(db.table('family_members')).toHaveLength(1);
    expect(db.table('user_preferences')[0].active_family_id).toBe(familyId);
    expect(db.table('sync_accounts')[0].sync_direction).toBe('manual');
  });

  it('rechecks the owner after code exchange before creating a dormant connection', async () => {
    const state = 'onboarding.opaque-state-long-enough';
    mock.cookies.set(calendarContinuationCookie('google'), sealCalendarContinuation({ userId, familyId, provider: 'google', state }));
    mock.cookies.set(syncOAuthStateCookie('google'), state);
    mock.identity.mockImplementationOnce(async () => { db.table('family_members')[0].role = 'teen'; return 'ada@example.test'; });
    const result = await googleFinish(request(`/api/sync/google/callback?code=approved&state=${state}`));
    expect(new URL(result.headers.get('location')!).searchParams.get('calendarStatus')).toBe('unavailable');
    expect(db.table('sync_accounts')).toHaveLength(0);
  });

  it.each(['google', 'microsoft'] as const)('expired %s continuation cannot fall into ordinary two-way connection', async (provider) => {
    const state = 'onboarding.opaque-state-long-enough';
    const values = new Map([[syncOAuthStateCookie(provider), state]]);
    const req = request(`/api/sync/${provider}/callback?code=approved&state=${state}`, values);
    const result = provider === 'google' ? await googleFinish(req) : await providerFinish(req, { params: Promise.resolve({ provider }) });
    expect(new URL(result.headers.get('location')!).pathname).toBe('/onboarding');
    expect(mock.exchange).not.toHaveBeenCalled();
    expect(mock.legacyContext).not.toHaveBeenCalled();
    expect(db.table('sync_accounts')).toHaveLength(0);
  });

  it.each(['actor', 'family', 'role', 'cancelled', 'state'] as const)('refuses OAuth callback after %s context changes without connecting', async (change) => {
    const state = 'onboarding.opaque-state-long-enough';
    mock.cookies.set(calendarContinuationCookie('google'), sealCalendarContinuation({ userId: change === 'actor' ? otherUser : userId, familyId, provider: 'google', state }));
    mock.cookies.set(syncOAuthStateCookie('google'), state);
    if (change === 'family') db.table('user_preferences')[0].active_family_id = 'another-family';
    if (change === 'role') db.table('family_members')[0].role = 'teen';
    const query = change === 'cancelled' ? 'error=access_denied' : 'code=approved';
    const result = await googleFinish(request(`/api/sync/google/callback?${query}&state=${change === 'state' ? `${state}wrong` : state}`));
    expect(new URL(result.headers.get('location')!).searchParams.get('calendarStatus')).toBe(change === 'cancelled' ? 'cancelled' : 'unavailable');
    expect(mock.exchange).not.toHaveBeenCalled();
    expect(db.table('sync_accounts')).toHaveLength(0);
  });

  it('does not reopen a completed family to start another onboarding connection', async () => {
    db.table('onboarding_progress')[0].status = 'completed';
    expect(await startCalendarConnectionAction({ provider: 'google', family: { name: 'Changed', timezone: 'UTC' }, displayName: 'Ada' })).toMatchObject({ ok: false });
    expect(db.table('families')[0].name).toBe('Ada family');
    expect(mock.cookies.size).toBe(0);
  });
});
