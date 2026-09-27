import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared harness for the module CRUD write-boundary triage (PLA-0410): these
// void/result form actions previously discarded the PostgREST write result and
// returned normally, so a failed write reported success while the row was lost.
const requireUserContext = vi.fn();
const createServer = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
// The paperwork actions gate on the session's assurance level (0391 / O-03,
// tests/a-password-alone-does-not-open-the-familys-vault.test.ts). The
// write-result contract under test HERE is the same whatever that level is,
// and the write client above has no `auth.mfa` to read it from — an unreadable
// level fails closed — so the verdict is "allow" throughout this file.
vi.mock('@/lib/auth/require-aal2', () => ({ aal2Verdict: async () => ({ action: 'allow' }) }));

// A write client whose insert/update/delete terminal awaits resolve to the
// configured result. update()/delete() return a chain awaitable after
// .eq().eq() — and after .select(), which a writer adds to learn whether a row
// actually changed. `rows` is what that .select() answers: none by default,
// the shape of an update row-level security filtered.
function writeClient(result: { error: unknown; rows?: unknown[] }) {
  const eqChain: Record<string, unknown> = {
    eq: () => eqChain,
    select: () => eqChain,
    then: (onF: (v: { data: unknown[] | null; error: unknown }) => unknown) =>
      Promise.resolve({ data: result.rows ?? null, error: result.error }).then(onF),
  };
  return {
    from: () => ({
      insert: () => Promise.resolve({ data: null, error: result.error }),
      update: () => eqChain,
      delete: () => eqChain,
    }),
  };
}

// Imported once, at collection time. Importing inside each case put the cold
// transform of an action module's whole graph inside the FIRST case's 5 s
// timeout — measured at 3.3 s for this file alone, and past 5 s (a red
// saveVehicleAction) under a loaded machine. The mocks above are hoisted, so
// these bind to them exactly as the per-case imports did.
const { saveVehicleAction, deleteVehicleAction } = await import('@/app/(app)/dashboard/auto/actions');
const { addPaperworkAction, setPaperworkStatusAction } = await import('@/app/(app)/dashboard/paperwork/actions');
const { logInteractionAction, deleteInteractionAction } = await import('@/app/(app)/dashboard/contacts/[id]/actions');

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
}

describe('module CRUD write boundaries', () => {
  beforeEach(() => {
    requireUserContext.mockResolvedValue({ active: { familyId: 'fam-1' }, user: { id: 'user-1' } });
  });
  afterEach(() => vi.clearAllMocks());

  describe('auto', () => {
    it('saveVehicleAction throws when the insert fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'rls denied' } }));
      await expect(saveVehicleAction(fd({ nickname: 'Van' }))).rejects.toThrow();
    });
    it('saveVehicleAction resolves on success', async () => {
      createServer.mockResolvedValue(writeClient({ error: null }));
      await expect(saveVehicleAction(fd({ nickname: 'Van' }))).resolves.toBeUndefined();
    });
    it('deleteVehicleAction throws when the soft-delete fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'permission denied' } }));
      await expect(deleteVehicleAction('v-1')).rejects.toThrow();
    });
  });

  describe('paperwork', () => {
    it('addPaperworkAction throws when the insert fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'insert failed' } }));
      await expect(addPaperworkAction(fd({ text: 'Field trip permission slip due Friday' }))).rejects.toThrow();
    });
    it('setPaperworkStatusAction throws when the status update fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'update failed' } }));
      await expect(setPaperworkStatusAction({ itemId: 'i-1', status: 'done' })).rejects.toThrow();
    });
    it('setPaperworkStatusAction does not report success when the update changed no row', async () => {
      // No error and no row back: what Postgres answers when a restrictive
      // policy filters the UPDATE. `{ ok: true }` here was the silent success.
      createServer.mockResolvedValue(writeClient({ error: null, rows: [] }));
      expect(await setPaperworkStatusAction({ itemId: 'i-1', status: 'done' })).toEqual({
        ok: false,
        error: "That change wasn't saved — you may not have permission. Refresh and try again.",
      });
    });
    it('setPaperworkStatusAction reports success when the row came back', async () => {
      createServer.mockResolvedValue(writeClient({ error: null, rows: [{ id: 'i-1' }] }));
      expect(await setPaperworkStatusAction({ itemId: 'i-1', status: 'done' })).toEqual({ ok: true });
    });
  });

  describe('contacts', () => {
    it('logInteractionAction throws when the insert fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'insert failed' } }));
      await expect(logInteractionAction(fd({ contact_id: 'c-1', title: 'Coffee' }))).rejects.toThrow();
    });
    it('deleteInteractionAction throws when the delete fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'delete failed' } }));
      await expect(deleteInteractionAction({ id: 'x-1', contactId: 'c-1' })).rejects.toThrow();
    });
  });
});
