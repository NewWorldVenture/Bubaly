'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer, createServiceClient } from '@/lib/supabase/server';
import { normalizeIdea, isFeedbackStatus, type IdeaDraft } from '@/lib/feedback/board';
import { describeActionError } from '@/lib/supabase/errors';

type Result = { ok: boolean; error?: string };

function actionFailure(operation: string, message: string, error: unknown): Result {
  console.error(`[feedback-action] ${operation} failed`, error);
  return { ok: false, error: describeActionError(error, message) };
}

/** The display name to attribute a submission to (first name of the member). */
function authorNameFor(ctx: Awaited<ReturnType<typeof requireUserContext>>): string {
  const name = ctx.active.member?.display_name?.trim();
  if (name) return name;
  const email = ctx.user.email;
  return email ? email.split('@')[0] : 'A Bubaly family';
}

/** Post a new idea to the board. Title required; everything else optional. */
export async function submitIdeaAction(draft: IdeaDraft): Promise<Result & { id?: string }> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const norm = normalizeIdea(draft);
  if (!norm.ok) return { ok: false, error: norm.error };

  const supabase = await createServer();
  const { data, error } = await supabase.from('feedback_ideas').insert({
    author_id: ctx.user.id,
    author_name: authorNameFor(ctx),
    family_id: ctx.active.familyId,
    title: norm.value.title,
    problem: norm.value.problem,
    body: norm.value.body,
    category: norm.value.category,
    impact: norm.value.impact,
    audience: norm.value.audience,
    kind: norm.value.kind,
    image_url: norm.value.imageUrl,
  }).select('id, title, kind, category, problem, body, impact, vote_count, author_name').single();

  if (error) return actionFailure('submit the idea', t('feedback.couldNotSubmitTheIdea'), error);

  // Fire-and-forget side effects: notify the super admin + mirror to the GitHub
  // tracker. Best-effort — the submission already succeeded, so a notification
  // or GitHub hiccup must never fail the user's action.
  try {
    const { onFeedbackSubmitted } = await import('@/lib/feedback/notify');
    await onFeedbackSubmitted(createServiceClient(), data);
  } catch (e) {
    console.error('[feedback] post-submit side effects failed', e);
  }

  revalidatePath('/feedback');
  return { ok: true, id: data.id };
}

/** Toggle the signed-in user's upvote on an idea. Idempotent per direction. */
export async function toggleVoteAction(ideaId: string): Promise<Result & { voted?: boolean; count?: number }> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const supabase = await createServer();

  const { data: existing, error: readErr } = await supabase
    .from('feedback_votes').select('id').eq('idea_id', ideaId).eq('user_id', ctx.user.id).maybeSingle();
  if (readErr) return actionFailure('check the vote', t('feedback.couldNotCheckTheVote'), readErr);

  if (existing) {
    const { error } = await supabase.from('feedback_votes').delete().eq('id', existing.id);
    if (error) return actionFailure('remove the vote', t('feedback.couldNotRemoveTheVote'), error);
  } else {
    const { error } = await supabase.from('feedback_votes').insert({ idea_id: ideaId, user_id: ctx.user.id });
    // A racing double-click can hit the unique index — treat as already-voted.
    if (error && error.code !== '23505' && !/duplicate key/i.test(error.message)) return actionFailure('save the vote', t('feedback.couldNotSaveTheVote'), error);
  }

  const { data: idea } = await supabase.from('feedback_ideas').select('vote_count').eq('id', ideaId).maybeSingle();
  revalidatePath('/feedback');
  return { ok: true, voted: !existing, count: idea?.vote_count ?? undefined };
}

/** Add a comment to an idea. */
export async function addCommentAction(input: { ideaId: string; body: string }): Promise<Result> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const body = input.body.trim();
  if (!body) return { ok: false, error: t('actions.writeSomethingFirst') };
  if (body.length > 2000) return { ok: false, error: t('actions.thatCommentIsALittle') };

  const supabase = await createServer();
  const admin = await isSuperAdmin();
  const { error } = await supabase.from('feedback_comments').insert({
    idea_id: input.ideaId,
    author_id: ctx.user.id,
    author_name: admin ? 'Bubaly Team' : authorNameFor(ctx),
    is_team: admin,
    body,
  });
  if (error) return actionFailure('add the comment', t('feedback.couldNotAddTheComment'), error);
  revalidatePath('/feedback');
  return { ok: true };
}

/** Move an idea through the roadmap pipeline. Super-admin only (service role,
 *  since there is no public UPDATE policy on feedback_ideas). */
export async function setIdeaStatusAction(input: { ideaId: string; status: string; note?: string }): Promise<Result> {
  const t = await getTranslations();
  await requireUserContext();
  if (!(await isSuperAdmin())) return { ok: false, error: t('actions.onlyTheBubalyTeamCan') };
  if (!isFeedbackStatus(input.status)) return { ok: false, error: t('actions.unknownStatus') };

  const svc = createServiceClient();
  const note = (input.note ?? '').trim();
  const { error } = await svc.from('feedback_ideas')
    .update({ status: input.status, admin_note: note || null })
    .eq('id', input.ideaId);
  if (error) return actionFailure('update the idea status', t('feedback.couldNotUpdateTheIdeaStatus'), error);
  revalidatePath('/feedback');
  return { ok: true };
}
