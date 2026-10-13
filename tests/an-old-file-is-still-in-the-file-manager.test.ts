import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { change, clientFor, has, nodes, render } from './helpers/module-harness';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { resetHookSlots } from './helpers/hook-slots';

// S13 — the File Manager (/dashboard/documents) and the Files hub
// (/dashboard/files/{cloud,vault,shared}) read `documents` with one unpaged
// select. PostgREST answers at most db-max-rows (1,000 on a default project)
// and says nothing, so past it the OLDEST files were gone from the list, the
// search ("No files match your filters"), the folder counts, "storage used" —
// and, because the Vault split runs on the client after the read, an old
// passport scan vanished from a Secure Vault holding three files.
//
// Each case drives the REAL module's own read against an in-memory database
// capped the way PostgREST caps it, and renders what came back.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const reads = vi.hoisted(() => ({ fetchers: {} as Record<string, (client: unknown) => PromiseLike<{ data: unknown[] | null; error: unknown }>> }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
// The harness's screen model, plus a hand on the fetcher the module passes it,
// so the test can run the module's OWN read against the capped database.
vi.mock('@/lib/hooks/use-realtime-query', async () => {
  const harness = (await import('./helpers/module-harness')).realtimeQueryModule(h);
  return {
    useRealtimeQuery: (options: Parameters<typeof harness.useRealtimeQuery>[0]) => {
      reads.fetchers[options.table] = options.fetcher as never;
      return harness.useRealtimeQuery(options);
    },
  };
});
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
vi.mock('@/components/ai/ai-insight', async () => (await import('./helpers/module-harness')).ui);

const { DocumentsModule } = await import('@/components/modules/documents-module');
const { FilesHubModule } = await import('@/components/modules/files-hub-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
const OLDEST = 'Passport scan 2016';
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  resetHookSlots(h.hooks);
  // PostgREST's db-max-rows on a default Supabase project.
  db = createInMemorySupabase({ maxRows: 1000 });
  h.db = db;
  h.rows = { documents: [] }; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  (h.app as Record<string, unknown>).role = 'parent';
  reads.fetchers = {};
  vi.spyOn(console, 'error').mockImplementation(() => {});
  db.seed('documents', [
    { id: 'doc-oldest', family_id: FAMILY, title: OLDEST, category: 'passport', is_secure: true, size_bytes: 900_000, mime_type: 'application/pdf', storage_path: `${FAMILY}/vault/passport.pdf`, created_by: 'user-1', created_at: '2016-01-02T00:00:00Z' },
    // A thousand newer photos and files of every kind.
    ...Array.from({ length: 1000 }, (_, i) => ({
      id: `doc-${String(i).padStart(4, '0')}`, family_id: FAMILY, title: `Holiday photo ${i}.jpg`, category: 'photos', is_secure: false,
      size_bytes: 1000, mime_type: 'image/jpeg', storage_path: `${FAMILY}/photos/${i}.jpg`, created_by: 'user-1',
      created_at: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60_000).toISOString(),
    })),
  ]);
});
afterEach(() => vi.restoreAllMocks());

/** Mount, run the module's own `documents` read against the capped database, and show what it returned. */
async function mountAndRead(element: () => ReactNode) {
  render(h.hooks, element() as never);
  const fetcher = reads.fetchers.documents;
  expect(fetcher, 'the module registered no documents read').toBeDefined();
  const { data, error } = await fetcher(clientFor(h));
  expect(error).toBeNull();
  h.rows.documents = (data ?? []) as Record<string, unknown>[];
  return { rows: data ?? [], tree: render(h.hooks, element() as never) };
}

describe('a family past 1,000 files still has its oldest one', () => {
  it('the File Manager reads every file, and a search for the oldest finds it', async () => {
    const { rows, tree } = await mountAndRead(() => createElement(DocumentsModule));
    expect(rows).toHaveLength(1001);

    const search = nodes(tree).find((node) => node.type === 'input' && node.props['aria-label'] === t('documents.searchFiles'))!;
    change(search, 'passport');
    const searched = render(h.hooks, createElement(DocumentsModule));

    expect(has(searched, OLDEST)).toBe(true);
    expect(has(searched, 'No files match your filters')).toBe(false);
  });

  it('the Secure Vault still holds the old passport scan behind a thousand newer files', async () => {
    const { rows, tree } = await mountAndRead(() => createElement(FilesHubModule, { view: 'vault' }));

    expect(rows).toHaveLength(1001);
    expect(has(tree, OLDEST)).toBe(true);
  });
});
