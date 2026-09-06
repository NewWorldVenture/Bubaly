// An approval a parent can grant has to be one Bubaly can then carry out.
//
// The gate stores `{name, args}` as the approval's payload
// (lib/trust/server.ts openApprovalRequest), and `approveRequest` replays it
// with `executeTool(scope, name, args)` (lib/services/approvals/index.ts).
// `executeTool` resolves the name through the tool registry and DENIES an
// unknown one, so a gated chat tool with no registry equivalent produces an
// approval that fails the moment a parent says yes:
//
//     "Approved, but Bubaly could not finish it: Bubaly has no tool called
//      "add_note", so nothing was done."
//
// That is invisible until a household actually turns approvals on, which is
// why it needs a test rather than a comment. This one fails in BOTH
// directions: a newly gated tool with no registry equivalent has to be named
// in `APPROVAL_CANNOT_REPLAY` with a reason, and an entry that gains one has
// to be removed. Same shape as tests/notification-write-boundary.test.ts.
import { describe, expect, it } from 'vitest';
import { APPROVAL_CANNOT_REPLAY, TOOL_DOMAIN } from '@/lib/assistant/trust-wrapper';
import { getTool } from '@/lib/ai/tools/registry';

const GATED = Object.keys(TOOL_DOMAIN).sort();

describe('a gated chat tool can be replayed from its approval', () => {
  it('has something to gate at all', () => {
    // Guards the two assertions below against passing vacuously if TOOL_DOMAIN
    // were emptied or renamed — an empty map satisfies every "for each" below.
    expect(GATED.length).toBeGreaterThanOrEqual(11);
  });

  it('every gated tool either resolves in the registry or is named as one that cannot', () => {
    const orphans = GATED.filter((name) => !getTool(name) && !(name in APPROVAL_CANNOT_REPLAY));
    expect(
      orphans,
      `gated with no registry tool and no entry in APPROVAL_CANNOT_REPLAY, so approving one fails: ${orphans.join(', ')}`,
    ).toEqual([]);
  });

  it('no entry outlives the gap it describes', () => {
    // A tool that gained a registry equivalent must leave the list, or the
    // family keeps being told Bubaly cannot finish something it now can.
    const stale = Object.keys(APPROVAL_CANNOT_REPLAY).filter((name) => getTool(name));
    expect(stale, `now resolvable; drop from APPROVAL_CANNOT_REPLAY: ${stale.join(', ')}`).toEqual([]);
  });

  it('no entry names a tool that is not gated', () => {
    const unmapped = Object.keys(APPROVAL_CANNOT_REPLAY).filter((name) => !(name in TOOL_DOMAIN));
    expect(unmapped, `not in TOOL_DOMAIN, so it is never gated: ${unmapped.join(', ')}`).toEqual([]);
  });

  it('every entry carries a reason, not just a name', () => {
    for (const [name, reason] of Object.entries(APPROVAL_CANNOT_REPLAY)) {
      expect(reason.length, `${name} has no reason`).toBeGreaterThan(20);
    }
  });

  it('the three known orphans are exactly the ones with no service behind them', () => {
    // Pinned by name so the count cannot drift silently. Each is written only
    // in lib/assistant/tools.ts: there is no lib/services/notes, no
    // lib/services/goals, and nothing under lib/ai/tools/ writes event_rsvps.
    expect(Object.keys(APPROVAL_CANNOT_REPLAY).sort()).toEqual(['add_goal', 'add_note', 'rsvp_to_event']);
  });

  it('the tools that DO resolve reach a real registry tool, not a same-named stub', () => {
    // The point of the registry lookup is that the replay writes the same row
    // the chat write would have. A resolved tool with no execute would satisfy
    // the assertion above and still fail at replay.
    for (const name of GATED.filter((n) => !(n in APPROVAL_CANNOT_REPLAY))) {
      const tool = getTool(name);
      expect(tool, `${name} no longer resolves`).toBeTruthy();
      expect(typeof tool?.execute, `${name} resolves to something with no execute`).toBe('function');
    }
  });
});
