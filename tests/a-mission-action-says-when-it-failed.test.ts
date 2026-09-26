import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { at } from './helpers/source-order';

/**
 * Audit C1-S9-73 — the missions review and creation actions returned nothing.
 *
 * Twenty-one failure paths across four actions were a bare `return;`. A
 * parent's Approve that failed stopped its spinner and said nothing. The plan
 * builder marked a chore "Added ✓" whether or not it was created, and every
 * suggestion it makes carries a reward, which a non-manager is refused. Each
 * action now returns `{ ok }` or `{ ok: false, error }`, and each caller shows it.
 */
const requireUserContext = vi.fn();
const createServer = vi.fn();
const applyCompletionRewards = vi.fn();

vi.mock('@/lib/supabase/auth', () => ({ requireUserContext: () => requireUserContext() }));
vi.mock('@/lib/supabase/server', () => ({ createServer: () => createServer(), createServiceClient: () => ({}) }));
vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@/lib/chores/server', () => ({
  applyCompletionRewards: (...a: unknown[]) => applyCompletionRewards(...a),
  logChoreEvent: async () => {},
}));
vi.mock('@/lib/chores/ai', () => ({ validateChoreSubmission: vi.fn(), generateChorePlan: vi.fn() }));

type Outcome = { data?: unknown; error?: unknown };
type Plan = {
  reads?: Record<string, Outcome>;
  updates?: Record<string, Outcome>;
  inserts?: Record<string, Outcome>;
  deletes?: Record<string, Outcome>;
};
type Call = { table: string; op: string; payload?: unknown };

function fakeDb(plan: Plan, calls: Call[]) {
  return {
    from(table: string) {
      let op = 'select';
      const outcome = (): Outcome => {
        const set = op === 'select' ? plan.reads : op === 'update' ? plan.updates : op === 'insert' ? plan.inserts : plan.deletes;
        return set?.[table] ?? { data: op === 'select' ? null : [{ id: `${table}-row` }], error: null };
      };
      const settle = () => {
        const o = outcome();
        return Promise.resolve({ data: o.error ? null : (o.data ?? null), error: o.error ?? null });
      };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        maybeSingle: settle,
        single: () => settle().then((r) => ({ ...r, data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data })),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => settle().then(res, rej),
        update: (payload: unknown) => { op = 'update'; calls.push({ table, op, payload }); return chain; },
        insert: (payload: unknown) => { op = 'insert'; calls.push({ table, op, payload }); return chain; },
        delete: () => { op = 'delete'; calls.push({ table, op }); return chain; },
      });
      return chain;
    },
  };
}

const SUBMISSION = { id: 'sub-1', status: 'pending_review', assignment_id: 'asg-1', chore_id: 'chore-1', member_id: 'kid-1' };
const ASSIGNMENT = { id: 'asg-1', status: 'submitted', ai_score: 90, member_id: 'kid-1' };
const CHORE = { id: 'chore-1', reward_mode: 'fixed_points', points: 10, difficulty: 'easy' };
const READS = { chore_submissions: { data: SUBMISSION }, chore_assignments: { data: ASSIGNMENT }, chores: { data: CHORE } };

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};
const actions = () => import('@/app/(app)/missions/actions');
const as = (role: string) => requireUserContext.mockResolvedValue({
  active: { familyId: 'fam-1', role, member: { id: 'mem-1' } }, user: { id: 'user-1' },
});

beforeEach(() => {
  as('parent');
  applyCompletionRewards.mockResolvedValue(undefined);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });

describe('approving a submission says whether it worked', () => {
  it('a child is refused by name, before anything is read', async () => {
    as('child');
    const res = await (await actions()).approveSubmissionAction(fd({ submission_id: 'sub-1' }));
    expect(res).toEqual({ ok: false, error: 'Only parents/guardians can approve' });
    expect(createServer).not.toHaveBeenCalled();
  });

  it('a refused read is a failure, not "no longer open"', async () => {
    createServer.mockResolvedValue(fakeDb({ reads: { chore_submissions: { error: { message: 'timeout' } } } }, []));
    const res = await (await actions()).approveSubmissionAction(fd({ submission_id: 'sub-1' }));
    expect(res.ok).toBe(false);
    expect((res as { error: string }).error).not.toBe('That chore is no longer open — refresh and try again.');
  });

  it('a submission that is gone says so', async () => {
    createServer.mockResolvedValue(fakeDb({}, []));
    const res = await (await actions()).approveSubmissionAction(fd({ submission_id: 'sub-1' }));
    expect(res).toEqual({ ok: false, error: 'That chore is no longer open — refresh and try again.' });
  });

  it('a status move that matched nothing is a failure', async () => {
    createServer.mockResolvedValue(fakeDb({ reads: READS, updates: { chore_submissions: { data: [] } } }, []));
    const res = await (await actions()).approveSubmissionAction(fd({ submission_id: 'sub-1' }));
    expect(res.ok).toBe(false);
  });

  it('a reward that could not be applied is a failure', async () => {
    applyCompletionRewards.mockRejectedValue(new Error('ledger refused'));
    createServer.mockResolvedValue(fakeDb({ reads: READS }, []));
    const res = await (await actions()).approveSubmissionAction(fd({ submission_id: 'sub-1' }));
    expect(res).toEqual({ ok: false, error: 'Could not finish the chore approval.' });
  });

  it('an approval that landed is ok', async () => {
    createServer.mockResolvedValue(fakeDb({ reads: READS }, []));
    const res = await (await actions()).approveSubmissionAction(fd({ submission_id: 'sub-1' }));
    expect(res).toEqual({ ok: true });
    expect(applyCompletionRewards).toHaveBeenCalledTimes(1);
  });
});

describe('rejecting and disputing say whether they worked', () => {
  it('a child cannot reject, and is told', async () => {
    as('child');
    const res = await (await actions()).rejectSubmissionAction(fd({ submission_id: 'sub-1', redo: '0' }));
    expect(res.ok).toBe(false);
    expect(createServer).not.toHaveBeenCalled();
  });

  it('a refused assignment update is a failure', async () => {
    createServer.mockResolvedValue(fakeDb({ reads: READS, updates: { chore_assignments: { error: { message: 'rls' } } } }, []));
    const res = await (await actions()).rejectSubmissionAction(fd({ submission_id: 'sub-1', redo: '1' }));
    expect(res.ok).toBe(false);
  });

  it('a rejection that landed is ok', async () => {
    createServer.mockResolvedValue(fakeDb({ reads: READS }, []));
    const res = await (await actions()).rejectSubmissionAction(fd({ submission_id: 'sub-1', redo: '0' }));
    expect(res).toEqual({ ok: true });
  });

  it('a dispute that could not be filed is a failure', async () => {
    createServer.mockResolvedValue(fakeDb({ reads: READS, inserts: { chore_disputes: { error: { message: 'rls' } } } }, []));
    const res = await (await actions()).disputeSubmissionAction(fd({ submission_id: 'sub-1', reason: 'I did it' }));
    expect(res.ok).toBe(false);
  });
});

describe('creating a chore says whether it worked', () => {
  const chore = { title: 'Make the bed', points: '10' };

  it('a non-manager pricing a chore is told why, and nothing is written', async () => {
    as('teen');
    const calls: Call[] = [];
    createServer.mockResolvedValue(fakeDb({}, calls));
    const res = await (await actions()).createChoreAction(fd(chore));
    expect(res).toEqual({ ok: false, error: "Only a parent or guardian can set a chore's reward." });
    expect(calls).toEqual([]);
  });

  it('a non-manager may still add an unpriced chore (not over-tightened)', async () => {
    as('teen');
    const calls: Call[] = [];
    createServer.mockResolvedValue(fakeDb({}, calls));
    const res = await (await actions()).createChoreAction(fd({ title: 'Make the bed' }));
    expect(res).toEqual({ ok: true });
    expect(calls.some((c) => c.table === 'chores' && c.op === 'insert')).toBe(true);
  });

  it('a refused insert is a failure', async () => {
    createServer.mockResolvedValue(fakeDb({ inserts: { chores: { error: { message: 'rls' } } } }, []));
    const res = await (await actions()).createChoreAction(fd(chore));
    expect(res).toEqual({ ok: false, error: 'Could not add that chore.' });
  });

  it('a chore whose assignments were refused is a failure, and is cleaned up', async () => {
    const calls: Call[] = [];
    createServer.mockResolvedValue(fakeDb({ inserts: { chore_assignments: { error: { message: 'rls' } } } }, calls));
    const f = fd(chore);
    f.append('member_ids', 'kid-1');
    const res = await (await actions()).createChoreAction(f);
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.table === 'chores' && c.op === 'delete')).toBe(true);
  });

  it('a created chore is ok', async () => {
    createServer.mockResolvedValue(fakeDb({}, []));
    const res = await (await actions()).createChoreAction(fd(chore));
    expect(res).toEqual({ ok: true });
  });
});

describe('every caller shows the outcome', () => {
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('none of the four actions returns void any more', () => {
    const src = readFileSync('app/(app)/missions/actions.ts', 'utf8');
    for (const name of ['approveSubmissionAction', 'rejectSubmissionAction', 'disputeSubmissionAction', 'createChoreAction']) {
      expect(src, name).toMatch(new RegExp(`export async function ${name}\\(formData: FormData\\): Promise<MissionActionResult>`));
    }
  });

  it('the review card shows a refusal', () => {
    const card = strip(readFileSync('app/(app)/missions/review-card.tsx', 'utf8'));
    expect(card).toContain('if (!res.ok) setError(res.error);');
    expect(card).toContain('{error && <p role="alert"');
    expect(card).toContain('review(approveSubmissionAction, fd)');
    expect(card).toContain('review(rejectSubmissionAction, fd)');
  });

  it('the plan builder marks "Added" only after the chore exists', () => {
    const gen = strip(readFileSync('app/(app)/missions/new/plan-generator.tsx', 'utf8'));
    expect(at(gen, 'const res = await createChoreAction(fd);')).toBeLessThan(at(gen, 'if (!res.ok) { setError(res.error); return; }'));
    expect(at(gen, 'if (!res.ok) { setError(res.error); return; }')).toBeLessThan(at(gen, 'setAdded((s) => new Set(s).add(idx));'));
  });

  it('the create form keeps its input on a refusal and clears only on success', () => {
    const page = strip(readFileSync('app/(app)/missions/new/page.tsx', 'utf8'));
    expect(page).toContain('<CreateChoreForm className=');
    expect(page).not.toContain('action={createChoreAction}');
    const form = strip(readFileSync('app/(app)/missions/new/create-chore-form.tsx', 'utf8'));
    expect(form).toContain('event.preventDefault();');
    expect(form).toContain('if (pending) return;');
    expect(at(form, 'if (!res.ok) { setError(res.error); return; }')).toBeLessThan(at(form, 'form.reset();'));
    expect(form).toContain('{error && <p role="alert"');
  });
});

describe("paperwork's materialize does not answer a refused read with silence (C1-S9-73)", () => {
  it('the item read error is thrown, like every other failure in that action; absence stays quiet', () => {
    const src = readFileSync('app/(app)/dashboard/paperwork/actions.ts', 'utf8');
    const fn = src.slice(at(src, 'export async function materializePaperworkActionAction('));
    expect(fn).toContain('const { data: item, error: itemError } = await supabase');
    expect(at(fn, "if (itemError) throw new Error(describeActionError(itemError, tr('actions.couldNotLoadThatDocument')));"))
      .toBeLessThan(at(fn, 'if (!item) return;'));
  });
});
