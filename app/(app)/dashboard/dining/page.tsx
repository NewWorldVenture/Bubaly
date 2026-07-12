import type { Metadata } from 'next';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { DiningModule, type DiningRow } from '@/components/modules/dining-module';

export const metadata: Metadata = { title: 'Dining Out' };
export const dynamic = 'force-dynamic';

const COLS = 'id, name, kind, cuisine, category, price_level, rating, distance_km, is_favorite, amount_cents, item_count, visited_at';

export default async function DiningPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();

  // Fail-safe per query: if dining_out isn't migrated on this DB yet, the page
  // renders clean empty states rather than crashing.
  const safe = async (q: PromiseLike<{ data: DiningRow[] | null }>): Promise<DiningRow[]> => {
    try { return (await q).data ?? []; } catch { return []; }
  };
  const [restaurants, visits] = await Promise.all([
    safe(supabase.from('dining_out').select(COLS)
      .eq('family_id', familyId).eq('kind', 'restaurant')
      .order('is_favorite', { ascending: false })
      .order('rating', { ascending: false, nullsFirst: false }).limit(50) as PromiseLike<{ data: DiningRow[] | null }>),
    safe(supabase.from('dining_out').select(COLS)
      .eq('family_id', familyId).eq('kind', 'visit')
      .order('visited_at', { ascending: false, nullsFirst: false }).limit(30) as PromiseLike<{ data: DiningRow[] | null }>),
  ]);

  return <DiningModule restaurants={restaurants} visits={visits} />;
}
