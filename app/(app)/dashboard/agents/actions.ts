// The write path for the agent roster's feed.
//
// `agents-module` let a family mark one of Bubaly's activity entries done or
// dismissed, and wrote it from the browser as:
//
//   await sb.from('agent_activity').update({ status }).eq('id', a.id);
//
// filtering `id` alone. `setActivityStatus` has always existed, adds the
// `family_id` filter, and reports a row it cannot find as `not_found` rather
// than as a silent success — the difference between "we changed nothing" and
// "we told you we changed something".
//
// This is the last direct write to `agent_activity` outside the service layer.
'use server';

import { revalidatePath } from 'next/cache';
import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { setActivityStatus, type ActivityStatus } from '@/lib/services/activity';
import { scopeFromUserContext } from '@/lib/services/scope';
import { describeActionError } from '@/lib/supabase/errors';

const PATH = '/dashboard/agents';

export type ActivityStatusResult = { ok: true } | { ok: false; error: string };

/** Resolve one feed entry. Only the two a person can choose from the roster. */
export async function resolveActivityAction(activityId: string, status: 'done' | 'dismissed'): Promise<ActivityStatusResult> {
  const t = await getTranslations();
  if (!activityId) return { ok: false, error: t('actions.thatEntryCouldNotBe') };

  // Outside the try: `requireUserContext` redirects a signed-out caller by
  // throwing, and catching that would show them a toast instead.
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const scope = scopeFromUserContext(ctx, supabase);

  try {
    // Narrowed at the boundary rather than trusting the argument: 'active' is a
    // legal ActivityStatus the roster has no button for, and `done` is the
    // status `lib/metric/time-saved-server.ts` counts as time Bubaly saved.
    const next: ActivityStatus = status === 'done' ? 'done' : 'dismissed';
    const result = await setActivityStatus(scope, activityId, next);
    if (!result.ok) return { ok: false, error: result.error };

    revalidatePath(PATH);
    return { ok: true };
  } catch (err) {
    console.error('[agents-action] resolve failed', err);
    return { ok: false, error: describeActionError(err, t('actions.couldNotUpdateThatEntry')) };
  }
}
