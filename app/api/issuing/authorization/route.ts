// app/api/issuing/authorization/route.ts
// Real-time Stripe Issuing authorization webhook — called synchronously by Stripe
// when a card is swiped. Must respond in <2 seconds or Stripe auto-declines.
// Approves or declines based on child wallet balance, card controls, and blocked categories.

import { NextRequest, NextResponse } from 'next/server';
import { getStripe } from '@/lib/stripe';
import { createServiceClient } from '@/lib/supabase/server';
import { withStripeTables } from '@/lib/supabase/stripe-tables';
import { balanceFromLedger } from '@/lib/wallet/ledger';
import type Stripe from 'stripe';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const body = await req.text();
  const sig = req.headers.get('stripe-signature') ?? '';
  const secret = process.env.STRIPE_ISSUING_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET ?? '';

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(body, sig, secret);
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  if (event.type !== 'issuing_authorization.request') {
    return NextResponse.json({ received: true });
  }

  const auth = event.data.object as Stripe.Issuing.Authorization;
  const stripe = getStripe();
  const supabase = createServiceClient();
  const db = withStripeTables(supabase);

  const { approved, reason } = await evaluateAuthorization(db, auth);

  // Respond to Stripe with approve/decline decision
  try {
    if (approved) {
      await stripe.issuing.authorizations.approve(auth.id);
    } else {
      await stripe.issuing.authorizations.decline(auth.id);
    }
  } catch (err) {
    console.error('[issuing/auth] Stripe respond error', err);
  }

  // Log the authorization decision
  const meta = auth.metadata ?? {};
  try {
    await db.from('stripe_authorizations').upsert(
      {
        authorization_id: auth.id,
        family_id: meta.family_id ?? null,
        card_id: auth.card.id,
        child_wallet_id: meta.child_wallet_id ?? null,
        status: approved ? 'approved' : 'declined',
        decision: approved ? 'approved' : 'declined',
        decline_reason: approved ? null : reason,
        amount_cents: auth.amount,
        currency: auth.currency,
        merchant_name: auth.merchant_data?.name ?? null,
        merchant_category: auth.merchant_data?.category ?? null,
        metadata: { ...meta, decision_reason: reason } as Record<string, unknown>,
        authorized_at: new Date().toISOString(),
      },
      { onConflict: 'authorization_id' },
    );
  } catch { /* non-fatal — table may not exist yet */ }

  return NextResponse.json({ approved });
}

async function evaluateAuthorization(
  db: ReturnType<typeof withStripeTables<ReturnType<typeof createServiceClient>>>,
  auth: Stripe.Issuing.Authorization,
): Promise<{ approved: boolean; reason: string }> {
  const cardId = auth.card.id;
  const amountCents = auth.amount;
  const merchantCategory = auth.merchant_data?.category ?? '';

  // 1. Load card record
  const { data: card } = await db
    .from('stripe_issuing_cards')
    .select('status, child_wallet_id, family_id')
    .eq('card_id', cardId)
    .maybeSingle();

  if (!card) return { approved: false, reason: 'card_not_found' };
  const typedCard = card as { status: string; child_wallet_id: string | null; family_id: string | null };
  if (typedCard.status !== 'active') return { approved: false, reason: 'card_inactive' };

  const familyId = typedCard.family_id;
  const childWalletId = typedCard.child_wallet_id;

  // 2. Load card controls
  const { data: controls } = await db
    .from('card_controls')
    .select('*')
    .eq('card_id', cardId)
    .maybeSingle();

  const typedControls = controls as {
    blocked_categories: string[];
    allow_atm: boolean;
    per_txn_limit_cents: number | null;
    parent_approval_threshold_cents: number | null;
  } | null;

  if (typedControls) {
    // Check merchant category blocks
    const blocked = typedControls.blocked_categories ?? [];
    if (merchantCategory && blocked.includes(merchantCategory)) {
      return { approved: false, reason: 'blocked_category' };
    }

    // Check ATM
    if (!typedControls.allow_atm && (merchantCategory === 'atm_s_and_cash_dispensers' || merchantCategory === 'cash_advance')) {
      return { approved: false, reason: 'atm_not_allowed' };
    }

    // Check per-transaction limit
    if (typedControls.per_txn_limit_cents && amountCents > typedControls.per_txn_limit_cents) {
      return { approved: false, reason: 'exceeds_per_transaction_limit' };
    }
  }

  // 3. Check child wallet balance
  if (childWalletId && familyId) {
    const { data: txns } = await db
      .from('wallet_transactions')
      .select('direction, amount_cents, status')
      .eq('family_id', familyId)
      .eq('child_wallet_id', childWalletId)
      .eq('status', 'completed');

    const entries = ((txns ?? []) as Array<{ direction: string; amount_cents: number; status: string }>).map((t) => ({
      direction: t.direction as 'credit' | 'debit',
      amount_cents: t.amount_cents,
      status: t.status,
    }));

    const balance = balanceFromLedger(entries);
    if (balance < amountCents) {
      return { approved: false, reason: 'insufficient_balance' };
    }

    // Check parent approval threshold
    if (typedControls?.parent_approval_threshold_cents && amountCents >= typedControls.parent_approval_threshold_cents) {
      return { approved: false, reason: 'requires_parent_approval' };
    }
  }

  return { approved: true, reason: 'approved' };
}
