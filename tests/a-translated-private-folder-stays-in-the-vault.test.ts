import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { byName, click, has, render } from './helpers/module-harness';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { resetHookSlots } from './helpers/hook-slots';
import { isSensitiveCategoryToTheDatabase } from '@/lib/documents/sensitivity';

// A folder that is private only in translation — Dutch "Financiën", German
// "Versicherung" — is filed with `is_secure` (5291f6bcd), because the
// database's own category rule (`is_sensitive_document`, 0312) reads ASCII
// English and calls those folders ordinary. For such a row `is_secure` is the
// ONLY thing between it and a child: the table read (0266) and the byte read
// (0303) both ask that predicate.
//
// The Files hub's "Move to shared" wrote `is_secure: false` for any row, so a
// parent moving a "Financiën" statement out of the Vault made it readable by
// every child in the family, under "Moved to Shared Files". Owner review
// 6371274621 on #1082.
//
// The move now refuses a row whose folder needs the flag, says why, and leaves
// the row in the Vault. An English "Finances" row still moves (its folder keeps
// it private in the database), an ordinary folder moves as before, and moving
// INTO the Vault is never refused. Driven through the real Files hub.

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

const { FilesHubModule } = await import('@/components/modules/files-hub-module');

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

function seed(category: string, isSecure: boolean) {
  const row = {
    id: 'doc-1', family_id: FAMILY, title: 'Statement 2026', category, is_secure: isSecure, is_favorite: false,
    size_bytes: 1000, mime_type: 'application/pdf', storage_path: `${FAMILY}/vault/1-statement.pdf`,
    created_by: 'user-1', created_at: '2026-10-01T00:00:00Z',
  };
  db.seed('documents', [row]);
  h.rows = { documents: [{ ...row }] };
}

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  (h.app as Record<string, unknown>).role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const row = () => db.table('documents')[0];
const updates = () => h.calls.filter((call) => call.table === 'documents' && call.calls.includes('update'));

async function move(view: 'vault' | 'shared', label: string) {
  const tree = render(h.hooks, createElement(FilesHubModule, { view }));
  expect(has(tree, 'Statement 2026'), 'the file is not on this view').toBe(true);
  await click(byName(tree, t(label)));
}

describe('a translated private folder stays in the Vault', () => {
  it.each(['Financiën', 'Versicherung', 'Gezondheid', 'Santé'])(
    '"%s": Move to shared is refused, says why, and the row stays secure',
    async (category) => {
      seed(category, true);
      expect(isSensitiveCategoryToTheDatabase(category), 'the database already protects this folder by name').toBe(false);

      await move('vault', 'filesHubModule.moveShared');

      expect(h.toasts.error).toEqual([t('filesHubModule.sensitiveStaysInVault', { category })]);
      expect(h.toasts.success).toEqual([]);
      expect(updates(), 'the flag was written').toEqual([]);
      expect(row().is_secure).toBe(true);
    },
  );

  it('an English "Finances" file still moves: its folder keeps it private in the database', async () => {
    seed('Finances', true);

    await move('vault', 'filesHubModule.moveShared');

    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual([t('filesHubModule.movedShared')]);
    expect(row().is_secure).toBe(false);
    expect(isSensitiveCategoryToTheDatabase(String(row().category))).toBe(true);
  });

  it('an ordinary "School" file moves to Shared as before', async () => {
    seed('School', true);

    await move('vault', 'filesHubModule.moveShared');

    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual([t('filesHubModule.movedShared')]);
    expect(row().is_secure).toBe(false);
  });

  it('a translated private folder can always be moved INTO the Vault', async () => {
    seed('Financiën', false);

    await move('shared', 'filesHubModule.moveVault');

    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual([t('filesHubModule.movedVault')]);
    expect(row().is_secure).toBe(true);
  });
});
