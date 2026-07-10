import { NextRequest, NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { getStripe } from '@/lib/stripe';

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireUserContext();
    const familyId = ctx.active.familyId;
    const supabase = await createServer();
    const stripe = getStripe();

    const { data } = await supabase
      .from('billing_customers')
      .select('customer_ref')
      .eq('family_id', familyId)
      .maybeSingle();

    if (!data?.customer_ref) {
      return NextResponse.json({ error: 'No billing account found' }, { status: 404 });
    }

    // PAY-5: trusted configured base first, not the caller-controlled Origin header.
    const origin = process.env.NEXT_PUBLIC_APP_URL ?? req.headers.get('origin') ?? 'http://localhost:3000';

    const session = await stripe.billingPortal.sessions.create({
      customer: data.customer_ref,
      return_url: `${origin}/dashboard/billing`,
    });

    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('Portal error:', err);
    return NextResponse.json({ error: 'Could not open billing portal' }, { status: 500 });
  }
}
