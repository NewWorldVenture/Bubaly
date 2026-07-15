import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { isMissingRelationError } from '@/lib/supabase/errors';
import { CommunityModule } from '@/components/marketplace/community-module';
import type { CircleLite, CircleMemberLite, ShareLite, SharedListingLite } from '@/lib/marketplace/community';

export const metadata: Metadata = { title: 'Community Circles' };
export const dynamic = 'force-dynamic';

/**
 * Community Marketplace (v1) — cross-family circles. Families join a circle by
 * invite code and share individual listings into it; the RLS layer (0173) makes
 * exactly those shared listings visible across family boundaries. Degrades to
 * an inviting empty state before the migration is applied.
 */
export default async function CommunityPage() {
  const ctx = await requireUserContext();
  const supabase = await createServer();
  const familyId = ctx.active.familyId;

  let circles: CircleLite[] = [];
  let members: CircleMemberLite[] = [];
  let shares: ShareLite[] = [];
  let shared: SharedListingLite[] = [];
  let migrated = true;
  const readWarnings: string[] = [];
  const reportRead = (label: string, error: { message?: string | null } | null | undefined) => {
    if (!error) return;
    console.error(`[marketplace-community] ${label} read failed`, error);
    readWarnings.push(label);
  };

  try {
    const [{ data: c, error: cErr }, { data: m, error: mErr }, { data: s, error: sErr }] = await Promise.all([
      supabase.from('marketplace_circles').select('id, name, emoji, join_code').order('created_at'),
      supabase.from('marketplace_circle_members').select('circle_id, family_id, family_name, role'),
      supabase.from('marketplace_listing_shares').select('listing_id, circle_id, family_id, created_at').order('created_at', { ascending: false }).limit(600),
    ]);
    if (cErr && isMissingRelationError(cErr)) migrated = false;
    else reportRead('Circles', cErr);
    reportRead('Circle members', mErr);
    reportRead('Listing shares', sErr);
    circles = c ?? [];
    members = m ?? [];
    shares = s ?? [];

    // The shared listings themselves — the 0173 circle-read policy grants
    // SELECT across family boundaries for exactly these ids.
    const ids = [...new Set(shares.map((x) => x.listing_id))];
    if (ids.length) {
      const { data: l, error: lErr } = await supabase
        .from('marketplace_listings')
        .select('id, title, kind, category, condition, price_cents, rent_period, status, family_id')
        .in('id', ids);
      reportRead('Shared listings', lErr);
      shared = (l ?? []) as SharedListingLite[];
    }
  } catch (error) {
    if (isMissingRelationError(error)) migrated = false;
    else {
      console.error('[marketplace-community] circle reads threw', error);
      readWarnings.push('Circle data');
    }
  }

  // My own available listings, for the share picker.
  const { data: mine, error: mineError } = await supabase
    .from('marketplace_listings')
    .select('id, title, kind, category, condition, price_cents, rent_period, status, family_id')
    .eq('family_id', familyId)
    .eq('status', 'available')
    .order('created_at', { ascending: false })
    .limit(200);
  reportRead('Your listings', mineError);

  return (
    <CommunityModule
      migrated={migrated}
      familyId={familyId}
      circles={circles}
      members={members}
      shares={shares}
      sharedListings={shared}
      myListings={(mine ?? []) as SharedListingLite[]}
      readWarnings={Array.from(new Set(readWarnings))}
    />
  );
}
