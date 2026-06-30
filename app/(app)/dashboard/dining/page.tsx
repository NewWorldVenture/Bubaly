import type { Metadata } from 'next';
import { MapPin, Heart, Star, Utensils, Receipt } from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Dining Out' };
export const dynamic = 'force-dynamic';

type Place = {
  id: string; name: string; cuisine: string | null; category: string | null;
  price_level: number | null; rating: number | null; distance_km: number | null;
  is_favorite: boolean; amount_cents: number | null; item_count: number | null; visited_at: string | null;
};

const priceLabel = (n: number | null) => (n && n > 0 ? '$'.repeat(Math.min(4, n)) : '');
const usd = (cents: number | null) => (cents == null ? '' : `$${(cents / 100).toFixed(2)}`);
const fmtDay = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

export default async function DiningPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  // Fail-safe per query: if dining_out isn't migrated on this DB yet (or a query
  // rejects), the page renders a clean empty state rather than crashing.
  const safe = async <T,>(q: PromiseLike<{ data: T[] | null }>): Promise<{ data: T[] | null }> => {
    try { return { data: (await q).data ?? null }; } catch { return { data: null }; }
  };
  const [{ data: recommended }, { data: recent }] = await Promise.all([
    safe(supabase.from('dining_out').select('id, name, cuisine, category, price_level, rating, distance_km, is_favorite, amount_cents, item_count, visited_at')
      .eq('family_id', familyId).eq('kind', 'restaurant').order('rating', { ascending: false, nullsFirst: false }).limit(20)),
    safe(supabase.from('dining_out').select('id, name, cuisine, category, price_level, rating, distance_km, is_favorite, amount_cents, item_count, visited_at')
      .eq('family_id', familyId).eq('kind', 'visit').order('visited_at', { ascending: false, nullsFirst: false }).limit(20)),
  ]);

  const recs = (recommended ?? []) as Place[];
  const visits = (recent ?? []) as Place[];

  return (
    <div className="space-y-6 pb-28">
      <div>
        <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Dining Out</h1>
        <p className="mt-1 text-sm text-muted">Discover healthy restaurants, save favorites, and track your dining-out history.</p>
      </div>

      {/* Recommended */}
      <section className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-4 flex items-center gap-2">
          <MapPin className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-bold">Recommended for you</h2>
        </div>
        {recs.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No saved restaurants yet — add places you&apos;d like to try.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {recs.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-emerald-500/15 text-emerald-400"><Utensils className="h-5 w-5" /></span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{r.name}</p>
                  <p className="truncate text-xs text-muted">
                    {[r.cuisine ?? r.category, priceLabel(r.price_level)].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3 text-xs text-muted">
                  {r.distance_km != null && <span>{r.distance_km} mi</span>}
                  {r.rating != null && <span className="flex items-center gap-1 text-amber-400"><Star className="h-3.5 w-3.5 fill-current" />{r.rating}</span>}
                  <Heart className={cn('h-4 w-4', r.is_favorite ? 'fill-rose-500 text-rose-500' : 'text-muted')} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Recent dining out */}
      <section className="rounded-2xl border border-border bg-surface/40 p-5">
        <div className="mb-4 flex items-center gap-2">
          <Receipt className="h-4 w-4 text-brand" />
          <h2 className="text-sm font-bold">Recent dining out</h2>
        </div>
        {visits.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">No dining-out history yet.</p>
        ) : (
          <ul className="divide-y divide-border/60">
            {visits.map((v) => (
              <li key={v.id} className="flex items-center gap-3 py-3">
                <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-brand/15 text-brand"><Utensils className="h-5 w-5" /></span>
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
    </div>
  );
}
