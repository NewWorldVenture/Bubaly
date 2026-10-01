import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase, type Row } from './helpers/in-memory-supabase';

// Canonical URL visibility only. This fixture neither models database AEO
// retirement nor closes new-path collisions or concurrent edits of the
// same legacy page. Those remain separate workflow gaps.
// Install barriers before importing the real action, bridge, or public reader.
const state = await vi.hoisted(async () => {
  const forbidden = vi.fn(() => { throw new Error('External operation forbidden in landing rename fixture'); });
  const http = (await import('node:http')).default;
  const https = (await import('node:https')).default;
  const net = (await import('node:net')).default;
  const tls = (await import('node:tls')).default;
  vi.stubGlobal('fetch', forbidden);
  const guards = [
    vi.spyOn(http, 'request').mockImplementation(forbidden), vi.spyOn(http, 'get').mockImplementation(forbidden),
    vi.spyOn(https, 'request').mockImplementation(forbidden), vi.spyOn(https, 'get').mockImplementation(forbidden),
    vi.spyOn(net, 'connect').mockImplementation(forbidden), vi.spyOn(net, 'createConnection').mockImplementation(forbidden),
    vi.spyOn(tls, 'connect').mockImplementation(forbidden),
  ];
  return { forbidden, guards, client: null as unknown, gate: vi.fn(), audit: vi.fn(), revalidate: vi.fn(), tag: vi.fn(), retireAnswers: vi.fn() };
});
vi.mock('@supabase/supabase-js', () => ({ createClient: state.forbidden }));
vi.mock('@supabase/ssr', () => ({ createServerClient: state.forbidden, createBrowserClient: state.forbidden }));
vi.mock('@/lib/supabase/service', () => ({ createServiceClient: state.forbidden }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.client }));
vi.mock('@/lib/ai/provider', () => ({ isAIConfigured: state.forbidden, resolveProvider: state.forbidden }));
vi.mock('@/lib/ai/settings', () => ({ getAIConfig: state.forbidden }));
vi.mock('@/lib/marketing/provider-sync', () => ({ syncMarketingProviders: state.forbidden }));
vi.mock('@/lib/i18n/server', () => ({ getLocaleContext: state.forbidden, getTranslations: state.forbidden }));
vi.mock('@/components/marketing/structured-data', () => ({ MarketingPageStructuredData: state.forbidden }));
vi.mock('@/lib/marketing/aeo', () => ({ AEO_TAG: 'fixture-aeo', localizeAeoQuestions: state.forbidden, readAeoQuestionsForPath: state.forbidden }));
vi.mock('next/cache', () => ({ revalidatePath: state.revalidate, revalidateTag: state.tag }));
vi.mock('next/navigation', () => ({ redirect: state.forbidden, notFound: state.forbidden }));
vi.mock('@/lib/marketing/admin', () => ({
  requireMarketingAdmin: state.gate,
  logMarketingAudit: state.audit,
  marketingActionFailure: (operation: string) => { throw new Error(`Could not ${operation}.`); },
}));
vi.mock('@/lib/marketing/platform', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/marketing/platform')>(),
  // Only two in-memory tables: AEO SQL/trigger behavior is outside this fixture.
  retireAeoQuestionsForPath: state.retireAnswers,
}));

import { updateLandingPage, setLandingPublished, archiveLandingPage } from '@/app/(app)/admin/marketing/actions';
import { getPublishedMarketingPage } from '@/lib/marketing/public-pages';

type Operation = { table: string; operation: string };
let db: InMemorySupabase;
let operations: Operation[];
let intercept: (operation: Operation) => unknown;
const legacyId = 'legacy-landing-one';
const oldSlug = 'old-landing';
const newSlug = 'new-landing';
const failure = { code: 'XX000', message: 'Synthetic write failure' };
const reply = (error: unknown) => ({ data: null, error });

function clientFor(fake: InMemorySupabase) {
  return {
    from(table: string) {
      if (!['marketing_landing_pages', 'marketing_pages'].includes(table)) return state.forbidden();
      const builder = fake.from(table);
      let operation = 'select';
      const proxy: object = new Proxy(builder, {
        get(target, property) {
          const value: unknown = Reflect.get(target, property);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            if (['insert', 'upsert', 'update', 'delete'].includes(String(property))) operation = String(property);
            if (['single', 'maybeSingle', 'then'].includes(String(property))) {
              const call = { table, operation };
              operations.push(call);
              const replacement = intercept(call);
              if (replacement !== undefined) {
                const result = Promise.resolve(replacement);
                return property === 'then' ? Reflect.apply(result.then, result, args) : result;
              }
            }
            const result = Reflect.apply(value, target, args);
            return result === target ? proxy : result;
          };
        },
      });
      return proxy;
    },
  };
}

function mirror(slug = oldSlug, overrides: Row = {}): Row {
  return {
    id: `canonical-${slug}`, page_type: 'landing', slug, path: `/lp/${slug}`, title: 'Original headline',
    summary: 'Original summary', body: 'Original body', status: 'published', deleted_at: null,
    content: { source: 'marketing_landing_pages', source_id: legacyId, metadata: {} },
    seo: {}, aeo: {}, published_at: '2026-09-01T00:00:00.000Z', ...overrides,
  };
}
function form(slug = newSlug) {
  const data = new FormData();
  Object.entries({ id: legacyId, slug, title: 'Updated title', headline: 'Updated headline', body: 'Updated body', cta_label: 'Start', cta_href: '/signup' })
    .forEach(([key, value]) => data.set(key, value));
  return data;
}
function fault(table: string, operation: string, result: unknown, occurrence = 1) {
  let seen = 0;
  intercept = call => call.table === table && call.operation === operation && ++seen === occurrence ? result : undefined;
}
function expectNoSuccess() {
  expect(state.audit).not.toHaveBeenCalled();
  expect(state.revalidate).not.toHaveBeenCalled();
}
beforeEach(() => {
  operations = [];
  intercept = () => undefined;
  db = createInMemorySupabase({ uniques: { marketing_pages: [['path']] }, defaults: { marketing_pages: { deleted_at: null } } });
  db.seed('marketing_landing_pages', [{ id: legacyId, slug: oldSlug, title: 'Original title', headline: 'Original headline', subhead: null, body: 'Original body', metadata: { retained: true }, published: true, status: 'published', deleted_at: null }]);
  db.seed('marketing_pages', [mirror()]);
  state.client = clientFor(db);
  state.gate.mockReset().mockResolvedValue({ supabase: state.client, actorId: 'fixture-admin', actorEmail: 'fixture@example.test' });
  state.audit.mockReset().mockResolvedValue(undefined);
  state.revalidate.mockReset();
  state.tag.mockReset();
  state.retireAnswers.mockReset().mockResolvedValue({ error: null });
});
afterEach(() => {
  expect(state.forbidden).not.toHaveBeenCalled();
  expect(state.guards.every(guard => guard.mock.calls.length === 0)).toBe(true);
});
afterAll(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('legacy landing rename through the real action, bridge, and public reader', () => {
  it('replaces the published URL and removes the old public mirror', async () => {
    expect(await getPublishedMarketingPage('landing', oldSlug)).toMatchObject({ id: `canonical-${oldSlug}` });
    await updateLandingPage(form());
    expect(await getPublishedMarketingPage('landing', newSlug)).toMatchObject({ title: 'Updated headline', content: { source_id: legacyId } });
    expect(await getPublishedMarketingPage('landing', oldSlug)).toBeNull();
    expect(db.table('marketing_landing_pages')[0]).toMatchObject({ slug: newSlug, metadata: { retained: true, cta_label: 'Start', cta_href: '/signup' } });
    expect(state.audit).toHaveBeenCalledOnce();
    expect(state.revalidate).toHaveBeenCalledWith(`/lp/${oldSlug}`);
    expect(state.revalidate).toHaveBeenCalledWith(`/lp/${newSlug}`);
    expect(state.retireAnswers).not.toHaveBeenCalled();
  });

  it.each(['unpublish', 'archive'])('keeps the old URL hidden after a subsequent %s', async operation => {
    await updateLandingPage(form());
    const data = new FormData(); data.set('id', legacyId); data.set('publish', '0');
    if (operation === 'archive') await archiveLandingPage(data); else await setLandingPublished(data);
    expect(await getPublishedMarketingPage('landing', newSlug)).toBeNull();
    expect(await getPublishedMarketingPage('landing', oldSlug)).toBeNull();
  });

  it('keeps a same-slug edit published without archiving its current canonical row', async () => {
    await updateLandingPage(form(oldSlug));
    expect(await getPublishedMarketingPage('landing', oldSlug)).toMatchObject({ id: `canonical-${oldSlug}`, title: 'Updated headline' });
    expect(state.audit).toHaveBeenCalledOnce();
  });

  it('keeps a renamed draft private and retires its previous draft mirror', async () => {
    Object.assign(db.table('marketing_landing_pages')[0], { published: false, status: 'draft' });
    db.table('marketing_pages')[0].status = 'draft';
    await updateLandingPage(form());
    expect(await getPublishedMarketingPage('landing', newSlug)).toBeNull();
    expect(await getPublishedMarketingPage('landing', oldSlug)).toBeNull();
    expect(db.table('marketing_pages').find(row => row.path === `/lp/${oldSlug}`)).toMatchObject({ status: 'archived' });
    expect(db.table('marketing_pages').find(row => row.path === `/lp/${newSlug}`)).toMatchObject({ status: 'draft' });
  });

  it.each([401, 403])('preserves the %s gate refusal before any database access', async status => {
    const sentinel = Object.assign(new Error('Synthetic gate refusal'), { status });
    state.gate.mockRejectedValueOnce(sentinel);
    await expect(updateLandingPage(form())).rejects.toBe(sentinel);
    expect(operations).toEqual([]);
    expectNoSuccess();
  });

  it('does not write for an incomplete form after checking the admin gate', async () => {
    await updateLandingPage(new FormData());
    expect(state.gate).toHaveBeenCalledOnce();
    expect(operations).toEqual([]);
    expectNoSuccess();
  });

  it.each(['select', 'update'])('stops on a returned legacy %s error', async operation => {
    const original = structuredClone(db.table('marketing_pages'));
    fault('marketing_landing_pages', operation, reply(failure));
    await expect(updateLandingPage(form())).rejects.toThrow();
    expect(db.table('marketing_pages')).toEqual(original);
    expectNoSuccess();
  });

  it.each(['select', 'update'])('preserves a rejected legacy %s without reporting success', async operation => {
    const original = structuredClone(db.table('marketing_pages'));
    const sentinel = new Error('Synthetic transport failure');
    intercept = call => { if (call.table === 'marketing_landing_pages' && call.operation === operation) return Promise.reject(sentinel); };
    await expect(updateLandingPage(form())).rejects.toBe(sentinel);
    expect(db.table('marketing_pages')).toEqual(original);
    expectNoSuccess();
  });

  it('refuses a missing legacy reload rather than auditing an unsynchronized edit', async () => {
    fault('marketing_landing_pages', 'select', reply(null), 2);
    await expect(updateLandingPage(form())).rejects.toThrow();
    expectNoSuccess();
  });

  it.each(['returned', 'rejected'])('refuses a %s legacy reload failure before touching canonical pages', async mode => {
    let reads = 0;
    intercept = call => {
      if (call.table === 'marketing_landing_pages' && call.operation === 'select' && ++reads === 2) {
        return mode === 'rejected' ? Promise.reject(new Error('Synthetic reload rejection')) : reply(failure);
      }
    };
    await expect(updateLandingPage(form())).rejects.toBeDefined();
    expect(operations.every(call => call.table !== 'marketing_pages')).toBe(true);
    expectNoSuccess();
  });

  it.each([
    ['returned error', { code: 'XX000', message: 'Synthetic replacement failure' }],
    ['permission error naming the table', { code: '42501', message: 'permission denied for table marketing_pages' }],
    ['missing replacement row', null],
  ])('refuses a %s from the replacement and preserves the old public mirror', async (_label, error) => {
    fault('marketing_pages', 'upsert', reply(error));
    await expect(updateLandingPage(form())).rejects.toBeDefined();
    expect(await getPublishedMarketingPage('landing', oldSlug)).not.toBeNull();
    expect(await getPublishedMarketingPage('landing', newSlug)).toBeNull();
    expectNoSuccess();
  });

  it('preserves a rejected replacement without retiring the old mirror', async () => {
    const sentinel = new Error('Synthetic replacement rejection');
    intercept = call => { if (call.table === 'marketing_pages' && call.operation === 'upsert') return Promise.reject(sentinel); };
    await expect(updateLandingPage(form())).rejects.toBe(sentinel);
    expect(await getPublishedMarketingPage('landing', oldSlug)).not.toBeNull();
    expectNoSuccess();
  });

  it.each([
    { code: 'PGRST205', message: "Could not find the table 'public.marketing_pages' in the schema cache" },
    { code: '42P01', message: 'relation "public.marketing_pages" does not exist' },
  ])('preserves legacy-only editing when the canonical table is explicitly unavailable: $code', async error => {
    db.replace('marketing_pages', []);
    intercept = call => call.table === 'marketing_pages' ? reply(error) : undefined;
    await updateLandingPage(form());
    expect(db.table('marketing_landing_pages')[0]).toMatchObject({ slug: newSlug, title: 'Updated title' });
    expect(state.audit).toHaveBeenCalledOnce();
    expect(operations.filter(call => call.table === 'marketing_pages').map(call => call.operation)).toEqual(['upsert']);
    expect(state.retireAnswers).not.toHaveBeenCalled();
  });

  it.each([
    { code: '42P01', message: 'relation "public.marketing_aeo_questions" does not exist' },
    { code: '42P01', message: 'relation "public.marketing_generation_jobs" does not exist' },
    { code: 'PGRST205', message: "Could not find the table 'public.marketing_generation_jobs' in the schema cache" },
  ])('refuses missing dependencies without mistaking them for an absent canonical table: $message', async error => {
    fault('marketing_pages', 'upsert', reply(error));
    await expect(updateLandingPage(form())).rejects.toBeDefined();
    expect(await getPublishedMarketingPage('landing', oldSlug)).not.toBeNull();
    expectNoSuccess();
  });

  it.each(['returned', 'rejected'])('does not claim success on a %s old-mirror retirement failure', async mode => {
    intercept = call => {
      if (call.table === 'marketing_pages' && call.operation === 'update') {
        if (mode === 'rejected') return Promise.reject(new Error('Synthetic retirement rejection'));
        return reply(failure);
      }
    };
    await expect(updateLandingPage(form())).rejects.toBeDefined();
    expect(await getPublishedMarketingPage('landing', newSlug)).not.toBeNull();
    expect(await getPublishedMarketingPage('landing', oldSlug)).not.toBeNull();
    expectNoSuccess();
  });

  it.each([
    ['permission failure', { code: '42501', message: 'permission denied for table marketing_pages' }],
    ['missing schema failure', { code: 'PGRST205', message: 'Synthetic missing relation' }],
    ['unacknowledged write', null],
  ])('does not suppress a retirement %s after a successful replacement', async (_label, error) => {
    fault('marketing_pages', 'update', reply(error));
    await expect(updateLandingPage(form())).rejects.toBeDefined();
    expect(await getPublishedMarketingPage('landing', oldSlug)).not.toBeNull();
    expectNoSuccess();
  });

  it('repairs the old owned alias when retrying after retirement failed and the legacy slug already changed', async () => {
    fault('marketing_pages', 'update', reply(failure));
    await expect(updateLandingPage(form())).rejects.toBeDefined();
    expect(db.table('marketing_landing_pages')[0].slug).toBe(newSlug);
    expectNoSuccess();
    intercept = () => undefined;
    await updateLandingPage(form());
    expect(await getPublishedMarketingPage('landing', newSlug)).not.toBeNull();
    expect(await getPublishedMarketingPage('landing', oldSlug)).toBeNull();
    expect(state.audit).toHaveBeenCalledOnce();
  });

  it.each([
    { content: { source: 'canonical-editor', source_id: legacyId } },
    { content: { source: 'marketing_landing_pages', source_id: 'another-legacy-page' } },
    { page_type: 'feature' },
    { path: '/features/old-landing' },
  ])('preserves an old-path canonical page owned elsewhere: %j', async override => {
    Object.assign(db.table('marketing_pages')[0], override);
    const unrelated = structuredClone(db.table('marketing_pages')[0]);
    await updateLandingPage(form());
    expect(db.table('marketing_pages').find(row => row.id === unrelated.id)).toEqual(unrelated);
    if (unrelated.path === `/lp/${oldSlug}`) expect(await getPublishedMarketingPage('landing', oldSlug)).not.toBeNull();
    expect(await getPublishedMarketingPage('landing', newSlug)).not.toBeNull();
    expect(state.retireAnswers).not.toHaveBeenCalled();
  });

  it('preserves ownership reassigned immediately before the retirement write', async () => {
    intercept = call => {
      if (call.table === 'marketing_pages' && call.operation === 'update') {
        db.table('marketing_pages')[0].content = { source: 'canonical-editor', source_id: 'replacement-owner' };
      }
    };
    await updateLandingPage(form());
    expect(await getPublishedMarketingPage('landing', oldSlug)).not.toBeNull();
    expect(state.retireAnswers).not.toHaveBeenCalled();
  });

  it('retires only this legacy page’s noncurrent aliases on an idempotent same-slug retry', async () => {
    db.table('marketing_landing_pages')[0].slug = newSlug;
    db.seed('marketing_pages', [mirror(newSlug), mirror('older-owned'), mirror('unrelated', { content: { source: 'marketing_landing_pages', source_id: 'another-id' } })]);
    await updateLandingPage(form());
    expect(await getPublishedMarketingPage('landing', newSlug)).not.toBeNull();
    expect(await getPublishedMarketingPage('landing', oldSlug)).toBeNull();
    expect(await getPublishedMarketingPage('landing', 'older-owned')).toBeNull();
    expect(await getPublishedMarketingPage('landing', 'unrelated')).not.toBeNull();
    expect(state.revalidate).toHaveBeenCalledWith(`/lp/${oldSlug}`);
    expect(state.revalidate).toHaveBeenCalledWith('/lp/older-owned');
  });

  it('succeeds when no old mirror exists', async () => {
    db.replace('marketing_pages', []);
    await updateLandingPage(form());
    expect(await getPublishedMarketingPage('landing', newSlug)).not.toBeNull();
    expect(state.audit).toHaveBeenCalledOnce();
  });

  it('leaves previously deleted owned aliases untouched', async () => {
    const archived = mirror('already-archived', { status: 'archived', deleted_at: '2026-09-20T00:00:00.000Z', updated_by: 'previous-admin' });
    db.seed('marketing_pages', [archived]);
    const original = structuredClone(db.table('marketing_pages').find(row => row.path === '/lp/already-archived'));
    await updateLandingPage(form());
    expect(db.table('marketing_pages').find(row => row.path === '/lp/already-archived')).toEqual(original);
  });
});
