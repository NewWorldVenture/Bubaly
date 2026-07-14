import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { loadServiceDescriptionOverrides } from '@/lib/services/descriptions-server';

export const runtime = 'nodejs';

// Public read of the super-admin service-description OVERRIDES (not the defaults —
// those are bundled in the client). Small payload; the "All Services" tooltip hook
// merges these over the code defaults. Cached briefly at the edge; falls back to an
// empty override set (→ code defaults) if the table isn't there yet.
export async function GET() {
  const overrides = await loadServiceDescriptionOverrides(createServiceClient());
  return NextResponse.json(
    { overrides },
    { headers: { 'Cache-Control': 'public, max-age=60, s-maxage=300, stale-while-revalidate=600' } },
  );
}
