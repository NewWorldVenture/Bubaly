import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInMemorySupabase, type InMemorySupabase } from './helpers/in-memory-supabase';

// The admin console's Delete removes a family document's file, then its row.
// Storage answers a delete it refused, and a delete of something already gone,
// the same way: `{ data: [], error: null }` (SEC-015). So an empty answer is
// checked by listing the folder: the object still listed means it was not
// removed, and the row — which is what hides a Vault file from a child
// (0303's document_object_is_restricted finds the row) — must stay.
//
// adminDeleteDocumentAction read that listing as "gone" whenever it could not
// see the object, including when the listing itself FAILED: a 503 on the list,
// or a reply with no list at all, went on to delete the row and answer
// `{ ok: true }`. A file whose removal nobody could confirm lost its
// protective row. Owner review 6353951568 on #1082, finding 2.
//
// It now reads the listing the way `removeConfirmed` (lib/storage/confirm-
// removal.ts) does for the family's own deletes: a listing that errors or
// answers with no list refuses and keeps the row; a listing that answers,
// without the object, lets a retry after a half-finished delete complete.

const state = vi.hoisted(() => ({
  db: null as unknown,
  removeReply: { data: [] as { name: string }[] | null, error: null as { message: string } | null },
  listReply: { data: [] as { name: string }[] | null, error: null as { message: string } | null },
  audits: [] as unknown[],
}));

vi.mock('@/lib/supabase/auth', () => ({ isSuperAdmin: async () => true, getUser: async () => ({ id: 'super-admin' }) }));
vi.mock('@/lib/auth/super-admin-assurance', () => ({ superAdminAssurance: async () => ({ ok: true }) }));
vi.mock('@/lib/supabase/server', () => ({ createServer: async () => state.db, createServiceClient: () => state.db }));
vi.mock('@/lib/i18n/server', () => ({ getTranslations: async () => (key: string) => key }));
vi.mock('@/lib/server/audit', () => ({ logAudit: async (_db: unknown, entry: unknown) => { state.audits.push(entry); } }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

const { adminDeleteDocumentAction } = await import('@/app/(app)/admin/actions');

const FAMILY = '0a0a0a0a-0000-4000-8000-00000000000a';
const PATH = `${FAMILY}/vault/1700000000000-will.pdf`;
let db: InMemorySupabase;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  state.audits = [];
  state.removeReply = { data: [], error: null };
  state.listReply = { data: [], error: null };
  db = createInMemorySupabase();
  db.seed('documents', [{ id: 'doc-will', family_id: FAMILY, title: 'The family will', is_secure: true, storage_path: PATH }]);
  const storage = {
    from: () => ({
      remove: async () => state.removeReply,
      list: async () => state.listReply,
    }),
  };
  state.db = new Proxy(db, { get: (target, property) => (property === 'storage' ? storage : Reflect.get(target, property)) });
});

const rows = () => db.table('documents').map((row) => row.id);

describe('the admin delete keeps the row when it cannot tell the file is gone', () => {
  it('a listing that fails (503) refuses, and the protective row stays', async () => {
    state.listReply = { data: null, error: { message: '503 Service Unavailable' } };

    await expect(adminDeleteDocumentAction('doc-will', PATH)).resolves.toEqual({ ok: false, error: 'actions.couldNotRemoveTheDocument' });
    expect(rows()).toEqual(['doc-will']);
  });

  it('a listing error is an error even beside an empty list', async () => {
    state.listReply = { data: [], error: { message: '503 Service Unavailable' } };

    await expect(adminDeleteDocumentAction('doc-will', PATH)).resolves.toEqual({ ok: false, error: 'actions.couldNotRemoveTheDocument' });
    expect(rows()).toEqual(['doc-will']);
  });

  it('a listing that answers with no list at all refuses too', async () => {
    state.listReply = { data: null, error: null };

    await expect(adminDeleteDocumentAction('doc-will', PATH)).resolves.toEqual({ ok: false, error: 'actions.couldNotRemoveTheDocument' });
    expect(rows()).toEqual(['doc-will']);
  });

  it('a file still listed after the delete was refused keeps its row', async () => {
    state.listReply = { data: [{ name: '1700000000000-will.pdf' }], error: null };

    await expect(adminDeleteDocumentAction('doc-will', PATH)).resolves.toEqual({ ok: false, error: 'actions.couldNotRemoveTheDocument' });
    expect(rows()).toEqual(['doc-will']);
  });

  it('a storage error on the delete itself refuses, and the row stays', async () => {
    state.removeReply = { data: null, error: { message: 'storage unavailable' } };

    await expect(adminDeleteDocumentAction('doc-will', PATH)).resolves.toEqual({ ok: false, error: 'actions.couldNotRemoveTheDocument' });
    expect(rows()).toEqual(['doc-will']);
  });

  it('a file genuinely gone already (the listing answers, without it) still lets the delete complete', async () => {
    state.listReply = { data: [{ name: '1700000000000-will.pdf.bak' }], error: null };

    await expect(adminDeleteDocumentAction('doc-will', PATH)).resolves.toEqual({ ok: true });
    expect(rows()).toEqual([]);
    expect(state.audits).toHaveLength(1);
  });

  it('a file the delete confirms removed deletes the row', async () => {
    state.removeReply = { data: [{ name: PATH }], error: null };
    state.listReply = { data: null, error: { message: 'never asked' } };

    await expect(adminDeleteDocumentAction('doc-will', PATH)).resolves.toEqual({ ok: true });
    expect(rows()).toEqual([]);
  });
});
