import { createClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Database } from '@/lib/database.types';
import { drainGuardianSmsReceipts } from '@/lib/guardian/sms-recovery';

const seam = vi.hoisted(() => ({ resume: vi.fn() }));
vi.mock('@/lib/guardian/sms-processing', () => ({ resumeGuardianSms: seam.resume }));
const KEY = 'guardian.sms_intake:recovery_cursor:v1';
const NOW = '2026-09-12T20:00:00.000Z';
const ID = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
type Row = Record<string, unknown>;
type Candidate = { id: string; created_at: string; tool_name: string; outputs: { phase: string } };
const row = (n: number, phase = 'captured', at = NOW): Candidate => ({ id: ID(n), created_at: at, tool_name: 'guardian.sms_intake', outputs: { phase } });
const copy = <T>(value: T): T => structuredClone(value);

function matchesFilter(expression: string, candidate: Candidate): boolean {
  const parts = (value: string) => {
    const result: string[] = []; let depth = 0, start = 0;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === '(') depth += 1;
      else if (value[i] === ')') depth -= 1;
      else if (value[i] === ',' && depth === 0) { result.push(value.slice(start, i)); start = i + 1; }
    }
    result.push(value.slice(start)); return result;
  };
  if (expression.startsWith('(')) return parts(expression.slice(1, -1)).some(part => matchesFilter(part, candidate));
  if (expression.startsWith('and(')) return parts(expression.slice(4, -1)).every(part => matchesFilter(part, candidate));
  if (expression.startsWith('or(')) return parts(expression.slice(3, -1)).some(part => matchesFilter(part, candidate));
  const match = /^(created_at|id)\.(eq|gt|lt|lte)\.(.+)$/.exec(expression);
  if (!match) throw new Error('Unexpected tuple comparison');
  const actual = match[1] === 'id' ? candidate.id : Date.parse(candidate.created_at);
  const expected = match[1] === 'id' ? match[3] : Date.parse(match[3]);
  return match[2] === 'eq' ? actual === expected : match[2] === 'gt' ? actual > expected : match[2] === 'lt' ? actual < expected : actual <= expected;
}

function fixture(initial: Candidate[] = []) {
  const state = {
    candidates: copy(initial), cursor: null as Row | null, calls: [] as { table: string; method: string; url: URL; body: Row | null }[],
    failure: null as 'cursor-read' | 'cursor-write' | 'queue' | null,
    lostWrite: false, invalidCount: false, held: null as 'cursor-read' | 'cursor-write' | 'queue' | null,
    release: undefined as (() => void) | undefined,
    beforePatch: undefined as (() => void) | undefined,
    overrideQueue: undefined as unknown,
  };
  const client = createClient<Database>('https://sms-recovery-fixture.invalid', 'synthetic-service-key', {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: async (raw, init = {}) => {
      const url = new URL(String(raw)), table = url.pathname.split('/').at(-1)!, method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as Row : null;
      state.calls.push({ table, method, url, body });
      const kind = table === 'ai_tool_calls' ? 'queue' : method === 'GET' ? 'cursor-read' : 'cursor-write';
      const execute = () => {
        if (state.failure === kind) return Response.json({ code: 'PGRST000', message: 'Synthetic outage' }, { status: 503 });
        if (table === 'app_settings') {
          if (method === 'GET') {
            const found = state.cursor ? [{ key: KEY, value: copy(state.cursor) }] : [];
            return Response.json(found, { headers: { 'content-range': `0-${Math.max(0, found.length - 1)}/${state.invalidCount ? 3 : found.length}` } });
          }
          if (method === 'POST') {
            if (state.cursor) return Response.json({ code: '23505' }, { status: 409 });
            state.cursor = copy(body?.value as Row);
          } else if (method === 'PATCH') {
            state.beforePatch?.();
            const filter = JSON.parse(url.searchParams.get('value')!.slice(3)) as Row;
            if (state.cursor && state.cursor.revision === filter.revision && state.cursor.version === filter.version) state.cursor = copy(body?.value as Row);
          } else throw new Error('Unexpected cursor operation');
          if (state.lostWrite) throw new Error('Synthetic response lost after commit');
          return Response.json([{ key: KEY }]);
        }
        if (table !== 'ai_tool_calls' || method !== 'GET') throw new Error('Unexpected recovery database operation');
        expect(url.searchParams.get('tool_name')).toBe('eq.guardian.sms_intake');
        expect(url.searchParams.get('outputs->>phase')).toBe('in.(captured,decided)');
        const order = url.searchParams.get('order');
        expect(['created_at.asc,id.asc', 'created_at.desc,id.desc']).toContain(order);
        expect(url.searchParams.get('limit')).toBe('1');
        expect(url.searchParams.getAll('or').length).toBeLessThanOrEqual(1);
        let candidates = state.candidates.filter(candidate => candidate.tool_name === 'guardian.sms_intake' && ['captured', 'decided'].includes(candidate.outputs.phase));
        const filter = url.searchParams.get('or');
        if (filter) candidates = candidates.filter(candidate => matchesFilter(filter, candidate));
        candidates.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id));
        if (order === 'created_at.desc,id.desc') candidates.reverse();
        return Response.json(state.overrideQueue === undefined ? candidates.slice(0, 1).map(({ id, created_at }) => ({ id, created_at })) : state.overrideQueue);
      };
      if (state.held === kind) return new Promise<Response>((resolve, reject) => {
        state.release = () => { try { resolve(execute()); } catch (error) { reject(error); } };
      });
      return execute();
    } },
  });
  return { client, state };
}
beforeEach(() => { seam.resume.mockReset(); seam.resume.mockResolvedValue('completed'); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Guardian SMS recovery traversal through the installed PostgREST client', () => {
  it('initializes an empty queue and never reads member-writable communications', async () => {
    const { client, state } = fixture();
    expect(await drainGuardianSmsReceipts(client)).toEqual({ examined: 0, completed: 0, busy: 0, unavailable: 0 });
    expect(state.cursor).toMatchObject({ version: 2, position: null, horizon: null });
    expect(state.calls.every(call => ['app_settings', 'ai_tool_calls'].includes(call.table))).toBe(true);
    expect(seam.resume).not.toHaveBeenCalled();
  });
  it('advances before processing and recovers captured and decided receipts only', async () => {
    const { client, state } = fixture([row(1), row(2, 'decided'), row(3, 'completed'), { ...row(4), tool_name: 'another.tool' }]);
    seam.resume.mockImplementation(async (_client, id) => {
      expect(state.cursor?.position).toEqual({ id, createdAt: NOW });
      return 'completed';
    });
    expect(await drainGuardianSmsReceipts(client, { limit: 2 })).toEqual({ examined: 2, completed: 2, busy: 0, unavailable: 0 });
    expect(seam.resume.mock.calls.map(call => call[1])).toEqual([ID(1), ID(2)]);
  });
  it('makes progress past malformed, busy and failing receipts over limit-one ticks and wraps', async () => {
    const { client } = fixture([row(1), row(2, 'decided'), row(3), row(4)]);
    seam.resume.mockImplementation(async (_client, id) => id === ID(1) ? 'unavailable' : id === ID(2) ? 'busy' : id === ID(3) ? Promise.reject(new Error('Synthetic poison')) : 'completed');
    for (let n = 0; n < 5; n += 1) await drainGuardianSmsReceipts(client, { limit: 1 });
    expect(seam.resume.mock.calls.map(call => call[1])).toEqual([ID(1), ID(2), ID(3), ID(4), ID(1)]);
  });
  it('retries an older temporarily busy receipt while a full batch of newer arrivals appears every tick', async () => {
    const { client, state } = fixture();
    let blockedOnce = true;
    seam.resume.mockImplementation(async (_client, id) => {
      if (id === ID(1) && blockedOnce) { blockedOnce = false; return 'busy'; }
      state.candidates.find(candidate => candidate.id === id)!.outputs.phase = 'completed';
      return 'completed';
    });
    for (let tick = 0; tick < 6; tick += 1) {
      for (let n = 1; n <= 8; n += 1) state.candidates.push(row(tick * 8 + n));
      await drainGuardianSmsReceipts(client);
      if (tick === 1) expect(state.candidates[0].outputs.phase).toBe('completed');
    }
    expect(seam.resume.mock.calls.filter(call => call[1] === ID(1))).toHaveLength(2);
  });
  it('keeps the saved sweep horizon across ticks and wraps before admitting later timestamps', async () => {
    const { client, state } = fixture([row(1), row(2)]);
    seam.resume.mockImplementation(async (_client, id) => {
      if (id !== ID(1)) state.candidates.find(candidate => candidate.id === id)!.outputs.phase = 'completed';
      return id === ID(1) ? 'busy' : 'completed';
    });
    await drainGuardianSmsReceipts(client, { limit: 1 });
    const savedHorizon = copy(state.cursor?.horizon);
    state.candidates.push(row(3, 'captured', '2026-09-12T20:01:00.000Z'));
    await drainGuardianSmsReceipts(client, { limit: 1 });
    expect(state.cursor?.horizon).toEqual(savedHorizon);
    expect(savedHorizon).toEqual({ id: ID(2), createdAt: NOW });
    await drainGuardianSmsReceipts(client, { limit: 1 });
    expect(seam.resume.mock.calls.map(call => call[1])).toEqual([ID(1), ID(2), ID(1)]);
    expect(state.cursor?.horizon).toEqual({ id: ID(3), createdAt: '2026-09-12T20:01:00.000Z' });
  });
  it('upgrades a legacy cursor through its observed revision before revisiting older receipts', async () => {
    const { client, state } = fixture([row(1), row(9)]);
    state.cursor = { version: 1, revision: ID(90), position: { id: ID(8), createdAt: NOW } };
    await drainGuardianSmsReceipts(client, { limit: 1 });
    expect(seam.resume.mock.calls.map(call => call[1])).toEqual([ID(1)]);
    expect(state.cursor).toMatchObject({ version: 2, position: { id: ID(1), createdAt: NOW }, horizon: { id: ID(9), createdAt: NOW } });
    const upgrade = state.calls.find(call => call.method === 'PATCH');
    expect(upgrade?.url.searchParams.get('value')).toBe(`cs.${JSON.stringify({ version: 1, revision: ID(90) })}`);
    expect(upgrade?.body?.value).toMatchObject({ version: 2, position: null, horizon: null });
  });
  it('orders timestamps before UUIDs and visits each candidate at most once per tick', async () => {
    const { client } = fixture([row(1, 'captured', '2026-09-12T20:01:00.000Z'), row(9)]);
    expect((await drainGuardianSmsReceipts(client, { limit: 20 })).examined).toBe(2);
    expect(seam.resume.mock.calls.map(call => call[1])).toEqual([ID(9), ID(1)]);
  });
  it('reconciles lost cursor responses without repeating an attempt', async () => {
    const { client, state } = fixture([row(1)]);
    state.lostWrite = true;
    expect((await drainGuardianSmsReceipts(client, { limit: 1 })).completed).toBe(1);
    expect(seam.resume).toHaveBeenCalledTimes(1);
  });
  it('does not process a candidate when another worker wins the cursor revision', async () => {
    const { client, state } = fixture([row(1)]);
    state.beforePatch = () => { state.cursor = { version: 1, revision: ID(90), position: { id: ID(1), createdAt: NOW } }; };
    expect(await drainGuardianSmsReceipts(client, { limit: 1 })).toEqual({ examined: 0, completed: 0, busy: 1, unavailable: 0 });
    expect(seam.resume).not.toHaveBeenCalled();
  });
  it.each(['cursor-read', 'cursor-write', 'queue'] as const)('fails honestly on %s storage failure', async failure => {
    const { client, state } = fixture([row(1)]);
    state.failure = failure;
    await expect(drainGuardianSmsReceipts(client)).rejects.toThrow();
    expect(seam.resume).not.toHaveBeenCalled();
  });
  it('does not report a failed cursor update as ordinary contention', async () => {
    const { client, state } = fixture([row(1)]);
    state.cursor = { version: 1, revision: ID(90), position: null };
    state.failure = 'cursor-write';
    await expect(drainGuardianSmsReceipts(client)).rejects.toThrow();
    expect(seam.resume).not.toHaveBeenCalled();
  });
  it.each([
    { version: 1, revision: ID(90), position: { id: 'bad', createdAt: NOW } },
    { version: 1, revision: ID(90), position: { id: ID(1), createdAt: 'bad,date' } },
    { version: 2, revision: ID(90), position: null },
    { version: 1, revision: ID(90), position: null, extra: true },
  ])('rejects malformed stored cursor %# without mutation', async cursor => {
    const { client, state } = fixture([row(1)]);
    state.cursor = cursor;
    await expect(drainGuardianSmsReceipts(client)).rejects.toThrow();
    expect(state.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('rejects unverified cursor counts', async () => {
    const { client, state } = fixture([row(1)]);
    state.invalidCount = true;
    await expect(drainGuardianSmsReceipts(client)).rejects.toThrow();
    expect(seam.resume).not.toHaveBeenCalled();
  });
  it.each([null, {}, [{ id: 'bad', created_at: NOW }], [{ id: ID(1), created_at: NOW }, { id: ID(2), created_at: NOW }]])('rejects malformed queue responses %#', async value => {
    const { client, state } = fixture([row(1)]);
    state.overrideQueue = value;
    await expect(drainGuardianSmsReceipts(client)).rejects.toThrow();
    expect(seam.resume).not.toHaveBeenCalled();
  });
  it.each([0, -1, 1.5, NaN])('rejects invalid work limit %s', async limit => {
    const { client, state } = fixture();
    await expect(drainGuardianSmsReceipts(client, { limit })).rejects.toThrow();
    expect(state.calls).toHaveLength(0);
  });
  it('does no database work when already cancelled', async () => {
    const { client, state } = fixture([row(1)]), controller = new AbortController();
    controller.abort();
    await expect(drainGuardianSmsReceipts(client, { signal: controller.signal })).rejects.toThrow();
    expect(state.calls).toHaveLength(0);
  });
  it.each(['cursor-read', 'cursor-write', 'queue'] as const)('bounds ignored cancellation during %s and does not resume after late return', async held => {
    vi.useFakeTimers();
    const { client, state } = fixture([row(1)]);
    state.held = held;
    const pending = drainGuardianSmsReceipts(client);
    const rejected = expect(pending).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(10_001);
    await rejected;
    const before = state.calls.length;
    state.release?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toHaveLength(before);
    expect(seam.resume).not.toHaveBeenCalled();
  });
  it('bounds a hung attempt and advances to the next receipt without restarting the held work', async () => {
    vi.useFakeTimers();
    const { client, state } = fixture([row(1), row(2)]);
    let release: (() => void) | undefined;
    seam.resume.mockImplementationOnce((_client, _id, options) => new Promise(resolve => {
      release = () => { expect(options.signal.aborted).toBe(true); resolve('completed'); };
    })).mockResolvedValue('completed');
    const pending = drainGuardianSmsReceipts(client, { limit: 2 });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await pending).toEqual({ examined: 2, completed: 1, busy: 0, unavailable: 1 });
    const before = state.calls.length;
    release?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(state.calls).toHaveLength(before);
    expect(seam.resume.mock.calls.map(call => call[1])).toEqual([ID(1), ID(2)]);
  });
});
