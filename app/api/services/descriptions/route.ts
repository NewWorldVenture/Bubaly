import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { readServiceDescriptionOverrides } from '@/lib/services/descriptions-server';

export const runtime = 'nodejs';

const RETRY_AFTER_SECONDS = 30;

// Public read of the super-admin service-description OVERRIDES (not the defaults —
// those are bundled in the client). Small payload; the "All Services" tooltip hook
// merges these over the code defaults. Cached briefly at the edge.
//
// A failed read is not "no custom descriptions". Answered as 200 `{}` under the
// public cache header below, one transient database error was stored at the edge
// and served to every visitor in the region for the life of the entry. It answers
// 503, which nothing may store; the tooltip already treats a non-ok answer as
// "use the code defaults", so the visitor sees the same thing — the next one just
// does not inherit the outage. The same rule as app/api/blog/search-index.
export async function GET() {
  const read = await readServiceDescriptionOverrides(createServiceClient());
  if (!read.ok) {
    console.error('[service-descriptions] overrides read failed', read.error);
    return NextResponse.json(
      { error: 'unavailable' },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': String(RETRY_AFTER_SECONDS) } },
    );
  }
  return NextResponse.json(
    { overrides: read.overrides },
    { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' } },
  );
}
