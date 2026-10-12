import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createClient as createSdkClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { cacheKey } from '@/lib/offline/cache';
import { readsEveryNote } from '@/lib/care/note-scope';
import { BehaviorModule } from '@/components/modules/behavior-module';
import type { SupabaseBrowser } from '@/lib/supabase/types';

type Entry = { id: string; family_id: string; member_id: string; logged_by: string; occurred_at: string; kind: string; category: string; points: number; note: string };
type Query = { table: string; familyId: string; deps: unknown[]; fetcher: (sb: SupabaseBrowser) => PromiseLike<{ data: Entry[] | null; error: { message: string } | null }> };
const h = vi.hoisted(() => ({
  viewer: { familyId: 'synthetic-family-a', userId: 'synthetic-author-a', role: 'teen' as string | null | undefined, isSuperAdmin: false, members: [{ id: 'synthetic-observed', display_name: 'Synthetic child' }] },
  rows: [] as Entry[], query: null as Query | null, error: null as string | null,
}));
vi.mock('@/components/app/app-context', () => ({ useApp: () => h.viewer }));
vi.mock('@/lib/hooks/use-realtime-query', () => ({ useRealtimeQuery: (query: Query) => { h.query = query; return { data: h.rows, loading: false, error: h.error, refresh: vi.fn() }; } }));
vi.mock('@/lib/supabase/client', () => ({ createClient: () => { throw new Error('Read fixture cannot write or create a production client'); } }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock('@/components/i18n/locale-provider', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/components/i18n/use-format', () => ({ useFamilyClock: () => ({ timeZone: 'UTC' }), useFormat: () => ({ fmtDate: (value: string) => value }) }));
vi.mock('@/components/ui/modal', () => ({ Modal: () => null }));
vi.mock('@/components/ui/input', () => ({ Input: () => null, Textarea: () => null, Field: () => null, Select: () => null }));
vi.mock('@/components/ui/avatar', () => ({ Avatar: () => null }));
vi.mock('@/components/ui/button', () => ({ Button: ({ children, ...props }: { children?: ReactNode }) => createElement('button', props, children) }));
vi.mock('@/components/ui/states', () => ({ SkeletonList: () => null, ErrorState: ({ message }: { message: string }) => createElement('div', { role: 'alert' }, message), EmptyState: ({ title, description }: { title: string; description: string }) => createElement('div', null, title, description) }));
vi.mock('@/components/ai/ai-insight', () => ({ AiInsight: () => createElement('span', null, 'synthetic-full-behavior-ai') }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children?: ReactNode; href: string }) => createElement('a', { href }, children) }));

const NOW = new Date('2026-10-11T12:00:00.000Z').getTime(), DAY = 86_400_000;
function row(id: string, author: string, ago: number, family = 'synthetic-family-a', member = 'synthetic-observed'): Entry {
  return { id, family_id: family, member_id: member, logged_by: author, occurred_at: new Date(NOW - ago).toISOString(), kind: 'positive', category: 'responsibility', points: 1, note: id };
}
function mixed(): Entry[] {
  return [
    ...Array.from({ length: 1002 }, (_, i) => row('synthetic-newer-other-' + i, 'synthetic-other', (i + 1) * 1000)),
    row('synthetic-older-own-a', 'synthetic-author-a', DAY), row('synthetic-older-own-b', 'synthetic-author-b', 2 * DAY),
    row('synthetic-too-old', 'synthetic-author-a', 400 * DAY), row('synthetic-foreign-family', 'synthetic-author-a', 1, 'synthetic-family-b'),
  ];
}
function render(rows: Entry[] = []) {
  h.rows = rows; h.query = null;
  return { html: renderToStaticMarkup(createElement(BehaviorModule)), get query() { expect(h.query, 'eligible existing behavior author must mount its own read').not.toBeNull(); return h.query!; } };
}
async function execute(query: Query, rows: Entry[], mode: 'before-held-sql' | 'after-held-sql' = 'before-held-sql', refuse = false) {
  const viewer = { ...h.viewer }, calls: URL[] = [];
  const sb = createSdkClient('https://synthetic-behavior.example.test', 'synthetic-not-a-live-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      expect(url.origin).toBe('https://synthetic-behavior.example.test'); expect(url.pathname).toBe('/rest/v1/behavior_logs'); calls.push(url);
      if (refuse) return new Response(JSON.stringify({ code: '42501', message: 'Synthetic read refused' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
      // Real SDK encodes the component's predicates; this synthetic PostgREST
      // seam evaluates them BEFORE the existing bounded sort and limit.
      // "after" models declared 0510; no migration/live RLS is exercised.
      let selected = [...rows];
      if (mode === 'after-held-sql' && !readsEveryNote(viewer.role)) selected = selected.filter(e => e.logged_by === viewer.userId);
      for (const key of ['family_id', 'logged_by'] as const) { const expression = url.searchParams.get(key); if (expression) { expect(expression.startsWith('eq.')).toBe(true); selected = selected.filter(e => e[key] === expression.slice(3)); } }
      const since = url.searchParams.get('occurred_at'); expect(since?.startsWith('gte.')).toBe(true); selected = selected.filter(e => e.occurred_at >= since!.slice(4));
      expect(url.searchParams.get('order')).toBe('occurred_at.desc'); const limit = Number(url.searchParams.get('limit')); expect(limit).toBe(1000);
      selected.sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
      return new Response(JSON.stringify(selected.slice(0, limit)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    } },
  });
  const result = await query.fetcher(sb as unknown as SupabaseBrowser); expect(calls).toHaveLength(1);
  expect(calls[0].searchParams.get('family_id')).toBe('eq.' + viewer.familyId);
  if (!refuse) expect(calls[0].searchParams.get('occurred_at')).toBe('gte.' + new Date(NOW - 365 * DAY).toISOString());
  return { ...result, url: calls[0] };
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); Object.assign(h.viewer, { familyId: 'synthetic-family-a', userId: 'synthetic-author-a', role: 'teen', isSuperAdmin: false }); h.rows = []; h.query = null; h.error = null; });
afterEach(() => { vi.useRealTimers(); });

describe('behavior authors read their own notes before the bounded window', () => {
  for (const role of ['teen', 'child']) for (const mode of ['before-held-sql', 'after-held-sql'] as const) {
    it(`${role} keeps an older own note beyond1000 other-author observations ${mode}`, async () => {
      h.viewer.role = role; const result = await execute(render().query, mixed(), mode);
      expect(result.error).toBeNull(); expect(result.data?.map(e => e.id)).toEqual(['synthetic-older-own-a']);
      const html = render(result.data ?? []).html; expect(html).toContain('synthetic-older-own-a'); expect(html).not.toContain('synthetic-newer-other-'); expect(html).not.toContain('synthetic-older-own-b');
      expect(result.url.searchParams.get('logged_by')).toBe('eq.synthetic-author-a'); expect(html).toContain('behaviorModule.onlyTheNotesYouLogged');
      expect(html).not.toContain('synthetic-full-behavior-ai'); expect(html).not.toContain('behavior.aiParentingInsight'); expect(html).not.toContain('behavior.balanceScore'); expect(html).not.toContain('behavior.logBehavior'); expect(html).not.toContain('aria-label="behavior.delete"');
    });
  }
  it.each(['parent', 'adult', 'caregiver'])('%s retains the original whole recent read and full-reader insight surfaces', async role => {
    h.viewer.role = role; const result = await execute(render().query, mixed()); expect(result.url.searchParams.get('logged_by')).toBeNull(); expect(result.data).toHaveLength(1000);
    const html = render(result.data ?? []).html; expect(html).toContain('synthetic-newer-other-'); expect(html).toContain('synthetic-full-behavior-ai'); expect(html).toContain('behavior.aiParentingInsight'); expect(html).toContain('behavior.balanceScore'); expect(html).not.toContain('behaviorModule.onlyTheNotesYouLogged');
    if (role === 'caregiver') { expect(html).not.toContain('behavior.logBehavior'); expect(html).not.toContain('aria-label="behavior.delete"'); } else { expect(html).toContain('behavior.logBehavior'); expect(html).toContain('aria-label="behavior.delete"'); }
  });
  for (const value of ['guest', 'unknown-role', null, undefined] as const) it(`refuses ${String(value)} before creating a read even for a superadmin`, () => {
    h.viewer.role = value; h.viewer.isSuperAdmin = true; const html = render(mixed()).html; expect(h.query).toBeNull(); expect(html).toContain('behaviorModule.keptForParentsAndCaregivers'); expect(html).not.toContain('synthetic-older-own-a');
  });
  it('refuses an absent user before any broad or author read', () => { h.viewer.role = 'parent'; h.viewer.userId = ''; render(mixed()); expect(h.query).toBeNull(); });
  it('refuses an absent family before any broad or author read', () => { h.viewer.role = 'parent'; h.viewer.familyId = ''; render(mixed()); expect(h.query).toBeNull(); });
  it('does not treat an observation subject as its author, including an over-returned row', () => {
    const html = render([row('synthetic-own-about-another', 'synthetic-author-a', DAY, 'synthetic-family-a', 'another-subject'), row('synthetic-other-about-viewer', 'synthetic-other', DAY, 'synthetic-family-a', 'synthetic-author-a')]).html;
    expect(html).toContain('synthetic-own-about-another'); expect(html).not.toContain('synthetic-other-about-viewer');
  });
  it('changing the author changes the cache distinction and masks old author data immediately', async () => {
    const first = render().query; const firstRows = (await execute(first, mixed())).data ?? []; h.viewer.userId = 'synthetic-author-b'; const current = render(firstRows);
    expect(current.html).not.toContain('synthetic-older-own-a'); expect(cacheKey(first.table, first.familyId, first.deps)).not.toBe(cacheKey(current.query.table, current.query.familyId, current.query.deps)); expect(current.query.deps).toEqual(['synthetic-family-a', 'teen', 'synthetic-author-b']);
    expect((await execute(current.query, mixed())).data?.map(e => e.id)).toEqual(['synthetic-older-own-b']);
  });
  it('a parent becoming an author-only reader removes old rows, parentingAI and partial summaries', async () => {
    h.viewer.role = 'parent'; const first = render().query; const rows = (await execute(first, mixed())).data ?? []; h.viewer.role = 'teen'; const current = render(rows);
    expect(current.html).not.toContain('synthetic-newer-other-'); expect(current.html).not.toContain('synthetic-full-behavior-ai'); expect(current.html).not.toContain('behavior.balanceScore'); expect(current.html).not.toContain('behavior.aiParentingInsight'); expect(cacheKey(first.table, first.familyId, first.deps)).not.toBe(cacheKey(current.query.table, current.query.familyId, current.query.deps));
    expect((await execute(current.query, mixed())).data?.map(e => e.id)).toEqual(['synthetic-older-own-a']);
  });
  it('an author becoming a caregiver gets the unchanged whole recent scope after reread', async () => {
    const first = render().query; h.viewer.role = 'caregiver'; const current = render().query; expect(cacheKey(first.table, first.familyId, first.deps)).not.toBe(cacheKey(current.table, current.familyId, current.deps));
    const result = await execute(current, mixed()); expect(result.url.searchParams.get('logged_by')).toBeNull(); expect(result.data).toHaveLength(1000);
  });
  it('a family switch masks old same-author notes while querying the new family and author', async () => {
    const first = render().query; const oldRows = (await execute(first, mixed())).data ?? []; h.viewer.familyId = 'synthetic-family-b'; const current = render(oldRows);
    expect(current.html).not.toContain('synthetic-older-own-a'); expect(cacheKey(first.table, first.familyId, first.deps)).not.toBe(cacheKey(current.query.table, current.query.familyId, current.query.deps)); expect((await execute(current.query, mixed())).data?.map(e => e.id)).toEqual(['synthetic-foreign-family']);
  });
  it('retains the rolling365day window for an author', async () => { const result = await execute(render().query, [row('synthetic-in-window', 'synthetic-author-a', DAY), row('synthetic-too-old', 'synthetic-author-a', 400 * DAY)]); expect(result.data?.map(e => e.id)).toEqual(['synthetic-in-window']); });
  it('retains the1000 row cap within eligible own-author rows', async () => {
    const rows = Array.from({ length: 1002 }, (_, i) => row('synthetic-own-' + i, 'synthetic-author-a', i * 1000)); const result = await execute(render().query, rows); expect(result.data).toHaveLength(1000); expect(result.data?.[999].id).toBe('synthetic-own-999');
  });
  it('keeps a refused read as an error and shows the existing named retry state', async () => { const result = await execute(render().query, [], 'before-held-sql', true); expect(result.data).toBeNull(); expect(result.error?.message).toBe('Synthetic read refused'); h.error = result.error?.message ?? null; const html = render().html; expect(html).toContain('role="alert"'); expect(html).toContain('behaviorModule.couldNotLoadBehaviorLogs'); expect(html).not.toContain('behavior.noBehaviorLoggedYet'); });
  it('an empty author history is labeled as limited without inviting unavailable manager-only writes', () => { const html = render().html; expect(html).toContain('behaviorModule.onlyTheNotesYouLogged'); expect(html).not.toContain('behaviorModule.logPositiveMomentsAndConcerns'); expect(html).not.toContain('behavior.logBehavior'); expect(html).not.toContain('behavior.generate'); });
  it('the author-only notice is present in every original base locale', () => {
    for (const locale of ['en-US', 'de-DE', 'es-ES', 'fr-FR', 'it-IT', 'nl-NL', 'pt-PT']) { const messages = JSON.parse(readFileSync(`lib/i18n/messages/${locale}.json`, 'utf8')) as Record<string, string>; expect(messages['behaviorModule.onlyTheNotesYouLogged'], locale).toBeTruthy(); expect(messages['behaviorModule.keptForParentsAndCaregivers'], locale).toBeTruthy(); }
    const english = JSON.parse(readFileSync('lib/i18n/messages/en-US.json', 'utf8')) as Record<string, string>; expect(english['behaviorModule.onlyTheNotesYouLogged']).toBe('Showing only behavior notes you logged. Other notes are kept for parents, adults and caregivers.');
  });
});
