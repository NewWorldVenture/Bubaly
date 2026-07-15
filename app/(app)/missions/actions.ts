'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { validateChoreSubmission, generateChorePlan, type ChorePlanItem } from '@/lib/chores/ai';
import { computeReward, canAutoApprove, type ChoreReward, type Difficulty } from '@/lib/chores/logic';
import { applyCompletionRewards, logChoreEvent } from '@/lib/chores/server';

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
  const { error } = await supabase.from('chore_submissions').delete()
    .eq('id', submissionId).eq('family_id', familyId);
  if (error) console.error('[chore proof] submission cleanup failed', error);
  await cleanupProofMedia(supabase, paths);
}

async function restoreAssignmentState(
  supabase: ChoreSupabase,
  familyId: string,
  assignment: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('chore_assignments').update({
    status: assignment.status,
    ai_score: assignment.ai_score,
    submitted_at: assignment.submitted_at,
    disputed: assignment.disputed,
    approved_at: assignment.approved_at,
    approved_by: assignment.approved_by,
    points_awarded: assignment.points_awarded,
    cash_awarded_cents: assignment.cash_awarded_cents,
  } as never).eq('id', assignment.id as string).eq('family_id', familyId);
  if (error) console.error('[chore state] assignment rollback failed', error);
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
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const assignmentId = str(formData, 'assignment_id');
  if (!assignmentId) return { ok: false, error: 'Missing assignment.' };

  // Load the assignment + its chore (RLS guarantees same-family).
  const { data: assignment } = await supabase
    .from('chore_assignments').select('*').eq('id', assignmentId).eq('family_id', familyId).maybeSingle();
  if (!assignment) return { ok: false, error: 'Chore not found.' };
  const { data: chore } = await supabase.from('chores').select('*').eq('id', assignment.chore_id).maybeSingle();
  if (!chore) return { ok: false, error: 'Chore not found.' };

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
      return { ok: false, error: 'Could not upload proof media.' };
    }
    mediaPaths.push(path);
    if (VISION_TYPES.has(file.type)) {
      const buf = Buffer.from(await file.arrayBuffer());
      images.push({ media_type: file.type, data: buf.toString('base64') });
    }
  }

  if (proofKind !== 'none' && mediaPaths.length === 0) {
    return { ok: false, error: 'This chore needs a photo or video as proof.' };
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
    return { ok: false, error: 'Could not save your submission.' };
  }

  await logChoreEvent(supabase, { familyId, assignmentId, submissionId: submission.id, actorId: assignment.member_id, action: 'submit', note });

  // Run AI validation (degrades safely to parent review).
  let verdict: Awaited<ReturnType<typeof validateChoreSubmission>>;
  try {
    verdict = await validateChoreSubmission({
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
    return { ok: false, error: 'Could not review your proof. Please try again.' };
  }

  const { error: validationError } = await supabase.from('chore_ai_validations').insert({
    family_id: familyId, submission_id: submission.id, status: verdict.status,
    quality_score: verdict.quality_score, confidence: verdict.confidence,
    recommended_reward_type: verdict.recommended_reward_type, recommended_reward_amount: verdict.recommended_reward_amount,
    kid_feedback: verdict.kid_feedback, parent_summary: verdict.parent_summary,
    detected_issues: verdict.detected_issues, safety_flags: verdict.safety_flags,
    needs_parent_review: verdict.needs_parent_review, model: verdict.model, is_fallback: verdict.is_fallback,
  });
  if (validationError) {
    await cleanupSubmission(supabase, familyId, submission.id, mediaPaths);
    return { ok: false, error: 'Could not save the proof review.' };
  }

  const { data: updatedAssignment, error: assignmentError } = await supabase.from('chore_assignments')
    .update({ ai_score: verdict.quality_score, submitted_at: new Date().toISOString() })
    .eq('id', assignmentId).eq('family_id', familyId).select('id').single();
  if (assignmentError || !updatedAssignment) {
    await cleanupSubmission(supabase, familyId, submission.id, mediaPaths);
    return { ok: false, error: 'Could not update the chore submission.' };
  }
  await logChoreEvent(supabase, { familyId, assignmentId, submissionId: submission.id, action: 'ai_validate', note: verdict.status });

  // Auto-approve only when the parent set a threshold and nothing needs a human.
  const autoOk = canAutoApprove({
    autoApproveScore: chore.auto_approve_score, score: verdict.quality_score,
    needsParentReview: verdict.needs_parent_review, safetyFlags: verdict.safety_flags,
  });

  if (autoOk && verdict.status === 'approved') {
    if (!await setSubmissionStatus(supabase, familyId, submission.id, 'approved')) {
      await restoreAssignmentState(supabase, familyId, assignment);
      return { ok: false, error: 'Could not finish the chore approval.' };
    }
    try {
      await finalizeApproval(supabase, { familyId, assignment, chore, submissionId: submission.id, score: verdict.quality_score, actorId: assignment.member_id, auto: true });
    } catch {
      await setSubmissionStatus(supabase, familyId, submission.id, 'parent_review');
      const { error: fallbackAssignmentError } = await supabase.from('chore_assignments').update({ status: 'submitted' })
        .eq('id', assignmentId).eq('family_id', familyId).select('id').single();
      if (fallbackAssignmentError) console.error('[chore state] parent-review fallback failed', fallbackAssignmentError);
      return { ok: false, error: 'Could not finish the chore approval. It was sent for parent review.' };
    }
  } else {
    const subStatus = verdict.status === 'needs_improvement' ? 'needs_improvement'
      : verdict.status === 'rejected' ? 'rejected' : verdict.status === 'approved' ? 'parent_review' : 'parent_review';
    if (!await setSubmissionStatus(supabase, familyId, submission.id, subStatus)) {
      await restoreAssignmentState(supabase, familyId, assignment);
      return { ok: false, error: 'Could not finish the proof review.' };
    }
    const { data: submittedAssignment, error: submittedAssignmentError } = await supabase.from('chore_assignments')
      .update({ status: 'submitted' }).eq('id', assignmentId).eq('family_id', familyId).select('id').single();
    if (submittedAssignmentError || !submittedAssignment) {
      await setSubmissionStatus(supabase, familyId, submission.id, 'pending');
      await restoreAssignmentState(supabase, familyId, assignment);
      return { ok: false, error: 'Could not finish the proof review.' };
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
    const { error: rollbackError } = await supabase.from('chore_assignments').update({
      status: args.assignment.status,
      approved_at: args.assignment.approved_at,
      approved_by: args.assignment.approved_by,
      points_awarded: args.assignment.points_awarded,
      cash_awarded_cents: args.assignment.cash_awarded_cents,
    } as never).eq('id', args.assignment.id as string).eq('family_id', args.familyId);
    if (rollbackError) console.error('[chore approval] assignment rollback failed', rollbackError);
    throw error instanceof Error ? error : new Error('Could not apply chore rewards');
  }

  await logChoreEvent(supabase, {
    familyId: args.familyId, assignmentId: args.assignment.id as string, submissionId: args.submissionId,
    actorId: args.actorId, action: args.auto ? 'auto_approve' : 'approve', pointsAwarded: points, cashCents,
  });
}

/** Parent approves a submission, optionally overriding the AI's reward. */
export async function approveSubmissionAction(formData: FormData): Promise<void> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const submissionId = str(formData, 'submission_id');
  if (!submissionId) return;

  const { data: submission } = await supabase.from('chore_submissions').select('*').eq('id', submissionId).eq('family_id', familyId).maybeSingle();
  if (!submission) return;
  const { data: assignment } = await supabase.from('chore_assignments').select('*').eq('id', submission.assignment_id).maybeSingle();
  const { data: chore } = await supabase.from('chores').select('*').eq('id', submission.chore_id ?? '').maybeSingle();
  if (!assignment || !chore) return;

  const score = intVal(formData, 'score') ?? assignment.ai_score ?? 100;
  if (!await setSubmissionStatus(supabase, familyId, submissionId, 'approved')) return;
  const { error: disputeError } = await supabase.from('chore_disputes').update({ status: 'resolved', resolution: 'Approved by parent', resolved_by: ctx.active.member.id, resolved_at: new Date().toISOString() }).eq('submission_id', submissionId).eq('status', 'open').select('id');
  if (disputeError) {
    await setSubmissionStatus(supabase, familyId, submissionId, submission.status);
    return;
  }
  try {
    await finalizeApproval(supabase, {
      familyId, assignment, chore, submissionId, score, actorId: ctx.active.member.id, auto: false,
      pointsOverride: intVal(formData, 'points'), cashOverride: intVal(formData, 'cash_cents'),
    });
  } catch {
    await setSubmissionStatus(supabase, familyId, submissionId, submission.status);
    const { error: disputeRestoreError } = await supabase.from('chore_disputes').update({ status: 'open', resolution: null, resolved_by: null, resolved_at: null })
      .eq('submission_id', submissionId).eq('status', 'resolved');
    if (disputeRestoreError) console.error('[chore state] dispute rollback failed', disputeRestoreError);
    return;
  }
  revalidatePath('/missions');
  revalidatePath('/kids');
}

/** Parent rejects or asks for a redo. */
export async function rejectSubmissionAction(formData: FormData): Promise<void> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const submissionId = str(formData, 'submission_id');
  const redo = str(formData, 'redo') === '1';
  if (!submissionId) return;
  const { data: submission } = await supabase.from('chore_submissions').select('*').eq('id', submissionId).eq('family_id', familyId).maybeSingle();
  if (!submission) return;

  if (!await setSubmissionStatus(supabase, familyId, submissionId, redo ? 'needs_improvement' : 'rejected')) return;
  const { data: updatedAssignment, error: assignmentError } = await supabase.from('chore_assignments').update({ status: redo ? 'in_progress' : 'rejected', disputed: false })
    .eq('id', submission.assignment_id).eq('family_id', familyId).select('id').single();
  if (assignmentError || !updatedAssignment) {
    await setSubmissionStatus(supabase, familyId, submissionId, submission.status);
    return;
  }
  await logChoreEvent(supabase, { familyId, assignmentId: submission.assignment_id, submissionId, actorId: ctx.active.member.id, action: redo ? 'redo' : 'reject', note: str(formData, 'note') });
  revalidatePath('/missions');
  revalidatePath('/kids');
}

/** Kid disputes the AI verdict and asks a parent to look. */
export async function disputeSubmissionAction(formData: FormData): Promise<void> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const submissionId = str(formData, 'submission_id');
  if (!submissionId) return;
  const { data: submission } = await supabase.from('chore_submissions').select('*').eq('id', submissionId).eq('family_id', familyId).maybeSingle();
  if (!submission) return;

  const { data: dispute, error: disputeError } = await supabase.from('chore_disputes').insert({ family_id: familyId, submission_id: submissionId, member_id: submission.member_id, reason: str(formData, 'reason'), status: 'open' }).select('id').single();
  if (disputeError || !dispute) return;
  if (!await setSubmissionStatus(supabase, familyId, submissionId, 'disputed')) {
    const { error: disputeCleanupError } = await supabase.from('chore_disputes').delete().eq('id', dispute.id).eq('family_id', familyId);
    if (disputeCleanupError) console.error('[chore state] dispute cleanup failed', disputeCleanupError);
    return;
  }
  const { data: updatedAssignment, error: assignmentError } = await supabase.from('chore_assignments').update({ status: 'submitted', disputed: true })
    .eq('id', submission.assignment_id).eq('family_id', familyId).select('id').single();
  if (assignmentError || !updatedAssignment) {
    await setSubmissionStatus(supabase, familyId, submissionId, submission.status);
    const { error: disputeCleanupError } = await supabase.from('chore_disputes').delete().eq('id', dispute.id).eq('family_id', familyId);
    if (disputeCleanupError) console.error('[chore state] dispute cleanup failed', disputeCleanupError);
    return;
  }
  await logChoreEvent(supabase, { familyId, assignmentId: submission.assignment_id, submissionId, actorId: submission.member_id, action: 'dispute', note: str(formData, 'reason') });
  revalidatePath('/missions');
  revalidatePath('/kids');
}

/** Parent creates a chore (with AI/reward/safety config) and assigns it. */
export async function createChoreAction(formData: FormData): Promise<void> {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;
  const title = str(formData, 'title');
  if (!title) return;
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
  if (choreError || !chore) return;

  if (memberIds.length) {
    const { error: assignmentError } = await supabase.from('chore_assignments').insert(memberIds.map((member_id) => ({
      family_id: familyId, chore_id: chore.id, member_id, due_at: str(formData, 'due_at'),
    })));
    if (assignmentError) {
      const { error: cleanupError } = await supabase.from('chores').delete().eq('id', chore.id).eq('family_id', familyId);
      if (cleanupError) console.error('[chore create] cleanup failed', cleanupError);
      return;
    }
  }
  revalidatePath('/missions');
  revalidatePath('/kids');
}

/** AI chore-plan generator — returns suggestions for the parent to review. */
export async function generatePlanAction(prompt: string, kidAges: number[]): Promise<{ items: ChorePlanItem[]; error?: string }> {
  await requireUserContext();
  if (!prompt.trim()) return { items: [], error: 'Describe what you want first.' };
  return generateChorePlan(prompt, kidAges);
}
