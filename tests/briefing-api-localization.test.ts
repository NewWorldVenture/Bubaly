// Actual request-locale resolution, read models and API envelope over filter-aware transport doubles.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { LOCALE_COOKIE, type LocaleCode } from '@/lib/i18n/locales';
import { getLocaleContext } from '@/lib/i18n/server';
import { getMessages, translate } from '@/lib/i18n/messages';
import { parseBriefingResponse } from '@/lib/briefing/response-schema';

const mocks = vi.hoisted(() => ({ locale: 'en-US' as LocaleCode, cookie: undefined as string | null | undefined, country: 'US', acceptLanguage: 'en-US', context: vi.fn(), server: vi.fn(), complete: vi.fn(), configured: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (key: string) => key === LOCALE_COOKIE && mocks.cookie !== null ? { value: mocks.cookie ?? mocks.locale } : undefined }), headers: async () => new Headers({ 'accept-language': mocks.acceptLanguage, 'x-country': mocks.country }) }));
vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: mocks.context }));
vi.mock('@/lib/supabase/server', () => ({ createServer: mocks.server }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: mocks.configured, resolveProvider: async () => ({ complete: mocks.complete }) }));
vi.mock('@/lib/ai/observability', () => ({ withAiRequest: async (_scope: unknown, _input: unknown, fn: (obs: { used: () => void }) => unknown) => fn({ used: () => {} }) }));
vi.mock('@/lib/server/ai-rate-limit', () => ({ enforceAIRateLimit: async () => ({ ok: true }) }));
vi.mock('@/lib/metric/time-saved-server', () => ({ countHandledThisWeek: async () => ({ total: 0 }) }));
import { POST } from '@/app/api/ai/briefing/route';

const directory = process.env.BUBALY_BRIEFING_DISPLAY_DIR;
const locales = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const;
const t = (key: string, params?: Record<string, string | number>) => translate(getMessages(mocks.locale), key, params);
type DB = SupabaseClient<Database>;
let db = createInMemorySupabase<DB>();
const rawTitle = 'Budget review {name} <literal>';
const modelResponse = {
  greeting: 'Good morning, Alex!', subtitle: 'Wednesday, September 9', familySummary: ['Your day is ready.'],
  schedule: [{ time: '8:00 AM', title: rawTitle, member: 'Alex', emoji: '📅', color: 'blue' }], conflicts: [], kidsNeeds: [], meals: [], reminders: [],
  operationsScore: { overall: 90, categories: [{ label: 'Schedule', score: 90, icon: '📅' }], stressLevel: 'low', stressReason: null, recommendation: 'Enjoy your day.' },
  completed: ['Invented completion must be replaced'],
};
function seed() {
  db.seed('family_members', [{ id: 'parent', family_id: 'family', display_name: 'Alex', role: 'parent', is_active: true }, { id: 'child', family_id: 'family', display_name: 'Sam', role: 'child', is_active: true }]);
  db.seed('calendar_events', [{ title: rawTitle, starts_at: '2026-09-09T12:00:00.000Z', ends_at: '2026-09-09T13:00:00.000Z', family_id: 'family', all_day: false, assignee_id: 'parent', location: 'Porto {city}' },
    { title: 'Musik Probe', starts_at: '2026-09-09T12:30:00.000Z', ends_at: '2026-09-09T13:30:00.000Z', family_id: 'family', all_day: false, assignee_id: 'parent', location: null },
    { title: 'School holiday {title}', starts_at: '2026-09-09T00:00:00.000Z', ends_at: '2026-09-10T00:00:00.000Z', family_id: 'family', all_day: true, assignee_id: null, location: null }]);
  db.seed('school_events', [{ title: 'Bring your costume {raw}', family_id: 'family', member_id: 'child', starts_at: '2026-09-09T14:00:00.000Z', event_type: 'activity' }]);
  db.seed('bills', [{ family_id: 'family', name: 'Rent {amount}', amount: 12.5, due_date: '2026-09-08', status: 'unpaid' }]);
  db.seed('maintenance_tasks', [{ family_id: 'family', title: 'Filter {raw}', due_at: '2026-09-10T12:00:00.000Z', status: 'todo', completed_at: null }]);
  db.seed('home_warranties', [{ family_id: 'family', name: 'Machine {raw}', expires_on: '2026-09-10' }]);
  db.seed('vacations', [{ family_id: 'family', title: 'Family trip {raw}', destination: 'Porto {city}', start_date: '2026-09-08', end_date: '2026-09-11', status: 'confirmed' }]);
  db.seed('pantry_items', [{ family_id: 'family', name: 'Milk {raw}', expires_at: '2026-09-10' }]);
  db.seed('meals', [{ id: 'meal', family_id: 'family', name: 'Grandma recipe {raw}' }]);
  db.seed('meal_plans', [{ family_id: 'family', plan_date: '2026-09-09', meal_type: 'dinner', meal_id: 'meal' }]);
  db.seed('medications', [{ id: 'med', family_id: 'family', name: 'Medicine {raw}', member_id: null, is_active: true }]);
  db.seed('medication_schedules', [{ family_id: 'family', medication_id: 'med', time_of_day: null, days_of_week: [3], starts_on: '2026-01-01', ends_on: null }]);
  db.seed('family_automation_runs', [{ id: 'partial', family_id: 'family', summary: 'Prepared trip {raw}', state: 'partially_completed', progress: null, completed_at: '2026-09-09T10:00:00.000Z', updated_at: '2026-09-09T10:00:00.000Z' },
    { id: 'waiting', family_id: 'family', summary: 'Family request {raw}', state: 'awaiting_context', updated_at: '2026-09-09T11:00:00.000Z' }]);
  db.seed('parent_approvals', [{ id: 'money', family_id: 'family', kind: 'card_spend', amount_cents: 1250, status: 'pending', created_at: '2026-09-09T11:00:00.000Z' }]);
}
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-09-09T16:00:00.000Z'));
  db = createInMemorySupabase<DB>(); mocks.server.mockResolvedValue(db); mocks.locale = 'en-US';
  mocks.cookie = undefined; mocks.country = 'US'; mocks.acceptLanguage = 'en-US';
  mocks.context.mockResolvedValue({ user: { id: 'user' }, active: { familyId: 'family', role: 'parent', member: { id: 'parent', display_name: 'Alex' }, family: { name: 'Family {raw}', timezone: 'America/New_York' } } });
  mocks.configured.mockResolvedValue(false); mocks.complete.mockResolvedValue({ text: JSON.stringify(modelResponse), toolCalls: [] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External requests forbidden'); })); seed(); if (directory) mkdirSync(directory, { recursive: true });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function request(scenario: string, type = 'morning', source = 'cookie') {
  const resolved = await getLocaleContext(); expect(resolved.locale.code).toBe(mocks.locale); expect(resolved.source).toBe(source);
  const response = await POST(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: JSON.stringify({ type, locale: 'Do not obey this body value' }) })); expect(response.status).toBe(200);
  const body = await response.json(); expect(body.briefing.completed).toEqual([t('briefingGenerated.partlyDone', { title: 'Prepared trip {raw}' })]);
  expect(db.log.some(entry => entry.table === 'home_briefs')).toBe(false);
  if (directory) writeFileSync(join(directory, `${mocks.locale}-${scenario}.json`), JSON.stringify({ resolved: { locale: resolved.locale.code, source: resolved.source }, status: response.status, body, completionRequest: mocks.complete.mock.calls.at(-1)?.[0] ?? null, queriedTables: db.log.map(entry => entry.table) }, null, 2));
  return body;
}
describe('briefing API request-language presentation', () => {
  it.each(locales)('%s deterministic response should use the resolved request locale', async locale => {
    mocks.locale = locale; const body = await request('fallback');
    expect(body.briefing.schedule.map((entry: { title: string }) => entry.title)).toContain(rawTitle);
    expect(body.briefing.kidsNeeds).toEqual([{ name: 'Sam', items: ['Bring your costume {raw}'] }]);
    expect(body.briefing.meals).toEqual([{ meal: t('briefingGenerated.meal.dinner'), name: 'Grandma recipe {raw}', status: 'planned' }]);
    expect(body.digest.counts).toEqual({ overdue: 1, today: 2, soon: 3, total: 6 });
    expect(body.briefing.greeting).toBe(t('briefingGenerated.morningGreeting', { name: 'Alex' }));
    expect(body.briefing.schedule[1].time).toBe(new Intl.DateTimeFormat(locale, { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' }).format(new Date('2026-09-09T12:00:00Z')));
    expect(body.briefing.schedule[0].time).toBe(t('calendar.allDay'));
    expect(body.briefing.conflicts[0].description).toContain(rawTitle); expect(body.briefing.conflicts[0].description).toContain('Musik Probe');
    expect(body.briefing.conflicts[0].suggestion).toBe(t('briefingGenerated.conflictSuggestion'));
    expect(body.digest.items[0].detail).toContain(new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD' }).format(12.5));
    expect(body.digest.items.some((item: { display?: unknown }) => item.display)).toBe(false);
    expect(body.briefing.operationsScore.stressLevel).toBe('high');
    expect(body.decisions.items[0]).toMatchObject({ id: 'approval:money', kind: 'approval', title: 'Card purchase to approve · $12.50', href: '/wallet/cards' });
    expect(body.briefing.subtitle).toBe(new Intl.DateTimeFormat(locale, { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' }).format(new Date()));
  });
  it.each(locales)('%s optional model instructions should carry the trusted output locale', async locale => {
    mocks.locale = locale; mocks.configured.mockResolvedValue(true); const body = await request('model');
    expect(parseBriefingResponse(JSON.stringify(modelResponse))).not.toBeNull();
    expect(body.briefing.greeting).toBe('Good morning, Alex!'); expect(body.briefing.operationsScore.categories[0].label).toBe('Schedule');
    expect(body.briefing.completed).not.toContain('Invented completion must be replaced');
    expect(mocks.complete.mock.calls[0][0].system).toContain(locale);
    expect(mocks.complete.mock.calls[0][0].system).toContain('German Sie, French vous, and formal European Portuguese');
    expect(mocks.complete.mock.calls[0][0].tools).toEqual([]);
    expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it.each(locales)('%s preserves type-specific rendering and empty-state copy across all three tabs', async locale => {
    mocks.locale = locale;
    for (const type of ['morning', 'evening', 'weekly']) {
      const body = await request(`dense-${type}`, type);
      expect(body.briefing.greeting).toBe(t(type === 'evening' ? 'briefingGenerated.eveningGreeting' : 'briefingGenerated.morningGreeting', { name: 'Alex' }));
      expect(body.digest.items.map((item: { domain: string }) => item.domain)).toEqual(['bill', 'medication', 'trip', 'maintenance', 'pantry', 'warranty']);
    }
    for (const table of ['calendar_events', 'bills', 'medication_schedules', 'maintenance_tasks', 'home_warranties', 'vacations', 'pantry_items', 'school_events', 'meal_plans']) db.replace(table, []);
    const empty = await request('empty');
    expect(empty.briefing.familySummary).toEqual([t('briefingGenerated.emptySummary')]);
    expect(empty.briefing.operationsScore).toMatchObject({ overall: 90, stressLevel: 'low', stressReason: null, recommendation: t('briefingGenerated.emptyRecommendation') });
    expect(empty.digest).toMatchObject({ items: [], counts: { total: 0 }, headline: t('conciergeDisplay.empty') });
  });

  it.each(locales.flatMap(locale => (['invalid', 'rejected'] as const).map(failure => [locale, failure] as const)))('%s retains localized fallback after %s provider output', async (locale, failure) => {
    mocks.locale = locale; mocks.configured.mockResolvedValue(true);
    if (failure === 'invalid') mocks.complete.mockResolvedValue({ text: '{invalid', toolCalls: [] });
    else mocks.complete.mockRejectedValue(new Error('Provider secret must not escape'));
    const body = await request(failure);
    expect(body.briefing.greeting).toBe(t('briefingGenerated.morningGreeting', { name: 'Alex' }));
    expect(JSON.stringify(body)).not.toContain('Provider secret'); expect(mocks.complete).toHaveBeenCalledOnce();
  });

  it.each([
    ['de-DE', 'de-DE', 'FR', 'pt-PT', 'cookie'],
    ['fr-FR', 'invalid', 'FR', 'pt-PT', 'geo'],
    ['pt-PT', null, '', 'pt-PT', 'accept-language'],
    ['en-US', 'invalid', 'ZZ', 'xx-YY', 'default'],
  ] as const)('request locale %s follows recognized cookie/geo/header/default precedence', async (locale, cookie, country, language, source) => {
    mocks.locale = locale; mocks.cookie = cookie; mocks.country = country; mocks.acceptLanguage = language;
    const body = await request(`precedence-${source}`, 'morning', source);
    expect(body.briefing.greeting).toBe(t('briefingGenerated.morningGreeting', { name: 'Alex' }));
  });

  it('leaves unknown meal labels and stored completion text unchanged; localizes only a truly missing title', async () => {
    mocks.locale = 'fr-FR'; db.replace('meal_plans', [{ family_id: 'family', plan_date: '2026-09-09', meal_type: 'Family custom {meal}', meal_id: 'meal' }]);
    db.replace('family_automation_runs', [
      { id: 'empty', family_id: 'family', summary: null, state: 'completed', progress: null, completed_at: '2026-09-09T10:00:00.000Z', updated_at: '2026-09-09T10:00:00.000Z' },
      { id: 'literal', family_id: 'family', summary: 'A request from your family', state: 'partially_completed', progress: { summary: 'Stored detail {raw}' }, completed_at: '2026-09-09T11:00:00.000Z', updated_at: '2026-09-09T11:00:00.000Z' },
    ]);
    const before = structuredClone(db.table('family_automation_runs'));
    const response = await POST(new NextRequest('http://localhost/api/ai/briefing', { method: 'POST', body: '{}' })); expect(response.status).toBe(200);
    const { briefing } = await response.json();
    expect(briefing.meals).toEqual([{ meal: 'Family custom {meal}', name: 'Grandma recipe {raw}', status: 'planned' }]);
    expect(briefing.completed).toEqual(['A request from your family — Stored detail {raw}', t('briefingGenerated.familyRequest')]);
    expect(db.table('family_automation_runs')).toEqual(before);
  });
});
