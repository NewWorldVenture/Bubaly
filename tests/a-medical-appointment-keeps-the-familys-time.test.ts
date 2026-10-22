// A medical appointment typed on the Health page was saved on the DEVICE's
// clock, not the family's.
//
// The Health page's "Add appointment" box is a <input type="datetime-local">:
// a naive wall reading ('2026-10-13T15:00'). The module turned it into an
// instant with `new Date(value)`, which resolves it in the zone of whatever
// device typed it. Every reader of `appointments` is on the FAMILY's clock
// (TIME-003): the Family Health page, the Health page's own dates, the daily
// and weekly briefings, and the Autopilot "Dentist is today" card, whose
// "Remind me" sets the reminder at the stored instant. So a parent away from
// home who booked "Dentist 15:00" stored another hour, and the family was
// shown, briefed and reminded at that hour. The symptom, metric and workout
// boxes in the same module had the same defect. The inbox, school, sports,
// homework and voting modules already resolve the box with
// `datetimeLocalToInstant` (lib/time/datetime-local.ts).
//
// Driven through the REAL HealthModule against an in-memory database
// (tests/helpers/module-harness.tsx). The family's zone reaches the module the
// way production gives it, through the locale provider's family time zone.
// The family zones here are neither UTC nor Los Angeles, the two zones the
// suite runs under, so the device's zone is never the family's.
import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { allByName, byName, change, click, nodes, render, type Node } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/ui/confirm', async () => (await import('./helpers/module-harness')).confirmModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);

const { HealthModule } = await import('@/components/modules/health-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
let db: InMemorySupabase;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  h.timeZone = 'America/New_York';
  (h.app as Record<string, unknown>).role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const screen = () => render(h.hooks, createElement(HealthModule));

/** The open modal with this title. */
function dialog(title: string): Node {
  const found = nodes(screen()).find((node) => node.props.role === 'dialog' && node.props['aria-label'] === title);
  if (!found) throw new Error(`no dialog titled ${title}`);
  return found;
}
const fields = (title: string, type: 'input' | 'select' | 'textarea') =>
  nodes(dialog(title).props.children as ReactNode).filter((node) => node.type === type);
const timeBox = (title: string) => fields(title, 'input').find((node) => node.props.type === 'datetime-local')!;
const saveButton = (title: string, label: string) => allByName(dialog(title), label, 'button')[0];

async function addAppointment(startsAt: string) {
  const title = t('health.addAppointment');
  await click(byName(screen(), t('health.addCheckup'), 'button'));
  change(fields(title, 'input')[0], 'Dentist');
  change(timeBox(title), startsAt);
  await click(saveButton(title, t('health.addAppointment')));
}

async function logSymptom(startedAt: string) {
  const title = t('health.logSymptom');
  await click(byName(screen(), t('health.logSymptom'), 'button'));
  change(fields(title, 'select')[0], 'member-1');
  change(fields(title, 'input')[0], 'Fever');
  change(timeBox(title), startedAt);
  await click(saveButton(title, t('health.logSymptom')));
}

async function logMetric(recordedAt: string) {
  const title = t('health.logHealthMetric');
  await click(byName(screen(), t('health.logMetric'), 'button'));
  change(fields(title, 'select')[0], 'member-1');
  change(fields(title, 'input').find((node) => node.props.type === 'number')!, '38.5');
  change(timeBox(title), recordedAt);
  await click(saveButton(title, t('health.logMetric')));
}

async function logWorkout(recordedAt: string) {
  const title = t('health.logWorkout');
  await click(byName(screen(), t('health.logWorkout'), 'button'));
  change(fields(title, 'select')[0], 'member-1');
  change(fields(title, 'input')[0], 'Swim practice');
  change(timeBox(title), recordedAt);
  await click(saveButton(title, t('health.logWorkout')));
}

const stored = (table: string, column: string) => db.table(table).map((row) => new Date(row[column] as string).toISOString());

describe('a medical appointment keeps the family\'s time', () => {
  it('"Dentist 15:00" typed for a New York family is 15:00 in New York', async () => {
    await addAppointment('2026-10-13T15:00');

    expect(stored('appointments', 'starts_at')).toEqual(['2026-10-13T19:00:00.000Z']);
    expect(h.toasts.success).toContain(t('healthModule.appointmentAdded'));
  });

  it('the same reading for a Tokyo family is 15:00 in Tokyo', async () => {
    h.timeZone = 'Asia/Tokyo';
    await addAppointment('2026-10-13T15:00');

    expect(stored('appointments', 'starts_at')).toEqual(['2026-10-13T06:00:00.000Z']);
  });

  it('a time that is not on the calendar is refused, and nothing is booked', async () => {
    await addAppointment('2026-02-30T15:00');

    expect(db.table('appointments')).toEqual([]);
    expect(h.toasts.error).toContain(t('errors.thatTimeIsNotOnTheFamilysClock'));
    expect(h.toasts.success).toEqual([]);
  });
});

describe('a symptom, a metric and a workout keep the family\'s time too', () => {
  it('a fever that started at 07:30 in New York', async () => {
    await logSymptom('2026-10-13T07:30');
    expect(stored('symptom_logs', 'started_at')).toEqual(['2026-10-13T11:30:00.000Z']);
  });

  it('a temperature taken at 21:00 in New York', async () => {
    await logMetric('2026-10-13T21:00');
    expect(stored('health_metrics', 'recorded_at')).toEqual(['2026-10-14T01:00:00.000Z']);
  });

  it('a swim at 18:15 in New York', async () => {
    await logWorkout('2026-10-13T18:15');
    expect(stored('workout_logs', 'recorded_at')).toEqual(['2026-10-13T22:15:00.000Z']);
  });

  it.each([
    ['symptom', logSymptom, 'symptom_logs'],
    ['metric', logMetric, 'health_metrics'],
    ['workout', logWorkout, 'workout_logs'],
  ] as const)('a %s time that is not on the calendar is refused, and nothing is logged', async (_kind, log, table) => {
    await log('2026-02-30T07:30');

    expect(db.table(table)).toEqual([]);
    expect(h.toasts.error).toContain(t('errors.thatTimeIsNotOnTheFamilysClock'));
  });

  it.each([
    ['symptom', logSymptom, 'symptom_logs', 'started_at'],
    ['metric', logMetric, 'health_metrics', 'recorded_at'],
    ['workout', logWorkout, 'workout_logs', 'recorded_at'],
  ] as const)('a %s with no time is now', async (_kind, log, table, column) => {
    const before = Date.now();
    await log('');

    const at = Date.parse(db.table(table)[0][column] as string);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
