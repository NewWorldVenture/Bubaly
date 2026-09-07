'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { getUser, isSuperAdmin } from '@/lib/supabase/auth';
import { createServiceClient } from '@/lib/supabase/server';
import { describeActionError } from '@/lib/supabase/errors';
import { isFeedbackStatus } from '@/lib/feedback/board';

// Super-admin console actions for the Feedback / Idea Board. All go through the
// service role (feedback_ideas has no public UPDATE/DELETE policy) behind a
// super-admin gate, and revalidate BOTH the admin console and the public board
// so a status change / roadmap note / pin is instantly reflected to members.

type Result = { ok: true } | { ok: false; error: string };
type AdminClient = ReturnType<typeof createServiceClient>;
type Guarded = { supabase: AdminClient; userId: string | null } | { ok: false; error: string };

const NOTE_MAX = 2000;

async function guard(): Promise<Guarded> {
  const t = await getTranslations();
  if (!(await isSuperAdmin())) return { ok: false, error: t('actions.notAuthorized') };
  const user = await getUser();
  return { supabase: createServiceClient(), userId: user?.id ?? null };
}

function done(): Result {
  revalidatePath('/admin/feedback');
  revalidatePath('/feedback');
  return { ok: true };
}

function fail(op: string, error: unknown): Result {
  console.error(`[admin-feedback] ${op} failed`, error);
  return { ok: false, error: describeActionError(error, `Could not ${op}.`) };
}

/** Move an idea through the roadmap and set its public note in one write. */
export async function updateIdeaAction(input: { ideaId: string; status: string; note: string }): Promise<Result> {
  const t = await getTranslations();
  const g = await guard();
  if (!('supabase' in g)) return g;
  if (!input.ideaId) return { ok: false, error: t('actions.missingIdea') };
  if (!isFeedbackStatus(input.status)) return { ok: false, error: t('actions.unknownStatus') };
  const note = (input.note ?? '').trim().slice(0, NOTE_MAX);
  const { data, error } = await g.supabase.from('feedback_ideas')
    .update({ status: input.status, admin_note: note || null })
    .eq('id', input.ideaId).select('id').maybeSingle();
  if (error) return fail('update the idea', error);
  if (!data) return { ok: false, error: t('actions.ideaNotFound') };
  return done();
}

/** Pin / unpin an idea to the top of the board. */
export async function setIdeaPinnedAction(input: { ideaId: string; pinned: boolean }): Promise<Result> {
  const t = await getTranslations();
  const g = await guard();
  if (!('supabase' in g)) return g;
  const { data, error } = await g.supabase.from('feedback_ideas')
    .update({ pinned: !!input.pinned })
    .eq('id', input.ideaId).select('id').maybeSingle();
  if (error) return fail('pin the idea', error);
  if (!data) return { ok: false, error: t('actions.ideaNotFound') };
  return done();
}

/** Remove an idea (spam / duplicate). Cascades to its votes + comments. */
export async function deleteIdeaAction(input: { ideaId: string }): Promise<Result> {
  const t = await getTranslations();
  const g = await guard();
  if (!('supabase' in g)) return g;
  const { data, error } = await g.supabase.from('feedback_ideas')
    .delete().eq('id', input.ideaId).select('id').maybeSingle();
  if (error) return fail('delete the idea', error);
  if (!data) return { ok: false, error: t('actions.ideaNotFound') };
  return done();
}

/** Run the feedback ↔ GitHub bot on demand (backfill + reconcile + relay). */
export async function syncGithubNowAction(): Promise<{ ok: true; summary: string } | { ok: false; error: string }> {
  const g = await guard();
  if (!('supabase' in g)) return g;
  try {
    const { runGithubFeedbackSync, summarizeSync } = await import('@/lib/feedback/github-sync');
    const { notifySuperAdmins } = await import('@/lib/feedback/notify');
    const result = await runGithubFeedbackSync(g.supabase);
    if (result.configured && (result.created > 0 || result.changes.length > 0)) {
      await notifySuperAdmins(g.supabase, {
        kind: 'github_sync',
        title: `Feedback ↔ GitHub (manual): ${summarizeSync(result)}`,
        body: result.changes.map((c) => `• ${c.title}: ${c.from} → ${c.to} (#${c.issue})`).join('\n') || undefined,
        url: '/admin/feedback', email: false,
      });
    }
    revalidatePath('/admin/feedback');
    revalidatePath('/feedback');
    return { ok: true, summary: summarizeSync(result) };
  } catch (e) {
    const f = fail('sync with GitHub', e);
    return { ok: false, error: 'error' in f ? f.error : 'Could not sync with GitHub.' };
  }
}

/** Mark super-admin notifications read (all unread, or a specific set). */
export async function markAdminNotificationsReadAction(ids?: string[]): Promise<Result> {
  const g = await guard();
  if (!('supabase' in g)) return g;
  let q = g.supabase.from('admin_notifications').update({ is_read: true });
  q = ids && ids.length ? q.in('id', ids) : q.eq('is_read', false);
  const { error } = await q;
  if (error) return fail('update notifications', error);
  revalidatePath('/admin/feedback');
  return { ok: true };
}

/** Post an official team reply on an idea (rendered as a Bubaly-team comment). */
export async function postTeamReplyAction(input: { ideaId: string; body: string }): Promise<Result> {
  const t = await getTranslations();
  const g = await guard();
  if (!('supabase' in g)) return g;
  const body = (input.body ?? '').trim().slice(0, NOTE_MAX);
  if (!body) return { ok: false, error: t('actions.writeAReplyFirst') };
  const { error } = await g.supabase.from('feedback_comments').insert({
    idea_id: input.ideaId,
    author_id: g.userId,
    author_name: 'Bubaly Team',
    is_team: true,
    body,
  });
  if (error) return fail('post the reply', error);
  return done();
}
