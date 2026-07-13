import type { Metadata } from 'next';
import Link from 'next/link';
import { Heart } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { SaveButton } from '@/components/marketplace/save-button';
import { KIND_LABELS, priceLabel, type ListingKind, type RentPeriod } from '@/lib/marketplace/listings';

export const metadata: Metadata = { title: 'Saved · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function MarketplaceSavedPage() {
  const ctx = await requireUserContext();
  const sb = await createServer();

  const { data: saves } = await sb
    .from('marketplace_saves')
    .select('id, listing_id, created_at')
    .eq('family_id', ctx.active.familyId)
    .eq('member_id', ctx.active.member.id)
    .order('created_at', { ascending: false })
    .limit(200);

  const ids = (saves ?? []).map((s) => s.listing_id);
  const { data: listings } = ids.length
    ? await sb.from('marketplace_listings').select('id, title, kind, status, price_cents, rent_period, location').in('id', ids)
    : { data: [] };
  const byId = new Map((listings ?? []).map((l) => [l.id, l]));

  const rows = (saves ?? []).flatMap((s) => {
    const l = byId.get(s.listing_id);
    return l ? [{ save: s, listing: l }] : [];
  });

  return (
    <div>
      <PageHeader title="Saved" description="The listings you’ve ♥’d — they’re here whenever you’re ready." />
      {rows.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-8 text-center text-sm text-muted">
          <Heart className="mx-auto mb-2 h-6 w-6" />
          Nothing saved yet — tap the ♥ on any listing to keep it here.
          <div className="mt-2"><Link href="/marketplace/browse" className="text-brand-text hover:underline">Browse the board</Link></div>
        </div>
      ) : (
        <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ save, listing: l }) => (
            <li key={save.id} className="flex items-start gap-3 rounded-xl border border-border bg-surface/60 p-3.5">
              <div className="min-w-0 flex-1">
                <Link href={`/marketplace/item/${l.id}`} className="line-clamp-2 text-sm font-medium hover:text-brand-text">{l.title}</Link>
                <p className="mt-1 text-xs text-muted">
                  {KIND_LABELS[l.kind as ListingKind] ?? l.kind}
                  {priceLabel(l.kind as ListingKind, l.price_cents, l.rent_period as RentPeriod | null) && ` · ${priceLabel(l.kind as ListingKind, l.price_cents, l.rent_period as RentPeriod | null)}`}
                  {l.status !== 'available' && ` · ${l.status}`}
                </p>
              </div>
              <SaveButton listingId={l.id} saved />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
