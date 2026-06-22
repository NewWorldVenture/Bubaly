import 'server-only';
import { createServiceClient } from '@/lib/supabase/server';
import { resolveExitIntent, normalizeTrigger, type ExitTrigger } from '@/lib/marketing/exit-intent';
import type { AudienceMatch, VisitorContext } from '@/lib/marketing/personalization';

export type PublicExitOffer = {
  id: string;
  headline: string;
  body: string | null;
  cta_label: string | null;
  cta_href: string | null;
  trigger: ExitTrigger;
};

type Row = {
  id: string; headline: string; body: string | null; cta_label: string | null; cta_href: string | null;
  match: AudienceMatch; trigger_config: unknown; priority: number; status: string; created_at: string; deleted_at: string | null;
};

/** Resolve the best active exit-intent offer for a visitor context. Reads with
 *  the service role (no client policies) and returns a trimmed public shape. */
export async function resolveActiveExitIntent(ctx: VisitorContext): Promise<PublicExitOffer | null> {
  const { data } = await createServiceClient()
    .from('marketing_exit_intent')
    .select('id, headline, body, cta_label, cta_href, match, trigger_config, priority, status, created_at, deleted_at')
    .eq('status', 'active')
    .is('deleted_at', null);
  const offer = resolveExitIntent((data ?? []) as unknown as Row[], ctx);
  if (!offer) return null;
  return {
    id: offer.id,
    headline: offer.headline,
    body: offer.body,
    cta_label: offer.cta_label,
    cta_href: offer.cta_href,
    trigger: normalizeTrigger(offer.trigger_config),
  };
}
