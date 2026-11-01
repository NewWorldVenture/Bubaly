import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from '@/lib/i18n/server';
import { createServiceClient } from '@/lib/supabase/server';
import { runNetworkAggregation } from '@/lib/network/aggregate-server';
import { hasCronAuthorization } from '@/lib/server/cron-auth';

export const runtime = 'nodejs';
export const maxDuration = 60;

// Intelligence Network aggregation cron — recomputes each consenting family's coarse
// contribution nightly, and publishes the k-anonymized, DP-noised cross-family
// aggregates once per publication epoch (a calendar month; the other nights hold
// that snapshot unchanged). Nothing is published until >= 100 families contribute
// (launch gate). Scheduled daily.
export async function GET(req: NextRequest) {
  const t = await getTranslations();
  if (!hasCronAuthorization(req)) {
    return NextResponse.json({ error: t('networkAggregate.unauthorized') }, { status: 401 });
  }
  try {
    const supabase = createServiceClient();
    const result = await runNetworkAggregation(supabase, new Date());
    return NextResponse.json(
      {
        ok: result.ok,
        contributors: result.contributors,
        aggregates: result.aggregates,
        ...(result.error ? { error: t('networkAggregate.networkAggregationFailed') } : {}),
      },
      { status: result.ok ? 200 : 502 },
    );
  } catch (err) {
    console.error('Network-aggregate cron error:', err);
    return NextResponse.json({ error: t('networkAggregate.networkAggregateCronFailed') }, { status: 500 });
  }
}
