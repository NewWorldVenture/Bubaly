import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { buildFinalizePayload, emptyDraft } from '@/lib/onboarding/flow';
import { onboardingItemKey, onboardingRunKey } from '@/lib/onboarding/idempotency';
import { finalizeOnboardingSchema } from '@/lib/validation';
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

const { finalizeOnboardingAction, previewCalendarImportAction } = await import('@/app/onboarding/actions');
const userId = '10000000-0000-4000-8000-000000000001';
const familyId = '20000000-0000-4000-8000-000000000001';
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

const calendar = (lines: string) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VEVENT', 'UID:Appointment-id', 'SUMMARY:Appointment', lines, 'END:VEVENT', 'END:VCALENDAR'].join('\n');
const local = (time: string) => 'DTSTART;TZID=America/New_York:' + time;
const draftFor = (timezone: string) => emptyDraft({ name: 'Ada', familyName: 'Ada family', timezone });
const locales = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;

describe('actual strict paste preview and finalization', () => {
  it('retries an older recurring:true payload with the original run/item identity and no false recurrence benefit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const payload = buildFinalizePayload({ ...draftFor('America/New_York'), importSource: 'paste',
      importedEvents: [{ title: 'Older listed occurrence', start: '2026-09-10T13:00:00Z', end: '2026-09-10T14:00:00Z', recurring: true }] });
    const canonical = finalizeOnboardingSchema.parse(payload);
    const expectedKey = onboardingItemKey(onboardingRunKey(userId, canonical), 'calendar-event', 0, canonical.calendarImport.events[0]);
    const original = db.from.bind(db); let failed = false;
    vi.spyOn(db, 'from').mockImplementation(table => {
      const query = original(table);
      if (table === 'onboarding_imports' && !failed) vi.spyOn(query, 'upsert').mockImplementation(() => { failed = true; throw new Error('import record unavailable'); });
      return query;
    });
    const first = await finalizeOnboardingAction(payload, { userId, familyId });
    expect(first.ok).toBe(false); expect(failed).toBe(true);
    expect(db.table('calendar_events')).toHaveLength(1);
    expect(db.table('calendar_events')[0].onboarding_key).toBe(expectedKey);
    const retry = await finalizeOnboardingAction(payload, { userId, familyId });
    expect(retry.ok).toBe(true); if (!retry.ok || !retry.data?.brief) throw new Error('Retry failed');
    expect(retry.data.brief.opportunities.some(item => item.id === 'recurring')).toBe(false);
    expect(retry.data.brief.timeSavedMinutes).toBe(2);
    expect(db.table('calendar_events')).toHaveLength(1); expect(db.table('calendar_events')[0].onboarding_key).toBe(expectedKey);
    expect(db.table('calendar_events')[0].recurrence).toBe('none'); expect(payload.calendarImport.events[0].recurring).toBe(true);
    expect(db.table('onboarding_imports')).toHaveLength(1);
  });
  it.each([false, true])('RRULE imports disclose listed occurrences without claiming recurrence benefits (returned flag modified: %s)', async modified => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const preview = await previewCalendarImportAction({ source: 'paste', timezone: 'America/New_York',
      icsText: calendar(local('20260910T090000') + '\nDURATION:PT1H\nRRULE:FREQ=WEEKLY') });
    expect(preview.ok).toBe(true); if (!preview.ok || !preview.data) throw new Error('Preview failed');
    expect(preview.data.disclosure).toEqual({ recurring: true });
    expect(preview.data.events[0].recurring).toBe(false);
    expect(preview.data.brief.opportunities.some(item => item.id === 'recurring')).toBe(false);
    expect(preview.data.brief.timeSavedMinutes).toBe(2);
    const returned = preview.data.events.map(event => ({ ...event, recurring: modified }));
    const result = await finalizeOnboardingAction(buildFinalizePayload({ ...draftFor('America/New_York'),
      importedEvents: returned, importSource: 'paste' }), { userId, familyId });
    expect(result.ok).toBe(true); if (!result.ok || !result.data?.brief) throw new Error('Finish failed');
    expect(result.data.brief.opportunities.some(item => item.id === 'recurring')).toBe(false);
    expect(result.data.brief.timeSavedMinutes).toBe(2);
    expect(db.table('calendar_events')[0].recurrence).toBe('none');
  });
  it.each([
    { label: 'named New York', lines: local('20260910T090000') + '\nDTEND;TZID=America/New_York:20260910T100000', start: '2026-09-10T13:00:00.000Z', end: '2026-09-10T14:00:00.000Z', clock: '9:00 AM', floating: false },
    { label: 'floating selected zone', lines: 'DTSTART:20260910T090000\nDTEND:20260910T100000', start: '2026-09-10T13:00:00.000Z', end: '2026-09-10T14:00:00.000Z', clock: '9:00 AM', floating: true },
    { label: 'explicit DATE-TIME UTC', lines: 'DTSTART;VALUE=DATE-TIME:20260910T130000Z\nDURATION:PT90M', start: '2026-09-10T13:00:00Z', end: '2026-09-10T14:30:00Z', clock: '9:00 AM', floating: false },
    { label: 'zero duration', lines: local('20260910T090000'), start: '2026-09-10T13:00:00.000Z', end: '2026-09-10T13:00:00.000Z', clock: '9:00 AM', floating: false },
  ])('$label persists exactly the previewed instants', async ({ lines, start, end, clock, floating }) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const from = vi.spyOn(db, 'from');
    const result = await previewCalendarImportAction({ source: 'paste', icsText: calendar(lines), timezone: 'America/New_York' });
    expect(result.ok).toBe(true); if (!result.ok || !result.data) throw new Error('Preview failed');
    expect(from.mock.calls.map(([table]) => table)).toEqual(['meal_ideas']);
    expect(db.table('calendar_events')).toHaveLength(0);
    expect(result.data.events[0]).toMatchObject({ start, end, allDay: false });
    expect(result.data.brief.timeline[0].timeLabel).toBe(clock);
    expect(result.data.disclosure).toEqual({ recurring: false, ...(floating ? { floatingTimezone: 'America/New_York' } : {}) });
    const payload = buildFinalizePayload({ ...draftFor('America/New_York'), importSource: 'paste', importedEvents: result.data.events });
    expect(JSON.stringify(payload)).not.toContain('disclosure');
    const final = await finalizeOnboardingAction(payload, { userId, familyId });
    expect(final.ok).toBe(true); if (!final.ok || !final.data?.brief) throw new Error('Finalization failed');
    expect(final.data.brief).toEqual(result.data.brief);
    expect(db.table('calendar_events')[0]).toMatchObject({ family_id: familyId, starts_at: start, ends_at: end, all_day: false });
    expect(db.table('onboarding_imports')[0]).toMatchObject({ source: 'paste', event_count: 1, today_count: 1 });
  });

  it('a pasted point event does not create an overlap in the preview or final brief', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
    const text = calendar(local('20260910T090000')).replace('END:VCALENDAR',
      'BEGIN:VEVENT\nSUMMARY:Second\nDTSTART;TZID=America/New_York:20260910T083000\nDTEND;TZID=America/New_York:20260910T093000\nEND:VEVENT\nEND:VCALENDAR');
    const preview = await previewCalendarImportAction({ source: 'paste', icsText: text, timezone: 'America/New_York' });
    expect(preview.ok).toBe(true); if (!preview.ok || !preview.data) throw new Error('Preview failed');
    expect(preview.data.brief.conflicts).toEqual([]);
    const result = await finalizeOnboardingAction(buildFinalizePayload({ ...draftFor('America/New_York'), importSource: 'paste', importedEvents: preview.data.events }), { userId, familyId });
    expect(result.ok && result.data?.brief?.conflicts).toEqual([]);
  });

  it.each([
    ['20260308T023000', '2026-03-08T07:30:00.000Z', '2026-03-08T12:00:00Z'],
    ['20261101T013000', '2026-11-01T05:30:00.000Z', '2026-11-01T12:00:00Z'],
  ])('preserves the DST interpretation of %s through saving', async (time, start, now) => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(now));
    const preview = await previewCalendarImportAction({ source: 'paste', icsText: calendar(local(time) + '\nDURATION:PT30M'), timezone: 'America/New_York' });
    expect(preview.ok).toBe(true); if (!preview.ok || !preview.data) throw new Error('Preview failed');
    expect(preview.data.events[0].start).toBe(start);
    const result = await finalizeOnboardingAction(buildFinalizePayload({ ...draftFor('America/New_York'), importSource: 'paste', importedEvents: preview.data.events }), { userId, familyId });
    expect(result.ok).toBe(true);
    expect(db.table('calendar_events')[0].starts_at).toBe(start);
  });

  it.each(locales)('%s returns localized import errors with no partial rows or family provisioning', async locale => {
    mock.locale = locale;
    const from = vi.spyOn(db, 'from');
    const cases = [
      ['invalidCalendar', 'not a calendar'],
      ['invalidDate', calendar('DTSTART;VALUE=DATE-TIME:20260230T090000Z')],
      ['invalidRange', calendar('DTSTART:20260910T130000Z\nDTEND:20260910T120000Z')],
      ['invalidDuration', calendar('DTSTART:20260910T130000Z\nDURATION:-PT1H')],
      ['unsupportedTimezone', calendar('DTSTART;TZID=Custom/Office:20260910T090000')],
      ['unsupportedRecurrence', calendar('DTSTART:20260910T130000Z\nEXDATE:20260910T130000Z')],
      ['tooManyEvents', 'x'.repeat(200001)],
    ];
    for (const [code, icsText] of cases) {
      expect(await previewCalendarImportAction({ source: 'paste', icsText, timezone: 'America/New_York' }))
        .toEqual({ ok: false, error: translate(getMessages(locale), 'calendarImport.' + code) });
    }
    expect(await previewCalendarImportAction({ source: 'paste', icsText: calendar('DTSTART:20260910T090000') }))
      .toEqual({ ok: false, error: translate(getMessages(locale), 'calendarImport.floatingTimezoneRequired') });
    expect(from).not.toHaveBeenCalled(); expect(mock.saveProfile).not.toHaveBeenCalled();
    expect(db.table('calendar_events')).toHaveLength(0); expect(mock.legacyContext).not.toHaveBeenCalled();
  });

  it('rejects a mixed paste as a whole, even after a valid first event', async () => {
    const text = calendar('DTSTART:20260910T130000Z').replace('END:VCALENDAR',
      'BEGIN:VEVENT\nDTSTART;TZID=Custom/Office:20260910T090000\nEND:VEVENT\nEND:VCALENDAR');
    const from = vi.spyOn(db, 'from');
    expect(await previewCalendarImportAction({ source: 'paste', icsText: text, timezone: 'America/New_York' }))
      .toEqual({ ok: false, error: translate(getMessages(mock.locale), 'calendarImport.unsupportedTimezone') });
    expect(from).not.toHaveBeenCalled();
  });

  it.each([
    { start: '2026-02-30T09:00:00Z' }, { start: '2026-09-10T09:00:00' },
    { start: '2026-09-10T09:00:00-04:00' }, { start: '2026-09-10T09:00:00Z', end: '2026-09-10T08:00:00Z' },
    { start: '2026-09-10T09:00:00Z', allDay: true },
  ])('rejects malformed browser-returned pasted times before any mutations: $start', async fields => {
    const auth = vi.spyOn(db.auth, 'getUser'); const from = vi.spyOn(db, 'from');
    const result = await finalizeOnboardingAction(buildFinalizePayload({ ...draftFor('America/New_York'),
      importSource: 'paste', importedEvents: [{ title: 'Returned event', ...fields }] }), { userId, familyId });
    expect(result).toEqual({ ok: false, error: translate(getMessages(mock.locale), 'calendarImport.invalidDate') });
    expect(auth).not.toHaveBeenCalled(); expect(from).not.toHaveBeenCalled(); expect(mock.saveProfile).not.toHaveBeenCalled();
  });
});
