import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient as createSdkClient, type SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Calendar } from 'lucide-react';
import { cacheKey } from '@/lib/offline/cache';

// A guest keeps their own check-ins: the held 0509 refuses a guest every
// other member's safety_check_ins row and keeps their own, 0516 gives each
// member their own, and a guest could always check in. So the check-in page
// is not withheld from a guest; it shows them their own check-ins and the
// composer, and nobody else's, and narrows the read before its limit.

type Row = { id: string; family_id: string; member_id: string | null; created_by: string; status: string; place_label: string | null; note: string | null; latitude: number | null; longitude: number | null; created_at: string };
type Query = { table: string; familyId: string; deps: unknown[]; fetcher: (sb: SupabaseClient) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }> };

const redirect = vi.hoisted(() => vi.fn((to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); }));
const harness = vi.hoisted(() => ({
  viewer: {
    familyId: 'synthetic-family', userId: 'synthetic-guest-user', role: 'guest',
    members: [{ id: 'synthetic-guest', display_name: 'Synthetic guest', color: null }, { id: 'synthetic-child', display_name: 'Synthetic child', color: null }],
    selfMember: { id: 'synthetic-guest' } as { id: string } | null,
  },
  rows: [] as Row[],
  query: null as Query | null,
}));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('@/components/app/app-context', () => ({ useApp: () => harness.viewer }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: (query: Query) => { harness.query = query; return { data: harness.rows, loading: false, error: null, refresh: vi.fn() }; } }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => { throw new Error('a read fixture writes nothing'); } }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/ui/confirm', () => ({ useConfirm: () => vi.fn() }));
vi.mock('@/components/i18n/locale-provider', () => ({ useLocale: () => ({ code: 'en-US' }), useTranslations: () => (key: string) => key }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/ui/input', () => ({ Input: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: () => null }));
vi.mock('@/components/ui/states', () => ({ SkeletonList: () => null, ErrorState: () => null, EmptyState: ({ title }: { title: string }) => title }));

const { CheckInView } = await import('@/components/family/check-in-view');
const { isWithheldFromGuest, refuseGuest } = await import('@/lib/auth/guest-scope');
const { isNavItemVisibleToRole } = await import('@/lib/constants/navigation');

const NOW = Date.parse('2026-10-11T12:00:00.000Z');
function row(id: string, member: string | null, minutesAgo: number, family = 'synthetic-family'): Row {
  return { id, family_id: family, member_id: member, created_by: member === 'synthetic-guest' ? 'synthetic-guest-user' : 'synthetic-other-user', status: 'safe', place_label: id, note: null, latitude: null, longitude: null, created_at: new Date(NOW - minutesAgo * 60_000).toISOString() };
}
/** 101 newer check-ins by a child, then the guest's own, older one. */
function mixed(): Row[] {
  return [...Array.from({ length: 101 }, (_, i) => row(`synthetic-child-${i}`, 'synthetic-child', i + 1)), row('synthetic-own', 'synthetic-guest', 500), row('synthetic-nobody', null, 2)];
}
function render(rows: Row[] = []) {
  harness.rows = rows;
  const html = renderToStaticMarkup(createElement(CheckInView));
  expect(harness.query).not.toBeNull();
  return { html, query: harness.query! };
}
/** Runs the module's own fetcher through the real SDK against a synthetic PostgREST that applies its predicates before order and limit. */
async function execute(query: Query, rows: Row[]) {
  const calls: URL[] = [];
  const sb = createSdkClient('https://synthetic-check-in.example.test', 'synthetic-not-a-live-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      expect(url.pathname).toBe('/rest/v1/safety_check_ins');
      calls.push(url);
      let selected = [...rows];
      for (const key of ['family_id', 'member_id'] as const) {
        const expression = url.searchParams.get(key);
        if (expression) { expect(expression.startsWith('eq.')).toBe(true); selected = selected.filter((r) => r[key] === expression.slice(3)); }
      }
      expect(url.searchParams.get('order')).toBe('created_at.desc');
      const limit = Number(url.searchParams.get('limit'));
      selected.sort((a, b) => b.created_at.localeCompare(a.created_at));
      return new Response(JSON.stringify(selected.slice(0, limit)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const result = await query.fetcher(sb);
  return { ...result, calls };
}

beforeEach(() => {
  Object.assign(harness.viewer, { familyId: 'synthetic-family', userId: 'synthetic-guest-user', role: 'guest', selfMember: { id: 'synthetic-guest' } });
  harness.rows = [];
  harness.query = null;
  redirect.mockClear();
});

describe('a guest reaches the check-in page', () => {
  it('the page is not withheld, sends no guest away, and is offered as a link', () => {
    expect(isWithheldFromGuest('/dashboard/family/check-in')).toBe(false);
    expect(() => refuseGuest({ active: { role: 'guest' } } as Parameters<typeof refuseGuest>[0], '/dashboard/family/check-in')).not.toThrow();
    expect(redirect).not.toHaveBeenCalled();
    const item = { href: '/dashboard/family/check-in', label: 'Check In', icon: Calendar };
    expect(isNavItemVisibleToRole(item, { isManager: false, isGuest: true })).toBe(true);
    expect(isNavItemVisibleToRole(item, { isManager: false, isGuest: true, isSuperAdmin: true })).toBe(true);
    const page = readFileSync('app/(app)/dashboard/family/check-in/page.tsx', 'utf8');
    expect(page).not.toContain('refuseGuest');
    expect(page).toContain('await requireUserContext();');
  });

  it('the other location pages stay withheld', () => {
    for (const href of ['/dashboard/locator', '/dashboard/family/driving-safety']) expect(isWithheldFromGuest(href), href).toBe(true);
  });
});

describe('a guest sees their own check-ins and nobody else\'s', () => {
  it('reads only their own, before the limit: 101 newer check-ins by a child do not crowd it out', async () => {
    const result = await execute(render().query, mixed());
    expect(result.calls).toHaveLength(1);
    expect(result.calls[0].searchParams.get('member_id')).toBe('eq.synthetic-guest');
    expect(result.calls[0].searchParams.get('family_id')).toBe('eq.synthetic-family');
    expect(result.data?.map((r) => r.id)).toEqual(['synthetic-own']);
    const { html } = render(result.data ?? []);
    expect(html).toContain('synthetic-own');
    expect(html).toContain('checkInView.onlyYourOwnCheckIns');
    expect(html).not.toContain('synthetic-child-');
  });

  it('can still check in: the composer is there', () => {
    const { html } = render([]);
    for (const label of ['Safe', 'On my way', 'Arrived', 'Need help']) expect(html, label).toContain(label);
  });

  it('another member\'s check-in is not shown even if a server returned it', () => {
    const { html } = render(mixed());
    expect(html).toContain('synthetic-own');
    expect(html).not.toContain('synthetic-child-');
    expect(html).not.toContain('synthetic-nobody');
  });

  it('a guest with no member record of their own reads nothing and sends no query', async () => {
    harness.viewer.selfMember = null;
    const result = await execute(render().query, mixed());
    expect(result.calls).toHaveLength(0);
    expect(result.data).toEqual([]);
    expect(render(mixed()).html).not.toContain('synthetic-');
  });

  it('a teen and a child are narrowed the same way', async () => {
    for (const role of ['teen', 'child']) {
      harness.viewer.role = role;
      const result = await execute(render().query, mixed());
      expect(result.calls[0].searchParams.get('member_id'), role).toBe('eq.synthetic-guest');
    }
  });
});

describe('a parent, an adult and a caregiver read everyone\'s, unchanged', () => {
  it.each(['parent', 'adult', 'caregiver'])('%s', async (role) => {
    harness.viewer.role = role;
    const result = await execute(render().query, mixed());
    expect(result.calls[0].searchParams.get('member_id')).toBeNull();
    expect(result.data).toHaveLength(100);
    const { html } = render(result.data ?? []);
    expect(html).toContain('synthetic-child-0');
    expect(html).not.toContain('checkInView.onlyYourOwnCheckIns');
  });

  it('a change of role or member is a different cached read', () => {
    const guest = render().query;
    harness.viewer.role = 'caregiver';
    const caregiver = render().query;
    harness.viewer.role = 'guest';
    harness.viewer.selfMember = { id: 'synthetic-other-self' };
    const otherSelf = render().query;
    const keys = [guest, caregiver, otherSelf].map((q) => cacheKey(q.table, q.familyId, q.deps));
    expect(new Set(keys).size).toBe(3);
  });
});
