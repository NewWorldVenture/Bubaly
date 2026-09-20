import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// A layout guards a PAGE. It does not guard a server action.
//
// `app/(app)/admin/layout.tsx` redirects a non-super-admin to /dashboard, and
// that is correct and not sufficient: a `'use server'` export is its own
// endpoint, invocable by anyone with a session and the action id, whether or
// not they ever render the page it was written for. So every exported admin
// action has to reach the gate by itself.
//
// All 138 do, today. This guard is for the 139th.
//
// ── why the check is transitive ────────────────────────────────────────────
//
// Counting `isSuperAdmin` inside each action's own body reports 38 failures and
// every one is wrong. The admin code gates through helpers, at more than one
// depth:
//
//   adminCreateUserAction  -> assertSuperAdmin()   -> isSuperAdmin()
//   createSegment          -> requireMarketingAdmin() (imported, gates inside)
//   resolveTicketAction    -> updateTicket()       -> guard() -> isSuperAdmin()
//
// One level of indirection brings 38 down to 3; the remaining 3 are the
// support-ticket actions, which are two levels deep. Resolving to a fixpoint
// brings it to 0 — which is the true answer, and the reason this file walks the
// call graph instead of grepping each function.
//
// ── why the walk is by directive, not by filename ──────────────────────────
//
// Today every admin action lives in a file with `actions` in its name, and a
// filename walk would answer correctly. It would also keep answering "all
// clear" the first time someone puts `'use server'` in `admin/<thing>/server.ts`
// — the rule right, the search too small to reach the violation. So the walk
// takes any file under the admin tree that carries the directive, plus the
// `actions`-named files, and `covers every 'use server' file` below fails if
// those two ever disagree.
const ROOT = join('app', '(app)', 'admin');

/** Gates that end the search: each refuses a non-super-admin by itself. */
const KNOWN_GATES = ['isSuperAdmin', 'requireMarketingAdmin', 'isSuperAdminEmail'];

const USE_SERVER = /^\s*(['"])use server\1\s*;?\s*$/m;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/** Every file under the admin tree that can export a server action. */
export function actionFiles(dir: string): string[] {
  return sourceFiles(dir).filter(
    (f) => f.includes('actions') || USE_SERVER.test(readFileSync(f, 'utf8')));
}

/** Comment bodies blanked, newlines kept, so a gate named in prose is not a gate. */
function stripComments(source: string): string {
  const chars = [...source];
  for (const m of source.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g)) {
    for (let i = m.index!; i < m.index! + m[0].length; i++) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

// Every top-level declaration, so a body is sliced at the next one and cannot
// absorb its neighbour's calls. `const` is here for two reasons: a server
// action may be written `export const x = async () => {}`, and a plain `const`
// between two functions has to end the first one's body.
const DECL = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+(\w+)/gm;
/** `function f`, `const f = () =>`, `const f = async function` — not `const N = 5`. */
const FUNCTION_LIKE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+\w+|^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]*)?=\s*(?:async\s*)?(?:function\b|\(|\w+\s*=>)/;

/** Exported actions in one file that cannot reach a gate by any call path. */
export function ungatedActions(source: string): string[] {
  const src = stripComments(source);
  const decls = [...src.matchAll(DECL)];
  const bodies = new Map<string, string>();
  const exportedActions: string[] = [];
  decls.forEach((m, i) => {
    const end = i + 1 < decls.length ? decls[i + 1].index! : src.length;
    const body = src.slice(m.index!, end);
    if (!FUNCTION_LIKE.test(body)) return;
    bodies.set(m[1], body);
    if (/^export\b/.test(body)) exportedActions.push(m[1]);
  });

  // A function is gated if it calls a known gate, or calls something in this
  // file that is gated. Iterate until nothing new becomes gated.
  const gated = new Set(KNOWN_GATES);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, body] of bodies) {
      if (gated.has(name)) continue;
      for (const g of gated) {
        if (new RegExp(`\\b${g}\\s*\\(`).test(body)) { gated.add(name); changed = true; break; }
      }
    }
  }

  return exportedActions.filter((name) => !gated.has(name));
}

describe('every admin server action reaches a super-admin gate', () => {
  const files = actionFiles(ROOT);

  it('finds the admin action surface (sanity: the walk works)', () => {
    expect(files.length).toBeGreaterThan(20);
    const exported = files.reduce(
      (n, f) => n + [...readFileSync(f, 'utf8').matchAll(/^export\s+async\s+function\s+/gm)].length, 0);
    expect(exported).toBeGreaterThan(100);
  });

  it('covers every \'use server\' file under the admin tree', () => {
    const directive = sourceFiles(ROOT).filter((f) => USE_SERVER.test(readFileSync(f, 'utf8')));
    const missed = directive.filter((f) => !files.includes(f));
    expect(missed, `'use server' files the walk does not read:\n${missed.join('\n')}`).toEqual([]);
    expect(directive.length).toBeGreaterThan(20);
  });

  it('resolves gates through helpers, at any depth (sanity: the matcher works)', () => {
    // Direct.
    expect(ungatedActions(`export async function a() { await isSuperAdmin(); }`)).toEqual([]);
    // One hop.
    expect(ungatedActions(
      `async function g() { return isSuperAdmin(); }\nexport async function a() { await g(); }`)).toEqual([]);
    // Two hops — the support-ticket shape.
    expect(ungatedActions(
      `async function g() { return isSuperAdmin(); }\n` +
      `async function upd() { await g(); }\n` +
      `export async function a() { return upd(); }`)).toEqual([]);
    // None at all.
    expect(ungatedActions(`export async function a() { await doThing(); }`)).toEqual(['a']);
    // A gate named only in prose is not a gate.
    expect(ungatedActions(`// calls isSuperAdmin() elsewhere\nexport async function a() { await doThing(); }`)).toEqual(['a']);
    // An arrow-form action is an action.
    expect(ungatedActions(`export const a = async () => { await doThing(); };`)).toEqual(['a']);
    expect(ungatedActions(`export const a = async () => { await isSuperAdmin(); };`)).toEqual([]);
    // A plain const is not an action, and does not end up reported.
    expect(ungatedActions(`export const LIMIT = 5;`)).toEqual([]);
    // A const between two functions ends the first one's body: `b` must not
    // inherit `a`'s gate, nor `a` inherit `b`'s.
    expect(ungatedActions(
      `export async function a() { await isSuperAdmin(); }\n` +
      `const SEP = 1;\n` +
      `export async function b() { await doThing(); }`)).toEqual(['b']);
  });

  it('has no exported admin action that skips the gate', () => {
    const offenders = files.flatMap((f) =>
      ungatedActions(readFileSync(f, 'utf8')).map((n) => `${f} :: ${n}`));
    expect(offenders, `admin server actions reachable without a super-admin check:\n${offenders.join('\n')}`).toEqual([]);
  });
});
