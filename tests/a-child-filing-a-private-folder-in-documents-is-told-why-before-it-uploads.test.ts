import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { change, click, nodes, render, text } from './helpers/module-harness';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { resetHookSlots } from './helpers/hook-slots';
import { isManager } from '@/lib/constants/roles';
import { isSensitiveCategory } from '@/lib/documents/sensitivity';

// A teen, a child or a caregiver may not file an adults-only document: 0266
// refuses the `documents` row when its category is sensitive ("School IDs",
// "Driving licence", "Medical") and the writer is not a parent or adult.
//
// The Files hub decides that BEFORE the bytes move (lib/documents/upload.ts,
// performUpload). Documents (/dashboard/documents) did not: it put the file in
// the bucket first, then the row was refused, and the person was told "Failed
// to save file" with no reason, on every retry. The file they just uploaded sat
// in the bucket until a rollback whose answer nobody read.
//
// Driven through the real module. The database refuses the row the way 0266
// does, and the bucket counts every upload.

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());
const bucket = vi.hoisted(() => ({ uploads: [] as string[], removes: [] as string[][], refuseRemove: false }));

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => {
  const { clientFor } = await import('./helpers/module-harness');
  const { withFaults } = await import('./helpers/in-memory-supabase');
  return {
    createClient: () => {
      const client = clientFor(h);
      return {
        // Reservation writes end in single(), which is a terminal promise:
        // retain fault injection there instead of allowing it to execute
        // before the older harness's builder.then can inspect the fault.
        ...withFaults(client, (table, calls) => h.fault?.(table, calls.map(call => call.method)) ?? null),
        storage: {
          from: (name: string) => {
            const real = client.storage.from(name);
            return {
              ...real,
              upload: async (path: string) => { bucket.uploads.push(path); return real.upload(path); },
              // Storage answers a refused delete with no error and an empty list.
              remove: async (paths: string[]) => { bucket.removes.push(paths); return bucket.refuseRemove ? { data: [], error: null } : real.remove(paths); },
            };
          },
        },
      };
    },
  };
});
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

const t = (key: string, params?: Record<string, string | number>) => translate(SOURCE_MESSAGES, key, params);
let db: ReturnType<typeof createInMemorySupabase>;
let role = 'parent';
let category = '';

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = { documents: [] }; h.readErrors = {}; h.refreshes = []; h.calls = [];
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  bucket.uploads = []; bucket.removes = []; bucket.refuseRemove = false;
  // 0266's insert policy: a sensitive row is a manager's to write.
  h.fault = (table, calls) => (table === 'documents' && calls.includes('insert') && isSensitiveCategory(category) && !isManager(role as never)
    ? { code: '42501', message: 'new row violates row-level security policy for table "documents"' }
    : null);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const stored = () => [...(h.storage.objects.get('documents') ?? [])];
const inserts = () => h.calls.filter((call) => call.table === 'documents' && call.calls.includes('insert'));

async function upload(as: string, folder: string) {
  role = as; category = folder;
  (h.app as Record<string, unknown>).role = as;
  const element = () => createElement(DocumentsModule);
  let tree = render(h.hooks, element());
  const camera = nodes(tree).find((node) => node.type === 'input' && node.props.capture === 'environment')!;
  change(camera, [new File(['scan'], 'card.jpg', { type: 'image/jpeg' })]);
  tree = render(h.hooks, element());
  change(nodes(tree).find((node) => node.type === 'input' && node.props.list === 'folder-options')!, folder);
  tree = render(h.hooks, element());
  const buttons = nodes(tree).filter((node) => node.type === 'button' && text(node).trim() === t('documents.uploadFile'));
  await click(buttons[buttons.length - 1]);
}

describe('Documents refuses an adults-only folder before the file moves', () => {
  it.each([
    ['teen', 'School IDs'],
    ['child', 'Medical'],
    ['caregiver', 'Driving licence'],
  ])('a %s filing into "%s" is told why, and nothing is uploaded or written', async (as, folder) => {
    await upload(as, folder);

    expect(h.toasts.error).toEqual([t('filesHubModule.refuseSensitive', { category: folder.toLowerCase() })]);
    expect(h.toasts.success).toEqual([]);
    expect(bucket.uploads, 'the bytes reached the bucket before the refusal').toEqual([]);
    expect(inserts(), 'a documents row was attempted').toEqual([]);
    expect(stored()).toEqual([]);
  });

  it('a teen still files an ordinary folder', async () => {
    await upload('teen', 'School');

    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual([t('documentsModule.fileUploaded')]);
    const rows = db.table('documents');
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('School');
    expect(stored()).toEqual([rows[0].storage_path]);
  });

  it.each(['parent', 'adult'])('a %s still files a medical record', async (as) => {
    await upload(as, 'Medical');

    expect(h.toasts.error).toEqual([]);
    expect(h.toasts.success).toEqual([t('documentsModule.fileUploaded')]);
    expect(db.table('documents')).toHaveLength(1);
    expect(stored()).toHaveLength(1);
  });

  it('a row the database refuses for another reason leaves no file behind, and says it was not saved', async () => {
    h.fault = (table, calls) => (table === 'documents' && calls.includes('insert') ? { code: '23514', message: 'check constraint' } : null);
    await upload('parent', 'School');

    expect(h.toasts.error).toEqual([t('documentsModule.failedToSaveFile')]);
    expect(h.toasts.success).toEqual([]);
    expect(bucket.uploads).toHaveLength(0);
    expect(stored(), 'the uploaded file outlived its refused row').toEqual([]);
    expect(db.table('documents')).toEqual([]);
  });

  it('a refused reservation needs no storage compensation even when removal would be refused', async () => {
    h.fault = (table, calls) => (table === 'documents' && calls.includes('insert') ? { code: '23514', message: 'check constraint' } : null);
    bucket.refuseRemove = true;
    await upload('parent', 'School');

    expect(h.toasts.error).toEqual([t('documentsModule.failedToSaveFile')]);
    expect(bucket.uploads).toEqual([]);
    expect(bucket.removes).toEqual([]);
    expect(stored()).toEqual([]);
    expect(db.table('documents')).toEqual([]);
  });
});
