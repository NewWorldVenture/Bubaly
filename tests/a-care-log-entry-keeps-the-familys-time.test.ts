// A care-log entry's time was read and written on the DEVICE's clock.
//
// The care log's "When" box is a <input type="datetime-local">: a naive wall
// reading ('2026-10-13T15:00'). The module filled it with the device's clock
// (a new entry's "now", an edited entry's stored time) and saved it with
// `new Date(value)`, which resolves it on the device's clock again. The log
// itself groups and prints every entry on the FAMILY's clock (TIME-003). So a
// caregiver or a parent away from home who logged "visited Grandma at 15:00"
// filed it under another hour, and sometimes another day. The module marked
// this as remaining TIME-003 scope.
//
// The box now reads and writes the family's clock, through
// lib/time/datetime-local.ts, as the inbox, school, sports and health modules
// do. Driven through the REAL CareModule against an in-memory database
// (tests/helpers/module-harness.tsx). The family zones here are neither UTC
// nor Los Angeles, the two zones the suite runs under, so the device's zone is
// never the family's.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, change, click, form, nodes, render, submit } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => (await import('./helpers/module-harness')).supabaseClientModule(h));
vi.mock('@/components/app/app-context', async () => (await import('./helpers/module-harness')).appContextModule(h));
vi.mock('@/components/ui/toast', async () => (await import('./helpers/module-harness')).toastModule(h));
vi.mock('@/components/i18n/locale-provider', async () => (await import('./helpers/module-harness')).localeProviderModule(h));
vi.mock('@/components/ui/button', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/modal', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/input', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { CareModule } = await import('@/components/modules/care-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const MINUTE = 60_000;
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

const screen = () => render(h.hooks, createElement(CareModule));
const timeBox = () => nodes(form(screen())).find((node) => node.type === 'input' && node.props.type === 'datetime-local')!;
const stored = () => db.table('care_log').map((row) => new Date(row.occurred_at as string).toISOString());

async function logCare(occurredAt?: string) {
  await click(byName(screen(), t('care.logCare'), 'button'));
  if (occurredAt !== undefined) change(timeBox(), occurredAt);
  await submit(form(screen()));
}

describe('a care-log entry keeps the family\'s time', () => {
  it('"visited at 15:00" logged for a New York family is 15:00 in New York', async () => {
    await logCare('2026-10-13T15:00');

    expect(stored()).toEqual(['2026-10-13T19:00:00.000Z']);
    expect(h.toasts.success).toContain(t('careModule.careLogged'));
  });

  it('the same reading for a Tokyo family is 15:00 in Tokyo', async () => {
    h.timeZone = 'Asia/Tokyo';
    await logCare('2026-10-13T15:00');

    expect(stored()).toEqual(['2026-10-13T06:00:00.000Z']);
  });

  it.each(['America/New_York', 'Asia/Tokyo'])('a new entry saved as the box opened is now, for a family in %s', async (zone) => {
    h.timeZone = zone;
    const before = Date.now();
    await logCare();

    // The box shows the family's minute, so the entry is now to the minute.
    const at = Date.parse(stored()[0]);
    expect(at).toBeGreaterThan(before - MINUTE);
    expect(at).toBeLessThanOrEqual(Date.now());
  });

  it('an edit that changes nothing keeps the entry where it was, to the second', async () => {
    // A quick-log button stamps the instant it was pressed, seconds and all.
    db.seed('care_log', [{
      id: 'entry-1', family_id: h.app.familyId, member_id: 'member-1', log_type: 'visit',
      occurred_at: '2026-10-13T19:04:37.123Z',
      wellbeing: null, note: 'Brought soup', logged_by: 'member-1', created_by: 'user-1',
    }]);
    const original = db.table('care_log')[0].occurred_at as string;

    await click(byName(screen(), t('care.edit'), 'button'));
    // The box shows the family's minute: 15:04 in New York.
    expect(timeBox().props.value).toBe('2026-10-13T15:04');
    await submit(form(screen()));

    expect(stored()).toEqual([original]);
    expect(h.toasts.success).toContain(t('careModule.entryUpdated'));
  });

  it('an edit that moves the time moves it on the family\'s clock', async () => {
    db.seed('care_log', [{
      id: 'entry-1', family_id: h.app.familyId, member_id: 'member-1', log_type: 'visit',
      occurred_at: '2026-10-13T19:04:37.123Z',
      wellbeing: null, note: 'Brought soup', logged_by: 'member-1', created_by: 'user-1',
    }]);

    await click(byName(screen(), t('care.edit'), 'button'));
    change(timeBox(), '2026-10-13T16:30');
    await submit(form(screen()));

    expect(stored()).toEqual(['2026-10-13T20:30:00.000Z']);
  });

  it('a time that is not on the calendar is refused, and nothing is logged', async () => {
    await logCare('2026-02-30T15:00');

    expect(db.table('care_log')).toEqual([]);
    expect(h.toasts.error).toContain(t('errors.thatTimeIsNotOnTheFamilysClock'));
    expect(h.toasts.success).toEqual([]);
  });

  it('a blank time is now', async () => {
    const before = Date.now();
    await logCare('');

    const at = Date.parse(stored()[0]);
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });
});
