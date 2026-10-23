import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// The admin console's "View" on a family document (admin/content) signs a
// link with the SERVICE ROLE, which signs any object in the bucket it is
// handed. adminGetDocumentUrlAction took that object's path from the browser:
// whatever path a request named, of any family, came back as a working link.
// adminDeleteDocumentAction beside it already reads the row's own path by id.
//
// It now takes the document's id, reads the row, and signs the row's own path:
//   - a missing row, or a row whose path is no longer the one the screen
//     listed, is refused and nothing is signed;
//   - a row whose path lies outside its own family's folder (nothing ties the
//     two together: the held 0499's recorded lead) is refused too.

const state = vi.hoisted(() => ({ db: null as unknown, signed: [] as string[] }));

vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => true, getUser: async () => ({ id: 'super-admin' }) }));
vi.mock('@/lib/auth/super-admin-assurance', () => ({ superAdminAssurance: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => {} }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { adminGetDocumentUrlAction } = await import('@/app/(app)/admin/actions');

const FAMILY_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const FAMILY_B = '0b0b0b0b-0000-4000-8000-00000000000b';
const PASSPORT = `${FAMILY_A}/vault/1700000000000-passport.pdf`;
const OTHER_FAMILYS_WILL = `${FAMILY_B}/legal/1700000000001-will.pdf`;

let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.signed = [];
  db = createInMemorySupabase();
  db.seed('documents', [
    { id: 'doc-passport', family_id: FAMILY_A, title: 'Passport', storage_path: PASSPORT },
    // A row of family A that names family B's file.
    { id: 'doc-planted', family_id: FAMILY_A, title: 'Planted', storage_path: OTHER_FAMILYS_WILL },
  ]);
  const storage = {
    from: () => ({
      createSignedUrl: async (path: string) => {
        state.signed.push(path);
        return { data: { signedUrl: `https://signed.invalid/${path}` }, error: null };
      },
    }),
  };
  state.db = new Proxy(db, { get: (target, property) => (property === 'storage' ? storage : Reflect.get(target, property)) });
});

describe('the admin opens the document row it was shown', () => {
  it('signs the row’s own path', async () => {
    await expect(adminGetDocumentUrlAction('doc-passport', PASSPORT))
      .resolves.toEqual({ ok: true, data: { url: `https://signed.invalid/${PASSPORT}` } });
    expect(state.signed).toEqual([PASSPORT]);
  });

  it('does not sign a path the browser named that is not the row’s', async () => {
    await expect(adminGetDocumentUrlAction('doc-passport', OTHER_FAMILYS_WILL))
      .resolves.toEqual({ ok: false, error: 'actions.documentNotFound' });
    expect(state.signed).toEqual([]);
  });

  it('does not sign anything for a row that is not there', async () => {
    await expect(adminGetDocumentUrlAction('doc-gone', PASSPORT))
      .resolves.toEqual({ ok: false, error: 'actions.documentNotFound' });
    expect(state.signed).toEqual([]);
  });

  it('does not sign another family’s file through a row that names it', async () => {
    await expect(adminGetDocumentUrlAction('doc-planted', OTHER_FAMILYS_WILL))
      .resolves.toEqual({ ok: false, error: 'actions.couldNotCreateADocument' });
    expect(state.signed).toEqual([]);
  });

  it('the console’s View button sends the row’s id with the path it listed', () => {
    const source = readFileSync('components/admin/document-row-actions.tsx', 'utf8');
    expect(source).toContain('adminGetDocumentUrlAction(documentId, storagePath)');
  });
});
