// N1 sibling — the School & Sports desk lists the household inbox.
//
// The owner's ROLE-SCOPE-001 decision withholds the household inbox from a
// guest: /dashboard/inbox, the Contact Center and the AI Front Desk send a guest
// to their landing page (lib/auth/guest-scope.ts). The school page is not
// withheld — a grandparent may follow the homework and the timetable — but its
// desk read every non-archived `family_inbox_messages` row (subject, body,
// sender) in the browser, with no role asked, and listed the school ones. RLS
// still answers a guest that read until the reserved 0509 is applied.
//
// Driven through the REAL module against an in-memory database
// (tests/helpers/module-harness.tsx).
import { createElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { has, render, settle } from './helpers/module-harness';
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
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
// The desk's Propose button calls a server action; nothing here presses it.
vi.mock('@/app/(app)/dashboard/school/actions', () => ({ proposeFrontDeskAction: vi.fn() }));

const { SchoolModule } = await import('@/components/modules/school-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: InMemorySupabase;

function as(role: string) {
  (h.app as Record<string, unknown>).role = role;
  h.app.selfMember = { id: 'member-1', display_name: 'Gran', role, is_active: true, color: null, birthday: null };
}

async function screen(): Promise<ReactNode> {
  let tree = render(h.hooks, createElement(SchoolModule));
  for (let i = 0; i < 4; i++) { await settle(); tree = render(h.hooks, createElement(SchoolModule)); }
  return tree;
}
const inboxReads = () => h.calls.filter((call) => call.table === 'family_inbox_messages').length;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  db.seed('family_members', [{ id: 'member-1', family_id: FAMILY, display_name: 'Ava Rivera', is_active: true, created_at: '2026-01-01T00:00:00Z' }]);
  db.seed('family_inbox_messages', [{
    id: 'msg-1', family_id: FAMILY, channel: 'email', direction: 'inbound', status: 'new', ai_handled: false,
    from_addr: 'office@lincoln-school.org', subject: 'Field trip permission slip',
    body: 'Please sign the permission slip for the class field trip to the science museum.',
    occurred_at: '2026-10-13T09:00:00Z',
  }]);
});

describe('the School & Sports desk shows a guest no household inbox', () => {
  it('a guest is not shown the desk, and the browser does not read the inbox', async () => {
    as('guest');
    const tree = await screen();

    expect(inboxReads(), 'family_inbox_messages was read for a guest').toBe(0);
    expect(has(tree, 'Field trip permission slip')).toBe(false);
    expect(has(tree, t('schoolDesk.title'))).toBe(false);
    // The rest of the school page is still theirs.
    expect(has(tree, t('school.statEvents'))).toBe(true);
  });

  it.each(['parent', 'adult', 'teen', 'caregiver'])('a %s still has the desk and the school message on it', async (role) => {
    as(role);
    const tree = await screen();

    expect(inboxReads()).toBeGreaterThan(0);
    expect(has(tree, t('schoolDesk.title'))).toBe(true);
    expect(has(tree, 'Field trip permission slip')).toBe(true);
  });
});
