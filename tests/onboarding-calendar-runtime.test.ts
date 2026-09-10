import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { calendarContinuationCookie, readCalendarContinuation, sealCalendarContinuation } from '@/lib/onboarding/calendar-state';
import { syncOAuthStateCookie } from '@/lib/sync/oauth-state';
import { buildFinalizePayload, emptyDraft } from '@/lib/onboarding/flow';
import type { ReviewPlan } from '@/lib/billing/review-selection';
import type { LocaleCode } from '@/lib/i18n/locales';
import { getMessages, translate } from '@/lib/i18n/messages';

const mock = vi.hoisted(() => ({ db: null as unknown, cookies: new Map<string, string>(), saveProfile: vi.fn(), exchange: vi.fn(), identity: vi.fn(), legacyContext: vi.fn(),
  adapter: null as unknown, context: vi.fn(), sendEmail: vi.fn(), locale: 'en-US' as LocaleCode }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: (name: string, value: string) => mock.cookies.set(name, value), get: (name: string) => mock.cookies.has(name) ? { value: mock.cookies.get(name) } : undefined }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => mock.db, createServiceClient: () => mock.db }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mock.legacyContext, getUserContext: mock.context }));
vi.mock('next/navigation', () => ({ redirect: (url: string) => { throw new Error(`redirect:${url}`); }, useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/i18n/server', async () => {
  const { getMessages, translate } = await import('@/lib/i18n/messages');
  return { getTranslations: async () => (key: string) => translate(getMessages(mock.locale), key) };
});
vi.mock('@/lib/sync/registry', () => ({ getAdapter: () => mock.adapter, configuredAdapters: () => mock.adapter ? [mock.adapter] : [] }));
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
const { finalizeOnboardingAction, previewCalendarImportAction } = await import('@/app/onboarding/actions');
const { default: OnboardingPage } = await import('@/app/onboarding/page');
const { GET: googleStart } = await import('@/app/api/sync/google/auth/route');
const { GET: googleFinish } = await import('@/app/api/sync/google/callback/route');
const { GET: providerStart } = await import('@/app/api/sync/[provider]/auth/route');
const { GET: providerFinish } = await import('@/app/api/sync/[provider]/callback/route');
const userId = '10000000-0000-4000-8000-000000000001';
const familyId = '20000000-0000-4000-8000-000000000001';
const otherUser = '10000000-0000-4000-8000-000000000002';
let db: InMemorySupabase;
beforeEach(() => {
  mock.locale = 'en-US';
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
  db.seed('families', [{ id: familyId, created_by: userId, name: 'Ada family', timezone: 'UTC', trial_ends_at: null, closed_at: null }]);
  db.seed('family_members', [{ id: 'owner-member', user_id: userId, family_id: familyId, role: 'parent', is_active: true, created_at: '2026-09-09' }]);
  db.seed('user_preferences', [{ user_id: userId, active_family_id: familyId, notification_prefs: { keep: true } }]);
  db.seed('onboarding_progress', [{ user_id: userId, family_id: familyId, source: 'wizard', status: 'in_progress', updated_at: '2026-09-09T00:00:00Z' }]);
  mock.adapter = { provider: 'google', isConfigured: () => true, getAccountIdentity: mock.identity,
    listCalendars: async () => [{ externalId: 'primary', primary: true, name: 'Ada calendar', timezone: 'UTC', color: null }],
    pullCalendarWindow: async () => [{ external_id: 'school', title: 'School meeting', starts_at: '2026-09-10T10:00:00Z', ends_at: '2026-09-10T11:00:00Z',
      location: 'School', all_day: false, recurrence_rule: null, cancelled: false }] };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('paste/demo preview uses the selected family timezone', () => {
  it.each([
    { name: 'evening across UTC midnight', now: '2026-09-10T00:00:00Z', timezone: 'America/New_York',
      rows: ['DTSTART:20260909T233000Z\nDTEND:20260910T010000Z\nSUMMARY:Practice', 'DTSTART:20260910T001500Z\nDTEND:20260910T013000Z\nSUMMARY:Appointment'], today: 2, firstTime: '7:30 PM' },
    { name: 'all-day original date', now: '2026-09-10T02:00:00Z', timezone: 'America/Los_Angeles',
      rows: ['DTSTART;VALUE=DATE:20260909\nSUMMARY:School closed', 'DTSTART;VALUE=DATE:20260910\nSUMMARY:Next holiday'], today: 1, firstTime: 'All day' },
    { name: 'spring DST evening', now: '2026-03-09T02:00:00Z', timezone: 'America/New_York',
      rows: ['DTSTART:20260309T020000Z\nDTEND:20260309T030000Z\nSUMMARY:Practice', 'DTSTART:20260309T023000Z\nDTEND:20260309T033000Z\nSUMMARY:Appointment'], today: 2, firstTime: '10:00 PM' },
    { name: 'morning ahead of UTC', now: '2026-09-09T22:30:00Z', timezone: 'Asia/Tokyo',
      rows: ['DTSTART:20260909T230000Z\nSUMMARY:Morning', 'DTSTART:20260910T160000Z\nSUMMARY:Tomorrow'], today: 1, firstTime: '8:00 AM' },
  ])('$name matches the actual finalized brief and stored summary', async ({ now, timezone, rows, today, firstTime }) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
    const icsText = ['BEGIN:VCALENDAR', ...rows.map(row => `BEGIN:VEVENT\n${row}\nEND:VEVENT`), 'END:VCALENDAR'].join('\n');
    const request = { source: 'paste' as const, icsText, timezone };
    const from = vi.spyOn(db, 'from');
    const preview = await previewCalendarImportAction(request);
    expect(preview.ok).toBe(true); if (!preview.ok || !preview.data) throw new Error('Preview unavailable');
    expect(from.mock.calls.map(([table]) => table)).toEqual(['meal_ideas']);
    expect(db.table('calendar_events')).toHaveLength(0); expect(db.table('onboarding_imports')).toHaveLength(0);
    const payload = buildFinalizePayload({ ...emptyDraft({ name: 'Ada', familyName: 'Ada family', timezone }), importSource: 'paste', importedEvents: preview.data.events });
    const result = await finalizeOnboardingAction(payload, { userId, familyId });
    expect(result.ok).toBe(true); if (!result.ok || !result.data?.brief) throw new Error('Finish unavailable');
    expect(result.data.brief.todayCount).toBe(today);
    expect(result.data.brief.timeline[0].timeLabel).toBe(firstTime);
    expect(db.table('onboarding_imports')[0]).toMatchObject({ family_id: familyId, today_count: today });
    expect(preview.data.brief).toEqual(result.data.brief);
    expect(db.table('calendar_events').map(row => row.starts_at)).toEqual(preview.data.events.map(event => event.start));
  });

  it.each([
    ['America/New_York', '2026-09-10T00:00:00Z', '2026-09-09T13:00:00.000Z'],
    ['Asia/Tokyo', '2026-09-09T22:30:00Z', '2026-09-10T00:00:00.000Z'],
    ['America/New_York', '2026-03-07T17:00:00Z', '2026-03-07T14:00:00.000Z'],
    ['America/New_York', '2026-10-31T16:00:00Z', '2026-10-31T13:00:00.000Z'],
  ])('demo preview and actual finalization keep the local sample schedule in %s at %s', async (timezone, instant, standup) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(instant));
    const request = { source: 'demo' as const, timezone };
    const from = vi.spyOn(db, 'from');
    const preview = await previewCalendarImportAction(request);
    expect(preview.ok).toBe(true); if (!preview.ok || !preview.data) throw new Error('Preview unavailable');
    expect(from.mock.calls.map(([table]) => table)).toEqual(['meal_ideas']);
    expect(preview.data.events[0].start).toBe(standup);
    expect(preview.data.brief.todayCount).toBe(4);
    expect(preview.data.brief.timeline.map(row => row.timeLabel)).toEqual(['9:00 AM', '4:00 PM', '4:30 PM', '6:30 PM']);
    expect(db.table('calendar_events')).toHaveLength(0);
    const result = await finalizeOnboardingAction(buildFinalizePayload({ ...emptyDraft({ name: 'Ada', familyName: 'Ada family', timezone: request.timezone }), importSource: 'demo', importedEvents: preview.data.events }), { userId, familyId });
    expect(result.ok).toBe(true); if (!result.ok || !result.data?.brief) throw new Error('Finish unavailable');
    expect(preview.data.brief).toEqual(result.data.brief);
    expect(db.table('calendar_events').map(row => [row.starts_at, row.ends_at])).toEqual(preview.data.events.map(event => [event.start, event.end]));
    expect(db.table('onboarding_imports')[0]).toMatchObject({ family_id: familyId, source: 'demo', today_count: 4, event_count: 12 });
  });

  it.each(['', ' ', 'Invalid/Zone', null, false, 42, {}, [], 'x'.repeat(101)].map(timezone => ({ timezone })))('rejects malformed supplied timezone $timezone before auth or calendar work', async ({ timezone }) => {
    const auth = vi.spyOn(db.auth, 'getUser'); const from = vi.spyOn(db, 'from');
    const result = await previewCalendarImportAction({ source: 'demo', timezone } as never);
    expect(result).toEqual({ ok: false, error: translate(getMessages(mock.locale), 'onboardingWizard.invalidPreviewTimezone') });
    expect(auth).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
  });

  it.each([
    ['en-US', 'Choose a valid time zone.'], ['de-DE', 'Wählen Sie eine gültige Zeitzone.'],
    ['es-ES', 'Elige una zona horaria válida.'], ['fr-FR', 'Choisissez un fuseau horaire valide.'],
    ['it-IT', 'Scegli un fuso orario valido.'], ['nl-NL', 'Kies een geldige tijdzone.'],
    ['pt-PT', 'Escolha um fuso horário válido.'],
  ] as const)('%s returns a localized timezone validation response before auth or reads', async (locale, error) => {
    mock.locale = locale;
    const auth = vi.spyOn(db.auth, 'getUser'); const from = vi.spyOn(db, 'from');
    expect(await previewCalendarImportAction({ source: 'demo', timezone: 'Invalid/Zone' })).toEqual({ ok: false, error });
    expect(auth).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
  });

  it.each([{ source: 'unsupported' }, { source: 'paste', icsText: 'x'.repeat(200_001) }])('preserves earlier source/text validation precedence', async input => {
    mock.locale = 'de-DE';
    const auth = vi.spyOn(db.auth, 'getUser'); const from = vi.spyOn(db, 'from');
    const original = await previewCalendarImportAction(input as never);
    expect(original.ok).toBe(false);
    expect(await previewCalendarImportAction({ ...input, timezone: 'Invalid/Zone' } as never)).toEqual(original);
    expect(auth).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled();
  });

  it('omitted timezone retains the legacy UTC presentation default', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-10T00:00:00Z'));
    const explicit = { source: 'demo' as const, timezone: 'UTC' };
    expect(await previewCalendarImportAction({ source: 'demo' })).toEqual(await previewCalendarImportAction(explicit));
  });

  it('a valid presentation timezone never bypasses the existing signed-in requirement', async () => {
    vi.spyOn(db.auth, 'getUser').mockResolvedValue({ data: { user: null }, error: null } as never);
    const from = vi.spyOn(db, 'from');
    const request = { source: 'demo' as const, timezone: 'America/New_York' };
    expect((await previewCalendarImportAction(request)).ok).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });
});
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

async function pendingOAuth(provider: 'google' | 'microsoft', reviewPlan?: ReviewPlan) {
  (mock.adapter as { provider: string }).provider = provider;
  const started = await startCalendarConnectionAction({ provider, family: { name: 'Ada family', timezone: 'UTC' }, displayName: 'Ada' }, { reviewPlan, expectedOwner: { userId, familyId } });
  if (!started.ok) throw new Error(started.error);
  const response = provider === 'google' ? await googleStart(request(started.url))
    : await providerStart(request(started.url), { params: Promise.resolve({ provider }) });
  const state = new URL(response.headers.get('location')!).searchParams.get('state')!;
  mock.cookies.set(syncOAuthStateCookie(provider), response.cookies.get(syncOAuthStateCookie(provider))!.value);
  const callback = (result = 'code=approved') => {
    const req = request(`/api/sync/${provider}/callback?${result}&state=${state}`);
    return provider === 'google' ? googleFinish(req) : providerFinish(req, { params: Promise.resolve({ provider }) });
  };
  return callback;
}

describe('onboarding Calendar Sync feature enforcement', () => {
  it.each(['off', 'failed-read'])('blocks %s before the family claim or continuation cookie', async (mode) => {
    db.replace('families', []); db.replace('family_members', []); db.replace('onboarding_progress', []); db.replace('user_preferences', []);
    if (mode === 'off') db.seed('app_settings', [{ key: 'feature_tiers', value: { 'calendar-sync': 'off' } }]);
    else {
      const from = db.from.bind(db);
      vi.spyOn(db, 'from').mockImplementation((table) => {
        if (table === 'app_settings') throw new Error('configuration unavailable');
        return from(table);
      });
    }
    const claim = vi.spyOn(db, 'rpc');
    expect(await startCalendarConnectionAction({ provider: 'google', family: { name: 'Ada family', timezone: 'UTC' }, displayName: 'Ada' })).toMatchObject({ ok: false });
    expect(claim).not.toHaveBeenCalled(); expect(mock.cookies.size).toBe(0);
    expect(mock.exchange).not.toHaveBeenCalled(); expect(db.table('families')).toHaveLength(0);
  });

  it('rechecks configuration before redirecting a prepared continuation to Google', async () => {
    const started = await startCalendarConnectionAction({ provider: 'google', family: { name: 'Ada family', timezone: 'UTC' }, displayName: 'Ada' });
    if (!started.ok) throw new Error(started.error);
    db.seed('app_settings', [{ key: 'feature_tiers', value: { 'calendar-sync': 'off' } }]);
    const response = await googleStart(request(started.url));
    expect(response.headers.get('location')).toContain('/onboarding?calendarStatus=unavailable');
    expect(mock.exchange).not.toHaveBeenCalled(); expect(db.table('sync_accounts')).toHaveLength(0);
  });

  it.each(['google', 'microsoft'] as const)('rejects %s consent return when the feature was disabled', async (provider) => {
    const callback = await pendingOAuth(provider);
    db.seed('app_settings', [{ key: 'feature_tiers', value: { 'calendar-sync': 'off' } }]);
    expect((await callback()).headers.get('location')).toContain('calendarStatus=unavailable');
    expect(mock.exchange).not.toHaveBeenCalled(); expect(mock.identity).not.toHaveBeenCalled();
    expect(db.table('sync_accounts')).toHaveLength(0); expect(db.table('sync_tokens')).toHaveLength(0);
  });

  it.each(['google', 'microsoft'] as const)('rechecks %s configuration after identity lookup before storing tokens', async (provider) => {
    const callback = await pendingOAuth(provider);
    mock.identity.mockImplementationOnce(async () => {
      db.seed('app_settings', [{ key: 'feature_tiers', value: { 'calendar-sync': 'off' } }]);
      return 'ada@example.test';
    });
    expect((await callback()).headers.get('location')).toContain('calendarStatus=unavailable');
    expect(mock.exchange).toHaveBeenCalledTimes(1);
    expect(db.table('sync_accounts')).toHaveLength(0); expect(db.table('sync_tokens')).toHaveLength(0);
  });

  it('blocks a preview changed during provider work without issuing a usable receipt', async () => {
    const { accountId } = await connected();
    const adapter = mock.adapter as { pullCalendarWindow: () => Promise<Record<string, unknown>[]> };
    const original = adapter.pullCalendarWindow;
    adapter.pullCalendarWindow = async () => {
      const events = await original();
      db.seed('app_settings', [{ key: 'feature_tiers', value: { 'calendar-sync': 'off' } }]);
      return events;
    };
    expect(await previewConnectedCalendarAction(accountId)).toMatchObject({ ok: false });
    expect(db.table('calendar_events')).toHaveLength(0);
    expect(db.table('sync_accounts')[0].sync_direction).toBe('manual');
  });

  it('rejects a valid earlier preview on Finish before any profile or canonical event write', async () => {
    const { preview } = await connected();
    db.seed('app_settings', [{ key: 'feature_tiers', value: { 'calendar-sync': 'off' } }]);
    const payload = buildFinalizePayload(emptyDraft({ name: 'Ada', familyName: 'Ada family', timezone: 'UTC', importedEvents: preview.events, importSource: 'url', calendarReceipt: preview.receipt }));
    expect(await finalizeOnboardingAction(payload)).toMatchObject({ ok: false });
    expect(mock.saveProfile).not.toHaveBeenCalled(); expect(db.table('calendar_events')).toHaveLength(0);
    expect(db.table('sync_accounts')[0].sync_direction).toBe('manual');
  });

  it('allows the normal Basic trial and requires Plus only when the feature is configured for it', async () => {
    db.table('families')[0].trial_ends_at = new Date(Date.now() + 5 * 86_400_000).toISOString();
    db.seed('app_settings', [{ key: 'feature_tiers', value: { 'calendar-sync': 'basic' } }]);
    const { accountId } = await connected();
    db.table('app_settings')[0].value = { 'calendar-sync': 'plus' };
    expect(await previewConnectedCalendarAction(accountId)).toMatchObject({ ok: false });
    db.seed('subscriptions', [{ family_id: familyId, plan: 'plus', status: 'active' }]);
    expect(await previewConnectedCalendarAction(accountId)).toMatchObject({ ok: true });
    expect(db.table('families')).toHaveLength(1);
  });
});

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
    await expect(OnboardingPage({})).resolves.toBeDefined();
    const reloaded = await previewConnectedCalendarAction(accountId);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) throw new Error(reloaded.error);
    expect(await finalizeOnboardingAction({ ...payload, calendarImport: { source: 'url', events: reloaded.data.events, receipt: reloaded.data.receipt } })).toMatchObject({ ok: true });
    expect(db.table('sync_accounts')[0].sync_direction).toBe('import');
    expect(db.table('families')).toHaveLength(1);
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('onboarding_imports')).toHaveLength(1);
    await expect(OnboardingPage({})).rejects.toThrow('redirect:/dashboard');
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
        db.seed('families', [{ id: familyId, created_by: userId, name: args.p_name, timezone: args.p_timezone, trial_ends_at: new Date(Date.now() + 5 * 86_400_000).toISOString(), closed_at: null }]);
        db.seed('onboarding_progress', [{ user_id: userId, family_id: familyId, source: 'wizard', status: 'in_progress', updated_at: '2026-09-09T00:00:00Z' }]);
      }
      return { data: [{ family_id: familyId, created: true }], error: null } as never;
    });
    await connected();
    await expect(OnboardingPage({})).resolves.toBeDefined();
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

describe('selected pricing continuation at the real onboarding boundaries', () => {
  const plans = ['basic_monthly', 'basic_annual', 'plus_monthly', 'plus_annual'] as const;
  it.each(plans)('a completed family reaches the exact %s review before profile or provider reads', async (reviewPlan) => {
    db.table('onboarding_progress')[0].status = 'completed';
    const from = vi.spyOn(db, 'from');
    await expect(OnboardingPage({ searchParams: Promise.resolve({ reviewPlan }) })).rejects.toThrow(`redirect:/dashboard/billing?view=manage&reviewPlan=${reviewPlan}`);
    expect(from.mock.calls.some(([table]) => table === 'profiles')).toBe(false);
  });
  it.each([{}, { reviewPlan: 'plus' }, { reviewPlan: ['plus_annual', 'plus_annual'] }, { reviewPlan: 'plus_annual', checkout: 'basic' }])('completed accounts with no unambiguous choice keep the dashboard destination: %j', async (query) => {
    db.table('onboarding_progress')[0].status = 'completed';
    await expect(OnboardingPage({ searchParams: Promise.resolve(query) })).rejects.toThrow('redirect:/dashboard');
  });
  it('keeps an unfinished owned family in the wizard with a separate typed hint', async () => {
    const rendered = await OnboardingPage({ searchParams: Promise.resolve({ reviewPlan: 'plus_annual' }) });
    expect(rendered.props).toMatchObject({ reviewPlan: 'plus_annual', expectedOwner: { userId, familyId } });
  });
  it('a missing-family account stays in onboarding with its authenticated owner', async () => {
    mock.context.mockResolvedValue({ needsFamily: true });
    db.replace('family_members', []); db.replace('user_preferences', []);
    const rendered = await OnboardingPage({ searchParams: Promise.resolve({ reviewPlan: 'basic_annual' }) });
    expect(rendered.props).toMatchObject({ reviewPlan: 'basic_annual', expectedOwner: { userId, familyId: null } });
  });
  it('preserves a valid selection through the signed-out entry without reading a profile', async () => {
    mock.context.mockResolvedValue(null);
    const from = vi.spyOn(db, 'from');
    await expect(OnboardingPage({ searchParams: Promise.resolve({ reviewPlan: 'plus_annual' }) })).rejects.toThrow('redirect:/login?reviewPlan=plus_annual');
    expect(from).not.toHaveBeenCalled();
  });
  it('an unavailable ownership read never becomes completed routing', async () => {
    const from = db.from.bind(db);
    vi.spyOn(db, 'from').mockImplementation((table) => { if (table === 'onboarding_progress') throw new Error('read unavailable'); return from(table); });
    await expect(OnboardingPage({ searchParams: Promise.resolve({ reviewPlan: 'plus_annual' }) })).rejects.toThrow('read unavailable');
  });
  for (const provider of ['google', 'microsoft'] as const) {
    it.each(['connected', 'cancelled', 'unavailable'] as const)(`${provider} returns the annual choice after %s with verified owner/state`, async (status) => {
      const callback = await pendingOAuth(provider, 'plus_annual');
      if (status === 'unavailable') mock.exchange.mockRejectedValueOnce(new Error('provider temporarily unavailable'));
      const response = await callback(status === 'cancelled' ? 'error=access_denied' : 'code=approved');
      const url = new URL(response.headers.get('location')!);
      expect(url.searchParams.get('reviewPlan')).toBe('plus_annual');
      expect(url.searchParams.get('calendarStatus')).toBe(status);
      if (status !== 'connected') expect(db.table('sync_accounts')).toHaveLength(0);
    });
    it.each(['actor', 'family', 'role', 'expired', 'tampered', 'state', 'provider'] as const)(`${provider} never recovers a choice from %s-invalid continuation`, async (change) => {
      const callback = await pendingOAuth(provider, 'basic_annual');
      const name = calendarContinuationCookie(provider);
      const original = readCalendarContinuation(mock.cookies.get(name))!;
      if (change === 'actor') mock.cookies.set(name, sealCalendarContinuation({ ...original, userId: otherUser }));
      if (change === 'family') db.table('user_preferences')[0].active_family_id = 'another-family';
      if (change === 'role') db.table('family_members')[0].role = 'teen';
      if (change === 'expired') mock.cookies.set(name, sealCalendarContinuation(original, Date.now() - 600_001));
      if (change === 'tampered') mock.cookies.set(name, `${mock.cookies.get(name)}tampered`);
      if (change === 'state') mock.cookies.set(syncOAuthStateCookie(provider), 'different-state');
      if (change === 'provider') mock.cookies.set(name, sealCalendarContinuation({ ...original, provider: provider === 'google' ? 'microsoft' : 'google' }));
      const url = new URL((await callback('error=access_denied')).headers.get('location')!);
      expect(url.searchParams.get('reviewPlan')).toBeNull();
      expect(mock.exchange).not.toHaveBeenCalled();
      expect(db.table('sync_accounts')).toHaveLength(0);
    });
    it(`${provider} disabled feature keeps the verified navigation hint without provider work`, async () => {
      const callback = await pendingOAuth(provider, 'basic_annual');
      db.seed('app_settings', [{ key: 'feature_tiers', value: { 'calendar-sync': 'off' } }]);
      const url = new URL((await callback()).headers.get('location')!);
      expect(url.searchParams.get('reviewPlan')).toBe('basic_annual');
      expect(url.searchParams.get('calendarStatus')).toBe('unavailable');
      expect(mock.exchange).not.toHaveBeenCalled(); expect(db.table('sync_accounts')).toHaveLength(0);
    });
  }
  it.each(['actor', 'family', 'unavailable'] as const)('stale %s Finish and Connect stop before profile, family claim, or cookie writes', async (change) => {
    const expectedOwner = { userId: change === 'actor' ? otherUser : userId, familyId };
    if (change === 'family') db.table('user_preferences')[0].active_family_id = otherUser;
    if (change === 'unavailable') {
      const from = db.from.bind(db);
      vi.spyOn(db, 'from').mockImplementation((table) => { if (table === 'user_preferences') throw new Error('read unavailable'); return from(table); });
    }
    const claim = vi.spyOn(db, 'rpc');
    const payload = buildFinalizePayload(emptyDraft({ name: 'Ada', familyName: 'Ada family' }));
    if (change === 'unavailable') await expect(finalizeOnboardingAction(payload, expectedOwner)).rejects.toThrow('read unavailable');
    else expect(await finalizeOnboardingAction(payload, expectedOwner)).toMatchObject({ ok: false });
    expect(await startCalendarConnectionAction({ provider: 'google', family: { name: 'Changed', timezone: 'UTC' }, displayName: 'Changed' }, { expectedOwner, reviewPlan: 'plus_annual' })).toMatchObject({ ok: false });
    expect(mock.saveProfile).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled(); expect(mock.cookies.size).toBe(0);
    expect(db.table('families')[0].name).toBe('Ada family');
  });
});
