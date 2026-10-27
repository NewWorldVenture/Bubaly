// The write path for play dates.
//
// PlayDatesView used to insert, update and delete play_dates straight from the
// browser under 0114's role-blind policies, and showed Schedule, Mark, Cancel
// and Delete to every role. So a guest (an invited grandparent or neighbour)
// could schedule, cancel or delete the family's play dates, which a guest does
// not do (0464: a guest views the household and does not write to it), and the
// insert carried whatever `created_by` the browser sent.
//
// Here the family comes from the session, `created_by` is the session's user,
// a guest is refused, and cancelling, reinstating or deleting a play date
// someone else arranged is a manager's: a parent or adult, or the play date's
// own author.
// The author is a filter on the write itself, so a play date the caller may not
// touch matches no row and is reported as not saved.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { describeActionError, wroteNoRows } from '@/lib/supabase/errors';
import { isManager } from '@/lib/constants/roles';
import { PLAY_DATE_STATUS } from '@/lib/family/safety';

const PATH = '/dashboard/family/play-dates';

/** The status each forward step starts from: the moves anyone in the household may make (the view's STATUS_FLOW). */
const STEP_FROM: Record<string, string> = { confirmed: 'planned', completed: 'confirmed' };

export type PlayDateActionResult = { ok: true } | { ok: false; error: string };

export type PlayDateInput = {
  title: string; member_id?: string | null; with_kids?: string | null; location?: string | null;
  starts_at: string; contact_name?: string | null; contact_phone?: string | null; notes?: string | null;
};

const text = (value: unknown, max: number): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed.slice(0, max) : null;
};

/** Session, translator and client, resolved outside any try: requireUserContext redirects by throwing. */
async function playDateScope() {
  const [tr, ctx, supabase] = await Promise.all([getTranslations(), requireUserContext(), createServer()]);
  return { tr, ctx, supabase, familyId: ctx.active.familyId };
}

export async function createPlayDateAction(input: PlayDateInput): Promise<PlayDateActionResult> {
  const { tr, ctx, supabase, familyId } = await playDateScope();
  if (ctx.active.role === 'guest') return { ok: false, error: tr('householdRoles.guestViewsOnly') };
  const title = text(input?.title, 200);
  const startsAt = typeof input?.starts_at === 'string' ? Date.parse(input.starts_at) : Number.NaN;
  if (!title || Number.isNaN(startsAt)) return { ok: false, error: tr('playDatesView.addATitleAndDate') };

  const memberId = text(input.member_id, 64);
  if (memberId) {
    const { data: member, error: memberError } = await supabase.from('family_members')
      .select('id').eq('id', memberId).eq('family_id', familyId).maybeSingle();
    if (memberError) return { ok: false, error: describeActionError(memberError, tr('errors.thatChangeWasNotSaved')) };
    if (!member) return { ok: false, error: tr('actions.thatUserIsNotAn') };
  }

  const { data: created, error } = await supabase.from('play_dates').insert({
    family_id: familyId, title, member_id: memberId,
    with_kids: text(input.with_kids, 200), location: text(input.location, 300),
    starts_at: new Date(startsAt).toISOString(), contact_name: text(input.contact_name, 200),
    contact_phone: text(input.contact_phone, 40), notes: text(input.notes, 2000), created_by: ctx.user.id,
  }).select('id');
  if (error) return { ok: false, error: describeActionError(error, tr('errors.thatChangeWasNotSaved')) };
  if (wroteNoRows(created)) return { ok: false, error: tr('errors.thatChangeWasNotSaved') };
  revalidatePath(PATH);
  return { ok: true };
}

export async function setPlayDateStatusAction(id: string, status: string): Promise<PlayDateActionResult> {
  const { tr, ctx, supabase, familyId } = await playDateScope();
  if (ctx.active.role === 'guest') return { ok: false, error: tr('householdRoles.guestViewsOnly') };
  if (typeof id !== 'string' || !id || typeof status !== 'string' || !Object.prototype.hasOwnProperty.call(PLAY_DATE_STATUS, status)) {
    return { ok: false, error: tr('errors.thatChangeWasNotSaved') };
  }
  // Moving a play date one step along (planned → confirmed → completed) is
  // anyone's in the household. Any other move (calling it off, calling it back
  // on, or moving it back) is its author's or a manager's. Only calling it off
  // was held back, so a child undid a parent's cancellation by setting
  // 'planned' (household-roles N10-R1). The step is a filter on the row's
  // CURRENT status, in the same write: a play date that is not where the step
  // starts, and not the caller's, matches no row and is reported as not saved.
  let write = supabase.from('play_dates').update({ status }).eq('id', id).eq('family_id', familyId);
  if (!isManager(ctx.active.role)) {
    const stepFrom = STEP_FROM[status];
    write = stepFrom ? write.or(`created_by.eq.${ctx.user.id},status.eq.${stepFrom}`) : write.eq('created_by', ctx.user.id);
  }
  const { data: updated, error } = await write.select('id');
  if (error) return { ok: false, error: describeActionError(error, tr('errors.thatChangeWasNotSaved')) };
  if (wroteNoRows(updated)) return { ok: false, error: tr('errors.thatChangeWasNotSaved') };
  revalidatePath(PATH);
  return { ok: true };
}

export async function deletePlayDateAction(id: string): Promise<PlayDateActionResult> {
  const { tr, ctx, supabase, familyId } = await playDateScope();
  if (ctx.active.role === 'guest') return { ok: false, error: tr('householdRoles.guestViewsOnly') };
  if (typeof id !== 'string' || !id) return { ok: false, error: tr('errors.thatChangeWasNotSaved') };
  const ownOnly = isManager(ctx.active.role) ? {} : { created_by: ctx.user.id };
  const { data: removed, error } = await supabase.from('play_dates').delete()
    .eq('id', id).eq('family_id', familyId).match(ownOnly).select('id');
  if (error) return { ok: false, error: describeActionError(error, tr('errors.thatChangeWasNotSaved')) };
  if (wroteNoRows(removed)) return { ok: false, error: tr('errors.thatChangeWasNotSaved') };
  revalidatePath(PATH);
  return { ok: true };
}
