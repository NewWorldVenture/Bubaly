'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MapPin, Heart, Star, Utensils, Receipt, Plus, Loader2 } from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { toggleFavoriteAction, addRestaurantAction, logVisitAction } from '@/app/(app)/dashboard/dining/actions';
import { useTranslations } from '@/components/i18n/locale-provider';

export type DiningRow = {
  id: string; name: string; kind: string; cuisine: string | null; category: string | null;
  price_level: number | null; rating: number | null; distance_km: number | null;
  is_favorite: boolean; amount_cents: number | null; item_count: number | null; visited_at: string | null;
};

const priceLabel = (n: number | null) => (n && n > 0 ? '$'.repeat(Math.min(4, n)) : '');
const usd = (cents: number | null) => (cents == null ? '' : `$${(cents / 100).toFixed(2)}`);
const fmtDay = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

export function DiningModule({ restaurants, visits }: { restaurants: DiningRow[]; visits: DiningRow[] }) {
  const t = useTranslations();
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [pending, startTransition] = useTransition();
  const [addOpen, setAddOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addForm, setAddForm] = useState({ name: '', cuisine: '', priceLevel: '2', rating: '' });
  const [logForm, setLogForm] = useState({ name: '', amount: '', items: '', when: new Date().toISOString().slice(0, 10) });

  const stats = useMemo(() => {
    const monthAgo = Date.now() - 30 * 86400_000;
    const recent = visits.filter(v => v.visited_at && new Date(v.visited_at).getTime() >= monthAgo);
    const spend = recent.reduce((s, v) => s + (v.amount_cents ?? 0), 0);
    const rated = restaurants.filter(r => r.rating != null);
    return {
      favorites: restaurants.filter(r => r.is_favorite).length,
      visits30d: recent.length,
      spend30d: spend,
      avgRating: rated.length ? Math.round(rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length * 10) / 10 : null,
    };
  }, [restaurants, visits]);

  function toggleFav(r: DiningRow) {
    setBusyId(r.id);
    startTransition(async () => {
      const res = await toggleFavoriteAction(r.id, !r.is_favorite);
      setBusyId(null);
      if (!res.ok) { toastError(res.error); return; }
      router.refresh();
    });
  }

  function submitAdd(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await addRestaurantAction({
        name: addForm.name,
        cuisine: addForm.cuisine || undefined,
        priceLevel: parseInt(addForm.priceLevel, 10) || undefined,
        rating: addForm.rating ? parseFloat(addForm.rating) : undefined,
      });
      if (!res.ok) { toastError(res.error); return; }
      success(`${addForm.name.trim()} saved.`);
      setAddOpen(false);
      setAddForm({ name: '', cuisine: '', priceLevel: '2', rating: '' });
      router.refresh();
    });
  }

  function submitLog(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const cents = logForm.amount ? Math.round(parseFloat(logForm.amount) * 100) : undefined;
      const res = await logVisitAction({
        name: logForm.name,
        amountCents: Number.isFinite(cents) ? cents : undefined,
        itemCount: logForm.items ? parseInt(logForm.items, 10) : undefined,
        visitedAt: logForm.when ? new Date(logForm.when + 'T19:00:00').toISOString() : undefined,
      });
      if (!res.ok) { toastError(res.error); return; }
      success('Visit logged.');
      setLogOpen(false);
      setLogForm({ name: '', amount: '', items: '', when: new Date().toISOString().slice(0, 10) });
      router.refresh();
    });
  }

  return (
    <div className="space-y-5 pb-28">
      <PageHeader
        title={t('dining.diningOut')}
        description={t('diningModule.discoverRestaurantsSaveFavoritesAnd')}
        action={
          <>
            <Button variant="outline" onClick={() => setLogOpen(true)}><Receipt className="h-4 w-4" /> {t('dining.logVisit')}</Button>
            <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> {t('dining.addPlace')}</Button>
          </>
        }
      />

      {/* Stats */}
      <div className="grid-stats">
        {[
          { label: 'Favorites', value: stats.favorites, icon: '❤️' },
          { label: 'Visits · 30d', value: stats.visits30d, icon: '🍽️' },
          { label: 'Spend · 30d', value: usd(stats.spend30d) || '$0.00', icon: '🧾' },
          { label: 'Avg rating', value: stats.avgRating ?? '—', icon: '⭐' },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <span className="text-2xl">{s.icon}</span>
            <div>
              <div className="text-2xl font-bold">{s.value}</div>
              <div className="text-[11px] text-muted">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Saved restaurants */}
      <section className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-4 flex items-center gap-2">
          <MapPin className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-bold">{t('dining.savedPlaces')}</h2>
        </div>
        {restaurants.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{t('dining.noSavedRestaurantsYetAddPlaces')}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {restaurants.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-emerald-400"><Utensils className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{r.name}</p>
                  <p className="truncate text-xs text-muted">
                    {[r.cuisine ?? r.category, priceLabel(r.price_level)].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-muted">
                  {r.distance_km != null && <span className="hidden sm:inline">{r.distance_km} mi</span>}
                  {r.rating != null && <span className="flex items-center gap-1 text-amber-400"><Star className="h-3.5 w-3.5 fill-current" />{r.rating}</span>}
                  <button onClick={() => toggleFav(r)} disabled={pending && busyId === r.id}
                    aria-label={r.is_favorite ? `Unfavorite ${r.name}` : `Favorite ${r.name}`}
                    className="rounded-lg p-1.5 transition hover:bg-elevated">
                    {busyId === r.id
                      ? <Loader2 className="h-4 w-4 animate-spin" />
                      : <Heart className={cn('h-4 w-4 transition', r.is_favorite ? 'fill-rose-500 text-rose-500' : 'text-muted hover:text-rose-400')} />}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent visits */}
      <section className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Receipt className="h-4 w-4 text-brand-text" />
          <h2 className="text-sm font-bold">{t('dining.recentDiningOut')}</h2>
        </div>
        {visits.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">{t('dining.noDiningOutHistoryYetLog')}</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {visits.map((v) => (
              <li key={v.id} className="flex items-center gap-3 py-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand-text"><Utensils className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{v.name}</p>
                  <p className="truncate text-xs text-muted">
                    {[fmtDay(v.visited_at), v.item_count != null ? `${v.item_count} items` : null].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {v.amount_cents != null && <span className="shrink-0 text-sm font-semibold">{usd(v.amount_cents)}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Add place */}
      {addOpen && (
        <Modal open onClose={() => setAddOpen(false)} title={t('dining.addAPlace')}>
          <form onSubmit={submitAdd} className="space-y-3">
            <Field label={t('dining.name')}>{(id) => <Input id={id} value={addForm.name} onChange={e => setAddForm({ ...addForm, name: e.target.value })} placeholder={t('diningModule.nonnaSTrattoria')} autoFocus />}</Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={t('dining.cuisine')}>{(id) => <Input id={id} value={addForm.cuisine} onChange={e => setAddForm({ ...addForm, cuisine: e.target.value })} placeholder={t('dining.italian')} />}</Field>
              <Field label={t('dining.price')}>{(id) => (
                <Select id={id} value={addForm.priceLevel} onChange={e => setAddForm({ ...addForm, priceLevel: e.target.value })}>
                  {['1', '2', '3', '4'].map(p => <option key={p} value={p}>{'$'.repeat(Number(p))}</option>)}
                </Select>
              )}</Field>
              <Field label={t('dining.rating')}>{(id) => <Input id={id} type="number" inputMode="decimal" min="0" max="5" step="0.1" value={addForm.rating} onChange={e => setAddForm({ ...addForm, rating: e.target.value })} placeholder="4.5" />}</Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAddOpen(false)}>{t('dining.cancel')}</Button>
              <Button type="submit" loading={pending}>{t('dining.savePlace')}</Button>
            </div>
          </form>
        </Modal>
      )}

      {/* Log visit */}
      {logOpen && (
        <Modal open onClose={() => setLogOpen(false)} title={t('dining.logAVisit')}>
          <form onSubmit={submitLog} className="space-y-3">
            <Field label={t('dining.restaurant')}>{(id) => <Input id={id} value={logForm.name} onChange={e => setLogForm({ ...logForm, name: e.target.value })} placeholder={t('dining.whereDidYouEat')} autoFocus />}</Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label={t('dining.total')}>{(id) => <Input id={id} type="number" inputMode="decimal" min="0" step="0.01" value={logForm.amount} onChange={e => setLogForm({ ...logForm, amount: e.target.value })} placeholder="64.20" />}</Field>
              <Field label={t('dining.items')}>{(id) => <Input id={id} type="number" min="0" value={logForm.items} onChange={e => setLogForm({ ...logForm, items: e.target.value })} placeholder="5" />}</Field>
              <Field label={t('dining.when')}>{(id) => <Input id={id} type="date" value={logForm.when} onChange={e => setLogForm({ ...logForm, when: e.target.value })} />}</Field>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setLogOpen(false)}>{t('dining.cancel')}</Button>
              <Button type="submit" loading={pending}>{t('dining.logIt')}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
