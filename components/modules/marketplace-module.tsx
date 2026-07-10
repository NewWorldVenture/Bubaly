'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Store, Plus, Search, Tag, Clock, HandHeart, Check, X, Pencil, Trash2,
  ShoppingBag, Package, Gift, HelpCircle, MapPin, Inbox, Database, Repeat,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { ListingImage } from '@/components/marketplace/listing-image';
import { cn } from '@/lib/utils/cn';
import {
  KIND_LABELS, KIND_ORDER, CATEGORY_LABELS, CONDITION_LABELS, RENT_PERIOD_LABELS,
  kindHasPrice, priceLabel, dollarsToCents, filterListings, availableCount,
  canOffer, isOwner, openOffersFor,
  type ListingKind, type ListingCategory, type ListingCondition, type RentPeriod, type ListingLike,
} from '@/lib/marketplace/listings';
import type { Tables } from '@/lib/database.types';

type Listing = Tables<'marketplace_listings'>;
type Offer = Tables<'marketplace_offers'>;

const KIND_ICON: Record<ListingKind, typeof Store> = {
  sell: ShoppingBag, rent: Clock, borrow: Package, free: Gift, wanted: HelpCircle,
  swap: Repeat, donate: HandHeart,
};
const KIND_STYLE: Record<ListingKind, string> = {
  sell: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30',
  rent: 'text-blue-300 bg-blue-500/10 border-blue-500/30',
  borrow: 'text-violet-300 bg-violet-500/10 border-violet-500/30',
  free: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  wanted: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
  swap: 'text-teal-300 bg-teal-500/10 border-teal-500/30',
  donate: 'text-pink-300 bg-pink-500/10 border-pink-500/30',
};

const blank = {
  id: '', title: '', description: '', kind: 'sell' as ListingKind,
  category: 'other' as ListingCategory, condition: '' as '' | ListingCondition,
  price: '', rent_period: 'day' as RentPeriod, location: '', photo_url: '',
};

export function MarketplaceModule({
  canSeed = false,
  initialKind = 'all',
  initialCategory = 'all',
  initialQuery = '',
  autoOpenPost = null,
}: {
  canSeed?: boolean;
  initialKind?: ListingKind | 'all';
  initialCategory?: ListingCategory | 'all';
  initialQuery?: string;
  autoOpenPost?: ListingKind | null;
}) {
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const selfId = selfMember?.id ?? null;

  const [kindFilter, setKindFilter] = useState<ListingKind | 'all'>(initialKind);
  const [catFilter, setCatFilter] = useState<ListingCategory | 'all'>(initialCategory);
  const [q, setQ] = useState(initialQuery);
  const [modalOpen, setModalOpen] = useState(!!autoOpenPost);
  const [form, setForm] = useState(autoOpenPost ? { ...blank, kind: autoOpenPost } : blank);
  const [saving, setSaving] = useState(false);
  const [offersFor, setOffersFor] = useState<Listing | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data: listings, loading, error } = useRealtimeQuery<Listing>({
    table: 'marketplace_listings', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('marketplace_listings').select('*').eq('family_id', familyId),
  });
  const { data: offers } = useRealtimeQuery<Offer>({
    table: 'marketplace_offers', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('marketplace_offers').select('*').eq('family_id', familyId),
  });

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? 'Someone';

  const visible = useMemo(
    () => filterListings(listings as ListingLike[], { kind: kindFilter, category: catFilter, q }),
    [listings, kindFilter, catFilter, q],
  ) as Listing[];

  const myOpenOffers = useMemo(
    () => new Set((offers ?? []).filter((o) => o.member_id === selfId && o.status === 'open').map((o) => o.listing_id)),
    [offers, selfId],
  );
  const openOfferCount = (listingId: string) => openOffersFor(listingId, offers ?? []).length;

  function openNew() { setForm(blank); setModalOpen(true); }
  function openEdit(l: Listing) {
    setForm({
      id: l.id, title: l.title, description: l.description ?? '', kind: l.kind as ListingKind,
      category: l.category as ListingCategory, condition: (l.condition ?? '') as '' | ListingCondition,
      price: l.price_cents ? String(l.price_cents / 100) : '',
      rent_period: (l.rent_period ?? 'day') as RentPeriod, location: l.location ?? '',
      photo_url: l.photo_url ?? '',
    });
    setModalOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { toastError('Give your listing a title'); return; }
    setSaving(true);
    const sb = createClient();
    const priced = kindHasPrice(form.kind);
    const fields = {
      title: form.title.trim(),
      description: form.description.trim() || null,
      kind: form.kind,
      category: form.category,
      condition: form.condition || null,
      price_cents: priced ? dollarsToCents(form.price) : 0,
      rent_period: form.kind === 'rent' ? form.rent_period : null,
      location: form.location.trim() || null,
      photo_url: form.photo_url.trim() || null,
    };
    const { error: err } = form.id
      ? await sb.from('marketplace_listings').update(fields).eq('id', form.id)
      : await sb.from('marketplace_listings').insert({ ...fields, family_id: familyId, member_id: selfId, created_by: userId });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(form.id ? 'Listing updated' : 'Posted to the family marketplace');
    setModalOpen(false);
  }

  async function remove(l: Listing) {
    if (!confirm(`Remove "${l.title}"?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('marketplace_listings').delete().eq('id', l.id);
    if (err) { toastError(describeDbError(err)); return; }
    success('Removed');
  }

  async function withdraw(l: Listing) {
    const sb = createClient();
    const { error: err } = await sb.rpc('marketplace_set_listing_status', { p_listing: l.id, p_status: 'withdrawn' });
    if (err) { toastError(describeDbError(err)); return; }
    success('Listing withdrawn');
  }

  // A member expresses interest / claims → creates an open offer + flips the
  // listing to "pending" so others see it's being discussed.
  async function makeOffer(l: Listing) {
    if (busyId || !canOffer(l as ListingLike, selfId, offers ?? [])) return;
    setBusyId(l.id);
    try {
      const sb = createClient();
      const kind = l.kind === 'sell' || l.kind === 'rent' ? 'interest' : 'claim';
      // Insert the offer; a DB trigger flips an available listing to 'pending', and
      // a partial unique index makes a second open offer a no-op ("already sent").
      const { error: err } = await sb.from('marketplace_offers').insert({
        family_id: familyId, listing_id: l.id, member_id: selfId, kind, created_by: userId,
      });
      if (err) {
        if (err.code === '23505') { success('You already reached out about this'); return; }
        toastError(describeDbError(err)); return;
      }
      success(kind === 'claim' ? 'You claimed this — the owner will confirm' : 'Interest sent to the owner');
    } finally {
      setBusyId(null);
    }
  }

  // Owner accepts an offer → one atomic, ownership-checked RPC claims the listing,
  // accepts this offer, declines the rest, and records the order.
  async function acceptOffer(l: Listing, offer: Offer) {
    const sb = createClient();
    const { error: err } = await sb.rpc('marketplace_accept_offer', { p_offer: offer.id });
    if (err) { toastError(describeDbError(err)); return; }
    success(`Handed off to ${memberName(offer.member_id)}`);
    setOffersFor(null);
  }

  async function declineOffer(offer: Offer) {
    const sb = createClient();
    const { error: err } = await sb.rpc('marketplace_decline_offer', { p_offer: offer.id });
    if (err) { toastError(describeDbError(err)); return; }
    success('Offer declined');
  }

  async function markCompleted(l: Listing) {
    const sb = createClient();
    const { error: err } = await sb.rpc('marketplace_set_listing_status', { p_listing: l.id, p_status: 'completed' });
    if (err) { toastError(describeDbError(err)); return; }
    success('Marked complete 🎉');
  }

  if (loading) return <SkeletonList count={5} />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load the marketplace'} />;

  const dialogOffers = offersFor ? openOffersFor(offersFor.id, offers ?? []) : [];

  return (
    <div>
      <PageHeader
        title="Family Marketplace"
        description="Buy, sell, rent, borrow or give away within the family. Post an item and everyone can claim it."
        action={
          <div className="flex items-center gap-2">
            {canSeed && (
              <Link href="/marketplace/seed"
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-muted transition hover:bg-elevated hover:text-fg">
                <Database className="h-4 w-4" /> Seed test data
              </Link>
            )}
            <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Post a listing</Button>
          </div>
        }
      />

      {/* Filters */}
      <div className="mb-5 space-y-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search listings…" className="pl-9" />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={kindFilter === 'all'} onClick={() => setKindFilter('all')}>All</FilterChip>
          {KIND_ORDER.map((k) => (
            <FilterChip key={k} active={kindFilter === k} onClick={() => setKindFilter(k)}>{KIND_LABELS[k]}</FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <FilterChip active={catFilter === 'all'} onClick={() => setCatFilter('all')} subtle>All categories</FilterChip>
          {(Object.keys(CATEGORY_LABELS) as ListingCategory[]).map((c) => (
            <FilterChip key={c} active={catFilter === c} onClick={() => setCatFilter(c)} subtle>{CATEGORY_LABELS[c]}</FilterChip>
          ))}
        </div>
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={Store} title="Nothing on the board yet"
          description="Post the first item — sell outgrown toys, lend a tool, or give away hand-me-downs."
          action={<Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Post a listing</Button>} />
      ) : (
        <>
          <p className="mb-3 text-xs text-muted">{availableCount(listings as ListingLike[])} available · {visible.length} shown</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((l) => {
              const kind = l.kind as ListingKind;
              const KindIcon = KIND_ICON[kind];
              const owner = isOwner(l as ListingLike, selfId);
              const price = priceLabel(kind, l.price_cents, l.rent_period as RentPeriod | null);
              const offerN = openOfferCount(l.id);
              const alreadyOffered = myOpenOffers.has(l.id);
              const offerable = canOffer(l as ListingLike, selfId, offers ?? []);
              return (
                <div key={l.id} className={cn('flex flex-col overflow-hidden rounded-2xl border border-border bg-surface/50',
                  l.status === 'claimed' && 'opacity-80')}>
                  <Link href={`/marketplace/item/${l.id}`} className="group block" aria-label={`View ${l.title}`}>
                  <ListingImage
                    src={l.photo_url}
                    alt={l.title}
                    className="h-40 w-full object-cover transition group-hover:opacity-90"
                    fallback={
                      <div className="flex h-40 w-full items-center justify-center bg-gradient-to-br from-surface to-border transition group-hover:opacity-90">
                        <KindIcon className="h-8 w-8 text-muted" />
                      </div>
                    }
                  />
                  </Link>
                  <div className="flex flex-1 flex-col p-4">
                  <div className="flex items-start justify-between gap-2">
                    <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide', KIND_STYLE[kind])}>
                      <KindIcon className="h-3 w-3" />{KIND_LABELS[kind]}
                    </span>
                    {price && <span className="text-sm font-semibold text-fg">{price}</span>}
                  </div>

                  <Link href={`/marketplace/item/${l.id}`} className="mt-2 font-semibold text-fg hover:text-brand">{l.title}</Link>
                  {l.description && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{l.description}</p>}

                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    <span className="inline-flex items-center gap-1"><Tag className="h-3.5 w-3.5" />{CATEGORY_LABELS[l.category as ListingCategory]}</span>
                    {l.condition && <span>{CONDITION_LABELS[l.condition as ListingCondition]}</span>}
                    {l.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{l.location}</span>}
                  </div>

                  <div className="mt-3 flex items-center gap-2 border-t border-border pt-3">
                    <Avatar name={memberName(l.member_id)} size={20} />
                    <span className="text-xs text-muted">{memberName(l.member_id)}{owner ? ' (you)' : ''}</span>
                    {l.status === 'claimed' && (
                      <span className="ml-auto text-[11px] text-emerald-300">Claimed by {memberName(l.claimed_by)}</span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="mt-3 flex items-center gap-1.5">
                    {owner ? (
                      <>
                        {offerN > 0 && l.status !== 'completed' && (
                          <Button size="sm" onClick={() => setOffersFor(l)} className="h-7 gap-1 text-xs">
                            <Inbox className="h-3.5 w-3.5" /> {offerN} {offerN === 1 ? 'offer' : 'offers'}
                          </Button>
                        )}
                        {l.status === 'claimed' && (
                          <Button size="sm" variant="outline" onClick={() => markCompleted(l)} className="h-7 gap-1 text-xs">
                            <Check className="h-3.5 w-3.5" /> Mark complete
                          </Button>
                        )}
                        <button onClick={() => openEdit(l)} aria-label="Edit" className="ml-auto rounded p-1 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
                        {l.status !== 'withdrawn' && (
                          <button onClick={() => withdraw(l)} aria-label="Withdraw" className="rounded p-1 text-muted hover:bg-elevated hover:text-amber-300"><X className="h-3.5 w-3.5" /></button>
                        )}
                        <button onClick={() => remove(l)} aria-label="Remove" className="rounded p-1 text-muted hover:bg-elevated hover:text-rose-400"><Trash2 className="h-3.5 w-3.5" /></button>
                      </>
                    ) : alreadyOffered ? (
                      <span className="inline-flex items-center gap-1 text-xs text-emerald-300"><Check className="h-3.5 w-3.5" /> {kind === 'sell' || kind === 'rent' ? 'Interest sent' : 'Claim sent'}</span>
                    ) : offerable ? (
                      <Button size="sm" onClick={() => makeOffer(l)} disabled={busyId === l.id} aria-busy={busyId === l.id} className="h-7 gap-1 text-xs">
                        <HandHeart className="h-3.5 w-3.5" /> {busyId === l.id ? 'Sending…' : kind === 'sell' || kind === 'rent' ? "I'm interested" : kind === 'wanted' ? 'I have this' : 'Claim it'}
                      </Button>
                    ) : (
                      <span className="text-xs text-muted capitalize">{l.status}</span>
                    )}
                  </div>
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Post / edit listing */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={form.id ? 'Edit listing' : 'Post a listing'}>
        <form onSubmit={save} className="space-y-4">
          <Field label="What is it?" required>
            {(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Kids' balance bike" autoFocus />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              {(id) => (
                <Select id={id} value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as ListingKind }))}>
                  {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Category">
              {(id) => (
                <Select id={id} value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value as ListingCategory }))}>
                  {(Object.keys(CATEGORY_LABELS) as ListingCategory[]).map((c) => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
                </Select>
              )}
            </Field>
          </div>

          {kindHasPrice(form.kind) && (
            <div className="grid grid-cols-2 gap-3">
              <Field label={form.kind === 'rent' ? 'Rate ($)' : 'Price ($)'}>
                {(id) => <Input id={id} type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} placeholder="0.00" />}
              </Field>
              {form.kind === 'rent' && (
                <Field label="Per">
                  {(id) => (
                    <Select id={id} value={form.rent_period} onChange={(e) => setForm((f) => ({ ...f, rent_period: e.target.value as RentPeriod }))}>
                      {(Object.keys(RENT_PERIOD_LABELS) as RentPeriod[]).map((p) => <option key={p} value={p}>{p}</option>)}
                    </Select>
                  )}
                </Field>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Condition">
              {(id) => (
                <Select id={id} value={form.condition} onChange={(e) => setForm((f) => ({ ...f, condition: e.target.value as '' | ListingCondition }))}>
                  <option value="">—</option>
                  {(Object.keys(CONDITION_LABELS) as ListingCondition[]).map((c) => <option key={c} value={c}>{CONDITION_LABELS[c]}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Where">
              {(id) => <Input id={id} value={form.location} onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))} placeholder="e.g. Garage shelf" />}
            </Field>
          </div>

          <Field label="Photo URL">
            {(id) => <Input id={id} value={form.photo_url} onChange={(e) => setForm((f) => ({ ...f, photo_url: e.target.value }))} placeholder="https://… (a photo makes it sell faster)" />}
          </Field>
          {form.photo_url.trim() && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={form.photo_url} alt="Listing preview" className="h-40 w-full rounded-lg object-cover" />
          )}

          <Field label="Details">
            {(id) => <Textarea id={id} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} placeholder="Size, age, why you're passing it on…" />}
          </Field>

          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Post it'}</Button>
          </div>
        </form>
      </Modal>

      {/* Review offers (owner) */}
      <Modal open={!!offersFor} onClose={() => setOffersFor(null)} title={offersFor ? `Offers on "${offersFor.title}"` : 'Offers'}>
        {dialogOffers.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">No open offers right now.</p>
        ) : (
          <ul className="space-y-2">
            {dialogOffers.map((o) => (
              <li key={o.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/50 p-3">
                <Avatar name={memberName(o.member_id)} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-fg">{memberName(o.member_id)}</div>
                  {o.message && <p className="truncate text-xs text-muted">{o.message}</p>}
                </div>
                <Button size="sm" onClick={() => offersFor && acceptOffer(offersFor, o as Offer)} className="h-7 gap-1 text-xs"><Check className="h-3.5 w-3.5" /> Accept</Button>
                <button onClick={() => declineOffer(o as Offer)} aria-label="Decline" className="rounded p-1 text-muted hover:text-rose-400"><X className="h-4 w-4" /></button>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </div>
  );
}

function FilterChip({ active, onClick, subtle, children }: { active: boolean; onClick: () => void; subtle?: boolean; children: React.ReactNode }) {
  return (
    <button onClick={onClick}
      className={cn('rounded-lg border px-2.5 py-1 text-xs font-medium transition',
        active
          ? 'border-brand bg-brand text-white'
          : subtle
            ? 'border-border bg-surface/50 text-muted hover:text-fg'
            : 'border-border bg-surface/50 text-fg hover:bg-elevated')}>
      {children}
    </button>
  );
}
