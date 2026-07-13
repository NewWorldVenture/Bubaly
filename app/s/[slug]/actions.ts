'use server';

import { headers } from 'next/headers';
import { createServiceClient } from '@/lib/supabase/server';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';

/**
 * Public survey submission — NO auth (respondents may be anonymous). Writes go
 * through the service-role client (surveys/responses are locked to it by RLS).
 * Validates that the survey exists, is active, and the score is within range.
 */
export async function submitResponseAction(input: {
  slug: string;
  score: number;
  comment?: string;
  email?: string;
}): Promise<{ ok: boolean; error?: string }> {
  const payload = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `survey:${clientIp(await headers())}`, { limit: 10 });
  if (!limited.ok) return { ok: false, error: 'Too many survey responses. Please try again shortly.' };

  const slug = typeof payload.slug === 'string' ? payload.slug.trim().slice(0, 200) : '';
  const { data: survey } = await supabase
    .from('surveys')
    .select('id, status, scale_min, scale_max')
    .eq('slug', slug)
    .is('deleted_at', null)
    .maybeSingle();

  if (!survey) return { ok: false, error: 'Survey not found.' };
  if (survey.status !== 'active') return { ok: false, error: 'This survey is no longer accepting responses.' };

  const score = Math.round(Number(payload.score));
  if (!Number.isFinite(score) || score < survey.scale_min || score > survey.scale_max) {
    return { ok: false, error: 'Please choose a valid rating.' };
  }

  const ua = (await headers()).get('user-agent')?.slice(0, 300) ?? null;
  const { error } = await supabase.from('survey_responses').insert({
    survey_id: survey.id,
    score,
    comment: typeof payload.comment === 'string' ? payload.comment.trim().slice(0, 2000) || null : null,
    respondent_email: typeof payload.email === 'string' ? payload.email.trim().slice(0, 200) || null : null,
    channel: 'link',
    user_agent: ua,
  });
  if (error) return { ok: false, error: 'Could not save your response. Please try again.' };
  return { ok: true };
}
