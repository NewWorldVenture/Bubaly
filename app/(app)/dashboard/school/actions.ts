'use server';

// School and sports proposals always wait for review, even when the household
// permits automatic work elsewhere. The approval payload carries the inbox
// reference; approved execution marks that source only after persisted success.
import { revalidatePath } from 'next/cache';
import { isManager } from '@/lib/constants/roles';
import { SCHOOL_DESK_AGENT, recoverSchoolProposal, schoolProposalSource } from '@/lib/front-desk/school-approval';
import { buildProposal, classify, type FrontDeskSubKind } from '@/lib/front-desk/school-sports';
import { getTranslations } from '@/lib/i18n/server';
import { getMembers } from '@/lib/services/family';
import { loadInboxMessage } from '@/lib/services/inbox';
import { listClassRoster } from '@/lib/services/school';
import { scopeFromUserContext } from '@/lib/services/scope';
import { listTeams } from '@/lib/services/sports';
import { gateAiAction } from '@/lib/trust/ai-gate';
import { roleOf } from '@/lib/trust/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';

export type ProposeFrontDeskResult =
  | { ok: true; outcome: 'pending_approval'; approvalId: string; reason: string }
  | { ok: true; outcome: 'handled' }
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
 * the approval queue. This action never executes the proposal.
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

  const previous = await recoverSchoolProposal(scope, message.data.id);
  if (previous === 'handled') {
    revalidatePath('/dashboard/school');
    revalidatePath('/dashboard/inbox');
    return { ok: true, outcome: 'handled' };
  }
  if (previous !== 'none') {
    return { ok: false, error: t(previous === 'review' ? 'schoolDesk.reviewPrevious' : 'schoolDesk.couldNotPropose'), code: 'previous_proposal' };
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
    agent: SCHOOL_DESK_AGENT,
    onBehalfOfMemberId: ctx.active.member.id,
    title,
    payload: { name: proposal.name, args: proposal.args, source: schoolProposalSource(message.data.id) },
    requireApprovalReason: t('schoolDesk.approvalRequired'),
    confidence: classification.confidence,
  });

  if (outcome.effect === 'deny') return { ok: false, error: outcome.reason, code: 'denied' };
  if (outcome.effect === 'require_approval') {
    if (!outcome.approvalId) return { ok: false, error: t('schoolDesk.approvalNotRecorded'), code: 'approval_failed' };
    // Deliberately NOT marked handled: an approval is a question, not an act.
    revalidatePath('/dashboard/school');
    return { ok: true, outcome: 'pending_approval', approvalId: outcome.approvalId, reason: outcome.reason };
  }

  // Fail closed if the gate ever stops honoring this surface's review rule.
  return { ok: false, error: t('schoolDesk.approvalNotRecorded'), code: 'approval_required' };
}
