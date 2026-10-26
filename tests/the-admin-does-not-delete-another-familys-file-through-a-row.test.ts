import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// The admin console's "Delete" on a family document (admin/content) removes
// the row's storage object with the SERVICE ROLE, which removes any object in
// the bucket it is handed. adminDeleteDocumentAction already reads the path
// from the row by id rather than from the browser, but nothing ties a row's
// path to the row's family (the held 0499's recorded lead): a row of family A
// that names family B's file had B's file removed when an operator deleted A's
// row. "View" beside it refuses such a row (the-admin-opens-the-document-row-
// it-was-shown); Delete now refuses it the same way, before anything is
// removed, and leaves the row for the operator to look at.

const state = vi.hoisted(() => ({ db: null as unknown, removed: [] as string[] }));

vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => true, getUser: async () => ({ id: 'super-admin' }) }));
vi.mock('@/lib/auth/super-admin-assurance', () => ({ superAdminAssurance: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { adminDeleteDocumentAction } = await import('@/app/(app)/admin/actions');

const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const PASSPORT = `${FAMILY_A}/vault/1700000000000-passport.pdf`;
const OTHER_FAMILYS_WILL = `${FAMILY_B}/legal/1700000000001-will.pdf`;

let db: InMemorySupabase;
const rowIds = () => db.table('documents').map((row) => row.id);

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.removed = [];
  db = createInMemorySupabase();
  db.seed('documents', [
    { id: 'doc-passport', family_id: FAMILY_A, title: 'Passport', storage_path: PASSPORT },
    // A row of family A that names family B's file.
    { id: 'doc-planted', family_id: FAMILY_A, title: 'Planted', storage_path: OTHER_FAMILYS_WILL },
    { id: 'doc-will', family_id: FAMILY_B, title: 'Will', storage_path: OTHER_FAMILYS_WILL },
  ]);
  const storage = {
    from: () => ({
      remove: async (paths: string[]) => {
        state.removed.push(...paths);
        return { data: paths.map((name) => ({ name })), error: null };
      },
      list: async () => ({ data: [], error: null }),
    }),
  };
  state.db = new Proxy(db, { get: (target, property) => (property === 'storage' ? storage : Reflect.get(target, property)) });
});

describe('the admin deletes the document row it was shown, and only its own family’s file', () => {
  it('removes the row’s own file and the row (control)', async () => {
    await expect(adminDeleteDocumentAction('doc-passport', PASSPORT)).resolves.toEqual({ ok: true });
    expect(state.removed).toEqual([PASSPORT]);
    expect(rowIds()).toEqual(['doc-planted', 'doc-will']);
  });

  it('does not remove another family’s file through a row that names it, and keeps the row', async () => {
    await expect(adminDeleteDocumentAction('doc-planted', OTHER_FAMILYS_WILL))
      .resolves.toEqual({ ok: false, error: 'actions.couldNotRemoveTheDocument' });
    expect(state.removed).toEqual([]);
    expect(rowIds()).toEqual(['doc-passport', 'doc-planted', 'doc-will']);
  });

  it('still removes that file through its own family’s row (control)', async () => {
    await expect(adminDeleteDocumentAction('doc-will', OTHER_FAMILYS_WILL)).resolves.toEqual({ ok: true });
    expect(state.removed).toEqual([OTHER_FAMILYS_WILL]);
  });

  it('removes nothing for a row that is not there', async () => {
    await expect(adminDeleteDocumentAction('doc-gone', PASSPORT))
      .resolves.toEqual({ ok: false, error: 'actions.documentNotFound' });
    expect(state.removed).toEqual([]);
  });
});
