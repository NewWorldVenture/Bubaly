'use client';

import { useMemo, useState } from 'react';
import { Heart, Plus, Trash2, Star, ExternalLink } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { FAVORITE_KIND_META } from '@/lib/meals/tracker';
import { useTranslations } from '@/components/i18n/locale-provider';

type Favorite = Tables<'family_favorites'>;
const KINDS = ['recipe', 'restaurant', 'meal', 'snack', 'drink', 'other'] as const;

export function FavoritesView() {
  const t = useTranslations();
  const { familyId, userId, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const { data: rows, loading, error, refresh } = useRealtimeQuery<Favorite>({
    table: 'family_favorites', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_favorites').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const [filter, setFilter] = useState<string>('all');
  const [form, setForm] = useState(false);

  const favorites = useMemo(() => rows ?? [], [rows]);
  const filtered = useMemo(() => filter === 'all' ? favorites : favorites.filter((f) => f.kind === filter), [favorites, filter]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const f of favorites) m[f.kind] = (m[f.kind] ?? 0) + 1;
    return m;
  }, [favorites]);

  async function remove(id: string) {
    if (!confirm('Remove this favorite?')) return;
    const { error } = await createClient().from('family_favorites').delete().eq('id', id);
    if (error) toastError(error.message); else success('Removed');
  }

  // A genuine read failure must surface + be retryable, not silently render as an
  // empty favorites list. (Missing-table/offline are already degraded by the hook.)
  if (error) return <ErrorState message={t('favoritesView.couldNotLoadFavoritesRefresh')} onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader title={t('favorites.familyFavorites')} description={t('favoritesView.theMealsRecipesAndSpots')}
        action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('favorites.addFavorite')}</Button>} />

      {/* Filter chips */}
      <div className="flex flex-wrap gap-2">
        <Chip active={filter === 'all'} onClick={() => setFilter('all')}>{t('favorites.all')}{favorites.length})</Chip>
        {KINDS.filter((k) => counts[k]).map((k) => (
          <Chip key={k} active={filter === k} onClick={() => setFilter(k)}>{FAVORITE_KIND_META[k].emoji} {FAVORITE_KIND_META[k].label} ({counts[k]})</Chip>
        ))}
      </div>

      {loading ? <SkeletonList /> : favorites.length === 0 ? (
        <EmptyState icon={Heart} title={t('favorites.noFavoritesYet')} description={t('favoritesView.saveTheRecipesRestaurantsAnd')}
          action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> {t('favorites.addFavorite')}</Button>} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((f) => {
            const meta = FAVORITE_KIND_META[f.kind] ?? FAVORITE_KIND_META.other;
            return (
              <div key={f.id} className="group rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2">
                    <span className="text-xl">{meta.emoji}</span>
                    <div className="min-w-0">
                      <p className="truncate font-semibold">{f.name}</p>
                      <p className="text-xs text-muted">{meta.label}</p>
                    </div>
                  </div>
                  <button onClick={() => remove(f.id)} className="rounded-lg p-1 text-muted/40 opacity-0 transition hover:text-danger group-hover:opacity-100" aria-label={t('favoritesView.remove')}><Trash2 className="h-4 w-4" /></button>
                </div>
                {f.rating != null && (
                  <div className="mt-2 flex gap-0.5">
                    {Array.from({ length: 5 }).map((_, i) => <Star key={i} className={cn('h-3.5 w-3.5', i < f.rating! ? 'fill-amber-400 text-amber-400' : 'text-muted/40')} />)}
                  </div>
                )}
                {f.notes && <p className="mt-2 text-sm text-muted">{f.notes}</p>}
                {f.ref_url && <a href={f.ref_url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-brand-text"><ExternalLink className="h-3.5 w-3.5" />{' '}{t('favoritesView.open')}</a>}
              </div>
            );
          })}
        </div>
      )}

      {form && <FavoriteModal familyId={familyId} userId={userId} memberId={selfMember?.id ?? null} onClose={() => setForm(false)} />}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn('rounded-full px-3 py-1.5 text-xs font-semibold transition', active ? 'bg-brand/15 text-brand-text' : 'bg-surface/60 text-muted hover:bg-elevated hover:text-fg')}>{children}</button>
  );
}

function FavoriteModal({ familyId, userId, memberId, onClose }: { familyId: string; userId: string; memberId: string | null; onClose: () => void }) {
  const t = useTranslations();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [v, setV] = useState({ name: '', kind: 'recipe', rating: '', notes: '', ref_url: '' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!v.name.trim()) return toastError('Add a name');
    setSaving(true);
    const { error } = await createClient().from('family_favorites').insert({
      family_id: familyId, member_id: memberId, kind: v.kind, name: v.name.trim(),
      rating: v.rating ? Number(v.rating) : null, notes: v.notes.trim() || null,
      ref_url: v.ref_url.trim() || null, created_by: userId,
    });
    setSaving(false);
    if (error) return toastError(error.message);
    success('Favorite added');
    onClose();
  }

  return (
    <Modal open onClose={onClose} title={t('favorites.addFavorite')}>
      <form onSubmit={submit} className="space-y-4">
        <Field label={t('favorites.name')}>{(id) => <Input id={id} value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder={t('favoritesView.grandmaSLasagna')} required autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('favorites.kind')}>{(id) => <Select id={id} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value })}>{KINDS.map((k) => <option key={k} value={k}>{FAVORITE_KIND_META[k].label}</option>)}</Select>}</Field>
          <Field label={t('favorites.rating')} hint={t('favoritesView.optional')}>{(id) => <Select id={id} value={v.rating} onChange={(e) => setV({ ...v, rating: e.target.value })}><option value="">—</option>{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{'★'.repeat(n)}</option>)}</Select>}</Field>
        </div>
        <Field label={t('favorites.link')} hint={t('favoritesView.optional')}>{(id) => <Input id={id} value={v.ref_url} onChange={(e) => setV({ ...v, ref_url: e.target.value })} placeholder="https://…" />}</Field>
        <Field label={t('favorites.notes')} hint={t('favoritesView.optional')}>{(id) => <Textarea id={id} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} rows={2} placeholder={t('favoritesView.whyTheFamilyLovesIt')} />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('favorites.cancel')}</Button>
          <Button type="submit" loading={saving} disabled={!v.name.trim()}>Add</Button>
        </div>
      </form>
    </Modal>
  );
}
