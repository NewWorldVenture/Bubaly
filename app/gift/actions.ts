'use server';

import { createServiceClient } from '@/lib/supabase/server';
import { clampGiftAmountCents } from '@/lib/wallet/gift';
import { createGiftCheckoutSession } from '@/lib/stripe/checkout';
import { walletTierForPlanLevel } from '@/lib/wallet/tiers';
import { planLevel } from '@/lib/constants/plans';

type Result = { ok: boolean; error?: string; checkoutUrl?: string };

// Public gift submission — called from the unauthenticated /gift/[token] page.
// When Stripe is configured the giver is redirected to Stripe Checkout so the
// wallet is credited automatically on payment.intent.succeeded. If Stripe is not
// configured the gift is recorded as a PENDING pledge that the family approves
// manually in /wallet/gift.
export async function submitGiftPledgeAction(input: {
  token: string;
  giverName: string;
  amountCents: number;
  message?: string;
  giverEmail?: string;
}): Promise<Result> {
  const token = (input.token ?? '').trim();
  const giverName = (input.giverName ?? '').trim().slice(0, 80);
  const giverEmail = (input.giverEmail ?? '').trim().slice(0, 200) || null;
  const amount = clampGiftAmountCents(input.amountCents);
  if (!token) return { ok: false, error: 'Invalid gift link.' };
  if (!giverName) return { ok: false, error: 'Please enter your name.' };
  if (amount === null) return { ok: false, error: 'Enter an amount between $1 and $1,000.' };

  const supabase = createServiceClient();

  const { data: link } = await supabase
    .from('gift_links')
    .select('id, family_id, child_wallet_id, is_active, occasion')
    .eq('token', token)
    .maybeSingle();
  if (!link || !link.is_active) return { ok: false, error: 'This gift link is no longer active.' };

  // Anti-abuse: cap pending pledges per link.
  const { count } = await supabase
    .from('gift_payments')
    .select('id', { count: 'exact', head: true })
    .eq('gift_link_id', link.id)
    .eq('status', 'pending');
  if ((count ?? 0) >= 25) return { ok: false, error: 'Too many pending gifts on this link. Please try later.' };

  // Look up child name and family tier for the Checkout line-item display + fee calc
  let childName = 'your child';
  if (link.child_wallet_id) {
    const { data: cw } = await supabase
      .from('child_wallets')
      .select('member_id')
      .eq('id', link.child_wallet_id)
      .maybeSingle();
    if (cw?.member_id) {
      const { data: m } = await supabase
        .from('family_members')
        .select('display_name')
        .eq('id', cw.member_id)
        .maybeSingle();
      if (m?.display_name) childName = m.display_name;
    }
  }

  const message = (input.message ?? '').trim().slice(0, 500) || null;

  // Create the gift_payment record (pending)
  const { data: giftRow, error: insertErr } = await supabase
    .from('gift_payments')
    .insert({
      family_id: link.family_id,
      gift_link_id: link.id,
      child_wallet_id: link.child_wallet_id,
      giver_name: giverName,
      giver_email: giverEmail,
      amount_cents: amount,
      message,
      occasion: link.occasion,
      status: 'pending',
    })
    .select('id')
    .single();
  if (insertErr || !giftRow) return { ok: false, error: 'Could not record your gift. Please try again.' };

  // Attempt Stripe Checkout when configured
  if (process.env.STRIPE_SECRET_KEY) {
    const { data: sub } = await supabase
      .from('subscriptions')
      .select('plan')
      .eq('family_id', link.family_id)
      .in('status', ['active', 'trialing'])
      .maybeSingle();

    const tier = walletTierForPlanLevel(planLevel(sub?.plan ?? null));

    const checkout = await createGiftCheckoutSession({
      amountCents: amount,
      childName,
      giverEmail: giverEmail ?? undefined,
      giverName,
      message: message ?? undefined,
      giftPaymentId: giftRow.id,
      familyId: link.family_id,
      tier,
    });

    if (checkout.ok && checkout.url) {
      // Record the stripe_ref on the gift payment so we can look it up later
      if (checkout.sessionId) {
        await supabase
          .from('gift_payments')
          .update({ stripe_ref: checkout.sessionId })
          .eq('id', giftRow.id);
      }
      return { ok: true, checkoutUrl: checkout.url };
    }
    // If Checkout creation fails, fall through to pledge mode (still better than nothing)
  }

  // Pledge mode: notify family that a gift is waiting for manual approval
  await supabase.from('notifications').insert({
    family_id: link.family_id,
    user_id: null,
    type: 'system',
    title: `🎁 ${giverName} sent a gift`,
    body: 'Approve it in Family Wallet to add it to your child’s wallet.',
    related_type: 'gift_payments',
    related_id: giftRow.id,
  });

  return { ok: true };
}
