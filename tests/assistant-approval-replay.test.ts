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
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/database.types';
import type { ServiceScope } from '@/lib/services/types';
import { createInMemorySupabase } from './helpers/in-memory-supabase';

const holder = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => holder.db }));
vi.mock('@/lib/ai/runs/continue', () => ({ kickRun: vi.fn() }));

import { decide } from '@/lib/services/approvals';
import { openApprovalRequest } from '@/lib/trust/server';
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

  it.each(['recorded', 'missing', 'foreign'] as const)('replays the stored asker without overwriting the approver’s RSVP (%s asker)', async (asker) => {
    const db = createInMemorySupabase<SupabaseClient<Database>>({
      defaults: { approval_requests: { approvals: [], run_id: null, request_id: null, plan_step_id: null, plan_step_ids: [], payload_kind: null, expires_at: null } },
    });
    holder.db = db;
    db.seed('family_members', [
      { id: 'parent', user_id: 'parent-user', family_id: 'family', role: 'parent' },
      { id: 'asker', user_id: 'asker-user', family_id: asker === 'foreign' ? 'other-family' : 'family', role: 'teen' },
    ]);
    db.seed('calendar_events', [{ id: 'event', title: 'Soccer', family_id: 'family', starts_at: '2026-09-16T16:00:00Z' }]);
    db.seed('event_rsvps', [{ id: 'parent-reply', event_id: 'event', family_id: 'family', member_id: 'parent', status: 'declined' }]);
    const requestedBy = asker === 'missing' ? null : 'asker';
    const approval = await openApprovalRequest(db, 'family', {
      actor: { kind: 'ai_agent', id: 'assistant', role: 'teen' },
      domain: 'calendar', capability: 'automate', agent: 'Bubaly', title: 'Reply to soccer',
      onBehalfOfMemberId: requestedBy,
      payload: { name: 'rsvp_to_event', args: { event_id: 'event', status: 'accepted' } },
    }, { effect: 'require_approval', reason: 'Review the reply', basis: 'fallback' });
    expect(approval?.id).toBeTruthy();
    expect(db.table('approval_requests')[0].requested_by_member_id).toBe(requestedBy);

    const scope: ServiceScope = { db, familyId: 'family', userId: 'parent-user', memberId: 'parent', role: 'parent', actorKind: 'member', tz: 'UTC' };
    const result = await decide(scope, approval!.id, 'approved');
    expect(db.table('event_rsvps').find((row) => row.member_id === 'parent')).toMatchObject({ id: 'parent-reply', status: 'declined' });
    if (asker === 'recorded') {
      expect(result).toMatchObject({ ok: true, data: { executed: true } });
      expect(db.table('event_rsvps')).toHaveLength(2);
      expect(db.table('event_rsvps').find((row) => row.member_id === 'asker')).toMatchObject({ status: 'accepted' });
      expect(db.table('ai_tool_calls')[0]).toMatchObject({ requested_by: 'asker-user', requested_by_member_id: 'asker', actor_kind: 'ai' });
    } else {
      expect(result.ok).toBe(false);
      expect(db.table('event_rsvps')).toHaveLength(1);
    }
  });

  it('every entry carries a reason, not just a name', () => {
    for (const [name, reason] of Object.entries(APPROVAL_CANNOT_REPLAY)) {
      expect(reason.length, `${name} has no reason`).toBeGreaterThan(20);
    }
  });

  it('has no orphans left', () => {
    // add_note and add_goal left when notes.create and goals.create landed.
    // rsvp_to_event left when the approval row started recording who asked —
    // a missing FACT, not a missing tool, which is why it outlived the other two.
    expect(Object.keys(APPROVAL_CANNOT_REPLAY)).toEqual([]);
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
