'use server';

// Server action behind the "Why this?" affordance (T7). When the family responds
// to an AI recommendation — Helpful / Not helpful / dismissed / undo / adjusted —
// we append a family-scoped row to ai_feedback. RLS (is_family_member) guarantees
// a caller only ever writes into their own family's log. Append-only signal.
import { requireUserContext } from '@/lib/supabase/auth';
import { getTranslations } from '@/lib/i18n/server';
import { createServer } from '@/lib/supabase/server';

export type FeedbackSurface = 'insight' | 'autopilot' | 'agent' | 'voting' | 'decision' | 'briefing';
export type FeedbackSignal = 'helpful' | 'not_helpful' | 'dismissed' | 'undo' | 'adjusted';

const SURFACES: FeedbackSurface[] = ['insight', 'autopilot', 'agent', 'voting', 'decision', 'briefing'];
const SIGNALS: FeedbackSignal[] = ['helpful', 'not_helpful', 'dismissed', 'undo', 'adjusted'];

export type RecordFeedbackInput = {
  surface: FeedbackSurface;
  signal: FeedbackSignal;
  refKind?: string | null;
  refId?: string | null;
  reason?: string | null;
  note?: string | null;
};

type Result = { ok: boolean; error?: string };

/** Record a "Why this?" response. Validates the enums so a bad client can't
 *  violate the CHECK constraints; truncates snapshots to keep rows small. */
export async function recordAiFeedbackAction(input: RecordFeedbackInput): Promise<Result> {
  const t = await getTranslations();
  if (!input || !SURFACES.includes(input.surface)) return { ok: false, error: t('aiFeedbackActions.invalidSurface') };
  if (!SIGNALS.includes(input.signal)) return { ok: false, error: t('aiFeedbackActions.invalidSignal') };

  const ctx = await requireUserContext();
  const supabase = await createServer();
  const { error } = await supabase.from('ai_feedback').insert({
    family_id: ctx.active.familyId,
    member_id: ctx.active.member?.id ?? null,
    surface: input.surface,
    signal: input.signal,
    ref_kind: input.refKind?.slice(0, 120) ?? null,
    ref_id: input.refId?.slice(0, 200) ?? null,
    reason: input.reason?.slice(0, 500) ?? null,
    note: input.note?.slice(0, 500) ?? null,
    created_by: ctx.user.id,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
