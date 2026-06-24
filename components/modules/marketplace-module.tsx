'use client';

import { useMemo, useState } from 'react';
import { Plus, Trash2, ChevronRight, Tag } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import type { Tables } from '@/lib/database.types';
import {
  LISTING_TYPES, LISTING_STATUSES, CONDITIONS, LISTING_CATEGORIES,
  listingTypeMeta, conditionLabel, listingsByCategory, listingsByType,
  marketplaceSummary, fmtPrice, fmtDate,
} from '@/lib/marketplace/listings';

type Listing = Tables<'marketplace_listings'>;

export function MarketplaceModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const listings = useRealtimeQuery<Listing>({
    table: 'marketplace_listings', familyId,
    fetcher: (s) => s.from('marketplace_listings').select('*').eq('family_id', familyId).eq('is_active', true).order('created_at', { ascending: false }),
    deps: [familyId],
  });

  const [selected, setSelected] = useState<Listing | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [filterType, setFilterType] = useState<string>('all');

  const summary = useMemo(() => {
    if (!listings.data) return null;
    return marketplaceSummary(listings.data);
  }, [listings.data]);

  const catStats = useMemo(() => listingsByCategory(listings.data ?? []), [listings.data]);
  const typeStats = useMemo(() => listingsByType(listings.data ?? []), [listings.data]);

  const filtered = useMemo(() => {
    if (!listings.data) return [];
    if (filterType === 'all') return listings.data;
    return listings.data.filter((l) => l.listing_type === filterType);
  }, [listings.data, filterType]);

  if (listings.loading) return <LoadingBlock />;

  return (
    <div className="space-y-6">
      <PageHeader title="Marketplace" />

      {summary && summary.total > 0 && (
        <div className="rounded-xl border border-border bg-surface/60 p-4">
          <p className="text-sm font-medium">{summary.text}</p>
        </div>
      )}

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-1.5 flex-wrap">
          <button
            onClick={() => setFilterType('all')}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${filterType === 'all' ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface/40'}`}
          >All</button>
          {LISTING_TYPES.map((t) => (
            <button
              key={t.value}
              onClick={() => setFilterType(t.value)}
              className={`text-xs px-3 py-1 rounded-full border transition-colors ${filterType === t.value ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-surface/40'}`}
            >{t.emoji} {t.label}</button>
          ))}
        </div>
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="w-4 h-4 mr-1" /> New Listing</Button>
      </div>

      {(catStats.length > 0 || typeStats.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {catStats.map(({ category, count }) => (
            <span key={category} className="text-xs px-2 py-0.5 rounded-full border border-border bg-surface/40">
              {category}: {count}
            </span>
          ))}
        </div>
      )}

      {filtered.length === 0 ? (
        <EmptyState title="No listings" description="Post items to sell, trade, or give away within your family." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((l) => {
            const meta = listingTypeMeta(l.listing_type);
            return (
              <button key={l.id} onClick={() => setSelected(l)}
                className="text-left rounded-xl border border-border bg-surface/60 p-5 hover:border-primary/40 transition-colors">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-bold line-clamp-1">{l.title || 'Untitled'}</span>
                  <ChevronRight className="w-4 h-4 text-muted shrink-0" />
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  <span className="text-xs px-2 py-0.5 rounded-full border border-border bg-surface/40">
                    {meta.emoji} {meta.label}
                  </span>
                  <span className="text-xs px-2 py-0.5 rounded-full border border-border bg-surface/40">
                    {conditionLabel(l.condition)}
                  </span>
                  {l.status !== 'active' && (
                    <span className="text-xs px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400">
                      {l.status}
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-lg font-bold text-primary">
                    {l.listing_type === 'wanted' ? '' : fmtPrice(l.price ? Number(l.price) : null)}
                  </span>
                  <span className="text-xs text-muted">{l.category}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      {addOpen && (
        <AddListingModal familyId={familyId} userId={userId}
          onClose={() => setAddOpen(false)}
          onSuccess={() => { setAddOpen(false); success('Listing created'); }} />
      )}
      {selected && (
        <ListingDetail listing={selected}
          onClose={() => setSelected(null)}
          onDelete={() => { setSelected(null); success('Listing removed'); }}
          onUpdate={() => { setSelected(null); success('Listing updated'); }} />
      )}
    </div>
  );
}

function AddListingModal({ familyId, userId, onClose, onSuccess }: {
  familyId: string; userId: string; onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('marketplace_listings').insert({
      family_id: familyId,
      created_by: userId,
      title: String(f.get('title') ?? ''),
      description: String(f.get('description') ?? ''),
      category: String(f.get('category') ?? 'Other'),
      condition: String(f.get('condition') ?? 'good') as Listing['condition'],
      listing_type: String(f.get('listing_type') ?? 'sell') as Listing['listing_type'],
      price: f.get('price') ? Number(f.get('price')) : null,
      location: String(f.get('location') ?? ''),
      notes: String(f.get('notes') ?? ''),
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  return (
    <Modal open onClose={onClose} title="New Listing">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title" required>{(id) => <Input id={id} name="title" autoFocus placeholder="What are you listing?" />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} name="description" rows={3} placeholder="Describe the item..." />}</Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Type">{(id) =>
            <Select id={id} name="listing_type" defaultValue="sell">
              {LISTING_TYPES.map((t) => <option key={t.value} value={t.value}>{t.emoji} {t.label}</option>)}
            </Select>
          }</Field>
          <Field label="Category">{(id) =>
            <Select id={id} name="category" defaultValue="Other">
              {LISTING_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          }</Field>
          <Field label="Condition">{(id) =>
            <Select id={id} name="condition" defaultValue="good">
              {CONDITIONS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </Select>
          }</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Price">{(id) => <Input id={id} name="price" type="number" placeholder="0 = free" />}</Field>
          <Field label="Location">{(id) => <Input id={id} name="location" placeholder="Pickup location" />}</Field>
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Create</Button>
        </div>
      </form>
    </Modal>
  );
}

function ListingDetail({ listing, onClose, onDelete, onUpdate }: {
  listing: Listing; onClose: () => void; onDelete: () => void; onUpdate: () => void;
}) {
  const { error: toastError } = useToast();
  const meta = listingTypeMeta(listing.listing_type);

  async function handleDelete() {
    const { error } = await createClient().from('marketplace_listings').update({ is_active: false }).eq('id', listing.id);
    if (error) { toastError(error.message); return; }
    onDelete();
  }

  async function markAs(status: Listing['status']) {
    const { error } = await createClient().from('marketplace_listings').update({ status }).eq('id', listing.id);
    if (error) { toastError(error.message); return; }
    onUpdate();
  }

  return (
    <Modal open onClose={onClose} title={listing.title || 'Listing'}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2 text-sm">
          <span className="px-2 py-0.5 rounded-full border border-border bg-surface/40">{meta.emoji} {meta.label}</span>
          <span className="px-2 py-0.5 rounded-full border border-border bg-surface/40">{conditionLabel(listing.condition)}</span>
          <span className="px-2 py-0.5 rounded-full border border-border bg-surface/40">{listing.category}</span>
          {listing.status !== 'active' && (
            <span className="px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400 capitalize">{listing.status}</span>
          )}
        </div>

        {listing.listing_type !== 'wanted' && (
          <p className="text-2xl font-bold text-primary">{fmtPrice(listing.price ? Number(listing.price) : null)}</p>
        )}

        {listing.description && <p className="text-sm text-muted">{listing.description}</p>}
        {listing.location && <p className="text-sm text-muted">📍 {listing.location}</p>}
        {listing.notes && <p className="text-sm text-muted">{listing.notes}</p>}
        <p className="text-xs text-muted">Listed {fmtDate(listing.created_at)}</p>

        {listing.status === 'active' && (
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="ghost" onClick={() => markAs('sold')}>Mark Sold</Button>
            <Button size="sm" variant="ghost" onClick={() => markAs('traded')}>Mark Traded</Button>
            <Button size="sm" variant="ghost" onClick={() => markAs('withdrawn')}>Withdraw</Button>
          </div>
        )}

        <div className="flex justify-between pt-2 border-t border-border">
          <Button variant="ghost" size="sm" className="text-rose-400" onClick={handleDelete}>
            <Trash2 className="w-4 h-4 mr-1" /> Delete
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
