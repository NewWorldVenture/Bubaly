'use server';

import { createServiceClient } from '@/lib/supabase/server';
import { clampGiftAmountCents } from '@/lib/wallet/gift';

type Result = { ok: boolean; error?: string };

// Public gift submission — called from the unauthenticated /gift/[token] page.
// Uses the service client (the unguessable token IS the authorization) to record
// a PENDING gift_payment that the family then approves in /wallet/gift. No money
// moves until a parent approves (and, with Stripe enabled, a charge succeeds).
export async function submitGiftPledgeAction(input: {
  token: string; giverName: string; amountCents: number; message?: string; giverEmail?: string;
}): Promise<Result> {
  const token = (input.token ?? '').trim();
  const giverName = (input.giverName ?? '').trim().slice(0, 80);
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
    .from('gift_payments').select('id', { count: 'exact', head: true })
    .eq('gift_link_id', link.id).eq('status', 'pending');
  if ((count ?? 0) >= 25) return { ok: false, error: 'Too many pending gifts on this link. Please try later.' };

  const { error } = await supabase.from('gift_payments').insert({
    family_id: link.family_id,
    gift_link_id: link.id,
    child_wallet_id: link.child_wallet_id,
    giver_name: giverName,
    giver_email: (input.giverEmail ?? '').trim().slice(0, 200) || null,
    amount_cents: amount,
    message: (input.message ?? '').trim().slice(0, 500) || null,
    occasion: link.occasion,
    status: 'pending',
  });
  if (error) return { ok: false, error: 'Could not record your gift. Please try again.' };

  // Let the family know a gift is waiting for approval.
  await supabase.from('notifications').insert({
    family_id: link.family_id, user_id: null, type: 'system',
    title: `🎁 ${giverName} sent a gift`, body: 'Approve it in Family Wallet to add it to your child’s wallet.',
    related_type: 'gift_payments', related_id: link.id,
  });

  return { ok: true };
}
