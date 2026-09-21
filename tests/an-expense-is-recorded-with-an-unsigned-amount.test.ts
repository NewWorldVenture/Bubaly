import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, TransactionType } from '@/lib/database.types';
import { createTransaction } from '@/lib/services/finances';
import type { ServiceScope } from '@/lib/services/types';

// `transactions.amount` is stored UNSIGNED and the direction lives in `type`.
// That is the convention `createTransaction` enforces — its first amount guard
// is `input.amount <= 0` → refuse — and the convention the wallet action and
// `listTransactions` already write and sum.
//
// The billing manager's Add Transaction form kept its own, older convention and
// negated expenses on the way out:
//
//     const finalAmount = type === 'expense' ? -Math.abs(parsedAmount) : Math.abs(parsedAmount);
//
// Harmless while that form inserted straight into Postgres; fatal once it became
// a CALLER of the service. Every expense a parent typed came back refused with
// "A transaction needs an amount above zero. Use the type to say whether money
// came in or went out." — advice impossible to follow, because Type was already
// on expense and the amount field already rejects negatives (min="0.01").
//
// This reads the amount expression the form actually hands to the action out of
// the source and runs it, rather than asserting on its spelling, then feeds the
// value it produces to the real service. A form that negates again fails at the
// service, exactly as a family would have hit it.
const FORM = 'components/modules/billing-module.tsx';
const TYPES: TransactionType[] = ['expense', 'income', 'transfer'];
/** What a parent types for a grocery run. */
const TYPED = 42.1;

function collect<T extends ts.Node>(root: ts.Node, pred: (n: ts.Node) => n is T): T[] {
  const out: T[] = [];
  const visit = (n: ts.Node) => { if (pred(n)) out.push(n); ts.forEachChild(n, visit); };
  visit(root);
  return out;
}

/** The `amount:` expression the form passes, with a local `const` resolved. */
function amountExpression(): ts.Expression {
  const source = readFileSync(FORM, 'utf8');
  const src = ts.createSourceFile(FORM, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const calls = collect(src, ts.isCallExpression)
    .filter((c) => c.expression.getText() === 'createTransactionAction');
  if (calls.length !== 1) throw new Error(`expected one createTransactionAction call in ${FORM}, found ${calls.length}`);
  const [call] = calls;

  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) throw new Error('createTransactionAction is not called with an object literal');
  const prop = arg.properties.find((p) => p.name?.getText() === 'amount');
  if (!prop) throw new Error('createTransactionAction is called without an `amount`');
  let expr: ts.Expression;
  if (ts.isPropertyAssignment(prop)) expr = prop.initializer;
  else if (ts.isShorthandPropertyAssignment(prop)) expr = prop.name;
  else throw new Error('`amount` is neither a property nor a shorthand');

  // The submit handler that owns the call — locals are read from it alone, so a
  // same-named `const` elsewhere in this 1600-line module cannot be picked up.
  let owner: ts.Node = call;
  while (owner.parent && !ts.isFunctionLike(owner)) owner = owner.parent;
  const locals = new Map<string, ts.Expression>();
  for (const d of collect(owner, ts.isVariableDeclaration)) {
    if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
  }
  const resolved = ts.isIdentifier(expr) ? locals.get(expr.text) : undefined;
  return resolved ?? expr;
}

const AMOUNT = amountExpression();
const BUILT_INS = new Set(['Math', 'Number', 'parseFloat', 'parseInt', 'String', 'Boolean', 'JSON', 'Object']);
/** Every free name the expression reads: `type` is bound to the form's Type field, the rest to what was typed. */
const FREE = [...new Set(
  collect(AMOUNT, ts.isIdentifier)
    .filter((id) => !(ts.isPropertyAccessExpression(id.parent) && id.parent.name === id))
    .filter((id) => !(ts.isPropertyAssignment(id.parent) && id.parent.name === id))
    .map((id) => id.text),
)].filter((n) => !BUILT_INS.has(n));

/** Run the form's own expression for a given Type selection. */
function amountSentFor(type: TransactionType): number {
  // eslint-disable-next-line no-new-func
  const run = new Function(...FREE, `return (${AMOUNT.getText()});`);
  return Number(run(...FREE.map((n) => (n === 'type' ? type : TYPED))));
}

type Call = { table: string; kind: 'select' | 'insert'; filters: Record<string, unknown>; payload?: Record<string, unknown> };

function makeDb() {
  const calls: Call[] = [];
  const from = (table: string) => {
    const call: Call = { table, kind: 'select', filters: {} };
    calls.push(call);
    const b: Record<string, unknown> = {};
    const filter = (c: string, v: unknown) => { call.filters[c] = v; return b; };
    Object.assign(b, {
      select: () => b, eq: filter,
      insert: (payload: Record<string, unknown>) => { call.kind = 'insert'; call.payload = payload; return b; },
      maybeSingle: () => Promise.resolve({ data: { id: String(call.filters.id) }, error: null }),
      single: () => Promise.resolve({ data: { id: 'txn-new', ...call.payload }, error: null }),
      then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
    });
    return b;
  };
  return { db: { from } as unknown as SupabaseClient<Database>, calls };
}

const scope = (db: SupabaseClient<Database>): ServiceScope => ({
  db, familyId: 'fam-1', userId: 'auth-1', memberId: 'member-1',
  role: 'parent', actorKind: 'member', tz: 'America/New_York', now: new Date('2026-09-05T12:00:00Z'),
});
const insertOf = (calls: Call[]) => calls.find((c) => c.table === 'transactions' && c.kind === 'insert')?.payload;

describe('an expense is recorded with an unsigned amount', () => {
  it.each(TYPES)('the billing form sends a positive amount for a %s', (type) => {
    expect(amountSentFor(type), `${FORM} sends ${AMOUNT.getText()} for a ${type}`).toBe(TYPED);
  });

  it.each(TYPES)('the service records what the form sends for a %s', async (type) => {
    const { db, calls } = makeDb();
    const res = await createTransaction(scope(db), {
      name: 'Whole Foods', amount: amountSentFor(type), type, category: 'Groceries', date: '2026-09-05',
    });

    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect(insertOf(calls)).toMatchObject({ amount: TYPED, type, name: 'Whole Foods' });
  });

  it('refuses the negative amount the form used to send, and writes nothing', async () => {
    const { db, calls } = makeDb();
    const res = await createTransaction(scope(db), { name: 'Whole Foods', amount: -TYPED, type: 'expense' });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain('needs an amount above zero');
    expect(insertOf(calls)).toBeUndefined();
  });
});
