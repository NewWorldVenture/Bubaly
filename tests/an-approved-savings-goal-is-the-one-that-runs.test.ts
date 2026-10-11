// A parent approves "Emergency fund, target $10,000". The family already has an
// "Emergency fund" with a $2,000 target. The idempotency probe matched any goal
// with that NAME (savings_goals has no idempotency_key column), so the keyed
// call — run executor, approval replay, purchase advice — handed the old goal
// back as the success of this one: nothing was inserted, and the summary read
// "Started saving for Emergency fund: $2,000". The amount that ran was not the
// amount that was approved, and nobody was told.
//
// And the savings modal: a contribution is a DELTA with no key, so a second
// press while the first was in flight posted it twice.
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { createSavingsGoal } from '@/lib/services/finances';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const FAMILY = 'family-1';
let db: ReturnType<typeof createInMemorySupabase<SupabaseClient<Database>>>;

const scope = (extra: Partial<ServiceScope> = {}): ServiceScope => ({
  db, familyId: FAMILY, userId: 'user-1', memberId: 'member-1',
  role: 'parent', actorKind: 'member', tz: 'UTC', ...extra,
});
const goals = () => db.table('savings_goals');

beforeEach(() => {
  db = createInMemorySupabase<SupabaseClient<Database>>({
    defaults: {
      savings_goals: { emoji: null, target_date: null },
      audit_logs: { resource_id: null, metadata: null },
    },
  });
  db.seed('savings_goals', [{
    id: 'old-goal', family_id: FAMILY, name: 'Emergency fund', target_amount: 2000, current_amount: 0,
  }]);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('an approved savings goal', () => {
  it('is not answered with an older goal of the same name and a different target', async () => {
    const res = await createSavingsGoal(scope({ idempotencyKey: 'approval-1' }), { name: 'emergency fund', targetAmount: 10000 });

    expect(res).toMatchObject({ ok: false, code: 'already_saved' });
    if (res.ok) return;
    // The family is told what actually stands, in money they recognise.
    expect(res.error).toContain('$2,000');
    expect(goals()).toHaveLength(1);
    expect(goals()[0]).toMatchObject({ id: 'old-goal', target_amount: 2000 });
  });

  it('is not answered with a same-named goal that already holds money', async () => {
    goals()[0].current_amount = 500;
    const res = await createSavingsGoal(scope({ runId: 'run-1', stepId: 'step-1' }), { name: 'Emergency fund', targetAmount: 2000 });
    expect(res).toMatchObject({ ok: false, code: 'already_saved' });
  });

  it('still recognises its own retry: same name, same money, no second row', async () => {
    const res = await createSavingsGoal(scope({ runId: 'run-1', stepId: 'step-1' }), { name: 'Emergency fund', targetAmount: 2000 });
    expect(res).toMatchObject({ ok: true, data: { id: 'old-goal' } });
    expect(goals()).toHaveLength(1);
  });

  it('creates a new goal when nothing by that name exists', async () => {
    const res = await createSavingsGoal(scope({ idempotencyKey: 'approval-2' }), { name: 'Summer trip', targetAmount: 3000 });
    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(goals().map((g) => g.name).sort()).toEqual(['Emergency fund', 'Summer trip']);
  });
});

// The modal's real submit callback, executed with synthetic state — the same
// technique tests/a-new-bill-on-a-short-month-before-0488.test.ts uses.
function contributeSubmit(env: Record<string, unknown>) {
  const file = 'components/finance/savings-view.tsx';
  const ast = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let body = '';
  const find = (node: ts.Node, inModal: boolean) => {
    const here = inModal || (ts.isFunctionDeclaration(node) && node.name?.text === 'ContributeModal');
    if (here && ts.isFunctionDeclaration(node) && node.name?.text === 'submit') body = node.getText(ast);
    ts.forEachChild(node, (child) => find(child, here));
  };
  find(ast, false);
  if (!body) throw new Error('ContributeModal has no submit callback with an in-flight guard');
  const js = ts.transpileModule(
    `function factory(env:any) {const {${Object.keys(env).join(',')}}=env;${body};return submit;}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } },
  ).outputText;
  return new Function(`${js};return factory;`)()(env) as (e: { preventDefault: () => void }) => Promise<void>;
}

describe('the savings contribution modal', () => {
  it('sends one contribution when pressed twice while the first is in flight', async () => {
    let answer!: () => void;
    const onAdd = vi.fn(() => new Promise<void>((resolve) => { answer = resolve; }));
    const env = { amt: '50', onAdd, inFlight: { current: false }, setSaving: vi.fn() };
    const submit = contributeSubmit(env);
    const event = { preventDefault: () => {} };

    const first = submit(event);
    const second = submit(event);   // the double-click
    answer();
    await Promise.all([first, second]);

    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(50);
    // And the button comes back once the answer is in.
    expect(env.inFlight.current).toBe(false);
    expect(env.setSaving).toHaveBeenLastCalledWith(false);
  });

  it('lets a later, deliberate contribution through once the first has answered', async () => {
    const onAdd = vi.fn(async () => {});
    const submit = contributeSubmit({ amt: '20', onAdd, inFlight: { current: false }, setSaving: vi.fn() });
    await submit({ preventDefault: () => {} });
    await submit({ preventDefault: () => {} });
    expect(onAdd).toHaveBeenCalledTimes(2);
  });

  it('shows the button as busy and disabled while a contribution is in flight', () => {
    const source = readFileSync('components/finance/savings-view.tsx', 'utf8');
    expect(source).toMatch(/<Button type="submit" loading=\{saving\} disabled=\{!amt \|\| saving\}>\{t\('savings\.addFunds'\)\}/);
  });
});
