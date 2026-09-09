'use server';

// "Propose" — the one button on the School & Sports desk.
//
// It takes an inbox message the family has not dealt with, classifies it with
// the pure pass in `lib/front-desk/school-sports.ts`, and asks the EXISTING
// approval spine whether Bubaly may act on it. Nothing here is new machinery:
// `gateAiAction` is the same gate Magic Import and the chat assistant use, and
// `runAction` is the same executor, so the family's Settings → Bubaly AI switch,
// their per-domain behaviour and their per-tool risk overrides all reach this
// surface without it knowing anything about them.
//
// THREE OUTCOMES, AND ONLY ONE OF THEM DOES ANYTHING:
//   deny             → nothing runs, nothing is marked.
//   require_approval → an `approval_requests` row is waiting; nothing runs, and
//                      the message stays UNHANDLED, because it is.
//   allow            → `runAction` executes, and only if it reports ok does
//                      `ai_handled` get written.
//
// WHAT THIS CANNOT PERSIST, AND WHY THE UI IS QUIET ABOUT IT:
// `family_inbox_messages` (0214) has no member_id, linked_type, linked_id or
// sub_intent column. So the classification is not stored, the created row is
// not linked back to the message, and — the one that matters — a proposal that
// goes to a parent for approval and is approved an hour later in the trust
// queue does NOT come back here to set `ai_handled`. The queue executes it, the
// ledger records it, and this message keeps saying "not handled" because
// nothing in the database ties the two together. The DDL that would fix it is
// named in the work queue's migration asks; until it exists the desk says only
// what the row can prove.
import { revalidatePath } from 'next/cache';
import { runAction } from '@/lib/ai/actions';
import { isManager } from '@/lib/constants/roles';
import { buildProposal, classify, type FrontDeskSubKind } from '@/lib/front-desk/school-sports';
import { getTranslations } from '@/lib/i18n/server';
import { getMembers } from '@/lib/services/family';
import { loadInboxMessage, markInboxMessageHandled } from '@/lib/services/inbox';
import { listClassRoster } from '@/lib/services/school';
import { scopeFromUserContext } from '@/lib/services/scope';
import { listTeams } from '@/lib/services/sports';
import { gateAiAction } from '@/lib/trust/ai-gate';
import { roleOf } from '@/lib/trust/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';

export type ProposeFrontDeskResult =
  | {
      ok: true;
      outcome: 'executed';
      /** True only because `family_inbox_messages.ai_handled` now says so. */
      handled: boolean;
      summary: string;
    }
  | { ok: true; outcome: 'pending_approval'; approvalId: string | null; reason: string }
  | { ok: false; error: string; code?: string };

/** The catalogue key naming each sub-kind, so the approval card reads in the family's language. */
const SUB_KIND_KEY: Record<FrontDeskSubKind, string> = {
  form: 'schoolDesk.kindForm',
  fee: 'schoolDesk.kindFee',
  gear: 'schoolDesk.kindGear',
  transport: 'schoolDesk.kindTransport',
  schedule_change: 'schoolDesk.kindScheduleChange',
};

/**
 * Classify one unhandled inbox message and put the resulting action in front of
 * the trust engine. Never executes anything the engine did not allow.
 */
export async function proposeFrontDeskAction(messageId: string): Promise<ProposeFrontDeskResult> {
  const t = await getTranslations();
  if (!messageId) return { ok: false, error: t('schoolDesk.messageGone'), code: 'not_found' };

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  // Filing the household's front-desk mail is a manager's act — the same rule
  // `lib/services/inbox` enforces on the write — and checking it here means a
  // child never gets an action executed and then told it could not be filed.
  if (!isManager(ctx.active.role)) {
    return { ok: false, error: t('schoolDesk.parentsOnly'), code: 'denied' };
  }

  // Read through the CALLER's client first: RLS proves this family may see the
  // row before anything else happens to it.
  const message = await loadInboxMessage(scope, messageId);
  if (!message.ok) return { ok: false, error: message.error, code: message.code };
  if (message.data.ai_handled) {
    return { ok: false, error: t('schoolDesk.alreadyHandled'), code: 'already_handled' };
  }

  // The roster, so the proposal can name the right child. Awaited one at a time
  // rather than batched: these return `ServiceResult`, which has `ok` and not
  // `data`, so it can never ride inside `settleAll` (see the strategy file's
  // settleAll hazard) — and each already fails closed on its own.
  const members = await getMembers(scope);
  if (!members.ok) return { ok: false, error: members.error, code: members.code };
  const classes = await listClassRoster(scope);
  if (!classes.ok) return { ok: false, error: classes.error, code: classes.code };
  // Inactive teams included on purpose: last season's coach still identifies
  // the child whose club is writing about this season's kit.
  const teams = await listTeams(scope, { activeOnly: false });
  if (!teams.ok) return { ok: false, error: teams.error, code: teams.code };

  const classification = classify(
    message.data,
    members.data.map((m) => ({ id: m.id, display_name: m.displayName })),
    teams.data,
    classes.data,
    { now: new Date().toISOString() },
  );
  const proposal = buildProposal(message.data, classification);
  if (!proposal) return { ok: false, error: t('schoolDesk.nothingToPropose'), code: 'unclassified' };

  const kindLabel = classification.subKind
    ? t(SUB_KIND_KEY[classification.subKind])
    : t(classification.domain === 'sports' ? 'schoolDesk.domainSports' : 'schoolDesk.domainSchool');
  const title = t('schoolDesk.proposalTitle', { kind: kindLabel, subject: proposal.subject });

  const outcome = await gateAiAction(supabase, ctx.active.familyId, {
    toolName: proposal.name,
    domain: proposal.domain,
    actorId: 'school_front_desk',
    actorRole: roleOf(ctx.active.role),
    agent: 'School & Sports desk',
    onBehalfOfMemberId: ctx.active.member.id,
    title,
    payload: { name: proposal.name, args: proposal.args },
    confidence: classification.confidence,
  });

  if (outcome.effect === 'deny') return { ok: false, error: outcome.reason, code: 'denied' };
  if (outcome.effect === 'require_approval') {
    // Deliberately NOT marked handled: an approval is a question, not an act.
    revalidatePath('/dashboard/school');
    return { ok: true, outcome: 'pending_approval', approvalId: outcome.approvalId, reason: outcome.reason };
  }

  // Trust was evaluated for this exact call a few lines up, so the registry
  // does not evaluate it a second time and open a second approval.
  const ran = await runAction(
    { supabase, familyId: ctx.active.familyId, userId: ctx.user.id },
    { name: proposal.name, args: proposal.args },
    { alreadyAuthorized: true },
  );
  if (!ran.ok) return { ok: false, error: ran.error ?? t('schoolDesk.couldNotPropose'), code: 'action_failed' };

  // Only now — something durable exists — may the row say handled. The write
  // needs the service role: 0214 gives family members SELECT and nothing more.
  const handled = await markInboxMessageHandled({ ...scope, db: createServiceClient() }, messageId);
  revalidatePath('/dashboard/school');
  revalidatePath('/dashboard/inbox');
  return {
    ok: true,
    outcome: 'executed',
    handled: handled.ok && handled.data.ai_handled === true,
    summary: ran.summary ?? title,
  };
}
