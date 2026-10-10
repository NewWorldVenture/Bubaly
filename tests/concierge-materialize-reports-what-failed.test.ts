import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { materializeConciergePlan } from '@/lib/services/approvals';
import { at } from './helpers/source-order';

/**
 * Audit C1-S9-72. `materializeConciergePlan` returned a bare list of applied
 * kinds, so "already in place", "the ledger was unreadable" and "every insert
 * was refused" were all `[]` — and every caller read `[]` as the first. It now
 * says what failed. These cases drive the real function against a fake client.
 */
type Opts = {
  ledger?: { action_kind: string }[];
  ledgerError?: unknown;
  calendarError?: unknown;
  reminderError?: unknown; // for kind 'reminder'
  taskError?: unknown; // for kind 'task' (same table, told apart by payload)
  logError?: unknown;
};

type LedgerRow = { id: string; action_kind: string; target_id: string | null };

/**
 * A fake that enforces 0158's `unique (family_id, plan_id, action_kind)` the
 * way Postgres does: a second insert of the same kind fails with 23505. The
 * ledger state can be shared between two fakes to model two callers racing.
 */
function fakeDb(o: Opts, shared?: { ledger: LedgerRow[]; records: { table: string; id: string }[] }) {
  const state = shared ?? { ledger: (o.ledger ?? []).map((r, i) => ({ id: `seed-${i}`, action_kind: r.action_kind, target_id: 'x' })), records: [] };
  const inserts: { table: string; payload: Record<string, unknown> }[] = [];
  const deletes: string[] = [];
  let n = 0;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const db = {
    from(table: string) {
      if (table === 'concierge_plan_actions') {
        let mode: 'read' | 'insert' | 'delete' | 'update' = 'read';
        let payload: Record<string, unknown> = {};
        const filters: Record<string, unknown> = {};
        const run = async () => {
          await tick();
          if (mode === 'read') {
            return o.ledgerError ? { data: null, error: o.ledgerError } : { data: state.ledger.map((r) => ({ action_kind: r.action_kind })), error: null };
          }
          if (mode === 'insert') {
            inserts.push({ table, payload });
            if (o.logError) return { data: null, error: o.logError };
            if (state.ledger.some((r) => r.action_kind === payload.action_kind)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
            const row = { id: `ledger-${++n}-${String(payload.action_kind)}`, action_kind: String(payload.action_kind), target_id: null };
            state.ledger.push(row);
            return { data: { id: row.id }, error: null };
          }
          if (mode === 'delete') {
            deletes.push(String(filters.id));
            const hit = state.ledger.filter((r) => r.id === filters.id);
            state.ledger = state.ledger.filter((r) => r.id !== filters.id);
            return { data: hit.map((r) => ({ id: r.id })), error: null };
          }
          const row = state.ledger.find((r) => r.id === filters.id);
          if (row) row.target_id = payload.target_id as string;
          return { data: row ? [{ id: row.id }] : [], error: null };
        };
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (c: string, v: unknown) => { filters[c] = v; return chain; },
          is: () => chain,
          single: () => run(),
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => run().then(res, rej),
          insert: (p: Record<string, unknown>) => { mode = 'insert'; payload = p; return chain; },
          update: (p: Record<string, unknown>) => { mode = 'update'; payload = p; return chain; },
          delete: () => { mode = 'delete'; return chain; },
        };
        return chain;
      }
      return {
        insert(payload: Record<string, unknown>) {
          inserts.push({ table, payload });
          const error = table === 'calendar_events'
            ? o.calendarError
            : payload.kind === 'task' ? o.taskError : o.reminderError;
          const single = async () => {
            await tick();
            if (error) return { data: null, error };
            const id = `${table}-${state.records.length + 1}`;
            state.records.push({ table, id });
            return { data: { id }, error: null };
          };
          return { select: () => ({ single }) };
        },
      };
    },
  };
  return { db: db as unknown as Parameters<typeof materializeConciergePlan>[0], inserts, deletes, state };
}

const plan = { id: 'plan-1', title: 'Beach day', description: null, location: null, planned_for: '2026-10-10', budget_cents: null };
const ALL = ['calendar', 'reminder', 'task'] as const;
const run = (o: Opts) => {
  const { db, inserts, deletes, state } = fakeDb(o);
  return materializeConciergePlan(db, 'fam-1', 'user-1', plan, [...ALL]).then((r) => ({ ...r, inserts, deletes, state }));
};

describe('the concierge materializer says what did not land (C1-S9-72)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies everything and reports no failures when every write lands', async () => {
    const r = await run({});
    expect(r.applied).toEqual(['calendar', 'reminder', 'task']);
    expect(r.failed).toEqual([]);
    // Every ledger row ends up linked to the record it reserved for.
    expect(r.state.ledger.every((l) => l.target_id)).toBe(true);
  });

  it('an unreadable ledger fails every target and writes nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run({ ledgerError: { message: 'permission denied' } });
    expect(r.applied).toEqual([]);
    expect(r.failed, 'not "already in place"').toEqual(['calendar', 'reminder', 'task']);
    expect(r.inserts, 'guessing "nothing applied" is how a plan lands twice').toEqual([]);
  });

  it('a refused insert is failed, and the others still land', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run({ calendarError: { message: 'rls' } });
    expect(r.applied).toEqual(['reminder', 'task']);
    expect(r.failed).toEqual(['calendar']);
    // No ledger row survives for the kind that did not land, or a retry would skip it.
    expect(r.state.ledger.map((l) => l.action_kind)).toEqual(['reminder', 'task']);
    expect(r.deletes).toHaveLength(1);
  });

  it('every insert refused is every kind failed, not an empty success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run({ calendarError: { m: 1 }, reminderError: { m: 2 }, taskError: { m: 3 } });
    expect(r.applied).toEqual([]);
    expect(r.failed).toEqual(['calendar', 'reminder', 'task']);
    expect(r.state.ledger).toEqual([]);
  });

  it('the genuine "already in place" is still empty on both sides', async () => {
    const r = await run({ ledger: [{ action_kind: 'calendar' }, { action_kind: 'reminder' }, { action_kind: 'task' }] });
    expect(r.applied).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.inserts).toEqual([]);
  });

  it('a ledger reservation that is refused creates nothing and is reported as failed', async () => {
    // The ledger row is reserved BEFORE the record, so a refused reservation
    // means no event was created — reporting it applied would hide that.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run({ logError: { message: 'ledger insert refused' } });
    expect(r.applied).toEqual([]);
    expect(r.failed).toEqual(['calendar', 'reminder', 'task']);
    expect(r.inserts.filter((i) => i.table !== 'concierge_plan_actions')).toEqual([]);
  });

  it('two materializations racing on one plan create each record once', async () => {
    // A double-click on "Make it happen" (or that button racing `decide`): both
    // callers read an empty ledger. The unique key must decide who creates the
    // record — before, both inserted an event and the loser's ledger conflict
    // was only logged and still counted as applied.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const shared = { ledger: [] as LedgerRow[], records: [] as { table: string; id: string }[] };
    const a = fakeDb({}, shared);
    const b = fakeDb({}, shared);
    const [ra, rb] = await Promise.all([
      materializeConciergePlan(a.db, 'fam-1', 'user-1', plan, [...ALL]),
      materializeConciergePlan(b.db, 'fam-1', 'user-1', plan, [...ALL]),
    ]);
    expect(shared.records.filter((r) => r.table === 'calendar_events')).toHaveLength(1);
    expect(shared.records.filter((r) => r.table === 'family_reminders')).toHaveLength(2); // one reminder + one task
    expect([...ra.applied, ...rb.applied].sort()).toEqual(['calendar', 'reminder', 'task']);
    expect([...ra.failed, ...rb.failed]).toEqual([]);
  });
});
describe('the approval path and the plan screen (C1-S9-72)', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  // Opens at the first brace that ENDS a line: a signature's return type
  // (`Promise<ServiceResult<{ summary: … }>>`) carries a brace of its own, and
  // matching that one would slice the type instead of the body.
  const block = (src: string, needle: string): string => {
    const start = at(src, needle);
    const open = src.indexOf('{\n', start);
    expect(open, `no body brace after ${needle}`).toBeGreaterThan(start);
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(`unbalanced after ${needle}`);
  };

  it('an approved plan that did not land fails before its run is closed as executed', () => {
    const svc = strip(readFileSync('lib/services/approvals/index.ts', 'utf8'));
    const fn = block(svc, 'async function runConciergePlan(');
    const bail = block(fn, 'if (failed.length) {');
    expect(bail).toMatch(/return fail\(/);
    // Before the summary is composed and before the legacy run is closed, so
    // the Autopilot panel keeps offering the retry.
    expect(at(fn, 'if (failed.length) {')).toBeLessThan(at(fn, 'const summary = runSummary('));
    expect(at(fn, 'if (failed.length) {')).toBeLessThan(at(fn, ".from('family_automation_runs')"));
  });

  it('the plan screen says when the follow-through failed, in the family\'s language', () => {
    const ui = strip(readFileSync('components/modules/concierge-module.tsx', 'utf8'));
    const fn = block(ui, 'async function updateStatus(');
    expect(fn).toMatch(/else if \(!res\.ok\) \{\s*toastError\(res\.error\);/);
    expect(fn).toContain("t('conciergeModule.queuedForApprovalCheckThe')");
    expect(fn).not.toContain('`Queued for approval');
  });

  it('the failure summary names what is missing, and never says "already in place"', async () => {
    const { runFailureSummary, runSummary } = await import('@/lib/autonomy/loop');
    expect(runFailureSummary('Beach day', [], ['calendar'])).toBe('“Beach day” accepted — Bubaly could not add the calendar event.');
    expect(runFailureSummary('Beach day', ['reminder'], ['calendar', 'task']))
      .toBe('“Beach day” accepted — Bubaly set a follow-up reminder, but could not add the calendar event and the prep task.');
    expect(runFailureSummary('Beach day', [], ['calendar'])).not.toContain('already in place');
    // The success sentence is unchanged by the refactor that shares its list-joining.
    expect(runSummary('Beach day', ['calendar', 'reminder', 'task']))
      .toBe('“Beach day” accepted — Bubaly put it on the calendar, set a follow-up reminder and added a prep task.');
  });
});
