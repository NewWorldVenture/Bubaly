'use server';

import { randomUUID } from 'node:crypto';
import { getTranslations } from '@/lib/i18n/server';
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { isManager } from '@/lib/constants/roles';
import { validateChoreSubmission, generateChorePlan, type ChorePlanItem } from '@/lib/chores/ai';
import { computeReward, canAutoApprove, type ChoreReward, type Difficulty } from '@/lib/chores/logic';
import { applyCompletionRewards, logChoreEvent } from '@/lib/chores/server';
import { wroteNoRows } from '@/lib/supabase/errors';

const BUCKET = 'chore-proof';
const MAX_FILE = 50 * 1024 * 1024;
const VISION_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function str(fd: FormData, k: string): string | null {
  const v = String(fd.get(k) ?? '').trim();
  return v === '' ? null : v;
}
function intVal(fd: FormData, k: string): number | null {
  const v = str(fd, k);
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
}

type ChoreSupabase = Awaited<ReturnType<typeof createServer>>;

async function cleanupProofMedia(supabase: ChoreSupabase, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) console.error('[chore proof] media cleanup failed', error);
}

async function cleanupSubmission(
  supabase: ChoreSupabase,
  familyId: string,
  submissionId: string,
  paths: string[],
): Promise<void> {
  // A rollback of a row this path inserted moments ago, so zero rows deleted is
  // a failure to remove it, not an absence — an orphan submission that shows
  // as pending review. Logged, not raised: the caller is already failing.
  // Audit C1-S9-61.
  const { data: removed, error } = await supabase.from('chore_submissions').delete()
    .eq('id', submissionId).eq('family_id', familyId).select('id');
  if (error || wroteNoRows(removed)) {
    console.error('[chore proof] submission cleanup failed — an orphan submission may remain', {
      submissionId, familyId, error: error?.message ?? 'no rows deleted',
    });
  }
  await cleanupProofMedia(supabase, paths);
}

async function restoreAssignmentState(
  supabase: ChoreSupabase,
  familyId: string,
  assignment: Record<string, unknown>,
): Promise<void> {
  const { data: restored, error } = await supabase.from('chore_assignments').update({
    status: assignment.status,
    ai_score: assignment.ai_score,
    submitted_at: assignment.submitted_at,
    disputed: assignment.disputed,
    approved_at: assignment.approved_at,
    approved_by: assignment.approved_by,
    points_awarded: assignment.points_awarded,
    cash_awarded_cents: assignment.cash_awarded_cents,
  } as never).eq('id', assignment.id as string).eq('family_id', familyId).select('id');
  // Restoring a row read moments ago, so zero rows is a failed restore: the
  // assignment keeps the half-applied state this rollback exists to undo.
  // Logged, not raised, as above. Audit C1-S9-61.
  if (error || wroteNoRows(restored)) {
    console.error('[chore state] assignment rollback failed', {
      assignmentId: assignment.id, familyId, error: error?.message ?? 'no rows updated',
    });
  }
}

async function setSubmissionStatus(
  supabase: ChoreSupabase,
  familyId: string,
  submissionId: string,
  status: string,
): Promise<boolean> {
  const { data, error } = await supabase.from('chore_submissions').update({ status: status as never })
    .eq('id', submissionId).eq('family_id', familyId).select('id').single();
  if (error || !data) {
    console.error('[chore state] submission transition failed', error ?? new Error('No submission row updated'));
    return false;
  }
  return true;
}

/**
 * What a review or creation action tells the screen that called it.
 *
 * These four actions were `Promise<void>`, and every failure path was a bare
 * `return;` — 21 of them. A parent's Approve (which mints a wallet reward)
 * that failed stopped its spinner and said nothing; the plan builder marked a
 * chore "Added ✓" whether or not it was created. Audit C1-S9-73.
 */
export type MissionActionResult = { ok: true } | { ok: false; error: string };

/** Resolve a chore's reward config into the pure ChoreReward shape. */
function rewardConfig(c: Record<string, unknown>): ChoreReward {
  return {
    reward_mode: (c.reward_mode as ChoreReward['reward_mode']) ?? 'fixed_points',
    points: (c.points as number) ?? null,
    points_min: (c.points_min as number) ?? null,
    points_max: (c.points_max as number) ?? null,
    cash_cents: (c.cash_cents as number) ?? null,
    cash_min_cents: (c.cash_min_cents as number) ?? null,
    cash_max_cents: (c.cash_max_cents as number) ?? null,
  };
}

/**
 * Kid submits proof for an assignment. Uploads media, creates a submission,
 * runs AI validation, stores the verdict, and either auto-approves (when the
 * chore allows and the score clears the threshold) or routes to parent review.
 */
export async function submitProofAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const assignmentId = str(formData, 'assignment_id');
  if (!assignmentId) return { ok: false, error: t('actions.missingAssignment') };

  // Load the assignment + its chore (RLS guarantees same-family).
  const { data: assignment } = await supabase
    .from('chore_assignments').select('*').eq('id', assignmentId).eq('family_id', familyId).maybeSingle();
  if (!assignment) return { ok: false, error: t('actions.choreNotFound') };
  const { data: chore } = await supabase.from('chores').select('*').eq('id', assignment.chore_id).maybeSingle();
  if (!chore) return { ok: false, error: t('actions.choreNotFound') };

  const proofKind = (chore.proof_required as string) ?? 'none';
  const note = str(formData, 'note');

  // Upload any submitted files and collect base64 for vision.
  const files = formData.getAll('media').filter((f): f is File => f instanceof File && f.size > 0);
  const mediaPaths: string[] = [];
  const images: { media_type: string; data: string }[] = [];
  for (const file of files.slice(0, 4)) {
    if (file.size > MAX_FILE) continue;
    const safe = file.name.replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(-100);
    const path = `${familyId}/${assignment.member_id}/${randomUUID()}-${safe}`;
    const { error } = await supabase.storage.from(BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
    if (error) {
      await cleanupProofMedia(supabase, mediaPaths);
      return { ok: false, error: t('actions.couldNotUploadProofMedia') };
    }
    mediaPaths.push(path);
    if (VISION_TYPES.has(file.type)) {
      const buf = Buffer.from(await file.arrayBuffer());
      images.push({ media_type: file.type, data: buf.toString('base64') });
    }
  }

  if (proofKind !== 'none' && mediaPaths.length === 0) {
    return { ok: false, error: t('actions.thisChoreNeedsAPhoto') };
  }

  // Create the submission row.
  const { data: submission, error: subErr } = await supabase
    .from('chore_submissions')
    .insert({
      family_id: familyId, assignment_id: assignmentId, chore_id: chore.id, member_id: assignment.member_id,
      kind: proofKind === 'none' ? 'none' : (proofKind as string), media_paths: mediaPaths, note, status: 'pending', created_by: ctx.user.id,
    })
    .select('id').single();
  if (subErr || !submission) {
    await cleanupProofMedia(supabase, mediaPaths);
    return { ok: false, error: t('actions.couldNotSaveYourSubmission') };
  }

  await logChoreEvent({ familyId, assignmentId, submissionId: submission.id, actorId: assignment.member_id, action: 'submit', note });

  // Run AI validation (degrades safely to parent review).
  let verdict: Awaited<ReturnType<typeof validateChoreSubmission>>;
  try {
    verdict = await validateChoreSubmission(scopeFromUserContext(ctx, supabase), {
      choreTitle: chore.title,
      instructions: chore.instructions ?? chore.description,
      proofKind: proofKind as 'none' | 'photo' | 'video' | 'before_after',
      difficulty: chore.difficulty,
      safetyLevel: chore.safety_level,
      kidNote: note,
      images,
    });
  } catch {
    await cleanupSubmission(supabase, familyId, submission.id, mediaPaths);
    return { ok: false, error: t('actions.couldNotReviewYourProof') };
  }

  // The AI verdict, the auto-approve payout, and every manager-decision status
  // transition are SERVER decisions, not the child's — they must run under the
  // service role. chore_ai_validations is SELECT-only for members (0043: "written
  // by the service-role engine"), and chore_submissions decision statuses are
  // DB-guarded to managers/service-role (0222). The child's session is only the
  // authority for creating the submission (above) and disputing it (below).
  const service = createServiceClient();
  const { error: validationError } = await service.from('chore_ai_validations').insert({
    family_id: familyId, submission_id: submission.id, status: verdict.status,
    quality_score: verdict.quality_score, confidence: verdict.confidence,
    recommended_reward_type: verdict.recommended_reward_type, recommended_reward_amount: verdict.recommended_reward_amount,
    kid_feedback: verdict.kid_feedback, parent_summary: verdict.parent_summary,
    detected_issues: verdict.detected_issues, safety_flags: verdict.safety_flags,
    needs_parent_review: verdict.needs_parent_review, model: verdict.model, is_fallback: verdict.is_fallback,
  });
  if (validationError) {
    await cleanupSubmission(supabase, familyId, submission.id, mediaPaths);
    return { ok: false, error: t('actions.couldNotSaveTheProof') };
  }

  const { data: updatedAssignment, error: assignmentError } = await supabase.from('chore_assignments')
    .update({ ai_score: verdict.quality_score, submitted_at: new Date().toISOString() })
    .eq('id', assignmentId).eq('family_id', familyId).select('id').single();
  if (assignmentError || !updatedAssignment) {
    await cleanupSubmission(supabase, familyId, submission.id, mediaPaths);
    return { ok: false, error: t('actions.couldNotUpdateTheChore') };
  }
  await logChoreEvent({ familyId, assignmentId, submissionId: submission.id, action: 'ai_validate', note: verdict.status });

  // Auto-approve only when the parent set a threshold and nothing needs a human.
  const autoOk = canAutoApprove({
    autoApproveScore: chore.auto_approve_score, score: verdict.quality_score,
    needsParentReview: verdict.needs_parent_review, safetyFlags: verdict.safety_flags,
  });

  if (autoOk && verdict.status === 'approved') {
    if (!await setSubmissionStatus(service, familyId, submission.id, 'approved')) {
      await restoreAssignmentState(supabase, familyId, assignment);
      return { ok: false, error: t('actions.couldNotFinishTheChore') };
    }
    try {
      // Auto-approval is a trusted, server-decided payout and runs in the CHILD's
      // session (the submitter). Route the reward finalization through the service
      // role so it credits the immutable ledger under the manager-only wallet RLS
      // (0217) — the child's session must never be the authority for a money credit.
      await finalizeApproval(service, { familyId, assignment, chore, submissionId: submission.id, score: verdict.quality_score, actorId: assignment.member_id, auto: true });
    } catch {
      await setSubmissionStatus(service, familyId, submission.id, 'parent_review');
      const { error: fallbackAssignmentError } = await supabase.from('chore_assignments').update({ status: 'submitted' })
        .eq('id', assignmentId).eq('family_id', familyId).select('id').single();
      if (fallbackAssignmentError) console.error('[chore state] parent-review fallback failed', fallbackAssignmentError);
      return { ok: false, error: t('actions.couldNotFinishTheChore2') };
    }
  } else {
    const subStatus = verdict.status === 'needs_improvement' ? 'needs_improvement'
      : verdict.status === 'rejected' ? 'rejected' : verdict.status === 'approved' ? 'parent_review' : 'parent_review';
    if (!await setSubmissionStatus(service, familyId, submission.id, subStatus)) {
      await restoreAssignmentState(supabase, familyId, assignment);
      return { ok: false, error: t('actions.couldNotFinishTheProof') };
    }
    const { data: submittedAssignment, error: submittedAssignmentError } = await supabase.from('chore_assignments')
      .update({ status: 'submitted' }).eq('id', assignmentId).eq('family_id', familyId).select('id').single();
    if (submittedAssignmentError || !submittedAssignment) {
      await setSubmissionStatus(service, familyId, submission.id, 'pending');
      await restoreAssignmentState(supabase, familyId, assignment);
      return { ok: false, error: t('actions.couldNotFinishTheProof') };
    }
  }

  revalidatePath('/kids');
  revalidatePath('/missions');
  return { ok: true };
}

/** Shared approval finalizer: sets reward, flips status, applies gamification. */
async function finalizeApproval(
  supabase: Awaited<ReturnType<typeof createServer>>,
  args: { familyId: string; assignment: Record<string, unknown>; chore: Record<string, unknown>; submissionId: string; score: number; actorId: string | null; auto: boolean; pointsOverride?: number | null; cashOverride?: number | null },
) {
  const reward = computeReward(rewardConfig(args.chore), args.score);
  const points = args.pointsOverride ?? reward.points;
  const cashCents = args.cashOverride ?? reward.cashCents;

  const { data: approvedAssignment, error: approvalError } = await supabase.from('chore_assignments').update({
    status: 'approved', approved_at: new Date().toISOString(), approved_by: args.actorId,
    points_awarded: points, cash_awarded_cents: cashCents,
  }).eq('id', args.assignment.id as string).eq('family_id', args.familyId).select('id').single();
  if (approvalError || !approvedAssignment) throw new Error('Could not save chore approval');

  try {
    await applyCompletionRewards(supabase, {
      familyId: args.familyId, memberId: args.assignment.member_id as string,
      difficulty: ((args.chore.difficulty as Difficulty) ?? 'medium'), qualityScore: args.score,
    });
  } catch (error) {
    const { data: rolledBackAssignment, error: rollbackError } = await supabase.from('chore_assignments').update({
      status: args.assignment.status,
      approved_at: args.assignment.approved_at,
      approved_by: args.assignment.approved_by,
      points_awarded: args.assignment.points_awarded,
      cash_awarded_cents: args.assignment.cash_awarded_cents,
    } as never).eq('id', args.assignment.id as string).eq('family_id', args.familyId).select('id');
    // Undoing an approval whose reward application threw. A rollback matching
    // ZERO rows leaves the assignment marked approved, with points and cash
    // recorded as awarded, when the code that actually awards them failed — the
    // child is recorded as paid without being paid. Logged rather than raised
    // because the original error is rethrown two lines below and is the one the
    // caller needs. Audit C1-S9-55.
    if (rollbackError || wroteNoRows(rolledBackAssignment)) {
      console.error('[chore approval] assignment rollback failed — an approval may be stranded', {
        assignmentId: args.assignment.id, familyId: args.familyId,
        error: rollbackError?.message ?? 'no rows updated',
      });
    }
    throw error instanceof Error ? error : new Error('Could not apply chore rewards');
  }

  await logChoreEvent({
    familyId: args.familyId, assignmentId: args.assignment.id as string, submissionId: args.submissionId,
    actorId: args.actorId, action: args.auto ? 'auto_approve' : 'approve', pointsAwarded: points, cashCents,
  });
}

/** Parent approves a submission, optionally overriding the AI's reward. */
export async function approveSubmissionAction(formData: FormData): Promise<MissionActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  // Approving a submission mints a wallet reward, so only a family manager
  // (parent/adult) may do it — a child must never approve their own chore.
  // RLS on chore_submissions is family-scoped (any member), so this app-level
  // gate is the authorization boundary; it must not be removed.
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsGuardiansCanApprove') };
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const submissionId = str(formData, 'submission_id');
  const failed: MissionActionResult = { ok: false, error: t('actions.couldNotFinishTheChore') };
  if (!submissionId) return failed;

  // A refused read is not a decided submission. Audit C1-S9-73.
  const { data: submission, error: submissionError } = await supabase.from('chore_submissions').select('*').eq('id', submissionId).eq('family_id', familyId).maybeSingle();
  if (submissionError) return failed;
  if (!submission) return { ok: false, error: t('actions.thatChoreIsNoLonger') };
  const { data: assignment, error: assignmentReadError } = await supabase.from('chore_assignments').select('*').eq('id', submission.assignment_id).maybeSingle();
  const { data: chore, error: choreReadError } = await supabase.from('chores').select('*').eq('id', submission.chore_id ?? '').maybeSingle();
  if (assignmentReadError || choreReadError) return failed;
  if (!assignment || !chore) return { ok: false, error: t('actions.thatChoreIsNoLonger') };

  const score = intVal(formData, 'score') ?? assignment.ai_score ?? 100;
  if (!await setSubmissionStatus(supabase, familyId, submissionId, 'approved')) return failed;
  const { error: disputeError } = await supabase.from('chore_disputes').update({ status: 'resolved', resolution: 'Approved by parent', resolved_by: ctx.active.member.id, resolved_at: new Date().toISOString() }).eq('submission_id', submissionId).eq('status', 'open').select('id');
  if (disputeError) {
    await setSubmissionStatus(supabase, familyId, submissionId, submission.status);
    return failed;
  }
  try {
    await finalizeApproval(supabase, {
      familyId, assignment, chore, submissionId, score, actorId: ctx.active.member.id, auto: false,
      pointsOverride: intVal(formData, 'points'), cashOverride: intVal(formData, 'cash_cents'),
    });
  } catch {
    await setSubmissionStatus(supabase, familyId, submissionId, submission.status);
    // Reopening a dispute whose resolution failed. Zero rows here is ambiguous
    // in the same way as the wallet hold in C1-S9-53 — the `.eq('status',
    // 'resolved')` predicate means it is also the case where there was no
    // resolved dispute to restore — so it is logged, not raised. What it must
    // not be is invisible: a family's dispute left closed over a resolution
    // that did not happen. Audit C1-S9-55.
    const { data: reopened, error: disputeRestoreError } = await supabase.from('chore_disputes').update({ status: 'open', resolution: null, resolved_by: null, resolved_at: null })
      .eq('submission_id', submissionId).eq('status', 'resolved').select('id');
    if (disputeRestoreError || wroteNoRows(reopened)) {
      console.error('[chore state] dispute rollback failed — a dispute may stay closed', {
        submissionId, error: disputeRestoreError?.message ?? 'no rows updated',
      });
    }
    return failed;
  }
  revalidatePath('/missions');
  revalidatePath('/kids');
  return { ok: true };
}

/** Parent rejects or asks for a redo. */
export async function rejectSubmissionAction(formData: FormData): Promise<MissionActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  // Reviewing (reject / request redo) is a manager decision — a child must not
  // adjudicate their own submission. Mirrors approveSubmissionAction's gate.
  if (!isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyParentsCanDoThis') };
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const submissionId = str(formData, 'submission_id');
  const redo = str(formData, 'redo') === '1';
  const failed: MissionActionResult = { ok: false, error: t('actions.couldNotUpdateTheChore') };
  if (!submissionId) return failed;
  const { data: submission, error: submissionError } = await supabase.from('chore_submissions').select('*').eq('id', submissionId).eq('family_id', familyId).maybeSingle();
  if (submissionError) return failed;
  if (!submission) return { ok: false, error: t('actions.thatChoreIsNoLonger') };

  if (!await setSubmissionStatus(supabase, familyId, submissionId, redo ? 'needs_improvement' : 'rejected')) return failed;
  const { data: updatedAssignment, error: assignmentError } = await supabase.from('chore_assignments').update({ status: redo ? 'in_progress' : 'rejected', disputed: false })
    .eq('id', submission.assignment_id).eq('family_id', familyId).select('id').single();
  if (assignmentError || !updatedAssignment) {
    await setSubmissionStatus(supabase, familyId, submissionId, submission.status);
    return failed;
  }
  await logChoreEvent({ familyId, assignmentId: submission.assignment_id, submissionId, actorId: ctx.active.member.id, action: redo ? 'redo' : 'reject', note: str(formData, 'note') });
  revalidatePath('/missions');
  revalidatePath('/kids');
  return { ok: true };
}

/** Kid disputes the AI verdict and asks a parent to look. */
export async function disputeSubmissionAction(formData: FormData): Promise<MissionActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const submissionId = str(formData, 'submission_id');
  const failed: MissionActionResult = { ok: false, error: t('actions.couldNotUpdateTheChore') };
  if (!submissionId) return failed;
  const { data: submission, error: submissionError } = await supabase.from('chore_submissions').select('*').eq('id', submissionId).eq('family_id', familyId).maybeSingle();
  if (submissionError) return failed;
  if (!submission) return { ok: false, error: t('actions.thatChoreIsNoLonger') };

  const { data: dispute, error: disputeError } = await supabase.from('chore_disputes').insert({ family_id: familyId, submission_id: submissionId, member_id: submission.member_id, reason: str(formData, 'reason'), status: 'open' }).select('id').single();
  if (disputeError || !dispute) return failed;
  if (!await setSubmissionStatus(supabase, familyId, submissionId, 'disputed')) {
    const { data: cleanedDispute, error: disputeCleanupError } = await supabase.from('chore_disputes').delete().eq('id', dispute.id).eq('family_id', familyId).select('id');
    if (disputeCleanupError || wroteNoRows(cleanedDispute)) {
      // The dispute row was inserted moments ago on this path, so zero rows is
      // a failure to remove it, not an absence — and it leaves an orphan
      // dispute against an assignment that was never marked disputed.
      console.error('[chore state] dispute cleanup failed — an orphan dispute may remain', {
        disputeId: dispute.id, familyId, error: disputeCleanupError?.message ?? 'no rows deleted',
      });
    }
    return failed;
  }
  const { data: updatedAssignment, error: assignmentError } = await supabase.from('chore_assignments').update({ status: 'submitted', disputed: true })
    .eq('id', submission.assignment_id).eq('family_id', familyId).select('id').single();
  if (assignmentError || !updatedAssignment) {
    await setSubmissionStatus(supabase, familyId, submissionId, submission.status);
    // The same rollback as the branch above, and the same reasoning: the dispute
    // row was inserted moments ago on this path, so zero rows deleted is a
    // failure to remove it rather than an absence. Logged, not raised — the
    // caller is already on its way out. Audit C1-S9-60.
    const { data: cleaned, error: disputeCleanupError } = await supabase.from('chore_disputes')
      .delete().eq('id', dispute.id).eq('family_id', familyId).select('id');
    if (disputeCleanupError || wroteNoRows(cleaned)) {
      console.error('[chore state] dispute cleanup failed — an orphan dispute may remain', {
        disputeId: dispute.id, familyId, error: disputeCleanupError?.message ?? 'no rows deleted',
      });
    }
    return failed;
  }
  await logChoreEvent({ familyId, assignmentId: submission.assignment_id, submissionId, actorId: submission.member_id, action: 'dispute', note: str(formData, 'reason') });
  revalidatePath('/missions');
  revalidatePath('/kids');
  return { ok: true };
}

/** Parent creates a chore (with AI/reward/safety config) and assigns it. */
export async function createChoreAction(formData: FormData): Promise<MissionActionResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const title = str(formData, 'title');
  if (!title) return { ok: false, error: t('actions.aTitleIsRequired') };

  // What a chore PAYS is a manager's number, not the submitter's.
  // payChoreRewardAction credits a wallet with `chores.cash_cents` whenever the
  // assignment carries no override, and the board copies `chores.points` into
  // points_awarded on approval — so a member pricing their own chore writes the
  // figure a parent's Pay click hands over. 0307 is the database boundary; this
  // refuses the same submission here rather than letting it fail silently —
  // which, while this action returned void, it still did: the refusal was a
  // bare `return;`, and the plan builder (which always sends `points`) showed
  // "Added ✓" over it. Audit C1-S9-73.
  const pricing = ['points', 'points_min', 'points_max', 'cash_cents', 'cash_min_cents', 'cash_max_cents'];
  const priced = pricing.some((field) => intVal(formData, field) != null);
  if (priced && !isManager(ctx.active.role)) return { ok: false, error: t('actions.onlyAParentCanSetAChoreReward') };

  const memberIds = formData.getAll('member_ids').map((v) => String(v)).filter(Boolean);

  const { data: chore, error: choreError } = await supabase.from('chores').insert({
    family_id: familyId, title,
    description: str(formData, 'description'),
    instructions: str(formData, 'instructions'),
    category: str(formData, 'category'),
    difficulty: str(formData, 'difficulty') ?? 'medium',
    est_minutes: intVal(formData, 'est_minutes'),
    points: intVal(formData, 'points') ?? 10,
    points_min: intVal(formData, 'points_min'),
    points_max: intVal(formData, 'points_max'),
    cash_cents: intVal(formData, 'cash_cents'),
    cash_min_cents: intVal(formData, 'cash_min_cents'),
    cash_max_cents: intVal(formData, 'cash_max_cents'),
    reward_mode: str(formData, 'reward_mode') ?? 'fixed_points',
    proof_required: str(formData, 'proof_required') ?? 'none',
    safety_level: str(formData, 'safety_level') ?? 'none',
    auto_approve_score: intVal(formData, 'auto_approve_score'),
    requires_approval: str(formData, 'requires_approval') !== '0',
    recurrence: (str(formData, 'recurrence') ?? 'none') as 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly',
    due_at: str(formData, 'due_at'),
    icon: str(formData, 'icon'),
    created_by: ctx.user.id,
  }).select('id').single();
  if (choreError || !chore) return { ok: false, error: t('actions.couldNotAddThatChore') };

  if (memberIds.length) {
    const { error: assignmentError } = await supabase.from('chore_assignments').insert(memberIds.map((member_id) => ({
      family_id: familyId, chore_id: chore.id, member_id, due_at: str(formData, 'due_at'),
    })));
    if (assignmentError) {
      const { data: cleanedChore, error: cleanupError } = await supabase.from('chores').delete().eq('id', chore.id).eq('family_id', familyId).select('id');
      if (cleanupError || wroteNoRows(cleanedChore)) {
        // Same shape: the chore was created moments ago, so zero rows leaves a
        // chore nobody is assigned to sitting in the family's list.
        console.error('[chore create] cleanup failed — an unassigned chore may remain', {
          choreId: chore.id, familyId, error: cleanupError?.message ?? 'no rows deleted',
        });
      }
      return { ok: false, error: t('actions.couldNotAddThatChore') };
    }
  }
  revalidatePath('/missions');
  revalidatePath('/kids');
  return { ok: true };
}

/** AI chore-plan generator — returns suggestions for the parent to review. */
export async function generatePlanAction(prompt: string, kidAges: number[]): Promise<{ items: ChorePlanItem[]; error?: string }> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  if (!prompt.trim()) return { items: [], error: t('actions.describeWhatYouWantFirst') };
  return generateChorePlan(scopeFromUserContext(ctx, await createServer()), prompt, kidAges);
}
