import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase } from './helpers/in-memory-supabase';
import { change, click, form, nodes, render, submit, text } from './helpers/module-harness';
import { SOURCE_MESSAGES } from '@/lib/i18n/messages';
import { translate } from '@/lib/i18n/translate';
import { resetHookSlots } from './helpers/hook-slots';
import { buildFamilyPath, isFamilyDocumentPath, isReservedDocumentPath } from '@/lib/storage/documents';

// A folder name is something a family types, in its own language, on its own
// keyboard. The storage key is not.
//
// `buildFamilyPath` cleaned the FILE name down to `[a-zA-Z0-9.\-_]` and put the
// typed FOLDER into the key as it was. Supabase Storage refuses any key outside
// `A-Za-z0-9_/!.*'() &$=@;:+,?-` (storage-api `isValidKey`,
// src/storage/limits.ts `VALID_OBJECT_KEY`: "a raw unicode name" is in its own
// list of rejected keys). So every upload into "École", "Financiën" or
// "Férias 2025" (the app's own French, Dutch and Portuguese examples for the
// folder box), into "Kids’ stuff" (the apostrophe an iPhone types), "Taxes #2"
// or "50% off" failed, in Documents with "Something went wrong" and in the Files
// hub with "Upload failed", and failed again on every retry.
//
// The bucket below refuses exactly what Storage refuses. The row keeps the
// folder as typed: only the key is cleaned, the way the file name already was.

const STORAGE_OBJECT_KEY = /^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/;

const h = await vi.hoisted(async () => (await import('./helpers/module-state')).createModuleState());

vi.mock('react', async (original) => (await import('./helpers/hook-slots')).withHookSlots(await original<object>(), h.hooks));
vi.mock('@/lib/hooks/use-realtime-query', async () => (await import('./helpers/module-harness')).realtimeQueryModule(h));
vi.mock('@/lib/supabase/client', async () => {
  const { clientFor: harnessClient } = await import('./helpers/module-harness');
  return {
    createClient: () => {
      const client = harnessClient(h);
      return {
        ...client,
        storage: {
          from: (name: string) => {
            const bucket = client.storage.from(name);
            return {
              ...bucket,
              upload: async (path: string) => (/^[A-Za-z0-9_/!.*'() &$=@;:+,?-]*$/.test(path)
                ? bucket.upload(path)
                : { data: null, error: { name: 'StorageApiError', message: `Invalid key: ${path}`, status: 400, statusCode: 'InvalidKey' } }),
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
const { FilesHubModule } = await import('@/components/modules/files-hub-module');

const t = (key: string) => translate(SOURCE_MESSAGES, key);
const FAMILY = h.app.familyId;
let db: ReturnType<typeof createInMemorySupabase>;

beforeEach(() => {
  resetHookSlots(h.hooks);
  db = createInMemorySupabase();
  h.db = db;
  h.rows = { documents: [] }; h.readErrors = {}; h.refreshes = []; h.calls = []; h.fault = null;
  h.storage = { objects: new Map(), refused: new Set() };
  h.toasts = { success: [], error: [] }; h.timeZone = 'UTC';
  (h.app as Record<string, unknown>).role = 'parent';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const scan = () => new File(['%PDF-1.4 school letter'], 'letter.pdf', { type: 'application/pdf' });
const stored = () => [...(h.storage.objects.get('documents') ?? [])];

/** What a family types in the folder box. Each one is a folder Storage refuses as a key. */
const FOLDERS = [
  'École',          // fr-FR's own example in the folder box
  'Financiën',      // nl-NL's
  'Férias 2025',    // pt-PT's
  'Kids’ stuff',    // the apostrophe iOS types
  'Taxes #2',
  '50% off',
  'Fotos 📷',
];

async function uploadInDocuments(folder: string) {
  const element = () => createElement(DocumentsModule);
  let tree = render(h.hooks, element());
  // The camera's "Scan document" input opens the upload form with the file picked.
  const camera = nodes(tree).find((node) => node.type === 'input' && node.props.capture === 'environment')!;
  change(camera, [scan()]);
  tree = render(h.hooks, element());
  change(nodes(tree).find((node) => node.type === 'input' && node.props.list === 'folder-options')!, folder);
  tree = render(h.hooks, element());
  const uploads = nodes(tree).filter((node) => node.type === 'button' && text(node).trim() === t('documents.uploadFile'));
  await click(uploads[uploads.length - 1]);
}

async function uploadInFilesHub(folder: string) {
  const element = () => createElement(FilesHubModule, { view: 'shared' });
  let tree = render(h.hooks, element()) as ReactNode;
  const open = nodes(tree).find((node) => node.type === 'button' && typeof node.props.onClick === 'function' && text(node).trim() === t('filesHub.upload'))!;
  await click(open);
  tree = render(h.hooks, element());
  const fields = nodes(form(tree));
  change(fields.find((node) => node.type === 'input' && node.props.type === 'file')!, [scan()]);
  change(fields.find((node) => node.type === 'input' && node.props.placeholder === t('documents.eGPassportEmmaPdf'))!, 'School letter');
  change(fields.find((node) => node.type === 'input' && node.props.placeholder === t('filesHub.eGTravelSchoolFinances'))!, folder);
  tree = render(h.hooks, element());
  await submit(form(tree));
}

function expectSavedUnder(folder: string, uploaded: string) {
  expect(h.toasts.error, `an upload into "${folder}" failed`).toEqual([]);
  expect(h.toasts.success).toEqual([uploaded]);
  const rows = db.table('documents');
  expect(rows).toHaveLength(1);
  // The family's folder name is the row's, exactly as typed.
  expect(rows[0].category).toBe(folder);
  // And the bytes are where the row says, under the family's own folder.
  const path = String(rows[0].storage_path);
  expect(stored()).toEqual([path]);
  expect(STORAGE_OBJECT_KEY.test(path)).toBe(true);
  expect(path.startsWith(`${FAMILY}/`)).toBe(true);
  expect(isFamilyDocumentPath(FAMILY, path), 'the assistant could not open it').toBe(true);
}

describe('a folder named the way a family names it still takes the upload', () => {
  it.each(FOLDERS)('Documents files a scan into "%s"', async (folder) => {
    await uploadInDocuments(folder);
    expectSavedUnder(folder, t('documentsModule.fileUploaded'));
  });

  it.each(FOLDERS)('the Files hub files a scan into "%s"', async (folder) => {
    await uploadInFilesHub(folder);
    expectSavedUnder(folder, t('filesHubModule.fileUploaded'));
  });
});

describe('the storage key a folder becomes', () => {
  const ASSET = '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b';

  it.each(['School', 'tax/2025', `manuals/${ASSET}`, `warranties/${ASSET}`, 'trip-memories', 'insurance', 'Mr. & Mrs.'])(
    'keeps "%s" as it is, so the asset sweep and the other uploaders find their files where they were',
    (folder) => {
      expect(buildFamilyPath(FAMILY, folder, 'a.pdf')).toMatch(new RegExp(`^${FAMILY}/${folder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\d+-a\\.pdf$`));
    },
  );

  it.each(['School/', '/School', 'School//2025', '.', '..', 'a/../b', '/'])(
    'writes no empty or dot-only folder in the key for "%s"',
    (folder) => {
      const path = buildFamilyPath(FAMILY, folder, 'a.pdf');
      const folders = path.split('/').slice(1, -1);
      expect(folders.length).toBeGreaterThan(0);
      for (const segment of folders) {
        expect(segment).not.toBe('');
        expect(segment).not.toMatch(/^\.+$/);
      }
      expect(STORAGE_OBJECT_KEY.test(path)).toBe(true);
      expect(isFamilyDocumentPath(FAMILY, path)).toBe(true);
    },
  );

  it('a question mark in a folder does not hide the file from the assistant', () => {
    // Storage accepts `?`, but readDocument's path check refuses it: the file
    // would upload and then be "not found" when the assistant opens it.
    const path = buildFamilyPath(FAMILY, 'Forms to sign?', 'a.pdf');
    expect(STORAGE_OBJECT_KEY.test(path)).toBe(true);
    expect(isFamilyDocumentPath(FAMILY, path)).toBe(true);
  });

  it('a reservation for a typed folder is recognised as that folder, and only that one', () => {
    const path = buildFamilyPath(FAMILY, 'École', 'a.pdf');
    expect(isReservedDocumentPath(FAMILY, 'École', path)).toBe(true);
    expect(isReservedDocumentPath(FAMILY, 'Medical', path)).toBe(false);
  });

  it('the bucket here refuses what Storage refuses, so a pass above is not the fake being lenient', async () => {
    const bucket = (await import('@/lib/supabase/client')).createClient().storage.from('documents');
    expect((await bucket.upload(`${FAMILY}/École/1-a.pdf`, scan())).error).not.toBeNull();
    expect(stored()).toEqual([]);
  });
});
