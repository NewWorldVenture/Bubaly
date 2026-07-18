'use client';

import { useMemo, useState } from 'react';
import {
  Gift, Plus, Pencil, Trash2, ExternalLink, DollarSign, Check, Lock,
  HandHeart, ShoppingBag, Star,
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
import { AiInsight } from '@/components/ai/ai-insight';
import { cn } from '@/lib/utils/cn';
import {
  claimState, canToggleClaim, sortWishes, WISH_PRIORITY_LABELS,
  type WishLike, type WishPriority, type ClaimState,
} from '@/lib/wishlists/gifts';
import type { Tables } from '@/lib/database.types';

type Wish = Tables<'wishlist_items'>;

const PRIORITY_STYLES: Record<WishPriority, string> = {
  high: 'text-rose-300 bg-rose-500/10 border-rose-500/30',
  medium: 'text-amber-300 bg-amber-500/10 border-amber-500/30',
  low: 'text-slate-300 bg-slate-500/10 border-slate-500/30',
};
const CLAIM_BADGE: Record<ClaimState, { label: string; cls: string } | null> = {
  hidden: null,
  unclaimed: { label: 'Unclaimed', cls: 'text-muted border-border' },
  claimed_by_you: { label: 'You\'re getting this', cls: 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' },
  claimed_by_other: { label: 'Claimed', cls: 'text-violet-300 bg-violet-500/10 border-violet-500/30' },
  purchased: { label: 'Purchased', cls: 'text-blue-300 bg-blue-500/10 border-blue-500/30' },
};

const blank = { id: '', title: '', url: '', price: '', priority: 'medium' as WishPriority, notes: '' };

export function WishlistsModule() {
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const selfId = selfMember?.id ?? null;

  const [activeMember, setActiveMember] = useState<string>(selfId ?? (members[0]?.id ?? ''));
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const { data: wishes, loading, error } = useRealtimeQuery<Wish>({
    table: 'wishlist_items', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('wishlist_items').select('*').eq('family_id', familyId),
  });

  const memberName = (id: string) => members.find((m) => m.id === id)?.display_name ?? 'Someone';
  const isOwnList = activeMember === selfId;

  const visible = useMemo(
    () => sortWishes((wishes ?? []).filter((w) => w.member_id === activeMember) as WishLike[]),
    [wishes, activeMember],
  );
  const wishById = useMemo(() => new Map((wishes ?? []).map((w) => [w.id, w])), [wishes]);

  // Count of items each member has, for the member tabs.
  const countByMember = useMemo(() => {
    const m = new Map<string, number>();
    for (const w of wishes ?? []) m.set(w.member_id, (m.get(w.member_id) ?? 0) + 1);
    return m;
  }, [wishes]);

  function openNew() { setForm(blank); setModalOpen(true); }
  function openEdit(w: Wish) {
    setForm({ id: w.id, title: w.title, url: w.url ?? '', price: w.price != null ? String(w.price) : '', priority: w.priority, notes: w.notes ?? '' });
    setModalOpen(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim()) { toastError('What do you wish for?'); return; }
    setSaving(true);
    const sb = createClient();
    const fields = { title: form.title.trim(), url: form.url.trim() || null, price: form.price ? Number(form.price) : null, priority: form.priority, notes: form.notes.trim() || null };
    const { error: err } = form.id
      ? await sb.from('wishlist_items').update(fields).eq('id', form.id)
      : await sb.from('wishlist_items').insert({ ...fields, family_id: familyId, member_id: selfId!, created_by: userId });
    setSaving(false);
    if (err) { toastError(describeDbError(err)); return; }
    success(form.id ? 'Wish updated' : 'Added to your wish list');
    setModalOpen(false);
  }

  async function remove(w: Wish) {
    if (!confirm(`Remove "${w.title}"?`)) return;
    const sb = createClient();
    const { error: err } = await sb.from('wishlist_items').delete().eq('id', w.id);
    if (err) { toastError(describeDbError(err)); return; }
    success('Removed');
  }

  async function toggleClaim(w: Wish) {
    if (!canToggleClaim(w as WishLike, selfId)) return;
    const sb = createClient();
    const mine = w.claimed_by === selfId;
    const { error: err } = await sb.from('wishlist_items').update(
      mine ? { claimed_by: null, claimed_at: null, is_purchased: false } : { claimed_by: selfId, claimed_at: new Date().toISOString() },
    ).eq('id', w.id);
    if (err) { toastError(describeDbError(err)); return; }
    success(mine ? 'Released' : 'You claimed this gift 🎁');
  }

  async function togglePurchased(w: Wish) {
    const sb = createClient();
    const { error: err } = await sb.from('wishlist_items').update({ is_purchased: !w.is_purchased }).eq('id', w.id);
    if (err) toastError(describeDbError(err));
  }

  if (loading) return <SkeletonList count={5} />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load wish lists'} />;

  return (
    <div>
      <PageHeader
        title="Wish Lists"
        description="Everyone's wishes in one place — claim gifts privately so surprises stay surprises."
        action={
          <div className="flex items-center gap-2">
            <AiInsight kind="wishlists" />
            {isOwnList && <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add a wish</Button>}
          </div>
        }
      />

      {/* Member tabs */}
      <div className="flex max-h-28 flex-wrap gap-1.5 mb-5 overflow-y-auto">
        {members.map((m) => (
          <button key={m.id} onClick={() => setActiveMember(m.id)}
            className={cn('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition',
              activeMember === m.id ? 'bg-brand text-white border-brand' : 'bg-surface/50 text-muted border-border hover:text-fg')}>
            <Avatar name={m.display_name} size={18} />
            {m.display_name}{m.id === selfId ? ' (you)' : ''}
            {countByMember.get(m.id) ? <span className="text-xs opacity-70">· {countByMember.get(m.id)}</span> : null}
          </button>
        ))}
      </div>

      {isOwnList && (
        <p className="text-xs text-muted mb-4 flex items-center gap-1.5">
          <Lock className="h-3.5 w-3.5" /> This is your list. You can&apos;t see who&apos;s claimed your wishes — that&apos;s the surprise!
        </p>
      )}

      {visible.length === 0 ? (
        <EmptyState icon={Gift} title={isOwnList ? 'Your wish list is empty' : `${memberName(activeMember)} hasn't added wishes yet`}
          description={isOwnList ? 'Add things you\'d love for birthdays and holidays — your family can claim them as gifts.' : 'Check back later, or nudge them to add some ideas.'}
          action={isOwnList && <Button onClick={openNew} className="gap-1.5"><Plus className="h-4 w-4" /> Add a wish</Button>} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {visible.map((row) => {
            const w = wishById.get(row.id)!;
            const cs = claimState(w as WishLike, selfId);
            const badge = CLAIM_BADGE[cs];
            const canClaim = canToggleClaim(w as WishLike, selfId);
            return (
              <div key={w.id} className={cn('rounded-2xl border p-4 flex flex-col', w.is_purchased && !isOwnList ? 'border-border bg-surface/30 opacity-75' : 'border-border bg-surface/50')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-brand/10 text-brand-text flex-shrink-0"><Gift className="h-5 w-5" /></div>
                  <div className="flex items-center gap-1.5">
                    <span className={cn('text-[10px] uppercase tracking-wide rounded border px-1.5 py-0.5 inline-flex items-center gap-1', PRIORITY_STYLES[w.priority])}>
                      {w.priority === 'high' && <Star className="h-3 w-3 fill-current" />}{WISH_PRIORITY_LABELS[w.priority]}
                    </span>
                    {isOwnList && (
                      <>
                        <button onClick={() => openEdit(w)} aria-label="Edit" className="p-1 rounded text-muted hover:text-fg hover:bg-elevated"><Pencil className="h-3.5 w-3.5" /></button>
                        <button onClick={() => remove(w)} aria-label="Remove" className="p-1 rounded text-muted hover:text-rose-400 hover:bg-elevated"><Trash2 className="h-3.5 w-3.5" /></button>
                      </>
                    )}
                  </div>
                </div>
                <div className="mt-2 font-semibold text-fg">{w.title}</div>
                {w.notes && <p className="mt-0.5 text-sm text-muted flex-1">{w.notes}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                  {w.price != null && <span className="inline-flex items-center gap-0.5"><DollarSign className="h-3.5 w-3.5" />{w.price}</span>}
                  {w.url && <a href={w.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-text hover:underline"><ExternalLink className="h-3.5 w-3.5" />View</a>}
                </div>

                {/* Gift coordination (hidden from owner) */}
                {!isOwnList && (
                  <div className="mt-3 pt-3 border-t border-border flex items-center justify-between gap-2">
                    {badge && <span className={cn('text-[11px] rounded border px-1.5 py-0.5', badge.cls)}>{badge.label}</span>}
                    <div className="flex items-center gap-1.5 ml-auto">
                      {cs === 'claimed_by_you' && (
                        <button onClick={() => togglePurchased(w)} className={cn('text-xs font-medium inline-flex items-center gap-1', w.is_purchased ? 'text-blue-300' : 'text-muted hover:text-blue-300')}>
                          <ShoppingBag className="h-3.5 w-3.5" />{w.is_purchased ? 'Bought' : 'Mark bought'}
                        </button>
                      )}
                      {canClaim && (
                        <Button size="sm" variant={cs === 'claimed_by_you' ? 'outline' : 'primary'} onClick={() => toggleClaim(w)} className="gap-1 h-7 text-xs">
                          {cs === 'claimed_by_you' ? <><Check className="h-3.5 w-3.5" /> Claimed</> : <><HandHeart className="h-3.5 w-3.5" /> Claim gift</>}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Add/edit (own list only) */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={form.id ? 'Edit wish' : 'Add a wish'}>
        <form onSubmit={save} className="space-y-4">
          <Field label="What do you wish for?" required>
            {(id) => <Input id={id} value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="e.g. Lego Botanicals set" autoFocus />}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Link">
              {(id) => <Input id={id} type="url" value={form.url} onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} placeholder="https://…" />}
            </Field>
            <Field label="Approx. price ($)">
              {(id) => <Input id={id} type="number" inputMode="decimal" min={0} step="0.01" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} placeholder="0.00" />}
            </Field>
          </div>
          <Field label="Priority">
            {(id) => (
              <Select id={id} value={form.priority} onChange={(e) => setForm((f) => ({ ...f, priority: e.target.value as WishPriority }))}>
                {(Object.keys(WISH_PRIORITY_LABELS) as WishPriority[]).map((p) => <option key={p} value={p}>{WISH_PRIORITY_LABELS[p]}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Notes">
            {(id) => <Textarea id={id} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Size, color, any details…" />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Add wish'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
