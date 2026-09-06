// The routine worker (§19): fires a due routine exactly once, and files a
// REQUEST rather than executing anything.
//
// The two failures this guards against are the ones a family would actually
// notice: being told the same thing twice (so the occurrence is reserved
// before anything is filed), and a paused Bubaly still doing work on a
// schedule set up before it was paused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createRequest: vi.fn(),
  createRun: vi.fn(),
  kickRun: vi.fn(),
  getAISettings: vi.fn(),
  nextRelativeFire: vi.fn(),
}));

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  rules: [] as Row[],
  families: [] as Row[],
  routineRuns: [] as Row[],
  updates: [] as { table: string; patch: Row; filters: Row }[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    const from = (table: string) => {
      const filters: Row = {};
      let payload: Row | null = null;
      let kind: 'select' | 'insert' | 'update' = 'select';
      const rowsFor = () => {
        const source = table === 'family_automation_rules' ? state.rules : table === 'families' ? state.families : state.routineRuns;
        return source.filter((r) => Object.entries(filters).every(([c, v]) => {
          if (c.startsWith('lte:')) return String(r[c.slice(4)] ?? '') <= String(v);
          if (c.startsWith('not:')) return r[c.slice(4)] !== null && r[c.slice(4)] !== undefined;
          if (c.startsWith('is:')) return (r[c.slice(3)] ?? null) === v;
          return r[c] === v;
        }));
      };
      const result = () => {
        if (kind === 'insert' && table === 'routine_runs') {
          const row = payload as Row;
          const clash = state.routineRuns.some((r) => r.rule_id === row.rule_id && r.due_at === row.due_at);
          if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          state.routineRuns.push({ ...row });
          return { data: row, error: null };
        }
        if (kind === 'update') {
          state.updates.push({ table, patch: payload as Row, filters: { ...filters } });
          for (const row of rowsFor()) Object.assign(row, payload);
          return { data: rowsFor(), error: null };
        }
        return { data: rowsFor(), error: null };
      };
      const b: Row = {};
      Object.assign(b, {
        select: () => b, order: () => b, limit: () => b,
        eq: (c: string, v: unknown) => { filters[c] = v; return b; },
        lte: (c: string, v: unknown) => { filters[`lte:${c}`] = v; return b; },
        not: (c: string) => { filters[`not:${c}`] = true; return b; },
        is: (c: string, v: unknown) => { filters[`is:${c}`] = v; return b; },
        insert: (p: Row) => { kind = 'insert'; payload = p; return b; },
        update: (p: Row) => { kind = 'update'; payload = p; return b; },
        single: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        maybeSingle: async () => { const r = result(); return { data: Array.isArray(r.data) ? r.data[0] ?? null : r.data, error: r.error }; },
        then: (resolve: (v: unknown) => void) => resolve(result()),
      });
      return b;
    };
    return { from };
  },
}));

vi.mock('@/lib/server/cron-auth', () => ({ hasCronAuthorization: (req: Request) => req.headers.get('authorization') === 'Bearer test-secret' }));
vi.mock('@/lib/services/ai-settings', () => ({ getAISettings: mocks.getAISettings }));
vi.mock('@/lib/ai/runs/store', () => ({ createRequest: mocks.createRequest, createRun: mocks.createRun }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: mocks.kickRun }));
vi.mock('@/lib/services/routines', async () => {
  const actual = await vi.importActual<typeof import('@/lib/services/routines')>('@/lib/services/routines');
  return { ...actual, nextRelativeFire: mocks.nextRelativeFire };
});

const { GET } = await import('@/app/api/cron/family-routines/route');

const req = (auth = 'Bearer test-secret') => new Request('https://bubaly.test/api/cron/family-routines', { headers: { authorization: auth } });

const RULE = {
  id: 'rule-1', family_id: 'fam-1', name: 'Plan our meals', action_config: { prompt: 'Plan our meals for next week' },
  schedule_kind: 'cron', schedule_expr: '0 17 * * 0', anchor_key: null, offset_days: null, at_hour: null,
  next_run_at: '2026-09-05T12:00:00.000Z', said: 'every Sunday at 5pm', is_enabled: true,
};

// The rule below fires on `0 17 * * 0` in America/New_York — Sunday 17:00 NY,
// which is 21:00 UTC — and the reschedule assertions name that exact instant on
// Sunday 2026-09-06. That is only "the next occurrence" while now is BEFORE it,
// so with a live clock these tests passed until 21:00 UTC on 2026-09-06 and
// have failed every run since: the worker correctly rolled forward a week and
// the hard-coded date did not. Pin the clock to the Saturday instead, just
// after the fixture's own next_run_at, so the expectations describe the
// scheduler's behaviour rather than the day the suite happens to run.
//
// Only Date is faked. Faking timers wholesale would stall the awaits in the
// worker under test.
const NOW = new Date('2026-09-05T13:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  vi.clearAllMocks();
  state.rules = [{ ...RULE }];
  state.families = [{ id: 'fam-1', timezone: 'America/New_York' }];
  state.routineRuns = [];
  state.updates = [];
  mocks.getAISettings.mockResolvedValue({ familyId: 'fam-1', enabled: true, behavior: 'execute', categoryBehavior: {}, riskOverrides: {}, childChannels: {}, memoryEnabled: true, quietHours: null });
  mocks.createRequest.mockResolvedValue({ ok: true, data: { id: 'req-1' } });
  mocks.createRun.mockResolvedValue({ ok: true, data: { id: 'run-1' } });
});

describe('the routine worker', () => {
  it('refuses an unauthorized caller', async () => {
    const res = await GET(req('Bearer wrong') as never);
    expect(res.status).toBe(401);
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it('files a request — it never executes the routine itself', async () => {
    const res = await GET(req() as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, filed: 1, skipped: 0 });

    // A request through the ordinary intake, of kind 'routine', with the
    // family's own words — so the planner and the trust gate still apply.
    expect(mocks.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: 'fam-1', role: 'system', actorKind: 'system' }),
      expect.objectContaining({ requestText: 'Plan our meals for next week', kind: 'routine' }),
      expect.anything(),
    );
    expect(mocks.kickRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ budgetMs: expect.any(Number) }));
  });

  it('reserves the occurrence before filing, so a second worker does nothing', async () => {
    await GET(req() as never);
    expect(state.routineRuns).toHaveLength(1);
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);

    // The same occurrence, a second worker: the unique index refuses it.
    state.rules = [{ ...RULE }];
    await GET(req() as never);
    expect(state.routineRuns).toHaveLength(1);
    expect(mocks.createRequest).toHaveBeenCalledTimes(1);
  });

  it('schedules the next occurrence from the family’s zone', async () => {
    await GET(req() as never);
    const reschedule = state.updates.find((u) => u.table === 'family_automation_rules' && u.patch.next_run_at);
    // Sunday 5pm New York, the next one after the tick.
    expect(reschedule?.patch.next_run_at).toBe('2026-09-06T21:00:00.000Z');
    expect(reschedule?.patch.last_run_at).toBeTruthy();
  });

  it('does nothing for a family that switched Bubaly off, and waits rather than forgetting', async () => {
    mocks.getAISettings.mockResolvedValue({ familyId: 'fam-1', enabled: false, behavior: 'execute', categoryBehavior: {}, riskOverrides: {}, childChannels: {}, memoryEnabled: true, quietHours: null });
    const res = await GET(req() as never);
    expect(await res.json()).toMatchObject({ filed: 0, skipped: 1 });
    expect(mocks.createRequest).not.toHaveBeenCalled();
    expect(state.routineRuns[0]).toMatchObject({ status: 'skipped' });
    // A pause is not a deletion. The rule steps past this occurrence so the
    // worker stops re-reading it every minute — and is still armed, so it
    // simply resumes when the family switches Bubaly back on. Nulling it (what
    // this used to do) silently lost every routine a family owned.
    expect(state.rules[0].next_run_at).toBe('2026-09-06T21:00:00.000Z');
  });

  it('records a failure instead of losing it silently', async () => {
    mocks.createRequest.mockResolvedValue({ ok: false, error: 'Bubaly could not record that request.', code: 'db' });
    const res = await GET(req() as never);
    expect(await res.json()).toMatchObject({ ok: false, filed: 0, problems: 1 });
    expect(state.updates.some((u) => u.table === 'routine_runs' && u.patch.status === 'failed')).toBe(true);
  });

  it('asks the anchor where a relative routine fires next, not the clock', async () => {
    state.rules = [{
      ...RULE, id: 'rule-2', schedule_kind: 'relative', schedule_expr: null,
      anchor_key: 'trip', offset_days: -2, at_hour: 9, said: 'two days before every trip',
    }];
    mocks.nextRelativeFire.mockResolvedValue(new Date('2026-10-22T13:00:00.000Z'));

    await GET(req() as never);
    expect(mocks.nextRelativeFire).toHaveBeenCalled();
    const reschedule = state.updates.find((u) => u.table === 'family_automation_rules' && u.patch.next_run_at);
    expect(reschedule?.patch.next_run_at).toBe('2026-10-22T13:00:00.000Z');
  });
});

// ─── Routines that could never fire ────────────────────────────────────────

describe('arming', () => {
  const RELATIVE = {
    id: 'rule-2', family_id: 'fam-1', name: 'Trip prep', action_config: { prompt: 'Make sure we are ready' },
    schedule_kind: 'relative', schedule_expr: null, anchor_key: 'trip', offset_days: -2, at_hour: 9,
    next_run_at: null, said: 'two days before every trip', is_enabled: true,
  };

  it('gives a routine with no next fire one, so a relative routine can fire at all', async () => {
    // The worker's only query is `.lte('next_run_at', now)`, which null never
    // matches. A relative routine stored unarmed — no trip on file yet, or a
    // pause that cleared it — was unreachable by construction.
    state.rules = [{ ...RELATIVE }];
    mocks.nextRelativeFire.mockResolvedValue(new Date('2026-09-18T13:00:00.000Z'));

    const res = await GET(req() as never);

    expect(await res.json()).toMatchObject({ armed: 1 });
    expect(state.rules[0].next_run_at).toBe('2026-09-18T13:00:00.000Z');
  });

  it('leaves a routine alone when its anchor still has nothing upcoming', async () => {
    state.rules = [{ ...RELATIVE }];
    mocks.nextRelativeFire.mockResolvedValue(null);

    const res = await GET(req() as never);

    expect(await res.json()).toMatchObject({ armed: 0 });
    expect(state.rules[0].next_run_at).toBeNull();
  });

  it('does not arm a routine the family switched off', async () => {
    state.rules = [{ ...RELATIVE, is_enabled: false }];
    mocks.nextRelativeFire.mockResolvedValue(new Date('2026-09-18T13:00:00.000Z'));

    const res = await GET(req() as never);

    expect(await res.json()).toMatchObject({ armed: 0 });
    expect(state.rules[0].next_run_at).toBeNull();
  });
});

describe('a reservation nobody came back for', () => {
  it('steps a wedged routine past an abandoned occurrence', async () => {
    // A worker that died between reserving the occurrence and rescheduling
    // leaves the reservation behind. The rule then collides on the same
    // `due_at` every tick and never advances — silently dead forever.
    state.routineRuns = [{
      family_id: 'fam-1', rule_id: 'rule-1', due_at: RULE.next_run_at, status: 'filed',
      request_id: null, created_at: '2026-01-01T00:00:00.000Z',
    }];

    const res = await GET(req() as never);

    expect(await res.json()).toMatchObject({ filed: 0, skipped: 1 });
    expect(state.routineRuns[0]).toMatchObject({ status: 'failed' });
    expect(state.rules[0].next_run_at).toBe('2026-09-06T21:00:00.000Z');
  });

  it('leaves a live worker’s reservation alone', async () => {
    // Fresh, and mid-tick somewhere else: not ours to touch.
    state.routineRuns = [{
      family_id: 'fam-1', rule_id: 'rule-1', due_at: RULE.next_run_at, status: 'filed',
      request_id: null, created_at: new Date().toISOString(),
    }];

    const res = await GET(req() as never);

    expect(await res.json()).toMatchObject({ filed: 0, skipped: 1 });
    expect(state.routineRuns[0]).toMatchObject({ status: 'filed' });
    expect(state.rules[0].next_run_at).toBe(RULE.next_run_at);
  });

  it('leaves an occurrence that already became a request alone', async () => {
    state.routineRuns = [{
      family_id: 'fam-1', rule_id: 'rule-1', due_at: RULE.next_run_at, status: 'filed',
      request_id: 'req-1', created_at: '2026-01-01T00:00:00.000Z',
    }];

    const res = await GET(req() as never);

    expect(await res.json()).toMatchObject({ skipped: 1 });
    expect(state.routineRuns[0]).toMatchObject({ status: 'filed', request_id: 'req-1' });
    expect(state.rules[0].next_run_at).toBe(RULE.next_run_at);
  });
});
