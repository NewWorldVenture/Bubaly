import { beforeEach, describe, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ rpc: vi.fn(), createClient: vi.fn() }));
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ unstable_cache: (read: unknown) => read }));
vi.mock('@supabase/supabase-js', () => ({ createClient: boundary.createClient }));

import { EMPTY_PUBLIC_STATS, getPublicStats } from '@/lib/marketing/stats';

const accounts = { families: 40, members: 100, tasks_completed: 150 };
const handled = { runs_completed: 80, runs_completed_30d: 30, families_with_runs: 20 };
const expectedAccounts = { families: 40, members: 100, tasksCompleted: 150 };
const expectedHandled = { handledCompleted: 80, handled30d: 30, familiesWithRuns: 20 };
const noHandled = { handledCompleted: 0, handled30d: 0, familiesWithRuns: 0 };

function results(handledData: unknown, accountData: unknown = [accounts]) {
  boundary.rpc.mockImplementation(async (name: string) => ({
    data: name === 'public_stats' ? accountData : handledData, error: null,
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  boundary.createClient.mockReturnValue({ rpc: boundary.rpc });
  results([handled]);
});

describe('public aggregate reader', () => {
  it('reads only anonymous aggregate RPCs and preserves both independent groups', async () => {
    expect(await getPublicStats()).toEqual({ ...expectedAccounts, ...expectedHandled });
    expect(boundary.rpc.mock.calls.map(([name]) => name).sort()).toEqual(['public_handled_stats', 'public_stats']);
    expect(boundary.createClient.mock.calls[0][2]).toEqual({ auth: { persistSession: false } });
  });

  it('accepts exact decimal-string bigint values without changing the count', async () => {
    results([{ runs_completed: '80', runs_completed_30d: '30', families_with_runs: '20' }]);
    expect(await getPublicStats()).toEqual({ ...expectedAccounts, ...expectedHandled });
  });

  it('accepts a single object response and actual zero counts', async () => {
    results({ runs_completed: 0, runs_completed_30d: '0', families_with_runs: 0 });
    expect(await getPublicStats()).toEqual({ ...expectedAccounts, ...noHandled });
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each([null, undefined, [], [handled, handled], '80', [null], [80], [[handled]]])(
    'hides a malformed or ambiguous aggregate row: %j', async (data) => {
      results(data);
      expect(await getPublicStats()).toEqual({ ...expectedAccounts, ...noHandled });
      expect(console.error).toHaveBeenCalledTimes(1);
    },
  );

  describe.each(['runs_completed', 'runs_completed_30d', 'families_with_runs'])('%s validation', (key) => {
    it.each([null, undefined, true, false, '', ' ', '25.5', '+25', '1e3', '0x20', -1, 25.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '9007199254740993', {}, []])(
      'never publishes malformed evidence: %j', async (value) => {
        results([{ ...handled, [key]: value }]);
        expect(await getPublicStats()).toEqual({ ...expectedAccounts, ...noHandled });
        expect(console.error).toHaveBeenCalledTimes(1);
      },
    );
  });

  it.each([
    { ...handled, runs_completed_30d: 81 },
    { ...handled, families_with_runs: 81 },
    { runs_completed: 0, runs_completed_30d: 1, families_with_runs: 0 },
  ])('rejects contradictory cohort sizes: %j', async (data) => {
    results([data]);
    expect(await getPublicStats()).toEqual({ ...expectedAccounts, ...noHandled });
  });

  it('does not replace missing fields with a plausible zero', async () => {
    results([{ runs_completed: 80 }]);
    expect(await getPublicStats()).toEqual({ ...expectedAccounts, ...noHandled });
  });

  it.each(['error', 'throw'])('preserves account counts when handled RPC fails through %s', async (mode) => {
    boundary.rpc.mockImplementation(async (name: string) => {
      if (name === 'public_stats') return { data: [accounts], error: null };
      if (mode === 'throw') throw new Error('unavailable');
      return { data: [handled], error: { message: 'unavailable' } };
    });
    expect(await getPublicStats()).toEqual({ ...expectedAccounts, ...noHandled });
  });

  it('preserves handled counts when account evidence is malformed', async () => {
    results([handled], [{ ...accounts, families: 42.5 }]);
    expect(await getPublicStats()).toEqual({ families: 0, members: 0, tasksCompleted: 0, ...expectedHandled });
  });

  it('fails closed before any RPC if the anonymous client cannot be configured', async () => {
    boundary.createClient.mockImplementation(() => { throw new Error('unavailable'); });
    expect(await getPublicStats()).toEqual(EMPTY_PUBLIC_STATS);
    expect(boundary.rpc).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
