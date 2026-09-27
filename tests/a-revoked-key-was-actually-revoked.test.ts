import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * "Assistant key revoked. It stops working immediately." must be true.
 *
 * revokeAssistantLinkAction writes through the service client, scoped by id
 * AND family so an id from elsewhere cannot revoke another household's key.
 * That scoping is right — but an id that matches nothing (another family's, or
 * one deleted in another tab) raises no error, it simply updates zero rows. The
 * action checked only `error` and then confirmed the revocation.
 *
 * Of every false "done" this audit has found, this is the one where the lie is
 * a security claim: a parent told a leaked key is dead stops worrying about it.
 */

const state = vi.hoisted(() => ({
  rows: [] as Array<{ id: string }>,
  error: null as null | { message: string },
  audits: 0,
  role: 'parent' as string,
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/supabase/auth', () => ({
  requireUserContext: async () => ({ user: { id: 'u-1' }, active: { familyId: 'f-1', role: state.role } }),
}));
vi.mock('@/lib/server/audit', () => ({ logAudit: async () => { state.audits += 1; } }));
vi.mock('@/lib/supabase/server', () => {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    update: () => chain, eq: () => chain,
    select: () => Promise.resolve({ data: state.error ? null : state.rows, error: state.error }),
  });
  return { createServiceClient: () => ({ from: () => chain }), createServer: async () => ({}) };
});

async function revoke() {
  const { revokeAssistantLinkAction } = await import('@/app/(app)/dashboard/assistants/actions');
  return revokeAssistantLinkAction('link-1');
}

describe('revoking an assistant key', () => {
  beforeEach(() => {
    vi.resetModules();
    state.rows = []; state.error = null; state.audits = 0; state.role = 'parent';
  });

  it('confirms a revocation that happened', async () => {
    state.rows = [{ id: 'link-1' }];
    const res = await revoke();
    expect(res.ok).toBe(true);
    expect(state.audits).toBe(1);
  });

  // The finding.
  it('does not claim a key is dead when nothing matched', async () => {
    state.rows = [];
    const res = await revoke();
    expect(res.ok, 'a zero-row revoke was reported as revoked').toBe(false);
    // Nothing happened, so nothing is audited as having happened.
    expect(state.audits).toBe(0);
  });

  it('still reports a real write error', async () => {
    state.error = { message: 'down' };
    expect((await revoke()).ok).toBe(false);
  });

  it('still refuses a non-manager before touching anything', async () => {
    state.role = 'teen';
    state.rows = [{ id: 'link-1' }];
    expect((await revoke()).ok).toBe(false);
    expect(state.audits).toBe(0);
  });
});
