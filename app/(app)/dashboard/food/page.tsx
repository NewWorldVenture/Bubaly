import type { Metadata } from 'next';
import Link from 'next/link';
import {
  CalendarRange, BookOpen, ShoppingCart, Boxes, Heart, Activity, Utensils,
  ChevronRight, LayoutGrid, Sparkles, Soup,
} from 'lucide-react';
import { requireUserContext } from '@/lib/supabase/auth';
import { createServer } from '@/lib/supabase/server';
import { cn } from '@/lib/utils/cn';

export const metadata: Metadata = { title: 'Food & Nutrition' };
export const dynamic = 'force-dynamic';

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const fmtDay = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

// Per-query fail-safe so one erroring/not-yet-migrated table (e.g. dining_out)
// degrades to an empty card instead of crashing the whole hub.
async function safe<T>(q: PromiseLike<{ data: T[] | null; count?: number | null }>): Promise<{ data: T[] | null; count: number | null }> {
  try { const r = await q; return { data: r.data ?? null, count: r.count ?? null }; }
  catch { return { data: null, count: null }; }
}

function FeatureCard({
  index, title, href, icon: Icon, tint, count, countLabel, children,
}: {
  index: number; title: string; href: string; icon: React.ComponentType<{ className?: string }>;
  tint: string; count: number; countLabel: string; children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col rounded-2xl border border-border bg-surface/40 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={cn('grid h-9 w-9 place-items-center rounded-xl', tint)}><Icon className="h-5 w-5" /></span>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-muted">{index}.</p>
            <h2 className="-mt-0.5 text-sm font-bold">{title}</h2>
          </div>
        </div>
        <Link href={href} className="flex items-center gap-0.5 rounded-lg px-2 py-1 text-xs font-semibold text-brand transition hover:bg-brand/10" aria-label={`Open ${title}`}>
          Open <ChevronRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="min-h-[120px] flex-1 space-y-2">{children}</div>
      <Link href={href} className="mt-4 border-t border-border/60 pt-3 text-xs font-semibold text-muted transition hover:text-brand">
        {count} {countLabel} <ChevronRight className="inline h-3 w-3" />
      </Link>
    </section>
  );
}

const EmptyHint = ({ children }: { children: React.ReactNode }) => <p className="py-4 text-center text-xs text-muted">{children}</p>;
function ListRow({ label, meta, dot }: { label: string; meta?: string; dot?: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dot ?? 'bg-brand/60')} />
      <span className="min-w-0 flex-1 truncate text-sm text-fg/90">{label}</span>
      {meta && <span className="shrink-0 text-xs text-muted">{meta}</span>}
    </div>
  );
}

const FEATURES = [
  { icon: Sparkles, tint: 'bg-blue-500/15 text-blue-400', title: 'Smart Meal Planning', desc: 'AI-powered meal suggestions based on preferences, dietary needs and goals.' },
  { icon: BookOpen, tint: 'bg-emerald-500/15 text-emerald-400', title: 'Healthy Recipes', desc: 'Thousands of family-friendly recipes with nutrition info, ratings and cooking tips.' },
  { icon: ShoppingCart, tint: 'bg-amber-500/15 text-amber-400', title: 'Organized Grocery Lists', desc: 'Auto-generate lists from your meal plan or recipes, organized by aisle.' },
  { icon: Boxes, tint: 'bg-orange-500/15 text-orange-400', title: 'Pantry Management', desc: 'Track what you have, get alerts for expiring items and low stock.' },
  { icon: Activity, tint: 'bg-violet-500/15 text-violet-400', title: 'Nutrition Tracking', desc: 'Track calories, macros and nutrients to stay on top of your family’s health.' },
  { icon: Heart, tint: 'bg-rose-500/15 text-rose-400', title: 'Dining Out Made Easy', desc: 'Discover healthy restaurants, save favorites and track your dining-out history.' },
];

export default async function FoodPage() {
  const ctx = await requireUserContext();
  const familyId = ctx.active.familyId;
  const supabase = await createServer();
  const now = new Date();
  const todayIso = isoDate(now);
  const weekEnd = isoDate(new Date(now.getTime() + 6 * 86400000));
  const expSoon = isoDate(new Date(now.getTime() + 14 * 86400000));

  const [
    { data: dinners, count: planCount },
    { data: recipes, count: recipeCount },
    { data: grocery, count: groceryCount },
    { data: pantry, count: pantryCount },
    { data: favorites, count: favoriteCount },
    { data: scores },
    { data: dining, count: diningCount },
  ] = await Promise.all([
    safe(supabase.from('meal_plans').select('plan_date, meal_id', { count: 'exact' })
      .eq('family_id', familyId).eq('meal_type', 'dinner').gte('plan_date', todayIso).lte('plan_date', weekEnd).order('plan_date')),
    safe(supabase.from('family_recipes').select('id, name, rating', { count: 'exact' })
      .eq('family_id', familyId).order('created_at', { ascending: false }).limit(4)),
    safe(supabase.from('grocery_items').select('id, name', { count: 'exact' })
      .eq('family_id', familyId).eq('is_checked', false).limit(4)),
    safe(supabase.from('pantry_items').select('id, name, expires_at, quantity, unit', { count: 'exact' })
      .eq('family_id', familyId).lte('expires_at', expSoon).order('expires_at', { ascending: true, nullsFirst: false }).limit(4)),
    safe(supabase.from('family_recipes').select('id, name, rating', { count: 'exact' })
      .eq('family_id', familyId).eq('is_favorite', true).order('rating', { ascending: false, nullsFirst: false }).limit(4)),
    safe(supabase.from('family_food_scores').select('overall, grade, snapshot_date')
      .eq('family_id', familyId).order('snapshot_date', { ascending: false }).limit(1)),
    safe(supabase.from('dining_out').select('id, name, cuisine, rating', { count: 'exact' })
      .eq('family_id', familyId).order('rating', { ascending: false, nullsFirst: false }).limit(4)),
  ]);

  // Resolve meal names for this week's dinners (kept robust to relation naming).
  const planRows = (dinners ?? []) as { plan_date: string; meal_id: string | null }[];
  const mealIds = [...new Set(planRows.map((p) => p.meal_id).filter((x): x is string => !!x))];
  const { data: meals } = mealIds.length
    ? await safe(supabase.from('meals').select('id, name').in('id', mealIds))
    : { data: [] as { id: string; name: string }[] };
  const mealName = new Map((meals ?? []).map((m) => [m.id, m.name]));

  type R = { id: string; name: string; rating: number | null };
  type G = { id: string; name: string };
  type P = { id: string; name: string; expires_at: string | null; quantity: number; unit: string | null };
  type D = { id: string; name: string; cuisine: string | null; rating: number | null };
  const score = (scores ?? [])[0] as { overall: number; grade: string } | undefined;

  const PAGES = ['Meal Planner', 'Recipes', 'Grocery List', 'Pantry Inventory', 'Family Favorites', 'Nutrition Tracker', 'Dining Out'];

  return (
    <div className="space-y-6 pb-28">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-black tracking-tight sm:text-3xl">Food &amp; Nutrition</h1>
          <p className="mt-1 text-sm text-muted">Plan healthy meals, discover recipes, manage groceries, track nutrition and enjoy dining together.</p>
        </div>
        <span className="inline-flex shrink-0 items-center gap-2 self-start rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm font-bold">
          <LayoutGrid className="h-4 w-4 text-emerald-400" /> 7 Pages
        </span>
      </div>

      <section className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-brand/5 p-6">
        <p className="text-sm font-semibold text-emerald-300">Eat well. Live well. — smart planning for a healthier, happier family.</p>
        <div className="mt-4 flex flex-wrap gap-2">
          {PAGES.map((p) => <span key={p} className="rounded-full border border-border bg-surface/60 px-3 py-1 text-xs font-semibold text-fg/80">{p}</span>)}
        </div>
      </section>

      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 xl:grid-cols-4">
        {/* 1. Meal Planner */}
        <FeatureCard index={1} title="Meal Planner" href="/dashboard/meals" icon={CalendarRange} tint="bg-blue-500/15 text-blue-400" count={planCount ?? 0} countLabel="dinners planned this week">
          {planRows.length === 0 ? <EmptyHint>No dinners planned yet.</EmptyHint>
            : planRows.slice(0, 4).map((p) => <ListRow key={p.plan_date} label={p.meal_id ? (mealName.get(p.meal_id) ?? 'Planned meal') : 'Planned meal'} meta={p.plan_date === todayIso ? 'Today' : fmtDay(p.plan_date)} dot="bg-blue-400" />)}
        </FeatureCard>

        {/* 2. Recipes */}
        <FeatureCard index={2} title="Recipes" href="/dashboard/recipes" icon={BookOpen} tint="bg-emerald-500/15 text-emerald-400" count={recipeCount ?? 0} countLabel="recipes">
          {(recipes ?? []).length === 0 ? <EmptyHint>No recipes yet.</EmptyHint>
            : (recipes as R[]).map((r) => <ListRow key={r.id} label={r.name} meta={r.rating ? `★ ${r.rating}` : ''} dot="bg-emerald-400" />)}
        </FeatureCard>

        {/* 3. Grocery List */}
        <FeatureCard index={3} title="Grocery List" href="/dashboard/grocery" icon={ShoppingCart} tint="bg-amber-500/15 text-amber-400" count={groceryCount ?? 0} countLabel="items to buy">
          {(grocery ?? []).length === 0 ? <EmptyHint>Your list is empty.</EmptyHint>
            : (grocery as G[]).map((g) => <ListRow key={g.id} label={g.name} dot="bg-amber-400" />)}
        </FeatureCard>

        {/* 4. Pantry Inventory */}
        <FeatureCard index={4} title="Pantry Inventory" href="/dashboard/pantry" icon={Boxes} tint="bg-orange-500/15 text-orange-400" count={pantryCount ?? 0} countLabel="expiring soon">
          {(pantry ?? []).length === 0 ? <EmptyHint>Nothing expiring soon.</EmptyHint>
            : (pantry as P[]).map((p) => <ListRow key={p.id} label={p.name} meta={p.expires_at ? fmtDay(p.expires_at) : `${p.quantity}${p.unit ? ' ' + p.unit : ''}`} dot="bg-orange-400" />)}
        </FeatureCard>

        {/* 5. Family Favorites */}
        <FeatureCard index={5} title="Family Favorites" href="/dashboard/recipes" icon={Heart} tint="bg-rose-500/15 text-rose-400" count={favoriteCount ?? 0} countLabel="favorites">
          {(favorites ?? []).length === 0 ? <EmptyHint>No favorites yet.</EmptyHint>
            : (favorites as R[]).map((r) => <ListRow key={r.id} label={r.name} meta={r.rating ? `★ ${r.rating}` : ''} dot="bg-rose-400" />)}
        </FeatureCard>

        {/* 6. Nutrition Tracker */}
        <FeatureCard index={6} title="Nutrition Tracker" href="/dashboard/kitchen" icon={Activity} tint="bg-violet-500/15 text-violet-400" count={score?.overall ?? 0} countLabel="family food score">
          {score ? (
            <div className="flex items-center gap-3">
              <span className={cn('grid h-14 w-14 place-items-center rounded-full text-lg font-black',
                score.overall >= 80 ? 'bg-emerald-500/15 text-emerald-400' : score.overall >= 60 ? 'bg-amber-500/15 text-amber-400' : 'bg-rose-500/15 text-rose-400')}>
                {score.overall}
              </span>
              <div>
                <p className="text-sm font-bold">Grade {score.grade}</p>
                <p className="text-xs text-muted">Calories, macros & nutrients tracked for your family.</p>
              </div>
            </div>
          ) : <EmptyHint>No nutrition snapshot yet.</EmptyHint>}
        </FeatureCard>

        {/* 7. Dining Out */}
        <FeatureCard index={7} title="Dining Out" href="/dashboard/dining" icon={Utensils} tint="bg-indigo-500/15 text-indigo-400" count={diningCount ?? 0} countLabel="saved places">
          {(dining ?? []).length === 0 ? <EmptyHint>No dining spots saved yet.</EmptyHint>
            : (dining as D[]).map((d) => <ListRow key={d.id} label={d.name} meta={d.rating ? `★ ${d.rating}` : (d.cuisine ?? '')} dot="bg-indigo-400" />)}
        </FeatureCard>

        {/* 8. Features panel */}
        <section className="flex flex-col rounded-2xl border border-border bg-surface/40 p-5 sm:col-span-2 xl:col-span-4">
          <div className="mb-4 flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-500/15 text-emerald-400"><Soup className="h-5 w-5" /></span>
            <h2 className="text-sm font-bold">Food &amp; Nutrition features</h2>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {FEATURES.map((f) => (
              <div key={f.title} className="flex items-start gap-3">
                <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', f.tint)}><f.icon className="h-5 w-5" /></span>
                <div>
                  <p className="text-sm font-semibold">{f.title}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted">{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-5 flex items-center gap-1.5 border-t border-border/60 pt-4 text-sm font-semibold text-emerald-300">
            <Heart className="h-4 w-4" /> Healthy choices. Happy family.
          </p>
        </section>
      </div>
    </div>
  );
}
