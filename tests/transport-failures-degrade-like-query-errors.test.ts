// One unreachable table must not cost a page every other read it already has.
//
// A Supabase query builder RESOLVES with { data, error } for anything the
// database answers — every error it reports included. It REJECTS only when the
// request never completed: DNS, TCP, TLS, an aborted or timed-out fetch. Those
// are exactly the failures an overloaded database produces, and they are
// invisible to the `if (res.error)` checks these callers are built around.
//
// Inside `Promise.all` that difference is the whole problem: one rejection
// rejects the batch, so a page that carefully handles res.error for all of its
// reads dies on an unhandled rejection and renders the route's error boundary
// instead of the degraded view it was written to show. That is what took out
// /dashboard while production reported CONNECT_TIMEOUT, and it is why
// `lib/supabase/settle.ts` exists.
//
// 155 files adopted it. These are the batches it never reached.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import { loadInboxQueue } from '@/lib/inbox/server';
import { verifyOnboardingOwner } from '@/lib/onboarding/verify-owner';
import { checkScheduleActor, readScheduleSnapshot } from '@/lib/social/scheduled-authority';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

type DB = SupabaseClient<Database>;

/**
 * A client whose named tables reject the way a transport failure does, and
 * whose other tables answer normally. Nothing here resolves with an `error` —
 * that path already worked; the rejection is the one under test.
 */
function clientRejecting(tables: string[], rows: Record<string, unknown[]> = {}) {
  const seen: string[] = [];
  const build = (table: string) => {
    seen.push(table);
    const run = () => (tables.includes(table)
      ? Promise.reject(new Error(`CONNECT_TIMEOUT reading ${table}`))
      : Promise.resolve({ data: rows[table] ?? [], count: (rows[table] ?? []).length, error: null }));
    const chain: Record<string, unknown> = {
      then: (...a: unknown[]) => (run() as Promise<unknown>).then(...(a as [])),
      catch: (...a: unknown[]) => (run() as Promise<unknown>).catch(...(a as [])),
      finally: (...a: unknown[]) => (run() as Promise<unknown>).finally(...(a as [])),
    };
    for (const m of ['select', 'eq', 'neq', 'gte', 'lte', 'lt', 'gt', 'in', 'is', 'not', 'or',
      'order', 'limit', 'range', 'abortSignal', 'single', 'maybeSingle']) {
      chain[m] = () => (m === 'maybeSingle' || m === 'single'
        ? (tables.includes(table)
          ? Promise.reject(new Error(`CONNECT_TIMEOUT reading ${table}`))
          : Promise.resolve({ data: (rows[table] ?? [])[0] ?? null, count: null, error: null }))
        : chain);
    }
    return chain;
  };
  return { client: { from: build } as unknown as DB, seen };
}

beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the inbox queue', () => {
  const rows = {
    family_inbox_messages: [{
      id: 'm1', channel: 'email', direction: 'inbound', from_addr: 'school@example.com',
      subject: 'Trip form', body: 'Please sign', ai_summary: null, ai_intent: 'action',
      ai_handled: false, status: 'new', occurred_at: '2026-09-07T09:00:00Z',
    }],
    paperwork_items: [{
      id: 'p1', kind: 'form', title: 'Consent form', summary: null, sender: 'School',
      due_on: '2026-09-20', urgency: 'normal', status: 'needs_action', created_at: '2026-09-07T09:00:00Z',
    }],
    family_communications: [{
      id: 'c1', channel: 'email', subject: 'Reminder', body: 'Hi', summary: null,
      category: 'school', status: 'new', priority: 'normal', received_at: '2026-09-07T09:00:00Z',
    }],
  };

  it('keeps the sources that answered when one of them is unreachable', async () => {
    const { client } = clientRejecting(['paperwork_items'], rows);

    // Under Promise.all this call REJECTED: the one unreachable table took the
    // two healthy ones with it, and the caller never reached its own handling.
    const queue = await loadInboxQueue(client, 'fam-1', { now: new Date('2026-09-07T12:00:00Z') });

    expect(queue.unavailable.paperwork).toBe(true);
    expect(queue.unavailable.messages).toBe(false);
    expect(queue.unavailable.communications).toBe(false);
    // And the rows that DID arrive are still in the queue, which is the whole
    // point of degrading rather than failing.
    expect(queue.items.length).toBeGreaterThan(0);
  });

  it('reports every source unavailable when the database is unreachable entirely', async () => {
    const { client } = clientRejecting(['family_inbox_messages', 'paperwork_items', 'family_communications'], rows);

    const queue = await loadInboxQueue(client, 'fam-1', { now: new Date('2026-09-07T12:00:00Z') });

    expect(queue.unavailable).toEqual({ messages: true, paperwork: true, communications: true });
    // Never "your inbox is empty" because the database was down.
    expect(queue.items).toEqual([]);
  });
});

describe('onboarding owner verification', () => {
  // The assertion is only reached when the caller passes an expected owner;
  // without one the function keeps the older callers' contract and returns true
  // before reading anything.
  const USER = '11111111-1111-4111-8111-111111111111';
  const expected = { userId: USER, familyId: null };

  it('answers false rather than throwing when a read never completes', async () => {
    const { client } = clientRejecting(['family_members']);

    // The function's contract is a boolean, and its own checks already answer
    // false for a failed read. A rejection used to escape that entirely — an
    // onboarding write would then fail with an unhandled error rather than a
    // refusal.
    await expect(verifyOnboardingOwner(client, USER, expected)).resolves.toBe(false);
  });

  it('still answers false when the preferences read is the one that fails', async () => {
    const { client } = clientRejecting(['user_preferences']);
    await expect(verifyOnboardingOwner(client, USER, expected)).resolves.toBe(false);
  });
});

describe('required social authority reads fail as a whole on transport rejection', () => {
  it.each(['family_members', 'social_access_permissions'])('rejects a failed %s authority read', async table => {
    const { client } = clientRejecting([table], {
      family_members: [{ id: 'member', family_id: 'family', user_id: 'user', role: 'parent', is_active: true }],
    });
    await expect(checkScheduleActor(client, 'family', { userId: 'user', memberId: 'member' }, 'publish_posts'))
      .rejects.toMatchObject({ name: 'ScheduledPublishError', key: 'socialSchedule.accessUnavailable' });
  });

  it.each(['social_posts', 'social_post_variants', 'social_post_targets', 'social_schedules', 'social_calendar_items'])(
    'never authorizes a partial snapshot after %s rejects', async table => {
      const { client } = clientRejecting([table]);
      await expect(readScheduleSnapshot(client, { familyId: 'family', postId: 'post', scheduleId: 'schedule',
        scheduledFor: '2026-12-01T12:00:00.000Z', timezone: 'UTC' })).rejects.toMatchObject({ name: 'ScheduledPublishError' });
    });
});

// Authority and receipt helpers require the entire batch and deliberately fail
// closed. Recognize that contract structurally, rather than excluding filenames:
// every query remains abortable, the immediate error branch must fail, and no
// enclosing catch may swallow the rejection and continue into provider work.
function isFailClosedBatch(source: string, position: number, file: string,
  load: (path: string) => string = path => readFileSync(path, 'utf8')): boolean {
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let declaration: ts.VariableDeclaration | undefined;
  const find = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.getStart(ast) <= position + 6 && node.end > position) declaration = node;
    if (node.getFullStart() <= position + 6 && node.end > position) ts.forEachChild(node, find);
  };
  find(ast);
  if (!declaration || !ts.isArrayBindingPattern(declaration.name)
    || !declaration.initializer || !ts.isAwaitExpression(declaration.initializer)) return false;
  const call = declaration.initializer.expression;
  if (!ts.isCallExpression(call) || !call.arguments[0] || !ts.isArrayLiteralExpression(call.arguments[0])) return false;
  const queries = call.arguments[0].elements.map(node => node.getText(ast));
  if (queries.every(query => /\.(insert|update|upsert|delete)\(/.test(query))) return true; // Not a read batch.
  if (queries.some(query => !query.includes('.abortSignal('))) return false;

  const throwing = new Set<string>();
  const isThrowingHelper = (node: ts.Node, name: string): boolean => ts.isFunctionDeclaration(node)
    && node.name?.text === name && node.type?.kind === ts.SyntaxKind.NeverKeyword
    && node.body?.statements.length === 1 && ts.isThrowStatement(node.body.statements[0]);
  for (const node of ast.statements) {
    if (ts.isFunctionDeclaration(node) && node.name && isThrowingHelper(node, node.name.text)) throwing.add(node.name.text);
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)
      || !node.moduleSpecifier.text.startsWith('.') || !node.importClause?.namedBindings
      || !ts.isNamedImports(node.importClause.namedBindings)) continue;
    const path = resolve(dirname(file), `${node.moduleSpecifier.text}.ts`);
    let dependency: ts.SourceFile;
    try { dependency = ts.createSourceFile(path, load(path), ts.ScriptTarget.Latest, true); } catch { continue; }
    for (const binding of node.importClause.namedBindings.elements) {
      if (dependency.statements.some(item => isThrowingHelper(item, binding.propertyName?.text ?? binding.name.text))) throwing.add(binding.name.text);
    }
  }
  const fails = (statement: ts.Statement | undefined): boolean => {
    if (!statement) return false;
    if (ts.isThrowStatement(statement)) return true;
    if (ts.isBlock(statement)) return fails(statement.statements.at(-1));
    if (!ts.isReturnStatement(statement) || !statement.expression) return false;
    const value = statement.expression;
    return ts.isStringLiteral(value) && value.text === 'failed'
      || ts.isCallExpression(value) && ts.isIdentifier(value.expression) && throwing.has(value.expression.text);
  };
  const statement = declaration.parent.parent;
  if (!ts.isVariableStatement(statement) || !ts.isBlock(statement.parent)) return false;
  const next = statement.parent.statements[statement.parent.statements.indexOf(statement) + 1];
  if (!next || !ts.isIfStatement(next) || !fails(next.thenStatement)) return false;
  const names = declaration.name.elements.filter(ts.isBindingElement).map(binding => binding.name.getText(ast));
  const checkedErrors = new Set<string>();
  const errorsIn = (node: ts.Node, found: Set<string>) => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.name.text === 'error') found.add(node.expression.text);
    ts.forEachChild(node, child => errorsIn(child, found));
  };
  errorsIn(next.expression, checkedErrors);
  const inspectArrays = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'some'
      && ts.isArrayLiteralExpression(node.expression.expression)) {
      const predicate = node.arguments[0], errors = new Set<string>();
      if (predicate && (ts.isArrowFunction(predicate) || ts.isFunctionExpression(predicate)) && predicate.parameters.length === 1) {
        errorsIn(predicate.body, errors);
        if (errors.has(predicate.parameters[0].name.getText(ast))) {
          for (const element of node.expression.expression.elements) if (ts.isIdentifier(element)) checkedErrors.add(element.text);
        }
      }
    }
    ts.forEachChild(node, inspectArrays);
  };
  inspectArrays(next.expression);
  if (names.some(name => !checkedErrors.has(name))) return false;
  const hasReturn = (node: ts.Node): boolean => ts.isReturnStatement(node)
    || (!ts.isFunctionLike(node) && Boolean(ts.forEachChild(node, child => hasReturn(child) || undefined)));
  for (let node: ts.Node = statement; node.parent && !ts.isFunctionLike(node.parent); node = node.parent) {
    if (ts.isTryStatement(node.parent) && node.parent.tryBlock === node) {
      if (node.parent.catchClause && !fails(node.parent.catchClause.block)) return false;
      if (node.parent.finallyBlock && hasReturn(node.parent.finallyBlock)) return false;
    }
  }
  return true;
}

describe('fail-closed batch recognition cannot hide degraded or swallowed failures', () => {
  const source = `function unavailable(): never { throw new Error('unavailable'); }
    async function authority(db) { try {
      const [member, permission] = await Promise.all([
        db.from('members').select('*').abortSignal(signal),
        db.from('permissions').select('*').abortSignal(signal),
      ]);
      if (member.error || permission.error) return unavailable();
      return member.data;
    } catch { return unavailable(); } }`;
  const guarded = (text: string) => isFailClosedBatch(text, text.indexOf('const [member'), 'synthetic.ts', () => '');
  it('recognizes a bounded required batch with an always-throwing failure helper', () => { expect(guarded(source)).toBe(true); });
  it.each([
    ['swallowed transport error', source.replace('catch { return unavailable(); }', 'catch { console.error("offline"); }')],
    ['partial result fallback', source.replace('if (member.error || permission.error) return unavailable();', 'if (member.error || permission.error) return member.data;')],
    ['missing permission check', source.replace('member.error || permission.error', 'member.error')],
    ['healthy data mistaken for an error check', source.replace('permission.error', 'permission.data')],
    ['unbounded query', source.replace('.abortSignal(signal)', '')],
    ['helper that returns success', source.replace("throw new Error('unavailable');", 'return true;')],
    ['finally overrides the failure', source.replace('catch { return unavailable(); }', 'catch { return unavailable(); } finally { return true; }')],
  ])('refuses the %s mutation', (_name, mutation) => { expect(guarded(mutation)).toBe(false); });
});

// The guard. A batch of two or more Supabase reads whose results are checked
// for `.error` must not leave one of them able to reject the batch.
describe('no read batch can be taken down by one transport failure', () => {
  it('every multi-read Promise.all either settles each read or is not one', async () => {
    const { readFile } = await import('node:fs/promises');
    const { glob } = await import('node:fs/promises');

    const offenders: string[] = [];
    for await (const entry of glob(['app/**/*.ts', 'app/**/*.tsx', 'lib/**/*.ts', 'components/**/*.tsx'])) {
      const file = String(entry);
      const source = await readFile(file, 'utf8');
      for (const m of source.matchAll(/(const|let)\s*\[([^\]]+)\]\s*=\s*await Promise\.all\(\[/g)) {
        let i = m.index + m[0].length;
        let depth = 1;
        while (i < source.length && depth > 0) {
          if ('[({'.includes(source[i])) depth += 1;
          else if (')]}'.includes(source[i])) depth -= 1;
          i += 1;
        }
        const block = source.slice(m.index, i);
        // A read counts as unprotected only when NO enclosing call is one of
        // the wrappers — counting occurrences is not enough, because a nested
        // `Promise.all(...map(...))` can hold reads that are each settled.
        let unprotected = 0;
        let reads = 0;
        const stack: string[] = [];
        for (let k = 0; k < block.length; k += 1) {
          if ('(['.includes(block[k])) {
            const name = (block.slice(Math.max(0, k - 24), k).match(/([A-Za-z_$][\w$]*)$/) ?? ['', ''])[1];
            stack.push(name);
          } else if (')]'.includes(block[k])) {
            stack.pop();
          } else if (/[A-Za-z_$]/.test(block[k]) && /^\w+\.from\('[a-z_]+'\)/.test(block.slice(k)) && !/[\w$.]/.test(block[k - 1] ?? ' ')) {
            reads += 1;
            if (!stack.some((n) => n === 'settle' || n === 'settleAll' || n === 'count')) unprotected += 1;
          }
        }
        if (reads < 2 || unprotected === 0) continue;
        // Only a batch whose results are actually inspected for `.error` is a
        // batch with degraded handling to lose.
        const names = m[2].split(',').map((n) => n.trim().split(':')[0].trim()).filter(Boolean);
        const after = source.slice(i, i + 3000);
        if (!names.some((n) => new RegExp(`\\b${n}\\??\\.error`).test(after + block))) continue;
        if (isFailClosedBatch(source, m.index, file)) continue;
        offenders.push(`${file}:${source.slice(0, m.index).split('\n').length}`);
      }
    }

    expect(offenders, `use settleAll (or settle each read) so one rejection cannot discard the batch:\n${offenders.join('\n')}`).toEqual([]);
  });
});
