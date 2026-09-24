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
const ALLOWED = new Map([
  // Admin-only analytics tile: shows its own query failure to the operator
  // debugging it, and never to a family.
  ['app/(app)/admin/marketing/visitor-intelligence/page.tsx', 'admin diagnostics'],
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('server code under app/ answers with a described error, not the database\'s text', () => {
  const findings = files('app').flatMap((file) => readFileSync(file, 'utf8').split('\n')
    .map((line, i) => ({ file, line: i + 1, text: line.trim() }))
    .filter(({ text }) => RAW.test(text) && !text.includes('console.')));

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
