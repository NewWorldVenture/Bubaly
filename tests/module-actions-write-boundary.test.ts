import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Shared harness for the module CRUD write-boundary triage (PLA-0410): these
// void/result form actions previously discarded the PostgREST write result and
// returned normally, so a failed write reported success while the row was lost.
const requireUserContext = vi.fn();
const createServer = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer() }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

// A write client whose insert/update/delete terminal awaits resolve to the
// configured result. update()/delete() return a chain awaitable after .eq().eq(),
// and now after .select() too.
//
// `data` is no longer hardcoded null. Once a write asks for `.select()`,
// PostgREST returns the affected rows, so "succeeded and returned nothing" is a
// shape the real client cannot produce for a write that matched something — and
// a fake that produces it makes every confirmed write look like a no-op. The
// same class of fake-vs-reality gap as C1-S9-26, found the same way: a fix went
// in and the fake, not the code, was what broke. Pass `rows: []` to model the
// case the confirmation exists for — a write that matched nothing. C1-S9-46.
function writeClient(result: { error: unknown; rows?: unknown[] }) {
  const rows = result.error ? null : (result.rows ?? [{ id: 'row-1' }]);
  const settle = (onF: (v: { data: unknown; error: unknown }) => unknown) =>
    Promise.resolve({ data: rows, error: result.error }).then(onF);
  const eqChain: Record<string, unknown> = {
    eq: () => eqChain,
    select: () => eqChain,
    then: settle,
  };
  return {
    from: () => ({
      insert: () => Promise.resolve({ data: rows, error: result.error }),
      update: () => eqChain,
      delete: () => eqChain,
    }),
  };
}

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
      const { saveVehicleAction } = await import('@/app/(app)/dashboard/auto/actions');
      await expect(saveVehicleAction(fd({ nickname: 'Van' }))).rejects.toThrow();
    });
    it('saveVehicleAction resolves on success', async () => {
      createServer.mockResolvedValue(writeClient({ error: null }));
      const { saveVehicleAction } = await import('@/app/(app)/dashboard/auto/actions');
      await expect(saveVehicleAction(fd({ nickname: 'Van' }))).resolves.toBeUndefined();
    });
    it('saveVehicleAction throws when the update matched no rows (C1-S9-46)', async () => {
      // The case the confirmation exists for, driven through the fake rather
      // than asserted against the source: no error, and nothing changed. Before
      // C1-S9-46 this resolved, and the form told the family their vehicle was
      // saved. An id is passed so this takes the UPDATE branch — the insert
      // branch cannot match zero rows and is deliberately not gated.
      createServer.mockResolvedValue(writeClient({ error: null, rows: [] }));
      const { saveVehicleAction } = await import('@/app/(app)/dashboard/auto/actions');
      await expect(saveVehicleAction(fd({ id: 'v-1', nickname: 'Van' }))).rejects.toThrow();
    });
    it('saveVehicleAction still resolves for an INSERT that returns no rows', async () => {
      // No id, so this inserts. An insert either inserts or errors, so gating it
      // on returned rows would invent a failure the database cannot produce.
      createServer.mockResolvedValue(writeClient({ error: null, rows: [] }));
      const { saveVehicleAction } = await import('@/app/(app)/dashboard/auto/actions');
      await expect(saveVehicleAction(fd({ nickname: 'Van' }))).resolves.toBeUndefined();
    });
    it('deleteVehicleAction throws when the soft-delete matched no rows (C1-S9-46)', async () => {
      createServer.mockResolvedValue(writeClient({ error: null, rows: [] }));
      const { deleteVehicleAction } = await import('@/app/(app)/dashboard/auto/actions');
      await expect(deleteVehicleAction('v-1')).rejects.toThrow();
    });
    it('deleteVehicleAction throws when the soft-delete fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'permission denied' } }));
      const { deleteVehicleAction } = await import('@/app/(app)/dashboard/auto/actions');
      await expect(deleteVehicleAction('v-1')).rejects.toThrow();
    });
  });

  describe('paperwork', () => {
    it('addPaperworkAction throws when the insert fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'insert failed' } }));
      const { addPaperworkAction } = await import('@/app/(app)/dashboard/paperwork/actions');
      await expect(addPaperworkAction(fd({ text: 'Field trip permission slip due Friday' }))).rejects.toThrow();
    });
    it('setPaperworkStatusAction throws when the status update fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'update failed' } }));
      const { setPaperworkStatusAction } = await import('@/app/(app)/dashboard/paperwork/actions');
      await expect(setPaperworkStatusAction({ itemId: 'i-1', status: 'done' })).rejects.toThrow();
    });
  });

  describe('contacts', () => {
    it('logInteractionAction throws when the insert fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'insert failed' } }));
      const { logInteractionAction } = await import('@/app/(app)/dashboard/contacts/[id]/actions');
      await expect(logInteractionAction(fd({ contact_id: 'c-1', title: 'Coffee' }))).rejects.toThrow();
    });
    it('deleteInteractionAction throws when the delete fails', async () => {
      createServer.mockResolvedValue(writeClient({ error: { message: 'delete failed' } }));
      const { deleteInteractionAction } = await import('@/app/(app)/dashboard/contacts/[id]/actions');
      await expect(deleteInteractionAction({ id: 'x-1', contactId: 'c-1' })).rejects.toThrow();
    });
  });
});
