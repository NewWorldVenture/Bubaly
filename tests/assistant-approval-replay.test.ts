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
import { readFileSync } from 'node:fs';
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

  it('the replay really does run as the approver, which is why rsvp_to_event stays out', () => {
    // The reason for the one remaining orphan is a fact about two other files,
    // so it is pinned here rather than left in a comment that can rot:
    //
    //   1. the approval row records no asker for an AI-filed request, and
    //   2. the decision action builds its scope from the person APPROVING.
    //
    // Together those mean a registry RSVP tool taking member_id from
    // scope.memberId would answer for the parent, and event_rsvps_once makes
    // that an upsert — so it would overwrite the parent's own reply. If either
    // line below stops being true, the orphan can go.
    expect(readFileSync('lib/trust/server.ts', 'utf8'))
      .toContain("requested_by_member_id: req.actor.kind === 'member' ? req.actor.id : null");
    expect(readFileSync('app/(app)/dashboard/approvals-actions.ts', 'utf8'))
      .toContain('scopeFromUserContext(ctx, await createServer())');
    expect(readFileSync('lib/services/scope.ts', 'utf8'))
      .toContain('memberId: ctx.active.member.id');
  });

  it('every entry carries a reason, not just a name', () => {
    for (const [name, reason] of Object.entries(APPROVAL_CANNOT_REPLAY)) {
      expect(reason.length, `${name} has no reason`).toBeGreaterThan(20);
    }
  });

  it('names the one orphan that is left, and it is left on purpose', () => {
    // add_note and add_goal left the list because notes.create and goals.create
    // resolve them — forced, not remembered: the stale-entry check above went
    // red the moment those tools landed.
    //
    // rsvp_to_event stays, and NOT because writing the tool is hard. The replay
    // runs under the APPROVER's scope and the approval row stores
    // requested_by_member_id: null for every AI-filed row, so a tool taking
    // member_id from scope.memberId would record the parent as attending — and
    // event_rsvps_once makes that an upsert, so it would overwrite the parent's
    // own reply. A refusal beats destroying an answer nobody touched.
    expect(Object.keys(APPROVAL_CANNOT_REPLAY)).toEqual(['rsvp_to_event']);
  });

  it('the ratchet still bites', () => {
    // A shrinking allow-list is exactly when a coverage test quietly stops
    // testing, so this proves the assertion fails for a NEW orphan rather than
    // trusting it to.
    const orphansFor = (gated: string[]) =>
      gated.filter((name) => !getTool(name) && !(name in APPROVAL_CANNOT_REPLAY));

    expect(orphansFor(GATED)).toEqual([]);
    expect(orphansFor([...GATED, 'brand_new_gated_write'])).toEqual(['brand_new_gated_write']);
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
