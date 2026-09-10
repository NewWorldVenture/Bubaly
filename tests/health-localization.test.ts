import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, getRawMessages, translate } from '@/lib/i18n/messages';
import { localeOrDefault, type LocaleCode } from '@/lib/i18n/locales';

const harness = vi.hoisted(() => ({
  locale: 'en-US' as LocaleCode, cursor: 0, slots: [] as unknown[],
  rows: {} as Record<string, Record<string, unknown>[]>, failed: '',
  refreshes: {} as Record<string, ReturnType<typeof vi.fn>>,
  insert: vi.fn(), upsert: vi.fn(), from: vi.fn(), success: vi.fn(), error: vi.fn(), requireFeature: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useMemo: (make: () => unknown) => make(),
  useCallback: (callback: unknown) => callback,
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === 'function' ? initial() : initial;
    return [harness.slots[index], (next: unknown) => { harness.slots[index] = typeof next === 'function' ? next(harness.slots[index]) : next; }];
  },
}));
vi.mock('@/components/i18n/locale-provider', () => ({
  useTranslations: () => (key: string, params?: Record<string, string | number>) => translate(getMessages(harness.locale), key, params),
  useLocale: () => localeOrDefault(harness.locale),
}));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => translate(getMessages(harness.locale), key) }));
vi.mock('@/lib/supabase/auth', () => ({ requireFeature: harness.requireFeature }));
vi.mock('@/components/outcomes/related-outcomes', () => ({ RelatedOutcomes: () => null }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => ({
  familyId: 'family-one', userId: 'user-one', members: [{ id: 'member-one', display_name: 'Alex', role: 'parent', color: '#112233' }],
}) }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: ({ table }: { table: string }) => ({
  data: harness.rows[table] ?? [], loading: false, error: harness.failed === table ? 'PRIVATE DATABASE DIAGNOSTIC' : null,
  refresh: harness.refreshes[table] ??= vi.fn(),
}) }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => ({ from: harness.from }) }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: harness.success, error: harness.error }) }));
vi.mock('@/components/ui/modal', () => ({ Modal: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
  open ? createElement('section', { 'aria-label': title }, children) : null,
}));

const { HealthModule } = await import('@/components/modules/health-module');
const { default: HealthPage, generateMetadata } = await import('@/app/(app)/dashboard/health/page');
const locales = ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT'] as const satisfies readonly LocaleCode[];
const tables = ['health_metrics', 'workout_logs', 'appointments', 'reminders', 'symptom_logs', 'health_goals'];
const NOW = new Date(2026, 8, 9, 12, 0, 0);
type Element = ReactElement<Record<string, unknown>>;
const t = (key: string, params?: Record<string, string | number>) => translate(getMessages(harness.locale), key, params);
const escaped = (text: string) => renderToStaticMarkup(createElement('span', null, text)).replace(/^<span>|<\/span>$/g, '');

function tree() { harness.cursor = 0; return HealthModule(); }
function html() { return renderToStaticMarkup(tree()); }
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!isValidElement<Record<string, unknown>>(value)) return [];
  return [value, ...Object.values(value.props).flatMap(nodes)];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (isValidElement<Record<string, unknown>>(value)) return text(value.props.children);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
function click(value: unknown, label: string) {
  const button = nodes(value).find((node) => typeof node.props.onClick === 'function' && text(node.props.children).trim() === label);
  expect(button, `Expected the visible action ${label}`).toBeDefined();
  return (button!.props.onClick as () => Promise<void> | void)();
}
function modal(title: string) {
  const found = nodes(tree()).find((node) => node.props.open === true && node.props.title === title);
  expect(found, `Expected an open form ${title}`).toBeDefined();
  return found!;
}
function field(form: Element, label: string, value: string) {
  const wrapper = nodes(form).find((node) => node.props.label === label);
  expect(wrapper, `Expected field ${label}`).toBeDefined();
  const input = (wrapper!.props.children as (id: string) => Element)('field-under-test');
  (input.props.onChange as (event: { target: { value: string } }) => void)({ target: { value } });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  harness.locale = 'en-US'; harness.cursor = 0; harness.slots = []; harness.rows = {}; harness.failed = ''; harness.refreshes = {};
  harness.insert.mockResolvedValue({ error: null }); harness.upsert.mockResolvedValue({ error: null });
  harness.from.mockReturnValue({ insert: harness.insert, upsert: harness.upsert });
  harness.requireFeature.mockResolvedValue(undefined);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function populated() {
  const date = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
  harness.rows.health_metrics = [0, -1, -2].map((day) => ({ member_id: 'member-one', type: 'steps', value: 12345, recorded_at: date(day) }));
  harness.rows.health_metrics.push(...[
    ['sleep_hours', 8.5], ['heart_rate', 72], ['calories', 285], ['active_minutes', 75], ['water_cups', 1],
  ].map(([type, value]) => ({ member_id: 'member-one', type, value, recorded_at: date(0) })));
  harness.rows.workout_logs = [{ id: 'workout-one', member_id: 'member-one', activity: 'Evening walk', duration_minutes: 75, calories: 285, distance: 3.2, recorded_at: date(0) }];
  harness.rows.appointments = [{ id: 'appointment-one', member_id: 'member-one', title: 'Checkup', starts_at: date(1) }];
  harness.rows.symptom_logs = [{ id: 'symptom-one', member_id: 'member-one', symptom: 'Headache', severity: 3, status: 'active', started_at: date(0) }];
}

describe.each(locales)('Health dashboard in %s', (locale) => {
  beforeEach(() => { harness.locale = locale; });

  it('renders translated tabs, empty states, insights, and server metadata', async () => {
    const result = html();
    for (const key of ['health.health', 'healthDashboard.overview', 'healthDashboard.nutrition', 'healthDashboard.vitals', 'healthDashboard.insightsEmpty', 'health.noSymptomsLogged']) {
      expect(result).toContain(escaped(t(key)));
    }
    expect(result).not.toContain('healthDashboard.');
    expect(await generateMetadata()).toEqual({ title: t('health.health') });
    await HealthPage();
    expect(harness.requireFeature).toHaveBeenCalledWith('/dashboard/health');
  });

  it('renders recorded values, localized dates and units, severity and complete dynamic insights', () => {
    populated();
    const result = html();
    const duration = t('healthDashboard.durationHoursMinutes', { hours: '8', minutes: '30' });
    for (const expected of [
      t('healthDashboard.stepStreak', { name: 'Alex', count: '3' }),
      t('healthDashboard.sleepInsight', { duration }),
      t('healthDashboard.memberCheckupDay', { name: 'Alex', count: '1', title: 'Checkup' }),
      t('healthDashboard.waterInsightOne', { count: '1' }),
      t('healthDashboard.moderate'), t('trustRole.parent'),
      (12345).toLocaleString(locale), `${(3.2).toLocaleString(locale)} ${t('healthDashboard.unitMiles')}`,
      NOW.toLocaleDateString(locale, { weekday: 'short' }),
      t('healthDashboard.todayAt', { time: NOW.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' }) }),
    ]) expect(result).toContain(escaped(expected));
    expect(result).toContain('Evening walk');
    expect(result).not.toMatch(/healthDashboard\.|\{(?:count|name|duration|title|time)\}/);
  });

  it.each([
    ['steps', 'steps'], ['sleep_hours', 'hours'], ['heart_rate', 'bpm'], ['calories', 'kcal'],
    ['active_minutes', 'min'], ['distance', 'miles'], ['weight', 'lbs'], ['water_cups', 'cups'],
  ])('translates the metric form while saving canonical %s / %s', async (type, unit) => {
    click(tree(), t('health.logMetric'));
    let form = modal(t('health.logHealthMetric'));
    expect(renderToStaticMarkup(form)).toContain(escaped(t('healthDashboard.unitMiles')));
    field(form, t('health.familyMember'), 'member-one');
    form = modal(t('health.logHealthMetric')); field(form, t('health.metricType'), type);
    form = modal(t('health.logHealthMetric')); field(form, t('health.value'), '12.5');
    await click(modal(t('health.logHealthMetric')), t('health.logMetric'));
    expect(harness.from).toHaveBeenCalledWith('health_metrics');
    expect(harness.insert).toHaveBeenCalledWith(expect.objectContaining({ family_id: 'family-one', member_id: 'member-one', type, unit, value: 12.5 }));
    expect(harness.success).toHaveBeenCalledWith(t('healthModule.metricLogged'));
  });

  it.each([1, 2])('renders a locale-safe active symptom count for %i symptoms', (count) => {
    populated();
    harness.rows.symptom_logs = Array.from({ length: count }, (_, index) => ({ ...harness.rows.symptom_logs[0], id: `symptom-${index}` }));
    const activeLabel: Record<(typeof locales)[number], string> = {
      'en-US': 'active', 'de-DE': 'aktiv', 'es-ES': 'en curso', 'fr-FR': 'en cours',
      'it-IT': 'in corso', 'nl-NL': 'actief', 'pt-PT': 'em curso',
    };
    expect(html()).toContain(escaped(`${count.toLocaleString(locale)} ${activeLabel[locale]}`));
  });

  it.each([
    ['steps', 'Steps'], ['sleep_hours', 'Sleep'], ['heart_rate', 'Heart Rate'], ['calories', 'Calories'],
    ['active_minutes', 'Active Minutes'], ['distance', 'Distance'], ['weight', 'Weight'], ['water_cups', 'Water'],
  ])('preserves the canonical %s / %s goal and weekly cadence when display labels translate', async (type, label) => {
    click(tree(), t('health.setGoals'));
    field(modal(t('health.setHealthGoal')), t('health.familyMember'), 'member-one');
    field(modal(t('health.setHealthGoal')), t('health.metric'), type);
    field(modal(t('health.setHealthGoal')), t('health.period'), 'weekly');
    field(modal(t('health.setHealthGoal')), t('health.target'), '5');
    await click(modal(t('health.setHealthGoal')), t('healthDashboard.saveGoal'));
    expect(harness.upsert).toHaveBeenCalledWith(expect.objectContaining({ metric_type: type, label, target: 5, period: 'weekly', family_id: 'family-one', member_id: 'member-one' }), { onConflict: 'member_id,metric_type,period' });
  });

  it('keeps the coach question/member payload and translates network failures', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('PRIVATE NETWORK DIAGNOSTIC'));
    vi.stubGlobal('fetch', fetch);
    click(tree(), t('health.askAi'));
    field(modal(t('health.aiHealthCoach')), t('health.aboutOptional'), 'member-one');
    field(modal(t('health.aiHealthCoach')), t('health.question'), 'My question');
    expect(renderToStaticMarkup(modal(t('health.aiHealthCoach')))).toContain(escaped(t('healthDashboard.coachDescription')));
    await click(modal(t('health.aiHealthCoach')), t('health.askTheCoach'));
    expect(fetch).toHaveBeenCalledWith('/api/ai/health/coach', expect.objectContaining({ method: 'POST', body: JSON.stringify({ question: 'My question', memberId: 'member-one' }) }));
    expect(html()).toContain(escaped(t('healthDashboard.networkError')));
    expect(html()).not.toContain('PRIVATE NETWORK DIAGNOSTIC');
  });

  it.each(tables)('keeps a failed %s read unavailable and retries all coordinated sources', (table) => {
    populated(); harness.failed = table;
    const result = tree();
    expect(renderToStaticMarkup(result)).toContain(escaped(t('healthDashboard.loadError')));
    expect(renderToStaticMarkup(result)).not.toContain('PRIVATE DATABASE DIAGNOSTIC');
    const retry = result.props.onRetry as () => void;
    retry();
    for (const source of tables) expect(harness.refreshes[source]).toHaveBeenCalledTimes(1);
  });
});

it('retains a rejected Health feature gate', async () => {
  const denied = new Error('feature denied');
  harness.requireFeature.mockRejectedValue(denied);
  await expect(HealthPage()).rejects.toBe(denied);
});

it('ships every new key in all seven raw catalogs with matching placeholders', () => {
  const english = getRawMessages('en-US');
  const keys = Object.keys(english).filter((key) => key.startsWith('healthDashboard.'));
  expect(keys).toHaveLength(64);
  for (const locale of locales) {
    const messages = getRawMessages(locale);
    for (const key of keys) {
      expect(typeof messages[key], `${locale}: ${key}`).toBe('string');
      expect(messages[key].match(/\{\w+\}/g)?.sort() ?? []).toEqual(english[key].match(/\{\w+\}/g)?.sort() ?? []);
    }
  }
});
