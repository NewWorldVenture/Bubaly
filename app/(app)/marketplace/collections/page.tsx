import type { Metadata } from 'next';
import Link from 'next/link';
import { FolderHeart, ArrowLeft } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { PageHeader } from '@/components/app/page-header';
import { KIND_LABELS, priceLabel, type ListingKind, type RentPeriod } from '@/lib/marketplace/listings';

export const metadata: Metadata = { title: 'Collections · Marketplace | Bubaly' };
export const dynamic = 'force-dynamic';

export default async function MarketplaceCollectionsPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const ctx = await requireUserContext();
  const sb = await createServer();
  const { id } = await searchParams;

  const { data: collections } = await sb
    .from('marketplace_collections')
    .select('id, name, emoji, description')
    .eq('family_id', ctx.active.familyId)
    .order('created_at', { ascending: true })
    .limit(50);

  const { data: items } = await sb
    .from('marketplace_collection_items')
    .select('collection_id, listing_id')
    .eq('family_id', ctx.active.familyId)
    .limit(2000);

  const countOf = new Map<string, number>();
  for (const it of items ?? []) countOf.set(it.collection_id, (countOf.get(it.collection_id) ?? 0) + 1);

  const open = id ? (collections ?? []).find((c) => c.id === id) ?? null : null;

  if (open) {
    const ids = (items ?? []).filter((i) => i.collection_id === open.id).map((i) => i.listing_id);
    const { data: listings } = ids.length
      ? await sb.from('marketplace_listings').select('id, title, kind, status, price_cents, rent_period').in('id', ids).limit(200)
      : { data: [] };
    return (
      <div>
        <Link href="/marketplace/collections" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-brand">
          <ArrowLeft className="h-3 w-3" /> All collections
        </Link>
        <PageHeader title={`${open.emoji ?? '🗂️'} ${open.name}`} description={open.description ?? `${ids.length} items in this collection.`} />
        <ul className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {(listings ?? []).map((l) => (
            <li key={l.id} className="rounded-xl border border-border bg-surface/60 p-3.5">
              <Link href={`/marketplace/browse?q=${encodeURIComponent(l.title)}`} className="line-clamp-2 text-sm font-medium hover:text-brand">{l.title}</Link>
              <p className="mt-1 text-xs text-muted">
                {KIND_LABELS[l.kind as ListingKind] ?? l.kind}
                {priceLabel(l.kind as ListingKind, l.price_cents, l.rent_period as RentPeriod | null) && ` · ${priceLabel(l.kind as ListingKind, l.price_cents, l.rent_period as RentPeriod | null)}`}
              </p>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title="Collections" description="Curated sets from the family board — dresses for the wedding, camping season, baby gear." />
      {(collections ?? []).length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface/40 p-8 text-center text-sm text-muted">
          <FolderHeart className="mx-auto mb-2 h-6 w-6" />
          No collections yet.
        </div>
      ) : (
        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {(collections ?? []).map((c) => (
            <li key={c.id}>
              <Link href={`/marketplace/collections?id=${c.id}`} className="block rounded-xl border border-border bg-surface/60 p-4 transition hover:border-brand/40">
                <span className="text-2xl">{c.emoji ?? '🗂️'}</span>
                <p className="mt-1.5 line-clamp-1 text-sm font-semibold">{c.name}</p>
                {c.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{c.description}</p>}
                <p className="mt-1 text-[11px] text-muted">{countOf.get(c.id) ?? 0} items</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
