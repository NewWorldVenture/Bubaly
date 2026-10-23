// Admin reach N8 (with its duplicate N13) — the marketplace board handed a
// super-admin SQL that wiped a real family's marketplace and other families'
// records on it.
//
// /marketplace/browse showed a super-admin a "Seed test data" link to
// /marketplace/seed, which rendered MARKETPLACE_SEED_SQL to paste into the
// Supabase SQL editor under "Safe to re-run". The script resolved a hard-coded
// email's family, fell back to the OLDEST family when that address had none,
// and then deleted that family's listings — which cascades away other
// families' orders, bids, negotiations, questions, circle shares and moderation
// reports on them — before inserting 500 fake listings, some claimed or
// completed.
//
// The real browse page is rendered for a super-admin through the real board
// (tests/helpers/module-harness.tsx). Negative control: before the fix the page
// passed canSeed and the board rendered the link; the route and the SQL were in
// the app.
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
vi.mock('@/components/ui/states', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/ui/avatar', async () => (await import('./helpers/module-harness')).ui);
vi.mock('@/components/app/page-header', async () => (await import('./helpers/module-harness')).ui);
vi.mock('next/link', async () => ({ default: (await import('./helpers/module-harness')).ui.Link }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => undefined }) }));
vi.mock('@/components/marketplace/listing-image', () => ({ ListingImage: () => null }));
vi.mock('@/components/marketplace/photo-upload', () => ({ PhotoUpload: () => null }));
vi.mock('@/lib/supabase/auth', () => auth);
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => h.db }));
vi.mock('@/lib/marketplace/matches-server', () => ({ loadAndSnapshotMatches: async () => [] }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));

const { default: BrowsePage } = await import('@/app/(app)/marketplace/browse/page');

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
  auth.requireUserContext.mockReset().mockResolvedValue({ user: { id: h.app.userId }, active: { familyId: h.app.familyId } });
  auth.isSuperAdmin.mockReset().mockResolvedValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("a super-admin's marketplace board", () => {
  it('links to no seed screen', async () => {
    const page = await BrowsePage({ searchParams: Promise.resolve({}) });
    const tree = render(h.hooks, page as ReactElement);
    // The control: the board itself rendered (its own Post button is there).
    expect(nodes(tree).some((node) => node.type === 'button')).toBe(true);
    const hrefs = nodes(tree).map((node) => node.props.href).filter((href): href is string => typeof href === 'string');
    expect(hrefs.filter((href) => href.includes('/seed'))).toEqual([]);
  });

  it('has no seed route, and nothing in the app ships SQL that deletes a family’s listings', () => {
    expect(existsSync('app/(app)/marketplace/seed/page.tsx')).toBe(false);
    const wipers = [...sourceFiles('app'), ...sourceFiles('components'), ...sourceFiles('lib')].filter((file) => {
      const src = readFileSync(file, 'utf8');
      return /delete\s+from\s+public\.marketplace_listings/i.test(src) || /from\s+public\.families\s+order\s+by\s+created_at\s+limit\s+1/i.test(src);
    });
    expect(wipers).toEqual([]);
  });
});
