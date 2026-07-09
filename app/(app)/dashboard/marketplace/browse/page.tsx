import type { Metadata } from 'next';
import { requireUserContext, isSuperAdmin } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { MarketplaceModule } from '@/components/modules/marketplace-module';
import { MarketplaceMatchesStrip } from '@/components/marketplace/matches-strip';
import { loadAndSnapshotMatches } from '@/lib/marketplace/matches-server';
import { KIND_ORDER, type ListingKind, type ListingCategory, CATEGORY_LABELS } from '@/lib/marketplace/listings';

export const metadata: Metadata = { title: 'Browse · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

// The full browse/post board (the original marketplace module), driven by the
// V2 rail: ?kind= filters, ?cat= filters, ?post=1[&kind=] opens the post modal,
// ?q= pre-fills search.
export default async function MarketplaceBrowsePage({ searchParams }: { searchParams: Promise<{ kind?: string; cat?: string; post?: string; q?: string }> }) {
  const ctx = await requireUserContext();
  const admin = await isSuperAdmin();
  const params = await searchParams;

  const kind = KIND_ORDER.includes(params.kind as ListingKind) ? (params.kind as ListingKind) : 'all';
  const cat = params.cat && params.cat in CATEGORY_LABELS ? (params.cat as ListingCategory) : 'all';
  const postKind = params.post ? (kind === 'all' ? 'sell' : kind) : null;

  const supabase = await createServer();
  const matches = await loadAndSnapshotMatches(supabase, ctx.active.familyId, ctx.user.id);

  return (
    <div>
      {matches.length > 0 && <MarketplaceMatchesStrip matches={matches} />}
      <MarketplaceModule
        canSeed={admin}
        initialKind={kind}
        initialCategory={cat}
        initialQuery={params.q ?? ''}
        autoOpenPost={postKind}
      />
    </div>
  );
}
