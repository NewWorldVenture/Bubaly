// Admin reach N1 (with its duplicates N3 and N7) — the knowledge base handed a
// super-admin SQL that wrote made-up facts into every real family.
//
// /dashboard/knowledge showed a super-admin a "Seed test data" link to
// /dashboard/knowledge/seed, which rendered FAMILY_FACTS_SEED_SQL with a Copy
// button, told the operator to run it in the Supabase SQL editor and called it
// "Non-destructive". The script looped over EVERY family and skipped only those
// that already had facts — so every new family — and wrote a pinned
// pediatrician and emergency contact, a Wi-Fi password, a garage code, an
// insurance number and, for about a third of members, a pinned allergy. The
// rows took the column default source='user', so the assistant, meal planning
// and grocery checks treated them as the family's own, and "Clear what Bubaly
// learned" could not remove them.
//
// The real page is rendered for a super-admin through the real module
// (tests/helpers/module-harness.tsx). Negative control: before the fix the page
// passed canSeed and the module rendered the link; the route file and the SQL
// were in the app.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { nodes, render } from './helpers/module-harness';
import { resetHookSlots } from './helpers/hook-slots';

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const auth = vi.hoisted(() => ({ requireUserContext: vi.fn(), isSuperAdmin: vi.fn() }));

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
vi.mock('@/lib/supabase/auth', () => auth);
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { default: KnowledgePage } = await import('@/app/(app)/dashboard/knowledge/page');

function sourceFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => join(dir, f).replaceAll('\\', '/'));
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  h.db = createInMemorySupabase();
  h.rows = {}; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] };
  auth.requireUserContext.mockReset().mockResolvedValue({ user: { id: h.app.userId } });
  auth.isSuperAdmin.mockReset().mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a super-admin's knowledge page", () => {
  it('links to no seed screen', async () => {
    const tree = render(h.hooks, (await KnowledgePage()) as ReactElement);
    const hrefs = nodes(tree).map((node) => node.props.href).filter((href): href is string => typeof href === 'string');
    // The control: the page's other link still renders, so the tree is real.
    expect(hrefs).toContain('/dashboard/settings#ai');
    expect(hrefs.filter((href) => href.includes('/seed'))).toEqual([]);
  });

  it('has no seed route, and nothing in the app ships SQL that writes facts into every family', () => {
    expect(existsSync('app/(app)/dashboard/knowledge/seed/page.tsx')).toBe(false);
    const writers = [...sourceFiles('app'), ...sourceFiles('components'), ...sourceFiles('lib')].filter((file) => {
      const src = readFileSync(file, 'utf8');
      return /insert\s+into\s+public\.family_facts/i.test(src) || /in\s+select\s+id\s+from\s+public\.families/i.test(src);
    });
    expect(writers).toEqual([]);
  });
});
