'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Plus, Sparkles, Activity, Check, X as XIcon,
  Search, MoreHorizontal, Clock, Heart, ThumbsUp, Utensils,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { cn } from '@/lib/utils/cn';
import { NUTRIENT_LABELS, dailyValuePct, fmtAmount, type Nutrition } from '@/lib/meals/nutrition';
import type { Tables, MealType } from '@/lib/database.types';

type Meal = Tables<'meals'>;
type Plan = Tables<'meal_plans'> & { meal: Meal | null };
type Recipe = Tables<'family_recipes'>;
type Vote = Tables<'meal_votes'>;
type VoteOption = Tables<'meal_vote_options'>;
type Ballot = Pick<Tables<'meal_vote_ballots'>, 'option_id' | 'member_id' | 'choice'>;

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_LABELS: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks' };
const MEAL_ICONS: Record<MealType, string> = { breakfast: '🌅', lunch: '🥗', dinner: '🍽️', snack: '🍎' };

const TABS = [
  { id: 'plan' as const, label: 'Meal Plan' },
  { id: 'recipes' as const, label: 'Recipes' },
  { id: 'groceries' as const, label: 'Groceries' },
  { id: 'favorites' as const, label: 'Favorites' },
];
type TabId = (typeof TABS)[number]['id'];

function weekStart(offset = 0): Date {
  const d = new Date();
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day + offset * 7);
  d.setHours(0, 0, 0, 0);
  return d;
}

function daysOfWeek(monday: Date) {
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    return d;
  });
}

/** Dish image with an emoji fallback if the URL fails to load. */
function MealImg({ src, emoji, className }: { src: string | null; emoji: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return <div className={cn('flex items-center justify-center bg-elevated text-2xl', className)}>{emoji}</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className={cn('object-cover', className)} />;
}

export function MealsModule() {
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const selfId = selfMember?.id ?? null;

  const [tab, setTab] = useState<TabId>('plan');
  const [weekOffset, setWeekOffset] = useState(0);
  const [library, setLibrary] = useState<Meal[]>([]);
  const [addCell, setAddCell] = useState<{ date: string; type: MealType } | null>(null);
  const [newMealOpen, setNewMealOpen] = useState(false);
  const [autoPlanOpen, setAutoPlanOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [recipeSearch, setRecipeSearch] = useState('');
  const [dinnerIdx, setDinnerIdx] = useState(0);

  const monday = useMemo(() => weekStart(weekOffset), [weekOffset]);
  const days = useMemo(() => daysOfWeek(monday), [monday]);
  const weekStartStr = useMemo(() => monday.toISOString().slice(0, 10), [monday]);

  const reloadLibrary = useCallback(() => {
    createClient().from('meals').select('*').eq('family_id', familyId).order('name')
      .then(({ data }) => setLibrary(data ?? []));
  }, [familyId]);
  useEffect(() => { reloadLibrary(); }, [reloadLibrary]);

  const { data: plans, loading, error, refresh } = useRealtimeQuery<Plan>({
    table: 'meal_plans', familyId, deps: [familyId, monday.toISOString()],
    fetcher: async (supabase) => {
      const { data, error } = await supabase.from('meal_plans').select('*').eq('family_id', familyId)
        .gte('plan_date', days[0].toISOString().slice(0, 10))
        .lte('plan_date', days[6].toISOString().slice(0, 10));
      if (error) return { data: null, error };
      const ids = [...new Set(data.map(p => p.meal_id).filter((x): x is string => !!x))];
      const { data: meals } = ids.length ? await supabase.from('meals').select('*').in('id', ids) : { data: [] as Meal[] };
      const byId = new Map((meals ?? []).map(m => [m.id, m]));
      return { data: data.map(p => ({ ...p, meal: byId.get(p.meal_id ?? '') ?? null })), error: null };
    },
  });

  const { data: recipes, refresh: refreshRecipes } = useRealtimeQuery<Recipe>({
    table: 'family_recipes', familyId, deps: [familyId],
    fetcher: (supabase) => supabase.from('family_recipes').select('*').eq('family_id', familyId)
      .order('last_made_at', { ascending: false, nullsFirst: false }).order('name').limit(200),
  });

  const { data: groceryItems, refresh: refreshGrocery } = useRealtimeQuery<Tables<'grocery_items'>>({
    table: 'grocery_items', familyId, deps: [familyId],
    fetcher: (supabase) => supabase.from('grocery_items')
      .select('*').eq('family_id', familyId)
      .order('is_checked').order('created_at', { ascending: false }).limit(80),
  });

  // Active family meal vote (latest), with options + ballots.
  const [voteData, setVoteData] = useState<{ vote: Vote; options: VoteOption[]; ballots: Ballot[] } | null>(null);
  const loadVote = useCallback(async () => {
    const sb = createClient();
    const { data: votes } = await sb.from('meal_votes').select('*').eq('family_id', familyId)
      .order('created_at', { ascending: false }).limit(1);
    const v = votes?.[0];
    if (!v) { setVoteData(null); return; }
    const [{ data: options }, { data: ballots }] = await Promise.all([
      sb.from('meal_vote_options').select('*').eq('vote_id', v.id),
      sb.from('meal_vote_ballots').select('option_id, member_id, choice').eq('vote_id', v.id),
    ]);
    setVoteData({ vote: v, options: options ?? [], ballots: ballots ?? [] });
  }, [familyId]);
  useEffect(() => { void loadVote(); }, [loadVote]);

  const cellKey = (date: string, type: MealType) => `${date}__${type}`;
  const planMap = useMemo(() => {
    const m = new Map<string, Plan>();
    for (const p of plans) m.set(cellKey(p.plan_date, p.meal_type), p);
    return m;
  }, [plans]);

  const todayStr = new Date().toISOString().slice(0, 10);
  const dateRange = `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  // This week's dinners → the "What's for Dinner?" carousel.
  const dinners = useMemo(
    () => days.map((d) => planMap.get(cellKey(d.toISOString().slice(0, 10), 'dinner'))).filter((p): p is Plan => !!p?.meal),
    [days, planMap],
  );
  useEffect(() => { setDinnerIdx(0); }, [weekOffset]);

  const recentlyCooked = useMemo(() => recipes.filter((r) => r.last_made_at).slice(0, 8), [recipes]);
  const favorites = useMemo(() => recipes.filter((r) => r.is_favorite), [recipes]);
  const filteredRecipes = useMemo(() => {
    const q = recipeSearch.trim().toLowerCase();
    return q ? recipes.filter((r) => r.name.toLowerCase().includes(q)) : recipes;
  }, [recipes, recipeSearch]);

  async function removePlan(id: string) {
    const { error } = await createClient().from('meal_plans').delete().eq('id', id);
    if (error) return toastError(describeDbError(error));
    void refresh();
  }

  async function addFromLibrary(mealId: string, date: string, mealType: MealType) {
    const { error } = await createClient().from('meal_plans')
      .insert({ family_id: familyId, meal_id: mealId, plan_date: date, meal_type: mealType, created_by: userId });
    if (error) return toastError(describeDbError(error));
    setAddCell(null); void refresh();
  }

  async function toggleFavorite(r: Recipe) {
    const { error } = await createClient().from('family_recipes').update({ is_favorite: !r.is_favorite }).eq('id', r.id);
    if (error) return toastError(describeDbError(error));
    void refreshRecipes();
  }

  async function toggleGrocery(item: Tables<'grocery_items'>) {
    const { error } = await createClient().from('grocery_items').update({ is_checked: !item.is_checked }).eq('id', item.id);
    if (error) return toastError(describeDbError(error));
    void refreshGrocery();
  }

  async function castVote(optionId: string) {
    if (!voteData || !selfId) return;
    const sb = createClient();
    // One ballot per member: clear any prior pick, then record this one.
    await sb.from('meal_vote_ballots').delete().eq('vote_id', voteData.vote.id).eq('member_id', selfId);
    const { error } = await sb.from('meal_vote_ballots').insert({
      vote_id: voteData.vote.id, option_id: optionId, family_id: familyId, member_id: selfId, choice: 'yes',
    });
    if (error) return toastError(describeDbError(error));
    success('Vote recorded');
    void loadVote();
  }

  if (loading) return <SkeletonList count={5} />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-with-sidebar">
      {/* Main */}
      <div className="module-main overflow-y-auto">
        {/* Header */}
        <div className="flex-shrink-0">
          <PageHeader
            title="Meals"
            description="Plan healthy meals your family will love."
            action={
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => setNewMealOpen(true)}><Plus className="h-4 w-4" /> Add Meal</Button>
                <Button variant="outline" size="sm" onClick={() => { setTab('recipes'); }}>
                  <Search className="h-4 w-4" /> Recipe Search
                </Button>
                <div className="relative">
                  <Button variant="outline" size="sm" onClick={() => setMoreOpen((v) => !v)} aria-label="More">
                    <MoreHorizontal className="h-4 w-4" /> More
                  </Button>
                  {moreOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} />
                      <div className="absolute right-0 z-20 mt-1 w-52 rounded-xl border border-border bg-elevated p-1 shadow-lg">
                        <button onClick={() => { setMoreOpen(false); setAutoPlanOpen(true); }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface">
                          <Sparkles className="h-4 w-4 text-brand-text" /> Auto-plan the week
                        </button>
                        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"><AiInsight kind="meals" /> AI insight</div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            }
          />

          {/* Tabs */}
          <div className="tab-bar mt-3 border-b border-border pb-2">
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cn('tab-item', tab === t.id ? 'tab-item-active' : 'tab-item-inactive')}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── MEAL PLAN TAB ─────────────────────────────────────── */}
        {tab === 'plan' && (
          <>
            {/* Week navigator */}
            <div className="flex flex-wrap items-center gap-2 py-3">
              <button onClick={() => setWeekOffset(w => w - 1)} aria-label="Previous week" className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronLeft className="h-4 w-4" /></button>
              <button onClick={() => setWeekOffset(w => w + 1)} aria-label="Next week" className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronRight className="h-4 w-4" /></button>
              <span className="flex items-center gap-2 text-sm font-semibold">📅 {dateRange}</span>
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => setWeekOffset(0)}>This Week</Button>
            </div>

            {/* Week grid — desktop */}
            <div className="hidden md:block">
              <div className="overflow-hidden rounded-xl border border-border">
                {/* Day headers */}
                <div className="grid border-b border-border bg-surface/40" style={{ gridTemplateColumns: '92px repeat(7, 1fr)' }}>
                  <div className="px-3 py-2" />
                  {days.map((d, i) => {
                    const isToday = d.toISOString().slice(0, 10) === todayStr;
                    return (
                      <div key={i} className={cn('border-l border-border px-2 py-2 text-center', isToday && 'bg-brand/10')}>
                        <div className={cn('text-[10px] font-semibold uppercase tracking-wide', isToday ? 'text-brand-text' : 'text-muted')}>{d.toLocaleDateString('en-US', { weekday: 'short' })}</div>
                        <div className={cn('text-xs font-bold', isToday ? 'text-brand-text' : 'text-fg')}>{d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</div>
                      </div>
                    );
                  })}
                </div>

                {/* Meal-type rows */}
                {MEAL_TYPES.map((type, ti) => (
                  <div key={type} className={cn('grid', ti < MEAL_TYPES.length - 1 && 'border-b border-border')} style={{ gridTemplateColumns: '92px repeat(7, 1fr)' }}>
                    <div className="flex flex-col items-center justify-center border-r border-border px-2 py-3">
                      <span className="text-lg">{MEAL_ICONS[type]}</span>
                      <span className="text-[10px] font-semibold text-muted">{MEAL_LABELS[type]}</span>
                    </div>
                    {days.map((d, di) => {
                      const dStr = d.toISOString().slice(0, 10);
                      const plan = planMap.get(cellKey(dStr, type));
                      const isToday = dStr === todayStr;
                      return (
                        <div key={di}
                          className={cn('group relative min-h-[104px] border-l border-border p-1.5 transition', isToday && 'bg-brand/5', !plan && 'cursor-pointer hover:bg-elevated/30')}
                          onClick={() => !plan && setAddCell({ date: dStr, type })}>
                          {plan ? (
                            <div className="relative overflow-hidden rounded-lg border border-border/60 bg-surface/40">
                              <MealImg src={plan.meal?.image_url ?? null} emoji={MEAL_ICONS[type]} className="h-14 w-full" />
                              <div className="px-1.5 py-1 text-[10px] font-medium leading-tight line-clamp-2">{plan.meal?.name ?? 'Meal'}</div>
                              <button onClick={(e) => { e.stopPropagation(); removePlan(plan.id); }} aria-label="Remove meal"
                                className="absolute right-1 top-1 hidden rounded-full bg-danger/90 p-0.5 group-hover:flex">
                                <XIcon className="h-2.5 w-2.5 text-white" />
                              </button>
                            </div>
                          ) : (
                            <div className="flex h-full flex-col items-center justify-center opacity-0 transition group-hover:opacity-100">
                              <Plus className="h-4 w-4 text-muted" />
                              <span className="mt-0.5 text-[9px] text-muted">Add meal</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            {/* Week grid — mobile (stacked) */}
            <div className="space-y-3 md:hidden">
              {days.map((d, di) => {
                const dStr = d.toISOString().slice(0, 10);
                const isToday = dStr === todayStr;
                return (
                  <div key={di} className={cn('overflow-hidden rounded-xl border border-border', isToday && 'border-brand/40')}>
                    <div className={cn('flex items-center gap-2 border-b border-border px-3 py-2', isToday ? 'bg-brand/10' : 'bg-surface/40')}>
                      <span className={cn('text-sm font-semibold', isToday ? 'text-brand-text' : 'text-fg')}>{d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
                      {isToday && <span className="rounded-full bg-brand/20 px-2 py-0.5 text-[10px] font-semibold text-brand-text">Today</span>}
                    </div>
                    <div className="divide-y divide-border/50">
                      {MEAL_TYPES.map(type => {
                        const plan = planMap.get(cellKey(dStr, type));
                        return (
                          <div key={type} className={cn('flex items-center gap-3 px-3 py-2.5', !plan && 'cursor-pointer hover:bg-elevated/30')}
                            onClick={() => !plan && setAddCell({ date: dStr, type })}>
                            {plan?.meal
                              ? <MealImg src={plan.meal.image_url} emoji={MEAL_ICONS[type]} className="h-10 w-10 shrink-0 rounded-lg" />
                              : <span className="text-base">{MEAL_ICONS[type]}</span>}
                            <div className="min-w-0 flex-1">
                              <div className="text-[10px] font-semibold uppercase text-muted">{MEAL_LABELS[type]}</div>
                              {plan ? <div className="truncate text-sm font-medium">{plan.meal?.name ?? 'Meal'}</div> : <div className="text-xs text-muted">Tap to add</div>}
                            </div>
                            {plan
                              ? <button onClick={(e) => { e.stopPropagation(); removePlan(plan.id); }} aria-label="Remove meal" className="rounded-full p-1 text-muted hover:text-danger"><XIcon className="h-3.5 w-3.5" /></button>
                              : <Plus className="h-4 w-4 text-muted" />}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Recently Cooked */}
            {recentlyCooked.length > 0 && (
              <div className="mt-6">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-base font-semibold">Recently Cooked</h2>
                  <button onClick={() => setTab('recipes')} className="text-xs text-brand-text hover:underline">View all</button>
                </div>
                <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-none">
                  {recentlyCooked.map((r) => (
                    <div key={r.id} className="w-40 shrink-0 overflow-hidden rounded-xl border border-border bg-surface/40">
                      <MealImg src={r.photo_url} emoji="🍽️" className="h-24 w-full" />
                      <div className="p-2">
                        <div className="truncate text-xs font-semibold">{r.name}</div>
                        <div className="mt-0.5 text-[10px] text-muted">
                          {r.last_made_at ? new Date(r.last_made_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* ── RECIPES TAB ───────────────────────────────────────── */}
        {tab === 'recipes' && (
          <div className="py-3">
            <div className="mb-3 flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-2">
              <Search className="h-4 w-4 text-muted" />
              <input value={recipeSearch} onChange={(e) => setRecipeSearch(e.target.value)} placeholder="Search recipes…"
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
              {recipeSearch && <button onClick={() => setRecipeSearch('')} aria-label="Clear"><XIcon className="h-4 w-4 text-muted" /></button>}
            </div>
            {filteredRecipes.length === 0 ? (
              <EmptyState icon={Utensils} title="No recipes yet" description="Saved recipes will appear here." />
            ) : (
              <RecipeGrid recipes={filteredRecipes} onToggleFavorite={toggleFavorite} />
            )}
          </div>
        )}

        {/* ── GROCERIES TAB ─────────────────────────────────────── */}
        {tab === 'groceries' && (
          <div className="py-3">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-base font-semibold">Grocery List</h2>
              <Link href="/dashboard/grocery" className="text-xs text-brand-text hover:underline">Open full list →</Link>
            </div>
            {groceryItems.length === 0 ? (
              <EmptyState icon={Check} title="Your list is empty" description="Add items from the Grocery module." />
            ) : (
              <div className="space-y-1.5">
                {groceryItems.map((item) => (
                  <button key={item.id} onClick={() => toggleGrocery(item)}
                    className="flex w-full items-center gap-3 rounded-xl border border-border bg-surface/30 px-3 py-2.5 text-left transition hover:bg-elevated/40">
                    <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded border', item.is_checked ? 'border-brand bg-brand' : 'border-border')}>
                      {item.is_checked && <Check className="h-3 w-3 text-white" />}
                    </span>
                    <span className={cn('flex-1 text-sm', item.is_checked ? 'text-muted line-through' : 'text-fg')}>{item.name}</span>
                    {item.category && <span className="rounded-full bg-elevated px-2 py-0.5 text-[10px] text-muted">{item.category}</span>}
                    {item.quantity && <span className="text-xs text-muted">{item.quantity}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── FAVORITES TAB ─────────────────────────────────────── */}
        {tab === 'favorites' && (
          <div className="py-3">
            {favorites.length === 0 ? (
              <EmptyState icon={Heart} title="No favorites yet" description="Tap the heart on a recipe to save it here." />
            ) : (
              <RecipeGrid recipes={favorites} onToggleFavorite={toggleFavorite} />
            )}
          </div>
        )}
      </div>

      {/* Right sidebar */}
      <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
        {/* What's for Dinner? */}
        <div className="sidebar-card">
          <p className="mb-3 text-sm font-semibold">What&apos;s for Dinner?</p>
          {dinners.length === 0 ? (
            <p className="text-xs text-muted">No dinners planned this week yet.</p>
          ) : (
            <div className="relative">
              <div className="overflow-hidden rounded-xl border border-border">
                <MealImg src={dinners[dinnerIdx]?.meal?.image_url ?? null} emoji="🍽️" className="h-36 w-full" />
              </div>
              <div className="mt-2">
                <p className="text-sm font-bold leading-snug">{dinners[dinnerIdx]?.meal?.name}</p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {new Date(dinners[dinnerIdx].plan_date).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}
                </p>
              </div>
              {dinners[dinnerIdx]?.meal?.recipe_url && (
                <a href={dinners[dinnerIdx]!.meal!.recipe_url!} target="_blank" rel="noreferrer"
                  className="mt-2 block rounded-lg bg-brand py-2 text-center text-xs font-semibold text-brand-fg transition hover:opacity-90">
                  View Recipe
                </a>
              )}
              {dinners.length > 1 && (
                <>
                  <button onClick={() => setDinnerIdx((i) => (i - 1 + dinners.length) % dinners.length)} aria-label="Previous dinner"
                    className="absolute left-1 top-[68px] grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-bg/70 text-fg backdrop-blur hover:bg-bg"><ChevronLeft className="h-4 w-4" /></button>
                  <button onClick={() => setDinnerIdx((i) => (i + 1) % dinners.length)} aria-label="Next dinner"
                    className="absolute right-1 top-[68px] grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-bg/70 text-fg backdrop-blur hover:bg-bg"><ChevronRight className="h-4 w-4" /></button>
                  <div className="mt-2 flex justify-center gap-1">
                    {dinners.map((_, i) => <span key={i} className={cn('h-1.5 w-1.5 rounded-full', i === dinnerIdx ? 'bg-brand' : 'bg-border')} />)}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Family Vote */}
        {voteData && voteData.options.length > 0 && (
          <FamilyVoteCard data={voteData} selfId={selfId} memberById={new Map(members.map((m) => [m.id, m]))} onVote={castVote} />
        )}

        {/* Grocery List */}
        <div className="sidebar-card">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">Grocery List</p>
            <button onClick={() => setTab('groceries')} className="text-[11px] font-medium text-brand-text hover:underline">View List</button>
          </div>
          {groceryItems.length === 0 ? (
            <p className="text-xs text-muted">Your grocery list is empty.</p>
          ) : (
            <div className="space-y-1.5">
              {groceryItems.slice(0, 6).map(item => (
                <div key={item.id} className="flex items-center gap-2">
                  <button onClick={() => toggleGrocery(item)} aria-label="Toggle"
                    className={cn('flex h-4 w-4 shrink-0 items-center justify-center rounded border', item.is_checked ? 'border-brand bg-brand' : 'border-border')}>
                    {item.is_checked && <Check className="h-2.5 w-2.5 text-white" />}
                  </button>
                  <span className={cn('flex-1 text-xs', item.is_checked ? 'text-muted line-through' : 'text-fg')}>{item.name}</span>
                  {item.quantity && <span className="text-[10px] text-muted">{item.quantity}</span>}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Nutrition Overview */}
        <WeekNutritionPanel weekStart={weekStartStr} planCount={plans.length} />
      </div>

      {/* Add-to-cell picker */}
      {addCell && (
        <Modal open title={`Add ${MEAL_LABELS[addCell.type]}`} onClose={() => setAddCell(null)}>
          <div className="space-y-3">
            <p className="text-xs text-muted">For {new Date(addCell.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            {library.length === 0 ? (
              <p className="text-sm text-muted">No meals in your library yet. Add a meal first.</p>
            ) : (
              <div className="max-h-72 space-y-1.5 overflow-y-auto">
                {library.map(m => (
                  <button key={m.id} onClick={() => addFromLibrary(m.id, addCell.date, addCell.type)}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface/40 px-2 py-2 text-left transition hover:bg-elevated">
                    <MealImg src={m.image_url} emoji={MEAL_ICONS[m.meal_type]} className="h-9 w-9 shrink-0 rounded-lg" />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{m.name}</div>
                      <div className="text-[10px] capitalize text-muted">{m.meal_type}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => { setAddCell(null); setNewMealOpen(true); }} className="w-full rounded-lg border border-dashed border-border py-2 text-xs text-muted transition hover:border-brand/50 hover:text-brand-text">
              + Create new meal
            </button>
          </div>
        </Modal>
      )}

      {newMealOpen && (
        <NewMealModal familyId={familyId} userId={userId} onClose={() => setNewMealOpen(false)}
          onSaved={() => { setNewMealOpen(false); reloadLibrary(); }} />
      )}

      {autoPlanOpen && (
        <AutoPlanModal weekStart={weekStartStr} mealTypes={MEAL_TYPES}
          onClose={() => setAutoPlanOpen(false)}
          onPlanned={() => { setAutoPlanOpen(false); void refresh(); }} />
      )}
    </div>
  );
}

function RecipeGrid({ recipes, onToggleFavorite }: { recipes: Recipe[]; onToggleFavorite: (r: Recipe) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
      {recipes.map((r) => {
        const total = (r.prep_time_mins ?? 0) + (r.cook_time_mins ?? 0);
        return (
          <div key={r.id} className="group overflow-hidden rounded-xl border border-border bg-surface/40 transition hover:bg-elevated/40">
            <div className="relative">
              <MealImg src={r.photo_url} emoji="🍽️" className="h-28 w-full" />
              <button onClick={() => onToggleFavorite(r)} aria-label={r.is_favorite ? 'Unfavorite' : 'Favorite'}
                className="absolute right-1.5 top-1.5 grid h-7 w-7 place-items-center rounded-full bg-bg/70 backdrop-blur transition hover:bg-bg">
                <Heart className={cn('h-3.5 w-3.5', r.is_favorite ? 'fill-danger text-danger' : 'text-muted')} />
              </button>
            </div>
            <div className="p-2.5">
              <div className="truncate text-sm font-semibold">{r.name}</div>
              <div className="mt-1 flex items-center gap-2 text-[10px] text-muted">
                {total > 0 && <span className="flex items-center gap-0.5"><Clock className="h-3 w-3" /> {total} min</span>}
                {r.difficulty && <span className="capitalize">{r.difficulty}</span>}
                {r.category && <span className="ml-auto rounded-full bg-elevated px-1.5 py-0.5 capitalize">{r.category}</span>}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FamilyVoteCard({ data, selfId, memberById, onVote }: {
  data: { vote: Vote; options: VoteOption[]; ballots: Ballot[] };
  selfId: string | null;
  memberById: Map<string, ReturnType<typeof useApp>['members'][number]>;
  onVote: (optionId: string) => void;
}) {
  const tally = (optId: string) => data.ballots.filter((b) => b.option_id === optId).length;
  const total = data.ballots.length || 1;
  const myPick = data.ballots.find((b) => b.member_id === selfId)?.option_id ?? null;
  return (
    <div className="sidebar-card">
      <p className="text-sm font-semibold">Family Vote</p>
      <p className="mb-3 text-[11px] text-muted">{data.vote.title || 'Help decide next week’s meals!'}</p>
      <div className="space-y-2.5">
        {data.options.map((opt) => {
          const n = tally(opt.id);
          const pct = Math.round((n / total) * 100);
          const mine = myPick === opt.id;
          return (
            <button key={opt.id} onClick={() => onVote(opt.id)} disabled={!selfId}
              className="block w-full text-left disabled:opacity-60">
              <div className="flex items-center gap-2">
                {opt.photo_url
                  ? <MealImg src={opt.photo_url} emoji="🍽️" className="h-7 w-7 shrink-0 rounded-full" />
                  : <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-elevated text-xs">🍽️</span>}
                <span className="flex-1 truncate text-xs font-medium">{opt.label}</span>
                <span className="text-xs font-bold">{n}</span>
                <ThumbsUp className={cn('h-3.5 w-3.5', mine ? 'fill-brand text-brand-text' : 'text-muted')} />
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-elevated">
                <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** AI Meal Planner — fills the week from your library/recipes, honoring diet and
 *  using up soon-to-expire pantry items, then writes it straight into the grid. */
function AutoPlanModal({ weekStart, mealTypes, onClose, onPlanned }: {
  weekStart: string; mealTypes: MealType[]; onClose: () => void; onPlanned: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MealType[]>(['dinner']);
  const [dietary, setDietary] = useState('');
  const [notes, setNotes] = useState('');
  const [useExpiring, setUseExpiring] = useState(true);
  const [avoidRepeats, setAvoidRepeats] = useState(true);

  function toggleType(t: MealType) {
    setSelected((p) => p.includes(t) ? p.filter((x) => x !== t) : [...p, t]);
  }

  async function run() {
    if (selected.length === 0) return toastError('Pick at least one meal to plan');
    setLoading(true);
    try {
      const res = await fetch('/api/ai/meals/plan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          weekStart, mealTypes: selected,
          dietary: dietary.split(',').map((s) => s.trim()).filter(Boolean),
          notes, useExpiring, avoidRepeats, write: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) { toastError(data.error ?? 'Could not generate a plan'); return; }
      success(`Planned ${data.count ?? data.assignments?.length ?? 0} meals for the week! 🍽️`);
      onPlanned();
    } catch {
      toastError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Auto-plan your week"
      description="Our planner fills the week from your saved meals & recipes, honoring your diet and using up food before it expires.">
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium">Which meals?</p>
          <div className="flex flex-wrap gap-2">
            {mealTypes.map((t) => (
              <button key={t} type="button" onClick={() => toggleType(t)}
                className={cn('rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition',
                  selected.includes(t) ? 'border-brand bg-brand/10 text-brand-text' : 'border-border hover:bg-elevated')}>
                {selected.includes(t) && <Check className="mr-1 inline h-3 w-3" />}{MEAL_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
        <Field label="Dietary needs" hint="Comma-separated, e.g. Vegetarian, Nut-free">
          {(id) => <Input id={id} value={dietary} onChange={(e) => setDietary(e.target.value)} placeholder="Vegetarian, Dairy-free" />}
        </Field>
        <Field label="Anything else?">
          {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Kid-friendly, quick weeknights, double up for leftovers…" className="min-h-[50px]" />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useExpiring} onChange={(e) => setUseExpiring(e.target.checked)} className="h-4 w-4 rounded border-border" />
          Use up pantry items that are expiring soon
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={avoidRepeats} onChange={(e) => setAvoidRepeats(e.target.checked)} className="h-4 w-4 rounded border-border" />
          Avoid repeating dishes this week
        </label>
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-muted">
          This replaces any meals already planned in the selected slots for this week.
        </p>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="button" loading={loading} onClick={run}><Sparkles className="h-4 w-4" /> Generate plan</Button>
        </div>
      </div>
    </Modal>
  );
}

const NUTRIENT_ORDER: (keyof Nutrition)[] = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'];

/** AI Nutrition Analysis for the planned week (cached server-side). */
function WeekNutritionPanel({ weekStart, planCount }: { weekStart: string; planCount: number }) {
  const { error: toastError } = useToast();
  const [data, setData] = useState<(Nutrition & { summary: string | null }) | null>(null);
  const [loading, setLoading] = useState(false);
  const [cached, setCached] = useState(false);

  const analyze = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/meals/nutrition', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subjectType: 'week', subjectId: weekStart, refresh }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not analyze nutrition'); return; }
      const n = json.nutrition;
      setData({
        calories: n.calories ?? 0, protein_g: Number(n.protein_g ?? 0), carbs_g: Number(n.carbs_g ?? 0),
        fat_g: Number(n.fat_g ?? 0), fiber_g: Number(n.fiber_g ?? 0), sugar_g: Number(n.sugar_g ?? 0),
        sodium_mg: Number(n.sodium_mg ?? 0), summary: n.summary ?? null,
      });
      setCached(json.cached);
    } catch {
      toastError('Network error — please try again');
    } finally {
      setLoading(false);
    }
  }, [weekStart, toastError]);

  useEffect(() => { setData(null); setCached(false); }, [weekStart]);

  return (
    <div className="sidebar-card">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Activity className="h-4 w-4 text-success" /> Nutrition Overview</p>
        {data && <span className="text-[10px] text-muted">avg / day{cached ? ' · saved' : ''}</span>}
      </div>

      {!data ? (
        <div className="text-center">
          <p className="mb-2 text-xs text-muted">
            {planCount === 0 ? 'Plan some meals, then analyze the week.' : 'See the nutrition of this week’s plan.'}
          </p>
          <Button size="sm" variant="outline" loading={loading} disabled={planCount === 0} onClick={() => analyze(false)}>
            <Sparkles className="h-4 w-4" /> Analyze week
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {NUTRIENT_ORDER.map((k) => {
            const val = data[k];
            const pct = dailyValuePct(k, val);
            return (
              <div key={k}>
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted">{NUTRIENT_LABELS[k]}</span>
                  <span className="font-medium">{fmtAmount(k, val)}{k !== 'calories' ? ` · ${pct}% DV` : ''}</span>
                </div>
                {k !== 'calories' && (
                  <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-elevated">
                    <div className="h-full rounded-full bg-success" style={{ width: `${Math.min(100, pct)}%` }} />
                  </div>
                )}
              </div>
            );
          })}
          {data.summary && <p className="pt-1 text-[11px] text-muted">{data.summary}</p>}
          <button onClick={() => analyze(true)} className="w-full pt-1 text-center text-[11px] text-muted hover:text-brand-text" disabled={loading}>
            {loading ? 'Analyzing…' : 'Re-analyze'}
          </button>
        </div>
      )}
    </div>
  );
}

function NewMealModal({ familyId, userId, onClose, onSaved }: { familyId: string; userId: string; onClose: () => void; onSaved: () => void }) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const meal_type = String(form.get('meal_type') ?? 'dinner') as MealType;
    const image_url = String(form.get('image_url') ?? '').trim() || null;
    const recipe_url = String(form.get('recipe_url') ?? '').trim() || null;
    if (!name) return toastError('Name required');
    setLoading(true);
    const { error } = await createClient().from('meals').insert({ family_id: familyId, name, meal_type, image_url, recipe_url, ingredients: [], created_by: userId });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title="Add Meal" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Meal name" required>{(id) => <Input id={id} name="name" autoFocus placeholder="Lemon Garlic Chicken" />}</Field>
        <Field label="Type">
          {(id) => <Select id={id} name="meal_type">{MEAL_TYPES.map(t => <option key={t} value={t}>{MEAL_LABELS[t]}</option>)}</Select>}
        </Field>
        <Field label="Photo URL" hint="Optional">{(id) => <Input id={id} name="image_url" placeholder="https://…" />}</Field>
        <Field label="Recipe link" hint="Optional">{(id) => <Input id={id} name="recipe_url" placeholder="https://…" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" type="button" onClick={onClose} size="sm">Cancel</Button>
          <Button type="submit" disabled={loading} loading={loading} size="sm">{loading ? 'Saving…' : 'Add Meal'}</Button>
        </div>
      </form>
    </Modal>
  );
}
