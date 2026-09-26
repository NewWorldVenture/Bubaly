import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Audit C1-S9-50 — ratchet for the unconfirmed-write class.
 *
 * The defect: a PostgREST `update` or `delete` with a filter, whose `error` is
 * checked but which never asks `.select()` for the affected rows. Zero rows and
 * one row are then indistinguishable, so the action reports success for work
 * that may not have happened. `C1-S9-16` found the first two; `C1-S9-46`
 * rebuilt the scan and found 102.
 *
 * This is deliberately a COUNT-PER-FILE baseline in the same shape as
 * `tests/silent-empty-read-ratchet.test.ts`, whose header states the rule this
 * one inherits: **only remove entries as they are fixed — never add.** A count
 * rather than a line number, because line numbers shift and a ratchet that
 * reddens on unrelated edits teaches people to edit the ratchet (the page
 * ratchet under C1-S9-43 broke that way on its own commit).
 *
 * Three verbs are deliberately NOT counted:
 *   - `insert`, which cannot match zero rows — it inserts or it errors.
 *   - `upsert`, which is counted by `C1-S9-46`'s scan separately and whose
 *     conflict semantics need per-site reasoning rather than a blanket rule.
 *   - an unfiltered `update`/`delete`, which has its own, larger problem.
 *
 * And six writes elsewhere are unconfirmed ON PURPOSE (C1-S9-49): the thing the
 * user came for has already succeeded by the time they run, so confirming them
 * would turn a succeeded action into a reported failure. Those live in files
 * below and are part of the counts — the ratchet bounds the class, it does not
 * claim every remaining instance is a defect.
 */
// `[^\S\n]*`, not `\s*`, and a block strip that keeps its newlines: `\s` matches
// the line break, so the original collapsed consecutive comment lines into one.
// Harmless for a count, but it moved every offset — which is exactly how the
// audit scanners came to publish wrong file:line numbers (C1-S9-52). Fixed here
// so the positions this scan reports can be trusted.
const strip = (s: string) => s
  .replace(/^[^\S\n]*\/\/.*$/gm, '')
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  // TRAILING comments too — the fifth defect in this sweep's instruments
  // (C1-S9-60). Only whole-line comments were stripped, so
  //   .eq('family_id', id) // RLS also enforces this; explicit for clarity
  //   .select('id');
  // ended the statement at the semicolon INSIDE the comment, before the
  // `.select`, and a confirmed write was counted as unconfirmed. The same cut
  // can fall before a `.eq(`, making a filtered write look unfiltered and
  // hiding it from the count entirely — the worse direction. Checked when this
  // went in: across every 'use server' file, the only change was the one false
  // positive. `(?<=[ \t])` because a URL's `//` follows a colon, never a space.
  .replace(/(?<=[ \t])\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

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

/** Every counted write, as file + 1-based line. `strip` preserves line numbers. */
function unconfirmedPositions(): Array<{ file: string; line: number }> {
  const files = execSync("grep -rl \"^'use server'\" app lib --include='*.ts' --include='*.tsx'", { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).sort();
  const out: Array<{ file: string; line: number }> = [];
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'));
    const re = /\.(update|delete)\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const before = src.slice(0, m.index);
      const stmtStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('\n\n')) + 1;
      const stmt = statementAt(src, stmtStart);
      if (!/\.from\(/.test(stmt)) continue;
      if (/\.select\(/.test(stmt)) continue;
      if (/count:\s*'exact'/.test(stmt)) continue;
      if (!/\.eq\(|\.in\(|\.match\(|\.neq\(|\.is\(/.test(stmt)) continue;
      out.push({ file: f, line: before.split('\n').length });
    }
  }
  return out;
}

function unconfirmedPerFile(): Map<string, number> {
  const files = execSync("grep -rl \"^'use server'\" app lib --include='*.ts' --include='*.tsx'", { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean).sort();
  const counts = new Map<string, number>();
  for (const f of files) {
    const src = strip(readFileSync(f, 'utf8'));
    const re = /\.(update|delete)\(/g;
    let m: RegExpExecArray | null, n = 0;
    while ((m = re.exec(src))) {
      const before = src.slice(0, m.index);
      const stmtStart = Math.max(before.lastIndexOf(';'), before.lastIndexOf('\n\n')) + 1;
      const stmt = statementAt(src, stmtStart);
      if (!/\.from\(/.test(stmt)) continue;      // not a database write
      if (/\.select\(/.test(stmt)) continue;      // confirmed by representation
      // Confirmed by COUNT instead. `Prefer: count=exact` is answered whether or
      // not a representation was asked for, so a write carrying it CAN tell zero
      // rows from one — `moveAssignmentAction` does, via `if (!count)`. Counting
      // it as unconfirmed was the scan being wrong about the code, which is the
      // direction this sweep keeps finding first. Audit C1-S9-59.
      if (/count:\s*'exact'/.test(stmt)) continue;
      if (!/\.eq\(|\.in\(|\.match\(|\.neq\(|\.is\(/.test(stmt)) continue; // unfiltered
      n++;
    }
    if (n) counts.set(f, n);
  }
  return counts;
}

// Known unconfirmed writes as of C1-S9-60. ONLY REMOVE or DECREASE entries as
// they are fixed — never add, never increase.
//
// Burn-down since the ratchet went in: 82 across 39 files (C1-S9-50) → 74/37
// (C1-S9-51) → 61/35 (C1-S9-53) → 54/34 (C1-S9-55) → 43/32 (C1-S9-56) → 42/32
// (C1-S9-57) → 35/29 (C1-S9-58) → 26/21 (C1-S9-59, nine writes confirmed) →
// 25/20 (C1-S9-59, `moveAssignmentAction` leaving because the SCAN was wrong
// about it, not because the code changed) → 10/6 (C1-S9-60: nine confirmed with a
// bail, four plus two concierge stamps confirmed for the log, and one more scan
// defect). Each
// step edited this baseline DOWN, and the stale-entry case below is what forced
// the edit rather than leaving fixed files sitting here quietly.
//
// **Every entry left is deliberate.** Ten writes where zero rows is the ordinary
// outcome or the thing asked for (a reset of something never customised, a
// throttle row that does not exist until a first failure, an annotation on a row
// that is being kept on purpose). The last case below holds them to that: each
// must carry its reason beside the code, so this list can no longer grow a
// member that is merely unfixed.
const BASELINE = new Map<string, number>([
  ['app/(app)/admin/marketing/content/actions.ts', 2],
  ['app/(app)/admin/services/actions.ts', 1],
  ['app/(app)/dashboard/customize-actions.ts', 2],
  ['app/(app)/dashboard/library/actions.ts', 2],
  ['app/(app)/dashboard/social-feed/actions.ts', 1],
  ['app/(app)/family/child-login-actions.ts', 2],
]);

describe('the unconfirmed-write class only shrinks (C1-S9-50)', () => {
  const found = unconfirmedPerFile();

  it('no file has MORE unconfirmed writes than its baseline', () => {
    const grew: string[] = [];
    for (const [file, n] of found) {
      const allowed = BASELINE.get(file) ?? 0;
      if (n > allowed) grew.push(`${file}: ${n} > ${allowed}`);
    }
    expect(grew, 'a write that reports success it cannot see was added').toEqual([]);
  });

  it('no NEW file joins the class', () => {
    const added = [...found.keys()].filter((f) => !BASELINE.has(f)).sort();
    expect(added, 'a server-action file grew its first unconfirmed write').toEqual([]);
  });

  it('the baseline lists no file that is already clean', () => {
    // Keeps the ratchet honest, exactly as silent-empty-read-ratchet does: a
    // baseline that lets fixed files linger quietly widens the hole it closes.
    const stale = [...BASELINE.keys()].filter((f) => !found.has(f)).sort();
    expect(stale, 'BASELINE lists files with no unconfirmed writes left — remove them').toEqual([]);
  });

  it('every remaining member states its reason beside the code (C1-S9-60)', () => {
    // With the class burned down to its deliberate members, "bounded" is no
    // longer the strongest thing that can be said — each one is there on
    // purpose. So each must have a comment naming its audit entry within the
    // twelve lines above it. A new unconfirmed write fails the cases above; this
    // one fails a surviving write whose reason has been deleted, which is how a
    // deliberate exemption quietly turns back into an unexamined one.
    const missing: string[] = [];
    for (const { file, line } of unconfirmedPositions()) {
      const lines = readFileSync(file, 'utf8').split('\n');
      const above = lines.slice(Math.max(0, line - 13), line).join('\n');
      if (!/\/\/.*Audit C1-S9-\d+/.test(above)) missing.push(`${file}:${line}`);
    }
    expect(missing, 'an unconfirmed write with no stated reason beside it').toEqual([]);
  });

  it('the baseline total matches what C1-S9-49 recorded', () => {
    // If this number moves without finalaudit.md moving with it, one of the two
    // is wrong — and the register is the thing other workers read.
    const total = [...BASELINE.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(10);
  });
});
