import { beforeEach, describe, expect, it, vi } from 'vitest';
import { recordSyncFailure } from '@/lib/sync/audit';

/**
 * Audit C1-S9-68 — a failed sync is recorded, or it is reported that it was not.
 *
 * Both sync engines marked the run, the job and the connection failed with
 * three writes whose results were discarded. A connection-health write that did
 * nothing left the sync page showing a failing integration as healthy.
 */
type Reply = { data: unknown; error: unknown };
function client(replyFor: (table: string) => Reply) {
  const writes: string[] = [];
  const from = (table: string) => {
    const chain = {
      update: () => chain,
      eq: () => chain,
      select: async () => { writes.push(table); return replyFor(table); },
    };
    return chain;
  };
  return { db: { from } as never, writes };
}
const params = { runId: 'run-1', jobId: 'job-1', accountId: 'acct-1', message: 'token expired', startedAt: Date.now() - 1000 };

beforeEach(() => { vi.restoreAllMocks(); });

describe('recordSyncFailure (C1-S9-68)', () => {
  it('writes the run, the job and the connection, and says nothing when all three land', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, writes } = client(() => ({ data: [{ id: 'x' }], error: null }));
    await recordSyncFailure(db, params);
    expect(writes).toEqual(['sync_job_runs', 'sync_jobs', 'sync_connections']);
    expect(err).not.toHaveBeenCalled();
  });

  it('reports a health write that matched nothing — the one that made a broken sync look healthy', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = client((t) => (t === 'sync_connections' ? { data: [], error: null } : { data: [{ id: 'x' }], error: null }));
    await recordSyncFailure(db, params);
    expect(err).toHaveBeenCalledWith('[sync] could not record the failure on the connection health', expect.objectContaining({ error: 'no rows updated' }));
  });

  it('reports an error on any of the three, and never throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db } = client(() => ({ data: null, error: { code: '08006', message: 'connection failure' } }));
    await expect(recordSyncFailure(db, params)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(3);
  });

  it('skips the run and job when there were none', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { db, writes } = client(() => ({ data: [{ id: 'x' }], error: null }));
    await recordSyncFailure(db, { ...params, runId: null, jobId: null });
    expect(writes).toEqual(['sync_connections']);
  });
});

describe('recordSyncFailure never throws into the engine (C1-S9-68)', () => {
  it('a rejected request is reported, not propagated', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const chain = { update: () => chain, eq: () => chain, select: async () => { throw new Error('fetch failed'); } };
    await expect(recordSyncFailure({ from: () => chain } as never, params)).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledWith('[sync] could not record the failure', expect.anything());
  });
});
