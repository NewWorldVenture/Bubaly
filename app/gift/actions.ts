'use server';

import { headers } from 'next/headers';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { clampGiftAmountCents } from '@/lib/wallet/gift';
import { clientIp } from '@/lib/server/rate-limit';
import { enforceRequestRateLimit } from '@/lib/server/request-rate-limit';
import { notify } from '@/lib/services/notifications';
import { systemScopeForFamily } from '@/lib/services/scope';

type Result = { ok: boolean; error?: string };

// Public gift submission — called from the unauthenticated /gift/[token] page.
// Uses the service client (the unguessable token IS the authorization) to record
// a PENDING gift_payment that the family then approves in /wallet/gift. No money
// moves until a parent approves (and, with Stripe enabled, a charge succeeds).
export async function submitGiftPledgeAction(input: {
  token: string; giverName: string; amountCents: number; message?: string; giverEmail?: string;
}): Promise<Result> {
  const t = await getTranslations();
  const payload = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const token = typeof payload.token === 'string' ? payload.token.trim().slice(0, 200) : '';
  const giverName = typeof payload.giverName === 'string' ? payload.giverName.trim().slice(0, 80) : '';
  const amount = clampGiftAmountCents(Number(payload.amountCents));
  if (!token) return { ok: false, error: t('actions.invalidGiftLink') };
  if (!giverName) return { ok: false, error: t('actions.pleaseEnterYourName') };
  if (amount === null) return { ok: false, error: t('actions.enterAnAmountBetween1') };

  const supabase = createServiceClient();
  const limited = await enforceRequestRateLimit(supabase, `gift:${clientIp(await headers())}`, { limit: 10 });
  if (!limited.ok) return { ok: false, error: t('actions.tooManyGiftAttemptsPlease') };

  const { data: link } = await supabase
    .from('gift_links')
    .select('id, family_id, child_wallet_id, is_active, occasion')
    .eq('token', token)
    .maybeSingle();
  if (!link || !link.is_active) return { ok: false, error: t('actions.thisGiftLinkIsNo') };

  // Anti-abuse: cap pending pledges per link.
  const { count } = await supabase
    .from('gift_payments').select('id', { count: 'exact', head: true })
    .eq('gift_link_id', link.id).eq('status', 'pending');
  if ((count ?? 0) >= 25) return { ok: false, error: t('actions.tooManyPendingGiftsOn') };

  const { error } = await supabase.from('gift_payments').insert({
    family_id: link.family_id,
    gift_link_id: link.id,
    child_wallet_id: link.child_wallet_id,
    giver_name: giverName,
    giver_email: typeof payload.giverEmail === 'string' ? payload.giverEmail.trim().slice(0, 200) || null : null,
    amount_cents: amount,
    message: typeof payload.message === 'string' ? payload.message.trim().slice(0, 500) || null : null,
    occasion: link.occasion,
    status: 'pending',
  });
  if (error) return { ok: false, error: t('actions.couldNotRecordYourGift') };

  // Let the family know a gift is waiting for approval — through the service,
  // so it lands inside the hours the family agreed to hear from Bubaly and a
  // retried submission does not notify twice. Not urgent: a gift sitting in the
  // wallet at 3am is still there at 8am, and nothing about it needs a parent
  // awake. A failure is best-effort as before; the gift is already recorded.
  const scope = await systemScopeForFamily(supabase, link.family_id);
  if (scope) {
    await notify(scope, {
      recipients: 'family',
      type: 'system',
      title: `🎁 ${giverName} sent a gift`,
      body: 'Approve it in Family Wallet to add it to your child’s wallet.',
      relatedType: 'gift_payments',
      relatedId: link.id,
    });
  }

  return { ok: true };
}
