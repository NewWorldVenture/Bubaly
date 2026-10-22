// N7, the sibling page — Life & Milestones ("What Bubaly has learned") read
// family_facts straight from the browser and rendered every fact in its three
// categories: preference, about, important.
//
// 'important' is the knowledge Add form's default category, and it is the one a
// parent saves a Wi-Fi password under. RLS (0264) hides only the medical and
// account categories; the sensitive TERMS (passwords, PINs, allergies, bank
// details…) are code only, and Family Memory, recall, search and insights all
// apply them to a child, teen, caregiver or guest. This page did not, and any
// member can open it, so a parent's alarm code and a sibling's allergies were a
// child's or a guest's to read here.
//
// Driven through the REAL module against an in-memory database
// (tests/helpers/module-harness.tsx).
import { createElement, type ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LifeEventSuggestion } from '@/lib/life-events/detect';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';
import { has, render } from './helpers/module-harness';
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
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/app/(app)/dashboard/knowledge/actions', () => ({
  forgetFactAction: vi.fn(), saveFactAction: vi.fn(), setFactPinnedAction: vi.fn(),
}));
vi.mock('@/app/(app)/dashboard/life-event-actions', () => ({
  launchLifeEventAction: vi.fn(), setLifeEventStatusAction: vi.fn(),
}));
// The page itself, for its "Coming up" signals: the reader's own RLS-bound client and context.
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({
    user: { id: 'user-1' },
    active: { familyId: h.app.familyId, role: (h.app as unknown as { role: string }).role, member: { id: 'member-1' }, family: { timezone: 'UTC' } },
  }),
}));

const { LifeEventsModule } = await import('@/components/modules/life-events-module');
const { default: LifeEventsPage } = await import('@/app/(app)/dashboard/life-events/page');

const FAMILY = h.app.familyId;
let db: InMemorySupabase;

const fact = (id: string, category: string, label: string, value: string, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, member_id: null, category, label, value, notes: null, is_pinned: false,
  source: 'user', created_by: 'parent-user', updated_at: '2026-10-01T12:00:00Z', expires_at: null, confidence: null, ...extra,
});

// Every one of these is in a category the page lists, and every one reaches
// the browser for any member: 0264 withholds only medical and account rows.
const SENSITIVE = [
  { text: 'hunter2-and-1234', label: 'Wi-Fi / alarm passwords' },
  { text: 'Peanuts, tree nuts', label: 'Emma allergies' },
  { text: 'see the drawer', label: 'Bank login' },
];

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  db.seed('family_facts', [
    fact('wifi', 'important', 'Wi-Fi / alarm passwords', 'hunter2-and-1234'),
    fact('allergy', 'preference', 'Emma allergies', 'Peanuts, tree nuts'),
    fact('noted', 'about', 'Bank login', 'see the drawer', { notes: 'routing number in the binder' }),
    fact('pizza', 'preference', 'Friday pizza', 'Margherita, extra basil'),
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function asRole(role: string) {
  (h.app as unknown as { role: string }).role = role;
  return render(h.hooks, createElement(LifeEventsModule));
}

describe('Life & Milestones shows a learned fact only to whoever may read it', () => {
  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s does not see a sensitive fact in important, preference or about', (role) => {
    const tree = asRole(role);
    for (const hidden of SENSITIVE) {
      expect(has(tree, hidden.text), `${role}: ${hidden.text}`).toBe(false);
      expect(has(tree, hidden.label), `${role}: ${hidden.label}`).toBe(false);
    }
    expect(has(tree, 'routing number in the binder')).toBe(false);
    // The rule withholds what it matches, not the section.
    expect(has(tree, 'Margherita, extra basil')).toBe(true);
  });

  it.each(['parent', 'adult'])('a %s sees every learned fact', (role) => {
    const tree = asRole(role);
    for (const shown of [...SENSITIVE.map((s) => s.text), 'Margherita, extra basil']) expect(has(tree, shown), shown).toBe(true);
  });
});

// The same page's "Coming up" section is worked out on the server from the
// same table, and a caregiving proposal quotes the fact it came from: "You told
// Bubaly about “…”". A fact the reader may not see is not theirs to be quoted.
describe('Coming up does not quote a fact the reader may not see', () => {
  const CARE = 'Mum’s medication and carer rota';
  async function comingUp(role: string) {
    (h.app as unknown as { role: string }).role = role;
    const page = (await LifeEventsPage()) as ReactElement<{ suggestions: LifeEventSuggestion[]; suggestionsUnavailable: boolean }>;
    expect(page.props.suggestionsUnavailable).toBe(false);
    return page.props.suggestions;
  }
  beforeEach(() => { db.seed('family_facts', [fact('care', 'important', CARE, 'Tuesdays and Fridays')]); });

  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s is not offered a plan that names it', async (role) => {
    db.seed('family_facts', [fact('carer', 'about', 'Dad’s carer', 'Comes on Tuesdays')]);
    const suggestions = await comingUp(role);
    expect(JSON.stringify(suggestions)).not.toContain(CARE);
    // The rule withholds the fact, not the proposal another fact supports.
    expect(suggestions.find((s) => s.templateKey === 'aging_parent')?.reasonParams.label).toBe('Dad’s carer');
  });

  it.each(['parent', 'adult'])('a %s is offered it', async (role) => {
    const suggestions = await comingUp(role);
    expect(suggestions.find((s) => s.templateKey === 'aging_parent')?.reasonParams.label).toBe(CARE);
  });
});
