'use server';

import { getTranslations } from '@/lib/i18n/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { scopeFromUserContext } from '@/lib/services/scope';
import { SERVICE_CODES } from '@/lib/services/types';
import { advisePurchase, type BeforeYouBuyInput, type PurchaseAdvisorResult } from '@/lib/services/purchases';

export type { BeforeYouBuyInput } from '@/lib/services/purchases';
export type BeforeYouBuyResult = ({ ok: true } & PurchaseAdvisorResult) | { ok: false; error: string };

/** The panel and Ask use the same family-scoped, read-only advisor. */
export async function adviseBeforeBuying(input: BeforeYouBuyInput): Promise<BeforeYouBuyResult> {
  const t = await getTranslations();
  const ctx = await requireUserContext();
  const scope = scopeFromUserContext(ctx, await createServer());
  const result = await advisePurchase(scope, input);
  if (!result.ok) {
    return { ok: false, error: result.code === SERVICE_CODES.invalidInput
      ? t('wishlistsActions.sayWhatYouReThinking')
      : t('wishlistsActions.couldNotCheckWhatYou') };
  }
  return { ok: true, ...result.data };
}
