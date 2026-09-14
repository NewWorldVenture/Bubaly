// `readOnly: true` is not a label. lib/ai/tools/execute.ts skips the write gate
// for such a tool — no evaluateTrust, no approval_requests row, and
// trailActionFor() returns null so nothing lands in the household trail either.
// The gate therefore believes what each tool says about itself, and until this
// file nothing checked whether it was true.
//
// The registry is a closed set of 94 tools, 48 of them read-only. All 48 are
// honest today. This is what keeps the 49th honest.
//
// Bodies are extracted through the TypeScript AST, by brace matching, NOT by
// taking a fixed number of characters after a function signature. That
// distinction is not stylistic: a character window written while developing this
// check reported `routines.list` as a writer, because `listRoutines` is a pure
// select and the window spilled into `setRoutineEnabled` beneath it.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const ROOT = process.cwd();
const TOOLS = join(ROOT, 'lib/ai/tools');
const MUTATION = /\.(insert|update|upsert|delete)\s*\(/;

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);

function resolveSpec(spec: string, from: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = resolve(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every named function in a file, body text keyed by name — brace-matched by the parser. */
function functionBodies(file: string): Map<string, string> {
  const sf = parse(file);
  const out = new Map<string, string>();
  const collect = (n: ts.Node): void => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) out.set(n.name.text, n.body.getText(sf));
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      out.set(n.name.text, n.initializer.body.getText(sf));
    }
    ts.forEachChild(n, collect);
  };
  ts.forEachChild(sf, collect);
  return out;
}

type Tool = { name: string; file: string; readOnly: boolean; execute: string };

/** Every tool definition literal in the registry's modules. */
function toolDefinitions(): Tool[] {
  const out: Tool[] = [];
  for (const entry of readdirSync(TOOLS)) {
    if (!entry.endsWith('.ts')) continue;
    const file = join(TOOLS, entry);
    const sf = parse(file);
    const visit = (n: ts.Node): void => {
      if (ts.isObjectLiteralExpression(n)) {
        const props = new Map<string, ts.Expression>();
        for (const p of n.properties) {
          if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) {
            props.set(p.name.text, p.initializer);
          }
        }
        const name = props.get('name');
        const readOnly = props.get('readOnly');
        const execute = props.get('execute');
        if (name && readOnly && execute && ts.isStringLiteral(name)) {
          out.push({
            name: name.text,
            file: file.replace(`${ROOT}/`, ''),
            readOnly: readOnly.kind === ts.SyntaxKind.TrueKeyword,
            execute: execute.getText(sf),
          });
        }
      }
      ts.forEachChild(n, visit);
    };
    ts.forEachChild(sf, visit);
  }
  return out;
}

/** Does this handler, or a function it calls one level away, mutate? */
function reachesAMutation(tool: Tool): string | null {
  if (MUTATION.test(tool.execute)) return 'its own handler';
  const called = new Set([...tool.execute.matchAll(/\b([a-zA-Z_$][\w$]*)\s*\(/g)].map((m) => m[1]));
  const absolute = join(ROOT, tool.file);
  const sources = [absolute];
  for (const m of readFileSync(absolute, 'utf8').matchAll(/from\s+'([^']+)'/g)) {
    const r = resolveSpec(m[1], absolute);
    if (r) sources.push(r);
  }
  for (const source of sources) {
    const bodies = functionBodies(source);
    for (const fn of called) {
      const body = bodies.get(fn);
      if (body && MUTATION.test(body)) return `${fn}() in ${source.replace(`${ROOT}/`, '')}`;
    }
  }
  return null;
}

const TOOLS_FOUND = toolDefinitions();

describe('a tool that says it cannot write, cannot write', () => {
  it('finds the surface it is policing', () => {
    // A sweep over an empty registry passes forever.
    expect(TOOLS_FOUND.length, 'no tool definitions parsed').toBeGreaterThan(80);
    expect(TOOLS_FOUND.filter((t) => t.readOnly).length, 'no read-only tools parsed').toBeGreaterThan(30);
    expect(TOOLS_FOUND.filter((t) => !t.readOnly).length, 'no write tools parsed').toBeGreaterThan(30);
  });

  it('no read-only tool reaches a mutation', () => {
    const offenders = TOOLS_FOUND
      .filter((t) => t.readOnly)
      .map((t) => ({ t, where: reachesAMutation(t) }))
      .filter((x) => x.where)
      .map((x) => `${x.t.name} (${x.t.file}) writes via ${x.where}`);
    expect(
      offenders,
      'execute.ts skips evaluateTrust, the approval and the household trail for a read-only tool — '
      + 'so a writer declared read-only is an ungated, unlogged write',
    ).toEqual([]);
  });

  it('the detector fires on a read-only tool that does write', () => {
    // Everything above currently passes, which is the condition under which a
    // blind check is indistinguishable from a clean registry.
    const planted: Tool = {
      name: 'calendar.pretendRead',
      file: 'lib/ai/tools/calendar.ts',
      readOnly: true,
      execute: "async (scope) => { await scope.db.from('calendar_events').delete().eq('id', '1'); }",
    };
    expect(reachesAMutation(planted)).toBe('its own handler');
  });

  it('the detector sees a mutation reached through a helper, not only inline', () => {
    // The harder half: handlers delegate, so a check that only reads the handler
    // would miss a tool whose service call does the writing.
    const viaHelper: Tool = {
      name: 'routines.pretendRead',
      file: 'lib/ai/tools/routines.ts',
      readOnly: true,
      execute: 'async (scope, input) => setRoutineEnabled(scope, input.id, false)',
    };
    expect(reachesAMutation(viaHelper)).toContain('setRoutineEnabled()');
  });

  it('does not mistake a pure read for a write', () => {
    // The false positive this file exists to avoid: a character window after
    // `function listRoutines(` spills into `setRoutineEnabled` below it.
    const pureRead: Tool = {
      name: 'routines.list',
      file: 'lib/ai/tools/routines.ts',
      readOnly: true,
      execute: 'async (scope) => listRoutines(scope)',
    };
    expect(reachesAMutation(pureRead), 'listRoutines is a select; only its neighbour writes').toBeNull();
  });
});
