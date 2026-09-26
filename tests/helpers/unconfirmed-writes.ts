import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The scanner behind the unconfirmed-write ratchets (C1-S9-50, C1-S9-61).
 *
 * The defect it counts: a PostgREST `update` or `delete` with a filter, whose
 * `error` may be checked but which never asks for the affected rows — neither
 * `.select()` (`Prefer: return=representation`) nor `{ count: 'exact' }`
 * (`Prefer: count=exact`). Zero rows and one row are then indistinguishable.
 *
 * Moved here from `an-unconfirmed-write-ratchet.test.ts` when a second ratchet
 * needed it, so the two cannot drift. Every rule below has been wrong at least
 * once; the audit IDs say where, because the next person to "simplify" one of
 * them should know what it was catching.
 */

/**
 * Strip comments while keeping every newline, so line numbers survive.
 *
 * - `[^\S\n]*`, not `\s*`: `\s` matches the line break, so the original,
 *   starting at a blank or whitespace-only line directly above a comment, ate
 *   that line's newline on the way to the `//` — and every offset after it
 *   moved (C1-S9-52).
 * - Block comments become spaces, not nothing, for the same reason.
 * - TRAILING comments too (C1-S9-60): `.eq(...) // a; b` otherwise ends the
 *   statement at the comment's semicolon, before a `.select`. `(?<=[ \t])`
 *   because a URL's `//` follows a colon, never whitespace.
 */
export const stripComments = (s: string): string => s
  .replace(/^[^\S\n]*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(?<=[ \t])\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

/**
 * Where the statement containing `index` begins: walking BACK to the first
 * `;`, `{` or `}` at bracket depth zero (or a blank line).
 *
 * The first version looked back for the last `;` only — the eighth defect in
 * these instruments, found under C1-S9-61 by a mutation that survived. For a
 * write that is the FIRST statement inside a block,
 *   if (x) {
 *     await db.from('t').update(v).eq('id', id);
 * the last `;` is before the `if`, so the "statement" became the whole
 * `if … else …` up to the next top-level `;`, and a `.select(` ANYWHERE in it —
 * an else branch's insert, a read further down — counted the write as
 * confirmed. Brackets are tracked so a `{` inside `from(\`${t}\`)` or an
 * argument list does not end the walk early.
 */
function statementStart(src: string, index: number): number {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = src[i];
    if (c === ')' || c === ']') depth++;
    else if (c === '(' || c === '[') {
      if (depth === 0) return i + 1;
      depth--;
    } else if (depth === 0 && (c === ';' || c === '{' || c === '}')) return i + 1;
    else if (depth === 0 && c === '\n' && src[i - 1] === '\n') return i + 1;
  }
  return 0;
}

/** From `start` to the first `;` at bracket depth zero. */
function statementAt(src: string, start: number): string {
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth <= 0) break;
  }
  return src.slice(start, i + 1);
}

/**
 * Filters that make a write TARGETED. The range operators were added under
 * C1-S9-61: a write narrowed by `.lt()` alone was read as unfiltered and
 * skipped. Checked when added — it hid nothing at the time.
 */
const FILTERED = /\.(eq|neq|in|is|match|lt|lte|gt|gte|like|ilike|contains|filter|or|not)\(/;
const CONFIRMED = /\.select\(|count:\s*'exact'/;

/**
 * A table access. `.from(` alone missed the guardian routes' wrapper,
 * `gFrom('guardian_screening_sessions')` — 31 call sites — so their writes were
 * visible only when an over-long statement happened to swallow a real `.from(`
 * from somewhere before them. Correcting the statement start (below) removed
 * that accident and exposed the gap. A `…From(` call is accepted when its first
 * argument is a string literal, which is what a table name is and what the
 * repository's other `…From(` helpers (`snippetFrom(x)`, `statusFrom(x)`) are
 * not. The ninth defect. Audit C1-S9-61.
 */
const TABLE_ACCESS = /\.from\(|\b[a-z]\w*From\(\s*['"`]/;

export type WriteSite = { file: string; line: number };

/**
 * Every unconfirmed, filtered write in one file.
 *
 * Two shapes. The single statement — `await db.from(t).update(x).eq(...)` —
 * is read whole. The BUILDER — `let q = db.from(t).update(x); q = q.eq(...);
 * await q` — was invisible before C1-S9-61: the declaring statement has no
 * filter, so it was skipped as unfiltered, and the statements that filtered and
 * ran it contain no `.from(`. It is now followed from the declaration to the
 * first `await <name>`, and judged on everything in between.
 */
export function unconfirmedWritesIn(file: string): WriteSite[] {
  const src = stripComments(readFileSync(file, 'utf8'));
  const out: WriteSite[] = [];
  const re = /\.(update|delete)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const before = src.slice(0, m.index);
    const stmtStart = statementStart(src, m.index);
    let stmt = statementAt(src, stmtStart);
    if (!TABLE_ACCESS.test(stmt)) continue;

    // `=(?!\s*await\b)`, not `=\s*(?!await\b)`: the latter backtracks — `\s*`
    // matches nothing, the lookahead sees " await", passes — and a plain
    // `const r = await db.from(…)…` was taken for a builder and DROPPED. Caught
    // by `tests/unconfirmed-writes-scanner.test.ts` before it shipped.
    const builder = /^\s*(?:let|const)\s+(\w+)\s*=(?!\s*await\b)/.exec(stmt);
    if (builder) {
      // Collect every later statement that mentions the builder, up to the one
      // that awaits or returns it, and judge them together. Following only the
      // literal `await <name>` (the first version) missed a builder awaited
      // inside an expression — `await (c ? q.is(…) : q.eq(…)).select(…)` —
      // which it then treated as "handed on" and skipped. That one happened to
      // be confirmed; an unconfirmed one would have been hidden.
      const name = builder[1];
      const uses = new RegExp(`\\b${name}\\b`, 'g');
      uses.lastIndex = stmtStart + stmt.length;
      let terminal: string | null = null;
      let u: RegExpExecArray | null;
      while ((u = uses.exec(src))) {
        const at = src.lastIndexOf(';', u.index) + 1;
        const use = statementAt(src, at);
        stmt += use;
        uses.lastIndex = at + use.length;
        if (/\bawait\b|\breturn\b/.test(use)) { terminal = use; break; }
      }
      // A builder RETURNED bare is handed on: whoever runs it owns the
      // confirmation, so it is not counted here. One returned with a `.select`
      // is confirmed by the rule below like any other.
      if (!terminal) continue;
      if (/\breturn\b/.test(terminal) && !/\bawait\b/.test(terminal) && !CONFIRMED.test(stmt)) continue;
    }

    if (CONFIRMED.test(stmt)) continue;
    if (!FILTERED.test(stmt)) continue;
    out.push({ file, line: before.split('\n').length });
  }
  return out;
}

export function filesMatching(command: string): string[] {
  return execSync(command, { encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();
}

export const USE_SERVER_FILES = () =>
  filesMatching("grep -rl \"^'use server'\" app lib --include='*.ts' --include='*.tsx'");

/** Everything else under app/ and lib/ that can reach the database. */
export const NON_ACTION_FILES = () => {
  const actions = new Set(USE_SERVER_FILES());
  return filesMatching("grep -rlE '\\.(update|delete)\\(' app lib --include='*.ts' --include='*.tsx'")
    .filter((f) => !actions.has(f) && !/\.test\.|\.d\.ts$/.test(f));
};

export function perFile(sites: WriteSite[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.file, (counts.get(s.file) ?? 0) + 1);
  return counts;
}
