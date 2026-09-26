// Every export of a 'use server' module is an HTTP endpoint with its own action
// id. The client can call it directly — the component that normally calls it is
// not a gate. So for the modules that hold a SERVICE-role client (which RLS does
// not check), two things have to be true of every exported action, and neither
// is checked by typecheck, lint, or the build:
//
//   1. it establishes who is calling, or it is deliberately public; and
//   2. if it keys a service-client read or write on a family id that arrived in
//      its own parameters, it is super-admin gated — because authenticating a
//      caller says who they are, not which family they may touch.
//
// This is parsed, not grepped, and the distinction is the whole reason the file
// exists. A brace-matching scan of
//
//     export async function issueCardAction(input: {…}): Promise<Result<{ cardId: string }>> {
//
// walks past the parameter list, takes the next `{` as the body — and lands in
// the RETURN TYPE. The "body" it extracts is `{ cardId: string }`, which
// contains no guard, so the action is reported unguarded while its third line
// is `await requireUserContext()`. Every action annotated with an object type
// in its return position was flagged that way. The parser knows the difference.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const SKIP = new Set(['node_modules', '.next', '.git', 'dist', 'build', 'coverage', 'supabase', 'mobile', 'tests']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(full)) out.push(full);
  }
  return out;
}

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

function isUseServer(sf: ts.SourceFile): boolean {
  const first = sf.statements[0];
  return !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression)
    && first.expression.text === 'use server';
}

const SERVICE_FACTORY = /^(createServiceClient|createServiceRoleClient|createAdminClient)$/;

/** Callables that establish who is acting, or refuse when they may not. */
const GUARDS = new Set([
  'requireUserContext', 'requireUser', 'requireFamilyContext', 'requireFamily', 'requireMember',
  'requireParent', 'requireAuth', 'requireSession', 'requireSuperAdmin', 'assertSuperAdmin',
  'isSuperAdmin', 'requireAdmin', 'assertAdmin', 'getSessionUser', 'getCurrentUser',
  'requireGuardian', 'assertFamilyMember', 'assertParent', 'requireChild', 'requireOwner',
  'assertOwner', 'requireActor', 'requireManager', 'assertManager', 'verifyOnboardingOwner',
  // supabase.auth.getUser() — the caller then refuses when there is no user.
  'getUser',
]);

/**
 * Actions that answer an UNAUTHENTICATED caller on purpose. Each needs a reason,
 * because the cost of an unexplained entry is that the next one gets added
 * without one. All five were read for this audit; all five are rate-limited by
 * client IP through the durable limiter, and the three marked below are covered
 * again by tests/public-server-action-safety.test.ts.
 */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  'app/reviews/new/actions.ts:submitReviewAction':
    'public review form; writes status pending unless it clears the configured auto-approve threshold',
  'app/s/[slug]/actions.ts:submitResponseAction':
    'public survey form; respondents may be anonymous, and the slug must resolve to an active survey',
  'app/gift/actions.ts:submitGiftPledgeAction':
    'public gift page; the unguessable link token IS the authorization, pledges are written pending a parent approval, and pending pledges per link are capped',
  'app/(auth)/actions.ts:childSignInAction':
    'a sign-in cannot require a session; throttled per username via child_login_throttle so a 4-digit PIN cannot be enumerated',
  'app/(app)/dashboard/inbox/actions.ts:inboxRequestText':
    'not an endpoint in the meaningful sense — a pure string composer over its own arguments, exported only so a test can pin it without a database. It reads nothing and writes nothing',
};

type Action = {
  file: string; rel: string; name: string; line: number;
  fn: ts.FunctionDeclaration; sf: ts.SourceFile;
};

function exportedActions(sf: ts.SourceFile, file: string): Action[] {
  const out: Action[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isFunctionDeclaration(stmt) || !stmt.name || !stmt.body) continue;
    const mods = ts.getModifiers(stmt) ?? [];
    if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (!mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) continue;
    out.push({
      file, rel: relative(ROOT, file), name: stmt.name.text,
      line: sf.getLineAndCharacterOfPosition(stmt.getStart(sf)).line + 1,
      fn: stmt, sf,
    });
  }
  return out;
}

/** Every identifier used in call position anywhere under a node. */
function callees(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (ts.isIdentifier(e)) names.add(e.text);
      else if (ts.isPropertyAccessExpression(e)) names.add(e.name.text);
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return names;
}

/** Every function in a module by name, so a guard held in a helper still counts. */
function localFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const locals = new Map<string, ts.Node>();
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) locals.set(n.name.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      locals.set(n.name.text, n.initializer.body);
    }
    ts.forEachChild(n, collect);
  };
  ts.forEachChild(sf, collect);
  return locals;
}

function reachesGuard(name: string, locals: Map<string, ts.Node>, seen = new Set<string>()): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const body = locals.get(name);
  if (!body) return false;
  const called = callees(body);
  for (const c of called) if (GUARDS.has(c)) return true;
  for (const c of called) if (locals.has(c) && reachesGuard(c, locals, seen)) return true;
  return false;
}

/** Names bound by a parameter list, destructuring included. */
function paramNames(fn: ts.FunctionDeclaration): Set<string> {
  const names = new Set<string>();
  const add = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const el of name.elements) if (!ts.isOmittedExpression(el)) add(el.name);
  };
  for (const p of fn.parameters) add(p.name);
  return names;
}

/** The leftmost identifier of a nested expression: `input.familyId` -> `input`. */
function rootIdent(expr: ts.Expression): string | null {
  let e: ts.Node = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)
      || ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e) || ts.isAsExpression(e)) {
      e = e.expression;
      continue;
    }
    return ts.isIdentifier(e) ? e.text : null;
  }
}

const FAMILY_KEY = /^(family_id|familyId)$/;

/** True when this body constructs a service-role client. */
function holdsServiceClient(body: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && SERVICE_FACTORY.test(n.expression.text)) found = true;
    ts.forEachChild(n, visit);
  };
  visit(body);
  return found;
}

/** Family ids that flow from this action's own parameters into a query or payload. */
function callerSuppliedFamilyKeys(fn: ts.FunctionDeclaration, sf: ts.SourceFile): string[] {
  const params = paramNames(fn);
  if (params.size === 0 || !fn.body) return [];
  const hits: string[] = [];
  const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
      && n.expression.name.text === 'eq' && n.arguments.length === 2
      && ts.isStringLiteral(n.arguments[0]) && FAMILY_KEY.test(n.arguments[0].text)) {
      const root = rootIdent(n.arguments[1]);
      if (root && params.has(root)) hits.push(`line ${at(n)}: .eq('${n.arguments[0].text}', ${root}…)`);
    }
    if (ts.isPropertyAssignment(n) && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))
      && FAMILY_KEY.test(n.name.text)) {
      const root = rootIdent(n.initializer);
      if (root && params.has(root)) hits.push(`line ${at(n)}: ${n.name.text}: ${root}…`);
    }
    ts.forEachChild(n, visit);
  };
  visit(fn.body);
  return hits;
}

const SERVER_MODULES = walk(ROOT).filter((f) => isUseServer(parse(f)));
const SERVICE_MODULES = SERVER_MODULES.filter((f) =>
  new RegExp(`\\b(${SERVICE_FACTORY.source.slice(1, -1)})\\b`).test(readFileSync(f, 'utf8')));

describe('a server action in a service-role module answers for who is calling', () => {
  it('finds the surface it is policing', () => {
    // A sweep that walks nothing passes forever. These are floors, not targets:
    // they only have to prove the walk reached the app.
    expect(SERVER_MODULES.length, "'use server' modules").toBeGreaterThan(100);
    expect(SERVICE_MODULES.length, 'of those, holding a service-role client').toBeGreaterThan(20);
    const actions = SERVICE_MODULES.flatMap((f) => exportedActions(parse(f), f));
    expect(actions.length, 'exported actions in service-role modules').toBeGreaterThan(80);
  });

  it('every one of them reaches a guard, or is public with a stated reason', () => {
    const unguarded: string[] = [];
    for (const file of SERVICE_MODULES) {
      const sf = parse(file);
      const locals = localFunctions(sf);
      for (const action of exportedActions(sf, file)) {
        if (reachesGuard(action.name, locals)) continue;
        const key = `${action.rel}:${action.name}`;
        if (key in PUBLIC_BY_DESIGN) continue;
        unguarded.push(`${action.rel}:${action.line}  ${action.name}`);
      }
    }
    expect(
      unguarded,
      'each is a callable endpoint with its own action id — establish who is calling, '
      + 'or add it to PUBLIC_BY_DESIGN with the reason it may answer a stranger',
    ).toEqual([]);
  });

  it('the public allowlist has no stale entries', () => {
    // An entry for an action that no longer exists is an exemption waiting to be
    // re-used by a future action that happens to take the same name.
    const live = new Set(
      SERVICE_MODULES.flatMap((f) => exportedActions(parse(f), f)).map((a) => `${a.rel}:${a.name}`),
    );
    const stale = Object.keys(PUBLIC_BY_DESIGN).filter((k) => !live.has(k));
    expect(stale, 'these allowlisted actions are gone — drop the entries').toEqual([]);
    for (const [key, reason] of Object.entries(PUBLIC_BY_DESIGN)) {
      expect(reason.length, `${key} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });
});

describe('authenticating a caller does not decide which family they may touch', () => {
  // The user client is checked by RLS, so a forged family_id is refused there.
  // The service client is not checked by anything. An action that takes a family
  // id from its caller and hands it to the service client is therefore only as
  // safe as its own gate — and the only gate that legitimately reaches across
  // families is super admin.
  const SUPER_ADMIN = new Set(['assertSuperAdmin', 'requireSuperAdmin', 'isSuperAdmin']);

  it('a service-client family key from the caller is super-admin gated', () => {
    const offenders: string[] = [];
    for (const file of SERVICE_MODULES) {
      const sf = parse(file);
      const locals = localFunctions(sf);
      for (const action of exportedActions(sf, file)) {
        if (!action.fn.body || !holdsServiceClient(action.fn.body)) continue;
        const hits = callerSuppliedFamilyKeys(action.fn, sf);
        if (hits.length === 0) continue;

        const reaches = (name: string, seen = new Set<string>()): boolean => {
          if (seen.has(name)) return false;
          seen.add(name);
          const body = locals.get(name);
          if (!body) return false;
          const called = callees(body);
          for (const c of called) if (SUPER_ADMIN.has(c)) return true;
          for (const c of called) if (locals.has(c) && reaches(c, seen)) return true;
          return false;
        };
        if (reaches(action.name)) continue;
        offenders.push(`${action.rel}:${action.line}  ${action.name}\n      ${hits.join('\n      ')}`);
      }
    }
    expect(
      offenders,
      'this action hands a caller-supplied family id to the service client, which RLS does not check. '
      + 'Take the family from the authenticated context instead, or gate the action on super admin',
    ).toEqual([]);
  });
});

describe('the detector fires on the shape it is policing', () => {
  // Both sweeps above currently find nothing. A sweep that finds nothing because
  // it cannot see is indistinguishable from one that finds nothing because the
  // code is clean — so prove it on code that IS broken.
  const parseText = (text: string): ts.SourceFile =>
    ts.createSourceFile('synthetic.ts', text, ts.ScriptTarget.Latest, true);

  it('catches an unguarded action, and clears the guarded one beside it', () => {
    const sf = parseText(`'use server';
      import { createServiceClient } from '@/lib/supabase/server';
      import { requireUserContext } from '@/lib/supabase/auth';
      export async function guardedAction(input: { id: string }): Promise<{ ok: boolean }> {
        const ctx = await requireUserContext();
        return { ok: Boolean(ctx && input.id) };
      }
      export async function unguardedAction(input: { id: string }): Promise<{ ok: boolean }> {
        const db = createServiceClient();
        await db.from('secrets').delete().eq('id', input.id);
        return { ok: true };
      }
    `);
    const locals = localFunctions(sf);
    const names = exportedActions(sf, 'synthetic.ts').map((a) => a.name);
    expect(names).toEqual(['guardedAction', 'unguardedAction']);
    expect(reachesGuard('guardedAction', locals)).toBe(true);
    expect(reachesGuard('unguardedAction', locals)).toBe(false);
  });

  it('sees through the return-type brace that defeated a text scan', () => {
    // The exact shape that produced the false positives: the body's opening
    // brace is NOT the first `{` after the parameter list.
    const sf = parseText(`'use server';
      import { requireUserContext } from '@/lib/supabase/auth';
      export async function issueCardAction(input: {
        childWalletId: string;
      }): Promise<Result<{ cardId: string }>> {
        const ctx = await requireUserContext();
        return { ok: true, cardId: input.childWalletId + ctx.user.id };
      }
    `);
    expect(reachesGuard('issueCardAction', localFunctions(sf)), 'the guard is on the first line of the body')
      .toBe(true);
  });

  it('counts a guard held in a same-module helper', () => {
    const sf = parseText(`'use server';
      import { assertSuperAdmin } from '@/lib/supabase/auth';
      async function gate() { return assertSuperAdmin(); }
      export async function adminThing(): Promise<void> { await gate(); }
    `);
    expect(reachesGuard('adminThing', localFunctions(sf))).toBe(true);
  });

  it('distinguishes a caller-supplied family id from one taken off the context', () => {
    const sf = parseText(`'use server';
      export async function fromCaller(input: { familyId: string }): Promise<void> {
        const db = createServiceClient();
        await db.from('subscriptions').update({ plan: 'free' }).eq('family_id', input.familyId);
      }
      export async function fromContext(input: { plan: string }): Promise<void> {
        const ctx = await requireUserContext();
        const db = createServiceClient();
        await db.from('subscriptions').update({ plan: input.plan }).eq('family_id', ctx.active.familyId);
      }
    `);
    const [caller, context] = exportedActions(sf, 'synthetic.ts');
    expect(holdsServiceClient(caller.fn.body!)).toBe(true);
    expect(callerSuppliedFamilyKeys(caller.fn, sf), 'input.familyId reached the service client').toHaveLength(1);
    // `input.plan` is caller-supplied too, but it is not the family key, and the
    // family key it does use comes off the authenticated context.
    expect(callerSuppliedFamilyKeys(context.fn, sf), 'ctx.active.familyId is not caller-supplied').toEqual([]);
  });
});
