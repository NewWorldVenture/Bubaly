// N7 — the Family Memory page (/dashboard/knowledge) showed every fact to every
// member, with a Copy button.
//
// The visibility rule for family facts has two halves. The CATEGORY half
// (medical, account) is RLS (0264). The TERMS half — passwords, PINs, bank,
// allergies, diagnoses, salary… — is code only (0385 says why), and every
// other reader applies it to a child, teen, caregiver or guest: recall, search,
// the AI context, insights. The page read family_facts straight from the
// browser and rendered all of it, so a parent's "Wi-Fi password", saved under
// the Add form's default category, was a child's to read and copy.
//
// Driven through the REAL module against an in-memory database
// (tests/helpers/module-harness.tsx).
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('@/app/(app)/dashboard/knowledge/actions', () => ({
  forgetFactAction: vi.fn(), saveFactAction: vi.fn(), setFactPinnedAction: vi.fn(),
}));

const { KnowledgeBaseModule } = await import('@/components/modules/knowledge-base-module');

const FAMILY = h.app.familyId;
let db: InMemorySupabase;

const fact = (id: string, label: string, value: string, extra: Record<string, unknown> = {}) => ({
  id, family_id: FAMILY, member_id: null, category: 'important', label, value, notes: null, is_pinned: false,
  source: 'user', created_by: 'parent-user', updated_at: '2026-10-01T12:00:00Z', ...extra,
});

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  // What the database returns to any member: 0264 hides only the medical and
  // account categories, so these all reach the browser.
  db.seed('family_facts', [
    fact('wifi', 'Wi-Fi / alarm passwords', 'hunter2-and-1234'),
    fact('allergy', 'Emma allergies', 'Peanuts, tree nuts'),
    fact('noted', 'Bank login', 'see the drawer', { notes: 'routing number in the binder' }),
    fact('shoes', 'Emma shoe size', 'US 2'),
  ]);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function asRole(role: string) {
  (h.app as unknown as { role: string }).role = role;
  return render(h.hooks, createElement(KnowledgeBaseModule));
}

describe('Family Memory shows a fact only to whoever may read it', () => {
  it.each(['child', 'teen', 'caregiver', 'guest'])('a %s does not see or get to copy a sensitive fact', (role) => {
    const tree = asRole(role);
    for (const hidden of ['hunter2-and-1234', 'Peanuts, tree nuts', 'see the drawer', 'Wi-Fi / alarm passwords', 'Emma allergies']) {
      expect(has(tree, hidden), `${role}: ${hidden}`).toBe(false);
    }
    expect(has(tree, 'US 2')).toBe(true);
  });

  it.each(['parent', 'adult'])('a %s sees every fact', (role) => {
    const tree = asRole(role);
    for (const shown of ['hunter2-and-1234', 'Peanuts, tree nuts', 'see the drawer', 'US 2']) expect(has(tree, shown), shown).toBe(true);
  });
});
