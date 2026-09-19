import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A server module may not hand a raw database message back as its error.
//
// `lib/supabase/errors.ts` exists to stop exactly this, and 67 call sites in 27
// files went around it — `if (error) return { ok: false, error: error.message }`
// in a server action, over and over. The string in `error.message` was written
// by Postgres for whoever maintains the schema:
//
//   invalid input value for enum redemption_status: "bogus"
//   function public.award_allowance(uuid, bigint) does not exist
//   relation "public.wallet_ledger_private" does not exist
//
// Each is a piece of the schema handed to anyone who can make a query fail.
// It is reconnaissance rather than a break on its own, and it contradicts a
// boundary the codebase had already written down and then walked past.
//
// CLIENT components are deliberately not covered. A `'use client'` module got
// its error from PostgREST in the browser's own memory; re-describing it there
// hides nothing from anybody. The boundary is the server's response.

const ROOT = process.cwd();

/** Files this rule governs: everything under app/ and lib/ that is not a
 *  client component, and not the normaliser itself. */
function serverModules(): string[] {
  const all = execSync("git ls-files 'app/*.ts' 'app/*.tsx' 'lib/*.ts' 'lib/*.tsx'", { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  expect(all.length, 'the file list has gone stale').toBeGreaterThan(200);
  return all.filter((f) => {
    if (f === 'lib/supabase/errors.ts') return false;
    const head = readFileSync(`${ROOT}/${f}`, 'utf8').slice(0, 600);
    return !/^\s*['"]use client['"]/m.test(head);
  });
}

// `error: err.message`, `error: e?.message`, `message: dbError.message` — an
// object-literal property carrying a raw message straight out of an error.
//
// The key decides how much the identifier has to look like an error, because a
// bare `e` is ambiguous and the ambiguity bit: `lib/ai/runs/detail.ts` maps run
// EVENTS with `events.map((e) => ({ …, message: e.message }))`, where `e` is a
// row and `e.message` is its own column. Under `error:` a bare `e` is an error
// by context — `catch (e) { return { error: e.message } }` is the shape this
// rule exists for. Under `message:` it is not, so there the name must say so.
const RAW = /\b(error|message)\s*:\s*([A-Za-z_$][\w$]*)\??\.message\b/g;
const AN_ERROR_BY_NAME = /err(or)?$/i;
const AN_ERROR_UNDER_ERROR_KEY = /^(e|err|error)$|err(or)?$/i;

function rawMessageReturns(file: string): string[] {
  const out: string[] = [];
  readFileSync(`${ROOT}/${file}`, 'utf8').split('\n').forEach((line, i) => {
    // Logging is not a response. A server log is the one place the raw string
    // belongs — it is how anyone diagnoses the failure the user was just
    // spared.
    if (/\bconsole\.|\blogger?\./.test(line)) return;
    for (const m of line.matchAll(RAW)) {
      const [, key, name] = m;
      const looksLikeAnError = key === 'error'
        ? AN_ERROR_UNDER_ERROR_KEY.test(name)
        : AN_ERROR_BY_NAME.test(name);
      if (looksLikeAnError) out.push(`${file}:${i + 1}  ${line.trim()}`);
    }
  });
  return out;
}

describe('a server module describes a database error rather than repeating it', () => {
  it('has no raw .message crossing the response boundary', () => {
    const leaks = serverModules().flatMap(rawMessageReturns);
    expect(
      leaks,
      'Use describeActionError(error) — or describeActionError(error, "Could not save the thing.") '
      + 'when there is a specific sentence worth showing. It returns the written message for every '
      + 'classified failure and the fallback for anything else.',
    ).toEqual([]);
  });

  // The rule is worth nothing if it governs an empty set, and this suite has
  // been burned by a pattern that matched no file at all before.
  it('is actually looking at the server modules', () => {
    const files = serverModules();
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith('/actions.ts'))).toBe(true);
    expect(files.some((f) => f.startsWith('lib/storage/'))).toBe(true);
    // …and it can still see a leak when there is one.
    expect(rawMessageReturns.toString()).toContain('matchAll');
  });
});
