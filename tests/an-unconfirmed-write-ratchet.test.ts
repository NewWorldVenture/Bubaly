import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { USE_SERVER_FILES, perFile, unconfirmedWritesIn } from './helpers/unconfirmed-writes';

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
// The scanner lives in `tests/helpers/unconfirmed-writes.ts` since C1-S9-61,
// shared with the sibling ratchet over everything that is NOT a server action,
// so the two cannot drift. Its header lists the five defects it has had.
const unconfirmedPositions = () => USE_SERVER_FILES().flatMap(unconfirmedWritesIn);
const unconfirmedPerFile = () => perFile(unconfirmedPositions());

// Known unconfirmed writes as of C1-S9-61. ONLY REMOVE or DECREASE entries as
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
// **And then UP by four, at C1-S9-61 — the one time this list has grown, and
// not because the code did.** The scanner was widened for a sibling ratchet and
// three of its defects surfaced on the way, two of which hid writes here:
//   - A write built across statements (`let q = …update(…)`, `q = q.eq(…)`,
//     `await q`) had no filter in its declaring statement and was skipped. Two
//     `admin_notifications` mark-reads.
//   - A write that is the FIRST statement in a block began, for the scanner, at
//     the last `;` — before the `if` — so a `.select(` anywhere in the
//     surrounding if/else confirmed it. Six writes, four of them real defects,
//     fixed in the same pass (a CRM claim that could overwrite an owner, a
//     departure event re-pointed at after deletion, two chore rollbacks).
// The four that are deliberate are counted, each with its reason beside it.
// 10/6 → 14/10. C1-S9-60's "every remaining write is deliberate" was true only
// of the writes the scanner could see.
//
// **Every entry left is deliberate.** Fourteen writes where zero rows is the ordinary
// outcome or the thing asked for (a reset of something never customised, a
// throttle row that does not exist until a first failure, an annotation on a row
// that is being kept on purpose). The last case below holds them to that: each
// must carry its reason beside the code, so this list can no longer grow a
// member that is merely unfixed.
const BASELINE = new Map<string, number>([
  ['app/(app)/admin/feedback/actions.ts', 1],
  ['app/(app)/admin/marketing/content/actions.ts', 2],
  ['app/(app)/admin/marketing/platform/actions.ts', 1],
  ['app/(app)/admin/notifications-actions.ts', 1],
  ['app/(app)/admin/services/actions.ts', 1],
  ['app/(app)/dashboard/customize-actions.ts', 2],
  ['app/(app)/dashboard/library/actions.ts', 2],
  ['app/(app)/dashboard/social-feed/actions.ts', 1],
  ['app/(app)/family/child-login-actions.ts', 2],
  ['app/(app)/feedback/actions.ts', 1],
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

  it('no file has FEWER than its baseline — a fix must prune it (C1-S9-61)', () => {
    // The stale-entry case below only fires when a file empties. A file going
    // from two to one stayed at two here, so the baseline drifted above the code
    // and the slack could be spent on a new write without anything going red.
    // Found when a probe counted 120 against a baseline of 121 and every case
    // still passed.
    const shrank: string[] = [];
    for (const [file, allowed] of BASELINE) {
      const n = found.get(file) ?? 0;
      if (n > 0 && n < allowed) shrank.push(`${file}: ${n} < ${allowed}`);
    }
    expect(shrank, 'lower these entries to match the code').toEqual([]);
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
    expect(total).toBe(14);
  });
});
