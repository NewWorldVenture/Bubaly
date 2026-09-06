import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Two client silent-write-failure bugs:
//  - autopilot resolve(): approving a "create reminder" suggestion inserted a
//    real family_reminders row with a bare await, then marked the suggestion
//    executed and toasted "Bubaly handled it" — a failed insert meant the user
//    was told it was handled while no reminder existed.
//
//    The write now goes through `createReminderAction` (§7), because the raw
//    insert sent `status: 'pending'` and `priority: 'normal'` — neither is in
//    0014's CHECK sets, so it was rejected EVERY time and this guard was the
//    only reason the family saw an error rather than a false "handled". The
//    property is unchanged and is what these two cases hold: capture the
//    outcome, and do not claim success ahead of it.
//  - voting vote(): the single-choice clear-delete (removing the prior vote
//    before inserting the new one) dropped its error; if the clear silently
//    failed but the insert succeeded, the member ended up with two votes on a
//    single-choice poll.
function body(src: string, fn: string): string {
  const start = src.indexOf(`async function ${fn}(`);
  expect(start, `${fn} should exist`).toBeGreaterThan(-1);
  const after = src.indexOf('async function ', start + 1);
  return src.slice(start, after === -1 ? undefined : after);
}

describe('autopilot resolve reminder insert fails visibly', () => {
  const b = body(readFileSync('components/modules/autopilot-module.tsx', 'utf8'), 'resolve');

  it('captures the reminder write’s outcome', () => {
    expect(b).toContain('const reminder = await createReminderAction(');
    expect(b).toContain('if (!reminder.ok) return toastError(reminder.error)');
    // And never goes back to a bare insert whose result nobody reads.
    expect(b).not.toMatch(/\.from\('family_reminders'\)/);
  });

  it("only marks the suggestion executed / claims success after that guard", () => {
    // A source-position check cannot tell "refuses" from "refuses too late" in
    // general; what it can tell here is that the claim of success is written
    // after the guard rather than before it, which is the bug that happened.
    const guard = b.indexOf('if (!reminder.ok) return toastError');
    const markExecuted = b.indexOf("status = 'executed'");
    expect(guard).toBeGreaterThan(-1);
    expect(markExecuted).toBeGreaterThan(guard);
  });
});

describe('voting vote clear/un-vote deletes fail visibly', () => {
  const b = body(readFileSync('components/modules/voting-module.tsx', 'utf8'), 'vote');

  it('the un-vote delete surfaces its error', () => {
    expect(b).toContain('const { error: unErr } = await supabase.from');
    expect(b).toContain('if (unErr) toastError(describeDbError(unErr))');
  });

  it('the single-choice clear returns before inserting when the clear fails', () => {
    const clear = b.indexOf('const { error: clearErr } = await supabase.from');
    const clearGuard = b.indexOf('if (clearErr) return toastError');
    const insert = b.indexOf(".insert({ family_id: familyId, poll_id");
    expect(clear).toBeGreaterThan(-1);
    expect(clearGuard).toBeGreaterThan(clear);
    expect(insert).toBeGreaterThan(clearGuard);
  });
});
