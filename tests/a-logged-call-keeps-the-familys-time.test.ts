// N11 — "Log communication" stored the time a family typed as UTC wall time.
//
// The form's Date/time is a <input type="datetime-local">: a naive wall
// reading ('2026-10-13T14:30'). It went raw into family_communications
// .received_at, a timestamptz, which Postgres reads in the session's zone —
// UTC on Supabase — so a Los Angeles parent logging a 2:30 PM call stored
// 7:30 AM Pacific, and the queue showed and ranked the call by that (TIME-003,
// the defect lib/time/datetime-local.ts exists for).
//
// Driven through the REAL inbox module against an in-memory database
// (tests/helpers/module-harness.tsx). The family's zone reaches the module the
// way production gives it, through the locale provider's family time zone.
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, form, render, submit } from './helpers/module-harness';
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
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/app/(app)/dashboard/reminders/actions', () => ({ createReminderAction: vi.fn() }));

const { InboxModule } = await import('@/components/modules/inbox-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
let db: InMemorySupabase;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  h.timeZone = 'America/Los_Angeles';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const screen = () => render(h.hooks, createElement(InboxModule));

async function logCommunication(fields: Record<string, string>) {
  await click(byName(screen(), t('inbox.logMessage'), 'button'));
  await submit(form(screen()), { channel: 'phone', direction: 'inbound', category: 'general', priority: 'normal', ...fields });
}

describe('a logged call keeps the family\'s time', () => {
  it('2:30 PM typed by a Los Angeles family is stored as 2:30 PM Pacific', async () => {
    await logCommunication({ subject: 'Dentist called', received_at: '2026-10-13T14:30' });

    expect(db.table('family_communications')).toHaveLength(1);
    expect(new Date(db.table('family_communications')[0].received_at as string).toISOString()).toBe('2026-10-13T21:30:00.000Z');
  });

  it('the same reading for a Tokyo family is 2:30 PM in Tokyo', async () => {
    h.timeZone = 'Asia/Tokyo';
    await logCommunication({ subject: 'Dentist called', received_at: '2026-10-13T14:30' });

    expect(new Date(db.table('family_communications')[0].received_at as string).toISOString()).toBe('2026-10-13T05:30:00.000Z');
  });

  it('a blank time is now', async () => {
    const before = Date.now();
    await logCommunication({ subject: 'Dentist called', received_at: '' });

    const at = new Date(db.table('family_communications')[0].received_at as string).getTime();
    expect(at).toBeGreaterThanOrEqual(before - 1000);
    expect(at).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('a time that is not on the calendar is refused, and nothing is logged', async () => {
    await logCommunication({ subject: 'Dentist called', received_at: '2026-02-30T14:30' });

    expect(db.table('family_communications')).toEqual([]);
    expect(h.toasts.error).toContain(t('errors.thatTimeIsNotOnTheFamilysClock'));
  });
});
