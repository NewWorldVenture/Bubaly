import { NextResponse } from 'next/server';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { withStripeTables } from '@/lib/supabase/stripe-tables';
import { getOrRefreshCapabilities } from '@/lib/stripe/capabilities';
import { isManager } from '@/lib/constants/roles';

export const runtime = 'nodejs';

/** GET /api/stripe/capabilities — returns current capability matrix for this family.
 *  Used by the setup page to poll for status after Stripe Connect onboarding. */
export async function GET() {
  try {
    const ctx = await requireUserContext();
    if (!isManager(ctx.active.role)) {
      return NextResponse.json({ error: 'Managers only' }, { status: 403 });
    }

    const supabase = await createServer();
    const db = withStripeTables(supabase);
    const { data: account } = await db
      .from('stripe_connected_accounts')
      .select('account_id, charges_enabled, payouts_enabled')
      .eq('family_id', ctx.active.familyId)
      .maybeSingle();

    const capabilities = await getOrRefreshCapabilities(
      supabase,
      ctx.active.familyId,
      account?.account_id ?? null,
    );

    return NextResponse.json({
      capabilities,
      chargesEnabled: account?.charges_enabled ?? false,
      payoutsEnabled: account?.payouts_enabled ?? false,
    });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}
