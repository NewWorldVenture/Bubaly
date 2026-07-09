import type { Metadata } from 'next';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { MarketplaceModule } from '@/components/modules/marketplace-module';
import { MarketplaceMatchesStrip } from '@/components/marketplace/matches-strip';
import { loadAndSnapshotMatches } from '@/lib/marketplace/matches-server';

export const metadata: Metadata = { title: 'Family Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function MarketplacePage() {
  const ctx = await requireUserContext();
  const admin = await isSuperAdmin();

  // Supply↔demand match intelligence (best-effort; empty before the table lands).
  const supabase = await createServer();
  const matches = await loadAndSnapshotMatches(supabase, ctx.active.familyId, ctx.user.id);

  return (
    <div>
      {matches.length > 0 && (
        <div className="mx-auto max-w-5xl px-4 pt-6 sm:px-6">
          <MarketplaceMatchesStrip matches={matches} />
        </div>
      )}
      <MarketplaceModule canSeed={admin} />
    </div>
  );
}
