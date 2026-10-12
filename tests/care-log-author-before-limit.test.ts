import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient as createSdkClient, type SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cacheKey } from '@/lib/offline/cache';
import { notesInScope, readsEveryNote } from '@/lib/care/note-scope';
import { CareModule } from '@/components/modules/care-module';

type Entry = { id: string; family_id: string; member_id: string; created_by: string; logged_by: string; occurred_at: string; log_type: 'note'; wellbeing: null; note: string };
type Query = { table: string; familyId: string; deps: unknown[]; fetcher: (sb: SupabaseClient) => PromiseLike<{ data: Entry[] | null; error: { message: string } | null }> };
const harness = vi.hoisted(() => ({
  viewer: { familyId: 'synthetic-family-a', userId: 'synthetic-author-a', role: 'teen', members: [{ id: 'synthetic-ward', display_name: 'Synthetic ward' }], selfMember: { id: 'synthetic-self' } },
  rows: [] as Entry[],
  query: null as Query | null,
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => harness.viewer }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: (query: Query) => { harness.query = query; return { data: harness.rows, loading: false, error: null }; } }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => { throw new Error('Read fixture must not write or create a production client'); } }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useLocale: () => 'en-US', useTranslations: () => (key: string) => key }));
vi.mock('@/components/i18n/use-format', () => ({ useFamilyClock: () => ({ timeZone: 'UTC' }), useFormat: () => ({ fmtTimeAgo: () => 'synthetic ago', fmtTime: (value: string) => value, fmtDate: (value: string) => value }) }));
vi.mock('@/components/ui/modal', () => ({ Modal: () => null }));
vi.mock('@/components/ui/input', () => ({ Input: () => null, Textarea: () => null, Field: () => null, Select: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: () => null }));
vi.mock('@/components/ui/states', () => ({ SkeletonList: () => null, ErrorState: () => null, EmptyState: () => null }));
vi.mock('@/components/app/page-header', () => ({ PageHeader: () => null }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => null }));

const NOW = new Date('2026-10-11T12:00:00.000Z').getTime();
const DAY = 24 * 60 * 60 * 1000;
function row(id: string, author: string, ago: number, family = 'synthetic-family-a'): Entry {
  return { id, family_id: family, member_id: 'synthetic-ward', created_by: author, logged_by: 'synthetic-self', occurred_at: new Date(NOW - ago).toISOString(), log_type: 'note', wellbeing: null, note: id };
}
function mixed(): Entry[] {
  return [
    ...Array.from({ length: 1002 }, (_, i) => row(`synthetic-newer-other-${i}`, 'synthetic-other', (i + 1) * 1000)),
    row('synthetic-older-own-a', 'synthetic-author-a', DAY),
    row('synthetic-older-own-b', 'synthetic-author-b', 2 * DAY),
    row('synthetic-outside-window', 'synthetic-author-a', 400 * DAY),
    row('synthetic-other-family', 'synthetic-author-a', 1, 'synthetic-family-b'),
  ];
}
function render(rows: Entry[] = []) {
  harness.rows = rows;
  const html = renderToStaticMarkup(createElement(CareModule));
  expect(harness.query).not.toBeNull();
  return { html, query: harness.query! };
}
async function execute(query: Query, rows: Entry[], mode: 'before-held-sql' | 'after-held-sql' = 'before-held-sql', error = false) {
  const calls: URL[] = [];
  const viewer = { ...harness.viewer };
  const sb = createSdkClient('https://synthetic-care.example.test', 'synthetic-not-a-live-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      expect(url.origin).toBe('https://synthetic-care.example.test');
      expect(url.pathname).toBe('/rest/v1/care_log');
      calls.push(url);
      if (error) return new Response(JSON.stringify({ code: '42501', message: 'Synthetic read refused' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      // Synthetic PostgREST seam: actual SDK predicates are evaluated before
      // sorting/limit. "after" models the already-declared author read rule;
      // this does not execute a migration or prove live RLS enforcement.
      let selected = [...rows];
      if (mode === 'after-held-sql' && !readsEveryNote(viewer.role)) selected = selected.filter((entry) => entry.created_by === viewer.userId);
      for (const key of ['family_id', 'created_by'] as const) {
        const expression = url.searchParams.get(key);
        if (expression) { expect(expression.startsWith('eq.')).toBe(true); selected = selected.filter((entry) => entry[key] === expression.slice(3)); }
      }
      const after = url.searchParams.get('occurred_at');
      if (after) { expect(after.startsWith('gte.')).toBe(true); selected = selected.filter((entry) => entry.occurred_at >= after.slice(4)); }
      expect(url.searchParams.get('order')).toBe('occurred_at.desc');
      const limit = Number(url.searchParams.get('limit'));
      expect(limit).toBe(1000);
      selected.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
      return new Response(JSON.stringify(selected.slice(0, limit)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const result = await query.fetcher(sb);
  expect(calls).toHaveLength(1);
  expect(calls[0].searchParams.get('family_id')).toBe('eq.' + viewer.familyId);
  expect(calls[0].searchParams.get('occurred_at')).toBe('gte.' + new Date(NOW - 365 * DAY).toISOString());
  return { ...result, url: calls[0] };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  Object.assign(harness.viewer, { familyId: 'synthetic-family-a', userId: 'synthetic-author-a', role: 'teen' });
  harness.rows = [];
  harness.query = null;
});
afterEach(() => { vi.useRealTimers(); });

describe('a care author is filtered before the bounded read', () => {
  for (const role of ['teen', 'child', 'guest']) {
    for (const mode of ['before-held-sql', 'after-held-sql'] as const) {
      it(`${role}: the older own note survives more than 1000 newer notes by others ${mode}`, async () => {
        harness.viewer.role = role;
        const { query } = render();
        const result = await execute(query, mixed(), mode);
        expect(result.error).toBeNull();
        // Observe the returned and rendered history before inspecting metadata:
        // on an unscoped pre-migration read, 1000 newer other-author rows crowd
        // the eligible older own row out before the client-side defence runs.
        expect(result.data?.map((entry) => entry.id)).toEqual(['synthetic-older-own-a']);
        const html = render(result.data ?? []).html;
        expect(html).toContain('synthetic-older-own-a');
        expect(result.url.searchParams.get('created_by')).toBe('eq.synthetic-author-a');
        expect(html).not.toContain('synthetic-newer-other-');
        expect(html).not.toContain('synthetic-older-own-b');
        expect(html).not.toContain('care.lastContact');
        expect(html).not.toContain('care.thisWeek');
      });
    }
  }
  it.each(['parent', 'adult', 'caregiver'])('%s retains the unchanged whole-log read and 1000-row cap', async (role) => {
    harness.viewer.role = role;
    const result = await execute(render().query, mixed());
    expect(result.url.searchParams.get('created_by')).toBeNull();
    expect(result.data).toHaveLength(1000);
    expect(result.data?.every((entry) => entry.id.startsWith('synthetic-newer-other-'))).toBe(true);
    expect(render(result.data ?? []).html).toContain('care.lastContact');
  });
  it('changing the author changes the actual realtime cache distinction and masks the previous author', async () => {
    const first = render().query;
    const firstRows = (await execute(first, mixed())).data ?? [];
    harness.viewer.userId = 'synthetic-author-b';
    const switched = render(firstRows);
    expect(switched.html).not.toContain('synthetic-older-own-a');
    expect(cacheKey(first.table, first.familyId, first.deps)).not.toBe(cacheKey(switched.query.table, switched.query.familyId, switched.query.deps));
    expect(switched.query.deps).toEqual(['synthetic-family-a', 'teen', 'synthetic-author-b']);
    const result = await execute(switched.query, mixed());
    expect(result.url.searchParams.get('created_by')).toBe('eq.synthetic-author-b');
    expect(result.data?.map((entry) => entry.id)).toEqual(['synthetic-older-own-b']);
  });
  it('a parent becoming an author-only reader changes the cache distinction and removes summaries', async () => {
    harness.viewer.role = 'parent';
    const original = render().query;
    const originalRows = (await execute(original, mixed())).data ?? [];
    harness.viewer.role = 'teen';
    const narrowed = render(originalRows);
    expect(narrowed.html).not.toContain('synthetic-newer-other-');
    expect(narrowed.html).not.toContain('care.lastContact');
    expect(cacheKey(original.table, original.familyId, original.deps)).not.toBe(cacheKey(narrowed.query.table, narrowed.query.familyId, narrowed.query.deps));
    expect((await execute(narrowed.query, mixed())).data?.map((entry) => entry.id)).toEqual(['synthetic-older-own-a']);
  });
  it('an author-only reader becoming a caregiver re-reads the unchanged whole-log scope', async () => {
    const original = render().query;
    harness.viewer.role = 'caregiver';
    const wider = render().query;
    expect(cacheKey(original.table, original.familyId, original.deps)).not.toBe(cacheKey(wider.table, wider.familyId, wider.deps));
    const result = await execute(wider, mixed());
    expect(result.url.searchParams.get('created_by')).toBeNull();
    expect(result.data).toHaveLength(1000);
  });
  it('a family switch keeps the current family predicate as well as the current author', async () => {
    const old = render().query;
    harness.viewer.familyId = 'synthetic-family-b';
    const current = render().query;
    expect(cacheKey(old.table, old.familyId, old.deps)).not.toBe(cacheKey(current.table, current.familyId, current.deps));
    const result = await execute(current, mixed());
    expect(result.data?.map((entry) => entry.id)).toEqual(['synthetic-other-family']);
  });
  it('the own-note filter preserves the rolling 365-day window', async () => {
    const result = await execute(render().query, [row('synthetic-in-window', 'synthetic-author-a', DAY), row('synthetic-too-old', 'synthetic-author-a', 400 * DAY)]);
    expect(result.data?.map((entry) => entry.id)).toEqual(['synthetic-in-window']);
  });
  it('a refused read stays an error rather than a successful empty history', async () => {
    const result = await execute(render().query, [], 'before-held-sql', true);
    expect(result.data).toBeNull();
    expect(result.error?.message).toBe('Synthetic read refused');
  });
  it('the original client-side author defence still refuses another author even if a server returns it', () => {
    const rows = [row('synthetic-own', 'synthetic-author-a', DAY), row('synthetic-not-own', 'synthetic-author-b', DAY)];
    expect(notesInScope(rows, 'teen', 'synthetic-author-a', (entry) => entry.created_by).map((entry) => entry.id)).toEqual(['synthetic-own']);
  });
});
