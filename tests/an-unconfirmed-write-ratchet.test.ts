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
const strip = (s: string) => s.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

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
      if (/\.select\(/.test(stmt)) continue;      // confirmed
      if (!/\.eq\(|\.in\(|\.match\(|\.neq\(|\.is\(/.test(stmt)) continue; // unfiltered
      n++;
    }
    if (n) counts.set(f, n);
  }
  return counts;
}

// Known unconfirmed writes as of C1-S9-55. ONLY REMOVE or DECREASE entries as
// they are fixed — never add, never increase.
//
// Burn-down since the ratchet went in: 82 across 39 files (C1-S9-50) → 74/37
// (C1-S9-51) → 61/35 (C1-S9-53) → 54/34 (C1-S9-55). Each step edited this baseline DOWN, and the
// stale-entry case below is what forced the edit rather than leaving fixed
// files sitting here quietly.
const BASELINE = new Map<string, number>([
  ['app/(app)/admin/marketing/affiliates/actions.ts', 1],
  ['app/(app)/admin/marketing/content/actions.ts', 2],
  ['app/(app)/admin/marketing/social/recurring/actions.ts', 2],
  ['app/(app)/admin/services/actions.ts', 1],
  ['app/(app)/dashboard/assistants/actions.ts', 1],
  ['app/(app)/dashboard/auto/actions.ts', 1],
  ['app/(app)/dashboard/concierge/actions.ts', 2],
  ['app/(app)/dashboard/contacts/[id]/actions.ts', 1],
  ['app/(app)/dashboard/customize-actions.ts', 2],
  ['app/(app)/dashboard/dining/actions.ts', 1],
  ['app/(app)/dashboard/family-digital-twin/actions.ts', 1],
  ['app/(app)/dashboard/family-signals/actions.ts', 1],
  ['app/(app)/dashboard/home/actions.ts', 1],
  ['app/(app)/dashboard/insight-actions.ts', 1],
  ['app/(app)/dashboard/library/actions.ts', 3],
  ['app/(app)/dashboard/life-event-actions.ts', 1],
  ['app/(app)/dashboard/moment-actions.ts', 1],
  ['app/(app)/dashboard/paperwork/actions.ts', 1],
  ['app/(app)/dashboard/playbook/playbook-actions.ts', 1],
  ['app/(app)/dashboard/recipes/vote/actions.ts', 2],
  ['app/(app)/dashboard/relationship/actions.ts', 2],
  ['app/(app)/dashboard/social-feed/actions.ts', 4],
  ['app/(app)/dashboard/sync/feeds/actions.ts', 1],
  ['app/(app)/dashboard/trip-intel/actions.ts', 4],
  ['app/(app)/dashboard/trust/actions.ts', 1],
  ['app/(app)/dashboard/workload/actions.ts', 1],
  ['app/(app)/family/child-login-actions.ts', 3],
  ['app/(app)/feedback/actions.ts', 1],
  ['app/(app)/marketplace/actions.ts', 4],
  ['app/(app)/marketplace/alerts/actions.ts', 2],
  ['app/(app)/marketplace/community/actions.ts', 1],
  ['app/(app)/marketplace/handoff/actions.ts', 1],
  ['app/(app)/missions/actions.ts', 1],
  ['app/onboarding/actions.ts', 1],
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

  it('the baseline total matches what C1-S9-49 recorded', () => {
    // If this number moves without finalaudit.md moving with it, one of the two
    // is wrong — and the register is the thing other workers read.
    const total = [...BASELINE.values()].reduce((a, b) => a + b, 0);
    expect(total).toBe(54);
  });
});
