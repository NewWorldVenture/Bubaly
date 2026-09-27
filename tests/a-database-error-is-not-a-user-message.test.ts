import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeActionError } from '@/lib/supabase/errors';

/**
 * A database error is not a message for the person who caused it. (SEC-023)
 *
 * `describeActionError` exists so a server action can answer "without exposing
 * unclassified database or provider details to the browser". Sixty-one returns
 * across 22 files under app/ skipped it and handed back `error.message` — the
 * raw Postgres/PostgREST text. Measured through the real `savePlace` action as a
 * real parent session:
 *
 *   radius 150.5          -> "invalid input syntax for type integer: \"150.5\""
 *   an id that is not one -> "invalid input syntax for type uuid: \"not-a-uuid\""
 *
 * Column types, constraint and table names, and the offending values, in
 * English, in every language. This scan keeps app/ at zero; the one named
 * exception is an admin diagnostics page.
 */

const RAW = /error:\s*[\w$]*(?:[Ee]rr|[Ee]rror)\??\.message\b/;
// The one exception this used to carry — the admin visitor-intelligence tile —
// now describes its error too, so the list is empty and stays honest by being
// empty.
const ALLOWED = new Map<string, string>([]);

/**
 * Line numbers inside a `console.*(…)` call. A log payload is where the raw
 * text belongs; the object form spans lines (`console.error('[x] failed', {\n
 * id, error: err.message,\n })`), so a same-line check alone mistook the
 * middle of a log for a response.
 */
function logLines(source: string): Set<number> {
  const inside = new Set<number>();
  for (const m of source.matchAll(/\bconsole\.(?:error|warn|log|info|debug)\s*\(/g)) {
    let depth = 0;
    let end = m.index!;
    for (let i = m.index! + m[0].length - 1; i < source.length; i++) {
      if (source[i] === '(') depth++;
      else if (source[i] === ')' && --depth === 0) { end = i; break; }
    }
    const first = source.slice(0, m.index!).split('\n').length;
    const last = source.slice(0, end).split('\n').length;
    for (let n = first; n <= last; n++) inside.add(n);
  }
  return inside;
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('server code under app/ answers with a described error, not the database\'s text', () => {
  const findings = files('app').flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    const logs = logLines(source);
    return source.split('\n')
      .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
      .filter(({ line, text }) => RAW.test(text) && !text.includes('console.') && !logs.has(line));
  });

  it('does not count a multi-line log payload as a response', () => {
    const src = "console.error('[x] failed', {\n  id,\n  error: err.message,\n});\nreturn { ok: false, error: err.message };";
    const logs = logLines(src);
    expect(logs.has(3)).toBe(true);
    expect(logs.has(5)).toBe(false);
  });

  it('recognises the shape it is looking for (non-vacuity)', () => {
    expect(RAW.test("if (error) return { ok: false, error: error.message };")).toBe(true);
    expect(RAW.test("if (error || !vote) return { ok: false, error: error?.message ?? 'Could not create vote' };")).toBe(true);
    expect(RAW.test("if (upErr) return { ok: false, error: upErr.message };")).toBe(true);
    expect(RAW.test("if (error) return { ok: false, error: describeActionError(error) };")).toBe(false);
  });

  it('finds none outside the named exception', () => {
    expect(findings.filter(({ file }) => !ALLOWED.has(file))).toEqual([]);
  });

  it('keeps the exception list honest', () => {
    // An entry whose file no longer has the shape is stale and must go.
    for (const file of ALLOWED.keys()) expect(findings.some((f) => f.file === file), file).toBe(true);
  });
});

describe('describeActionError hides what it cannot classify, and keeps what it can', () => {
  it('replaces the two strings measured through savePlace with the fallback', () => {
    expect(describeActionError({ code: '22P02', message: 'invalid input syntax for type integer: "150.5"' }, 'Could not save that place.'))
      .toBe('Could not save that place.');
    expect(describeActionError({ code: '22P02', message: 'invalid input syntax for type uuid: "not-a-uuid"' }, 'Could not save that place.'))
      .toBe('Could not save that place.');
  });

  it('still tells a person when they lack permission, or the thing already exists', () => {
    expect(describeActionError({ code: '42501', message: 'new row violates row-level security policy for table "family_places"' }))
      .toMatch(/permission/i);
    expect(describeActionError({ code: '23505', message: 'duplicate key value violates unique constraint "x"' }))
      .toMatch(/already exists/i);
  });
});
