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

function fakeDb(o: Opts) {
  const inserts: { table: string; payload: Record<string, unknown> }[] = [];
  const db = {
    from(table: string) {
      if (table === 'concierge_plan_actions') {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: o.ledgerError ? null : (o.ledger ?? []), error: o.ledgerError ?? null }).then(res),
          insert: (payload: Record<string, unknown>) => {
            inserts.push({ table, payload });
            return Promise.resolve({ error: o.logError ?? null });
          },
        };
        return chain;
      }
      return {
        insert(payload: Record<string, unknown>) {
          inserts.push({ table, payload });
          const error = table === 'calendar_events'
            ? o.calendarError
            : payload.kind === 'task' ? o.taskError : o.reminderError;
          const single = () => Promise.resolve({ data: error ? null : { id: `${table}-1` }, error: error ?? null });
          return { select: () => ({ single }) };
        },
      };
    },
  };
  return { db: db as unknown as Parameters<typeof materializeConciergePlan>[0], inserts };
}

const plan = { id: 'plan-1', title: 'Beach day', description: null, location: null, planned_for: '2026-10-10', budget_cents: null };
const ALL = ['calendar', 'reminder', 'task'] as const;
const run = (o: Opts) => {
  const { db, inserts } = fakeDb(o);
  return materializeConciergePlan(db, 'fam-1', 'user-1', plan, [...ALL]).then((r) => ({ ...r, inserts }));
};

describe('the concierge materializer says what did not land (C1-S9-72)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies everything and reports no failures when every write lands', async () => {
    const r = await run({});
    expect(r.applied).toEqual(['calendar', 'reminder', 'task']);
    expect(r.failed).toEqual([]);
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
    // No ledger row for the kind that did not land, or a retry would skip it.
    const logged = r.inserts.filter((i) => i.table === 'concierge_plan_actions').map((i) => i.payload.action_kind);
    expect(logged).toEqual(['reminder', 'task']);
  });

  it('every insert refused is every kind failed, not an empty success', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run({ calendarError: { m: 1 }, reminderError: { m: 2 }, taskError: { m: 3 } });
    expect(r.applied).toEqual([]);
    expect(r.failed).toEqual(['calendar', 'reminder', 'task']);
  });

  it('the genuine "already in place" is still empty on both sides', async () => {
    const r = await run({ ledger: [{ action_kind: 'calendar' }, { action_kind: 'reminder' }, { action_kind: 'task' }] });
    expect(r.applied).toEqual([]);
    expect(r.failed).toEqual([]);
    expect(r.inserts).toEqual([]);
  });

  it('a lost ledger row does not un-count a record that exists (not over-tightened)', async () => {
    // The real calendar event and reminder exist; failing them here would send
    // the family to retry work that succeeded.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await run({ logError: { message: 'ledger insert refused' } });
    expect(r.applied).toEqual(['calendar', 'reminder', 'task']);
    expect(r.failed).toEqual([]);
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
