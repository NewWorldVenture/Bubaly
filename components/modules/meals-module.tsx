'use client';

import Link from 'next/link';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft, ChevronRight, Plus, Sparkles, Activity, Check, X as XIcon,
  Search, MoreHorizontal, Clock, Heart, ThumbsUp, Utensils,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { settleAll } from '@/lib/supabase/settle';
import { createMealAction, planMealAction, removeMealPlanAction } from '@/app/(app)/dashboard/meals/actions';
import { addMealPlanToGroceryListAction, setGroceryItemCheckedAction } from '@/app/(app)/dashboard/grocery/actions';
import type { Substitution } from '@/lib/meals/substitutions';
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
import { useLocale, useTranslations } from '@/components/i18n/locale-provider';
import { formatMealDay, mealWeek } from '@/lib/meals/week';
import type { Ingredient, PlanSlot } from '@/lib/services/meals';
import type { QueryRefreshConfirmation } from '@/lib/hooks/use-realtime-query';

type Meal = Tables<'meals'>;
type Plan = Tables<'meal_plans'> & { meal: Meal | null };
type Recipe = Tables<'family_recipes'>;
type Vote = Tables<'meal_votes'>;
type VoteOption = Tables<'meal_vote_options'>;
type Ballot = Pick<Tables<'meal_vote_ballots'>, 'option_id' | 'member_id' | 'choice'>;

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_ICONS: Record<MealType, string> = { breakfast: '🌅', lunch: '🥗', dinner: '🍽️', snack: '🍎' };

/**
 * The five sentences a substitution can carry, by the key the pure helper
 * returns. The helper's own `reason` string is English and belongs to logs and
 * model output; what a family reads comes from the catalogue, with the
 * household's own word for the allergy or the food as the only placeholder.
 */
const SUBSTITUTION_REASON_KEYS: Record<Substitution['reasonKey'], string> = {
  allergySwap: 'mealsModule.swappedBecauseTheFamilyRecords',
  allergyDropped: 'mealsModule.leftOffTheFamilyRecords',
  dislikeSwap: 'mealsModule.swappedBecauseNobodyInThe',
  dislikeDropped: 'mealsModule.leftOffNobodyInThe',
  pantrySwap: 'mealsModule.youAlreadyHaveThisIn',
};

const TABS = [
  { id: 'plan' as const, label: 'Meal Plan' },
  { id: 'recipes' as const, label: 'Recipes' },
  { id: 'groceries' as const, label: 'Groceries' },
  { id: 'favorites' as const, label: 'Favorites' },
];
type TabId = (typeof TABS)[number]['id'];

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
  const tr = useTranslations();
  const locale = useLocale().code;
  const { familyId, userId, family, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const selfId = selfMember?.id ?? null;

  const [tab, setTab] = useState<TabId>('plan');
  const [weekOffset, setWeekOffset] = useState(0);
  const [showAllMeals, setShowAllMeals] = useState(false);
  const [addCell, setAddCell] = useState<{ date: string; type: MealType; scope: object; id: number } | null>(null);
  const [newMealOpen, setNewMealOpen] = useState(false);
  const [autoPlanOpen, setAutoPlanOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [recipeSearch, setRecipeSearch] = useState('');
  const [dinnerIdx, setDinnerIdx] = useState(0);
  const [addingPlan, setAddingPlan] = useState(false);
  const [skipPantry, setSkipPantry] = useState(false);
  const [removingPlan, setRemovingPlan] = useState<string | null>(null);
  // The receipt of the add that just happened, not a standing claim: the rows
  // it describes are the `grocery_items` the service wrote a moment ago, and it
  // clears when the week changes.
  const [lastAdd, setLastAdd] = useState<{ added: number; skipped: string[]; inPantry: string[]; substitutions: Substitution[] } | null>(null);

  const [, setDayClock] = useState(() => mealWeek(family.timezone || 'UTC', 0).today);
  useEffect(() => {
    const checkDay = () => {
      const today = mealWeek(family.timezone || 'UTC', 0).today;
      setDayClock(previous => previous === today ? previous : today);
    };
    const visible = () => { if (document.visibilityState === 'visible') checkDay(); };
    checkDay();
    const timer = window.setInterval(checkDay, 60_000);
    document.addEventListener('visibilitychange', visible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [family.timezone]);
  const week = mealWeek(family.timezone || 'UTC', weekOffset);
  const days = week.days, weekStartStr = week.start, todayStr = week.today;
  const scope = useMemo(() => ({ familyId, userId, weekStartStr }), [familyId, userId, weekStartStr]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const mounted = useRef(false), pickerSequence = useRef(0);
  const groceryIntent = useRef<object | null>(null), removeIntent = useRef<object | null>(null);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useLayoutEffect(() => {
    groceryIntent.current = null; removeIntent.current = null;
    setAddCell(null); setNewMealOpen(false); setAutoPlanOpen(false);
    setAddingPlan(false); setRemovingPlan(null); setLastAdd(null); setDinnerIdx(0); setSkipPantry(false);
  }, [scope]);
  const isCurrentScope = () => mounted.current && scopeRef.current === scope;
  const mealLabel = (type: MealType) => tr(`mealsPlanner.${type}`);
  const dayLabel = (day: string) => formatMealDay(day, locale, { weekday: 'long', month: 'short', day: 'numeric' });
  const openPicker = (date: string, type: MealType) => {
    if (isCurrentScope()) setAddCell({ date, type, scope, id: ++pickerSequence.current });
  };

  const { data: library, loading: libraryLoading, error: libraryError, refresh: reloadLibrary, refreshAndConfirm: confirmLibrary } = useRealtimeQuery<Meal>({
    table: 'meals', familyId, deps: [familyId],
    fetcher: async (supabase) => {
      const result = await supabase.from('meals').select('*').eq('family_id', familyId).order('name');
      if (result.error) console.error('[meals] library read failed', { message: result.error.message });
      return result;
    },
  });
  const libraryRef = useRef(library); libraryRef.current = library;

  const { data: plans, loading, error, refresh, refreshAndConfirm } = useRealtimeQuery<Plan>({
    table: 'meal_plans', familyId, deps: [familyId, weekStartStr],
    fetcher: async (supabase) => {
      const { data, error } = await supabase.from('meal_plans').select('*').eq('family_id', familyId)
        .gte('plan_date', days[0]).lte('plan_date', days[6]);
      if (error) return { data: null, error };
      const ids = [...new Set(data.map(p => p.meal_id).filter((x): x is string => !!x))];
      const { data: meals, error: mealError } = ids.length ? await supabase.from('meals').select('*').eq('family_id', familyId).in('id', ids) : { data: [] as Meal[], error: null };
      if (mealError) return { data: null, error: mealError };
      const byId = new Map((meals ?? []).map(m => [m.id, m]));
      if (ids.some(id => !byId.has(id))) return { data: null, error: { message: tr('mealsPlanner.choicesUnavailable') } };
      return { data: data.map(p => ({ ...p, meal: byId.get(p.meal_id ?? '') ?? null })), error: null };
    },
  });
  const plansRef = useRef(plans);
  plansRef.current = plans;
  const readSlot = (slot: PlanSlot) => {
    const matches = plansRef.current.filter(plan => plan.plan_date === slot.date && plan.meal_type === slot.mealType);
    const plan = matches[0];
    return matches.length === 1 && plan.id === slot.id && plan.meal_id === slot.mealId && plan.meal?.name === slot.name
      && JSON.stringify(readIngredients(plan.meal?.ingredients ?? null)) === JSON.stringify(slot.ingredients);
  };

  const { data: recipes, loading: recipesLoading, error: recipesError, refresh: refreshRecipes } = useRealtimeQuery<Recipe>({
    table: 'family_recipes', familyId, deps: [familyId],
    fetcher: (supabase) => supabase.from('family_recipes').select('*').eq('family_id', familyId)
      .order('last_made_at', { ascending: false, nullsFirst: false }).order('name').limit(200),
  });

  const { data: groceryItems, loading: groceryLoading, error: groceryError, refresh: refreshGrocery, refreshAndConfirm: confirmGrocery } = useRealtimeQuery<Tables<'grocery_items'>>({
    table: 'grocery_items', familyId, deps: [familyId],
    fetcher: (supabase) => supabase.from('grocery_items')
      .select('*').eq('family_id', familyId)
      .order('is_checked').order('created_at', { ascending: false }).limit(80),
  });

  // Active family meal vote (latest), with options + ballots.
  const [voteData, setVoteData] = useState<{ vote: Vote; options: VoteOption[]; ballots: Ballot[] } | null>(null);
  const loadVote = useCallback(async () => {
    const sb = createClient();
    const { data: votes, error: voteErr } = await sb.from('meal_votes').select('*').eq('family_id', familyId)
      .order('created_at', { ascending: false }).limit(1);
    // Enhancement panel (this week's "what's for dinner" vote). Degrade to no
    // panel on failure, but log it rather than silently hiding an active vote.
    if (voteErr) { console.error('[meals] vote read failed', { message: voteErr.message }); setVoteData(null); return; }
    const v = votes?.[0];
    if (!v) { setVoteData(null); return; }
    const [{ data: options, error: optErr }, { data: ballots, error: balErr }] = await settleAll([
      sb.from('meal_vote_options').select('*').eq('vote_id', v.id),
      sb.from('meal_vote_ballots').select('option_id, member_id, choice').eq('vote_id', v.id),
    ]);
    if (optErr || balErr) console.error('[meals] vote detail read failed', { options: optErr?.message, ballots: balErr?.message });
    setVoteData({ vote: v, options: options ?? [], ballots: ballots ?? [] });
  }, [familyId]);
  useEffect(() => { void loadVote(); }, [loadVote]);

  const cellKey = (date: string, type: MealType) => `${date}__${type}`;
  const planMap = useMemo(() => {
    const m = new Map<string, Plan>();
    for (const p of plans) m.set(cellKey(p.plan_date, p.meal_type), p);
    return m;
  }, [plans]);

  const dateRange = `${formatMealDay(days[0], locale, { month: 'short', day: 'numeric' })} – ${formatMealDay(days[6], locale, { month: 'short', day: 'numeric', year: 'numeric' })}`;

  // This week's dinners → the "What's for Dinner?" carousel.
  const dinners = useMemo(
    () => days.map((d) => planMap.get(cellKey(d, 'dinner'))).filter((p): p is Plan => !!p?.meal),
    [days, planMap],
  );
  useEffect(() => { setDinnerIdx(0); setLastAdd(null); }, [weekOffset]);

  /**
   * "Add this week's plan to the list" — the button M10 never had.
   *
   * The subtraction (every ingredient of every planned dish, minus what the
   * pantry has in stock, minus what is already unbought on the list) and the
   * allergy/preference/pantry swaps both live in the groceries service. This
   * only reports what it did: how many lines were written, how many were
   * already there, how many the cupboard covered, and every swap with its
   * reason. Each of those is a fact about what the service just did — which
   * for a pantry swap is a line it did NOT write.
   */
  async function addWeekToGroceryList() {
    if (!isCurrentScope() || groceryIntent.current || loading || error) return;
    const intent = {}; groceryIntent.current = intent;
    const current = () => isCurrentScope() && groceryIntent.current === intent;
    setAddingPlan(true);
    try {
      const result = await addMealPlanToGroceryListAction({
        from: days[0], to: days[6], usePantry: skipPantry,
      });
      if (!current()) return;
      if (!result.ok) { toastError(result.error); return; }
      setTab('groceries');
      const readback = await confirmGrocery();
      if (!current()) return;
      if (!readback.ok) { toastError(readback.error ?? tr('mealsPlanner.groceryReadbackFailed')); return; }
      setLastAdd({
        added: result.added,
        skipped: result.skipped,
        inPantry: result.inPantry,
        substitutions: result.substitutions,
      });
      success(result.added > 0
        ? tr('mealsModule.addedItemsToYourGrocery', { count: result.added })
        : tr('mealsModule.nothingNewToBuyEverything'));
    } catch (err) {
      if (current()) toastError(describeDbError(err));
    } finally {
      if (current()) { groceryIntent.current = null; setAddingPlan(false); }
    }
  }

  const recentlyCooked = useMemo(() => recipes.filter((r) => r.last_made_at).slice(0, 8), [recipes]);
  const favorites = useMemo(() => recipes.filter((r) => r.is_favorite), [recipes]);
  const filteredRecipes = useMemo(() => {
    const q = recipeSearch.trim().toLowerCase();
    return q ? recipes.filter((r) => r.name.toLowerCase().includes(q)) : recipes;
  }, [recipes, recipeSearch]);

  async function removePlan(id: string) {
    if (!isCurrentScope() || removeIntent.current) return;
    const intent = {}; removeIntent.current = intent; setRemovingPlan(id);
    const current = () => isCurrentScope() && removeIntent.current === intent;
    try {
      const result = await removeMealPlanAction(id);
      if (!current()) return;
      if (!result.ok) { toastError(result.error); return; }
      if (result.id !== id) { toastError(tr('mealsPlanner.removeUnconfirmed')); return; }
      const readback = await refreshAndConfirm();
      if (!current()) return;
      if (!readback.ok || plansRef.current.some(plan => plan.id === id)) { toastError(tr('mealsPlanner.removeUnconfirmed')); return; }
      success(tr('mealsPlanner.removed'));
    } catch (err) { if (current()) toastError(describeDbError(err, tr('mealsPlanner.removeUnconfirmed'))); }
    finally { if (current()) { removeIntent.current = null; setRemovingPlan(null); } }
  }

  async function toggleFavorite(r: Recipe) {
    const { error } = await createClient().from('family_recipes').update({ is_favorite: !r.is_favorite }).eq('id', r.id);
    if (error) return toastError(describeDbError(error));
    void refreshRecipes();
  }

  async function toggleGrocery(item: Tables<'grocery_items'>) {
    // The shopping page's action, not a second spelling of it — two versions of
    // one operation on one table is how the forks this work removes began.
    const result = await setGroceryItemCheckedAction(item.id, !item.is_checked);
    if (!result.ok) return toastError(result.error);
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
    success(tr('mealsModule.voteRecorded'));
    void loadVote();
  }

  return (
    <div className="module-with-sidebar">
      {/* Main */}
      <div className="module-main overflow-y-auto">
        {/* Header */}
        <div className="flex-shrink-0">
          <PageHeader
            title={tr('mealsPlanner.title')}
            description={tr('mealsModule.planHealthyMealsYourFamily')}
            action={
              <div className="flex items-center gap-2">
                <Button size="sm" onClick={() => setNewMealOpen(true)}><Plus className="h-4 w-4" /> {tr('meals.addMeal')}</Button>
                <Button variant="outline" size="sm" onClick={() => { setTab('recipes'); }}>
                  <Search className="h-4 w-4" /> {tr('meals.recipeSearch')}
                </Button>
                <div className="relative">
                  <Button variant="outline" size="sm" onClick={() => setMoreOpen((v) => !v)} aria-label={tr('meals.more')}>
                    <MoreHorizontal className="h-4 w-4" /> {tr('meals.more')}
                  </Button>
                  {moreOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setMoreOpen(false)} />
                      <div className="absolute right-0 z-20 mt-1 w-52 rounded-xl border border-border bg-elevated p-1 shadow-lg">
                        <button onClick={() => { setMoreOpen(false); setAutoPlanOpen(true); }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface">
                          <Sparkles className="h-4 w-4 text-brand-text" /> {tr('meals.autoPlanTheWeek')}
                        </button>
                        <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"><AiInsight kind="meals" /> {tr('meals.aiInsight')}</div>
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
              <button onClick={() => setWeekOffset(w => w - 1)} aria-label={tr('meals.previousWeek')} className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronLeft className="h-4 w-4" /></button>
              <button onClick={() => setWeekOffset(w => w + 1)} aria-label={tr('meals.nextWeek')} className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronRight className="h-4 w-4" /></button>
              <span className="flex items-center gap-2 text-sm font-semibold">📅 {dateRange}</span>
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => setWeekOffset(0)}>{tr('meals.thisWeek')}</Button>
              <Button size="sm" onClick={addWeekToGroceryList} loading={addingPlan} disabled={loading || !!error || plans.length === 0}>
                <Utensils className="h-4 w-4" /> {tr('mealsModule.addThisWeekToThe')}
              </Button>
              <label className="flex min-h-11 w-full items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={skipPantry} disabled={addingPlan} onChange={event => setSkipPantry(event.target.checked)} className="h-4 w-4" />{tr('mealsPlanner.skipPantry')}
              </label>
            </div>

            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-muted" role="status">{!loading && !error ? tr('mealsPlanner.progress', { count: dinners.length }) : ''}</p>
              <Button variant="outline" size="sm" aria-pressed={showAllMeals} onClick={() => setShowAllMeals(value => !value)}>
                {tr(showAllMeals ? 'mealsPlanner.dinnersOnly' : 'mealsPlanner.showAll')}
              </Button>
            </div>
            {loading ? <SkeletonList count={7} /> : error ? <ErrorState message={error} onRetry={refresh} /> : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" aria-label={tr('mealsPlanner.title')}>
                {days.map(date => (
                  <section key={date} className={cn('overflow-hidden rounded-xl border border-border bg-surface/30', date === todayStr && 'border-brand/50')}>
                    <h2 className={cn('border-b border-border px-3 py-2 text-sm font-semibold', date === todayStr ? 'bg-brand/10' : 'bg-surface/40')}>
                      {dayLabel(date)} {date === todayStr && <span className="ml-1 text-xs text-brand-text">{tr('meals.today')}</span>}
                    </h2>
                    <div className="divide-y divide-border">
                      {(showAllMeals ? MEAL_TYPES : ['dinner'] as MealType[]).map(type => {
                        const plan = planMap.get(cellKey(date, type));
                        return (
                          <div key={type} className="flex items-center gap-1 p-2">
                            <button type="button" onClick={() => openPicker(date, type)}
                              aria-label={tr('mealsPlanner.forDay', { meal: mealLabel(type), date: dayLabel(date) })}
                              className="focus-ring flex min-h-16 min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left hover:bg-elevated">
                              <MealImg src={plan?.meal?.image_url ?? null} emoji={MEAL_ICONS[type]} className="h-12 w-12 shrink-0 rounded-lg" />
                              <span className="min-w-0 flex-1">
                                <span className="block text-xs text-muted">{mealLabel(type)}</span>
                                <span className="block break-words text-sm font-semibold">{plan?.meal?.name ?? tr('mealsPlanner.choose')}</span>
                                {plan && <span className="mt-1 block text-xs text-brand-text">{tr('mealsPlanner.change')}</span>}
                              </span>
                              {!plan && <Plus className="h-4 w-4 shrink-0 text-brand-text" />}
                            </button>
                            {plan && <button type="button" onClick={() => void removePlan(plan.id)} disabled={removingPlan !== null}
                              aria-label={tr('meals.removeMeal') + ': ' + mealLabel(type) + ', ' + dayLabel(date)}
                              className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-danger disabled:opacity-50">
                              <XIcon className="h-4 w-4" />
                            </button>}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                ))}
              </div>
            )}

            {/* Recently Cooked */}
            {recentlyCooked.length > 0 && (
              <div className="mt-6">
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-base font-semibold">{tr('meals.recentlyCooked')}</h2>
                  <button onClick={() => setTab('recipes')} className="text-xs text-brand-text hover:underline">{tr('meals.viewAll')}</button>
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
              <input value={recipeSearch} onChange={(e) => setRecipeSearch(e.target.value)} placeholder={tr('meals.searchRecipes')}
                className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted" />
              {recipeSearch && <button onClick={() => setRecipeSearch('')} aria-label={tr('meals.clear')}><XIcon className="h-4 w-4 text-muted" /></button>}
            </div>
            {recipesLoading ? <SkeletonList count={3} /> : recipesError ? <ErrorState message={recipesError} onRetry={refreshRecipes} /> : filteredRecipes.length === 0 ? (
              <EmptyState icon={Utensils} title={tr('meals.noRecipesYet')} description={tr('mealsModule.savedRecipesWillAppearHere')} />
            ) : (
              <RecipeGrid recipes={filteredRecipes} onToggleFavorite={toggleFavorite} />
            )}
          </div>
        )}

        {/* ── GROCERIES TAB ─────────────────────────────────────── */}
        {tab === 'groceries' && (
          <div className="py-3">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">{tr('meals.groceryList')}</h2>
              <Button size="sm" variant="outline" onClick={addWeekToGroceryList} loading={addingPlan} disabled={loading || !!error || plans.length === 0}>
                <Utensils className="h-4 w-4" /> {tr('mealsModule.addThisWeekToThe')}
              </Button>
              <Link href="/dashboard/grocery" className="ml-auto text-xs text-brand-text hover:underline">{tr('meals.openFullList')}</Link>
              <label className="flex min-h-11 w-full items-center gap-2 text-sm text-muted">
                <input type="checkbox" checked={skipPantry} disabled={addingPlan} onChange={event => setSkipPantry(event.target.checked)} className="h-4 w-4" />{tr('mealsPlanner.skipPantry')}
              </label>
            </div>

            {/* What the last add actually did. Every line here describes rows
                the groceries service wrote, skipped or deliberately left
                unwritten a moment ago. An allergy or dislike swap names what
                went ON the list in place of the plan's ingredient; a pantry
                swap is the opposite — nothing was written, because the family
                already owns the thing, and the sentence says so. */}
            {lastAdd && (
              <div className="mb-3 rounded-2xl border border-border bg-surface/30 p-3">
                <p className="text-xs font-semibold">{tr('mealsModule.whatChangedOnYourList')}</p>
                <ul className="mt-1.5 space-y-1 text-xs text-muted">
                  <li>{tr('mealsModule.addedItemsToYourGrocery', { count: lastAdd.added })}</li>
                  {lastAdd.skipped.length > 0 && <li>{tr('mealsModule.alreadyOnTheListItems', { count: lastAdd.skipped.length })}</li>}
                  {lastAdd.inPantry.length > 0 && <li>{tr('mealsModule.alreadyInThePantryItems', { count: lastAdd.inPantry.length })}</li>}
                </ul>
                {lastAdd.substitutions.length > 0 && (
                  <ul className="mt-2 space-y-1 border-t border-border/60 pt-2 text-xs">
                    {lastAdd.substitutions.map((s) => (
                      <li key={`${s.from}-${s.to ?? 'dropped'}`} className="flex flex-wrap items-baseline gap-1">
                        <span className="font-medium">{s.from}</span>
                        <span aria-hidden>→</span>
                        <span className="font-medium">{s.to ?? tr('mealsModule.leftOffTheList')}</span>
                        <span className="text-muted">— {tr(SUBSTITUTION_REASON_KEYS[s.reasonKey], { trigger: s.trigger })}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            {groceryLoading ? <SkeletonList count={3} /> : groceryError ? <ErrorState message={groceryError} onRetry={refreshGrocery} /> : groceryItems.length === 0 ? (
              <EmptyState icon={Check} title={tr('meals.yourListIsEmpty')} description={tr('mealsModule.addItemsFromTheGrocery')} />
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
            {recipesLoading ? <SkeletonList count={3} /> : recipesError ? <ErrorState message={recipesError} onRetry={refreshRecipes} /> : favorites.length === 0 ? (
              <EmptyState icon={Heart} title={tr('meals.noFavoritesYet')} description={tr('mealsModule.tapTheHeartOnA')} />
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
          <p className="mb-3 text-sm font-semibold">{tr('meals.whatAposSForDinner')}</p>
          {loading ? <SkeletonList count={1} /> : error ? <p className="text-xs text-danger">{error}</p> : dinners.length === 0 ? (
            <p className="text-xs text-muted">{tr('meals.noDinnersPlannedThisWeekYet')}</p>
          ) : (
            <div className="relative">
              <div className="overflow-hidden rounded-xl border border-border">
                <MealImg src={dinners[dinnerIdx]?.meal?.image_url ?? null} emoji="🍽️" className="h-36 w-full" />
              </div>
              <div className="mt-2">
                <p className="text-sm font-bold leading-snug">{dinners[dinnerIdx]?.meal?.name}</p>
                <p className="mt-0.5 text-[11px] text-muted">
                  {dayLabel(dinners[Math.min(dinnerIdx, dinners.length - 1)].plan_date)}
                </p>
              </div>
              {dinners[dinnerIdx]?.meal?.recipe_url && (
                <a href={dinners[dinnerIdx]!.meal!.recipe_url!} target="_blank" rel="noreferrer"
                  className="mt-2 block rounded-lg bg-brand py-2 text-center text-xs font-semibold text-brand-fg transition hover:opacity-90">
                  {tr('meals.viewRecipe')}
                </a>
              )}
              {dinners.length > 1 && (
                <>
                  <button onClick={() => setDinnerIdx((i) => (i - 1 + dinners.length) % dinners.length)} aria-label={tr('meals.previousDinner')}
                    className="absolute left-1 top-[68px] grid h-7 w-7 -translate-y-1/2 place-items-center rounded-full bg-bg/70 text-fg backdrop-blur hover:bg-bg"><ChevronLeft className="h-4 w-4" /></button>
                  <button onClick={() => setDinnerIdx((i) => (i + 1) % dinners.length)} aria-label={tr('meals.nextDinner')}
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
            <p className="text-sm font-semibold">{tr('meals.groceryList')}</p>
            <button onClick={() => setTab('groceries')} className="text-[11px] font-medium text-brand-text hover:underline">{tr('meals.viewList')}</button>
          </div>
          {groceryLoading ? <SkeletonList count={1} /> : groceryError ? <p className="text-xs text-danger">{groceryError}</p> : groceryItems.length === 0 ? (
            <p className="text-xs text-muted">{tr('meals.yourGroceryListIsEmpty')}</p>
          ) : (
            <div className="space-y-1.5">
              {groceryItems.slice(0, 6).map(item => (
                <div key={item.id} className="flex items-center gap-2">
                  <button onClick={() => toggleGrocery(item)} aria-label={tr('meals.toggle')}
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
      {addCell?.scope === scope && (
        <MealPicker key={addCell.id} date={addCell.date} mealType={addCell.type}
          title={tr('mealsPlanner.forDay', { meal: mealLabel(addCell.type), date: dayLabel(addCell.date) })}
          library={library} recipes={recipes} choicesLoading={libraryLoading || recipesLoading}
          choicesError={libraryError || recipesError} retryChoices={() => { void reloadLibrary(); void refreshRecipes(); }}
          isScopeCurrent={isCurrentScope} refreshAndConfirm={refreshAndConfirm}
          readSlot={readSlot}
          onClose={() => setAddCell(null)} onSaved={() => { setAddCell(null); void reloadLibrary(); success(tr('mealsPlanner.saved')); }} />
      )}

      {newMealOpen && (
        <NewMealModal key={familyId + userId + weekStartStr} isScopeCurrent={isCurrentScope} onClose={() => setNewMealOpen(false)}
          refreshAndConfirm={confirmLibrary} readMeal={meal => libraryRef.current.some(row => row.id === meal.id && row.family_id === familyId && row.name === meal.name
            && JSON.stringify(readIngredients(row.ingredients)) === JSON.stringify(readIngredients(meal.ingredients)))}
          onSaved={() => { setNewMealOpen(false); success(tr('mealsPlanner.saved')); }} />
      )}

      {autoPlanOpen && (
        <AutoPlanModal weekStart={weekStartStr} dates={days} mealTypes={MEAL_TYPES} readSlots={slots => slots.every(readSlot)}
          isScopeCurrent={isCurrentScope} refreshAndConfirm={refreshAndConfirm}
          onClose={() => setAutoPlanOpen(false)}
          onPlanned={() => { if (isCurrentScope()) setAutoPlanOpen(false); }} />
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
  const tr = useTranslations();
  const tally = (optId: string) => data.ballots.filter((b) => b.option_id === optId).length;
  const total = data.ballots.length || 1;
  const myPick = data.ballots.find((b) => b.member_id === selfId)?.option_id ?? null;
  return (
    <div className="sidebar-card">
      <p className="text-sm font-semibold">{tr('meals.familyVote')}</p>
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
function AutoPlanModal({ weekStart, dates, mealTypes, readSlots, isScopeCurrent, refreshAndConfirm, onClose, onPlanned }: {
  weekStart: string; dates: string[]; mealTypes: MealType[]; readSlots: (slots: PlanSlot[]) => boolean; isScopeCurrent: () => boolean;
  refreshAndConfirm: () => Promise<QueryRefreshConfirmation>; onClose: () => void; onPlanned: () => void;
}) {
  const tr = useTranslations();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MealType[]>(['dinner']);
  const [dietary, setDietary] = useState('');
  const [notes, setNotes] = useState('');
  const [useExpiring, setUseExpiring] = useState(true);
  const [avoidRepeats, setAvoidRepeats] = useState(true);
  const [failure, setFailure] = useState<string | null>(null), [savedCount, setSavedCount] = useState<number | null>(null);
  const alive = useRef(false), closed = useRef(false), pending = useRef(false), receipt = useRef<PlanSlot[] | null>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && !closed.current && isScopeCurrent();
  const close = useCallback(() => { closed.current = true; onCloseRef.current(); }, []);

  function toggleType(t: MealType) {
    setSelected((p) => p.includes(t) ? p.filter((x) => x !== t) : [...p, t]);
  }

  async function run() {
    if (!current() || pending.current) return;
    if (selected.length === 0) return toastError(tr('mealsModule.pickAtLeastOneMeal'));
    pending.current = true; setLoading(true); setFailure(null);
    try {
      if (receipt.current === null) {
      const res = await fetch('/api/ai/meals/plan', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          weekStart, mealTypes: selected,
          dietary: dietary.split(',').map((s) => s.trim()).filter(Boolean),
          notes, useExpiring, avoidRepeats, write: true,
        }),
      });
      if (!current()) return;
      const data = await res.json();
      if (!current()) return;
      if (!res.ok) { setFailure(typeof data?.error === 'string' ? data.error : tr('mealsPlanner.saveUnconfirmed')); return; }
      if (data?.written !== true || !Number.isInteger(data.count) || data.count <= 0 || data.count > selected.length * 7
        || !Array.isArray(data.slots) || data.count !== data.slots.length
        || data.slots.some((slot: PlanSlot) => !validSlotReceipt(slot) || !dates.includes(slot.date) || !selected.includes(slot.mealType))
        || new Set(data.slots.map((slot: PlanSlot) => slot.id)).size !== data.count
        || new Set(data.slots.map((slot: PlanSlot) => slot.date + '/' + slot.mealType)).size !== data.count) {
        setFailure(tr('mealsPlanner.saveUnconfirmed')); return;
      }
      receipt.current = data.slots; setSavedCount(data.count);
      }
      const readback = await refreshAndConfirm();
      if (!current()) return;
      if (!readback.ok) { setFailure(tr('mealsPlanner.planReadbackFailed')); return; }
      if (!readSlots(receipt.current!)) { setFailure(tr('mealsPlanner.saveUnconfirmed')); return; }
      success(tr('mealsPlanner.autoSaved', { count: receipt.current!.length }));
      closed.current = true;
      onPlanned();
    } catch {
      if (current()) setFailure(receipt.current === null ? tr('mealsModule.networkErrorPleaseTryAgain') : tr('mealsPlanner.planReadbackFailed'));
    } finally {
      if (current()) { pending.current = false; setLoading(false); }
    }
  }

  return (
    <Modal open onClose={close} title={tr('meals.autoPlanYourWeek')}
      description={tr('mealsModule.ourPlannerFillsTheWeek')}>
      <div className="space-y-4">
        <fieldset disabled={loading || savedCount !== null} className="min-w-0 space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium">{tr('meals.whichMeals')}</p>
          <div className="flex flex-wrap gap-2">
            {mealTypes.map((t) => (
              <button key={t} type="button" onClick={() => toggleType(t)}
                className={cn('rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition',
                  selected.includes(t) ? 'border-brand bg-brand/10 text-brand-text' : 'border-border hover:bg-elevated')}>
                {selected.includes(t) && <Check className="mr-1 inline h-3 w-3" />}{tr('mealsPlanner.' + t)}
              </button>
            ))}
          </div>
        </div>
        <Field label={tr('meals.dietaryNeeds')} hint={tr('mealsModule.commaSeparatedEGVegetarian')}>
          {(id) => <Input id={id} value={dietary} onChange={(e) => setDietary(e.target.value)} placeholder={tr('meals.vegetarianDairyFree')} />}
        </Field>
        <Field label={tr('meals.anythingElse')}>
          {(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={tr('meals.kidFriendlyQuickWeeknightsDoubleUp')} className="min-h-[50px]" />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useExpiring} onChange={(e) => setUseExpiring(e.target.checked)} className="h-4 w-4 rounded border-border" />
          {tr('meals.useUpPantryItemsThatAre')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={avoidRepeats} onChange={(e) => setAvoidRepeats(e.target.checked)} className="h-4 w-4 rounded border-border" />
          {tr('meals.avoidRepeatingDishesThisWeek')}
        </label>
        <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-muted">
          {tr('meals.thisReplacesAnyMealsAlreadyPlanned')}
        </p>
        </fieldset>
        {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={close}>{tr('meals.cancel')}</Button>
          <Button type="button" loading={loading} onClick={run}><Sparkles className="h-4 w-4" /> {tr(savedCount !== null ? 'mealsPlanner.retry' : 'meals.generatePlan')}</Button>
        </div>
      </div>
    </Modal>
  );
}

const NUTRIENT_ORDER: (keyof Nutrition)[] = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g', 'sugar_g', 'sodium_mg'];

/** AI Nutrition Analysis for the planned week (cached server-side). */
function WeekNutritionPanel({ weekStart, planCount }: { weekStart: string; planCount: number }) {
  const tr = useTranslations();
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
      toastError(tr('mealsModule.networkErrorPleaseTryAgain'));
    } finally {
      setLoading(false);
    }
  }, [weekStart, toastError, tr]);

  useEffect(() => { setData(null); setCached(false); }, [weekStart]);

  return (
    <div className="sidebar-card">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Activity className="h-4 w-4 text-success" /> {tr('meals.nutritionOverview')}</p>
        {data && <span className="text-[10px] text-muted">{tr('meals.avgDay')}{cached ? ' · saved' : ''}</span>}
      </div>

      {!data ? (
        <div className="text-center">
          <p className="mb-2 text-xs text-muted">
            {planCount === 0 ? 'Plan some meals, then analyze the week.' : 'See the nutrition of this week’s plan.'}
          </p>
          <Button size="sm" variant="outline" loading={loading} disabled={planCount === 0} onClick={() => analyze(false)}>
            <Sparkles className="h-4 w-4" /> {tr('meals.analyzeWeek')}
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

type IngredientDraft = { name: string; quantity: string; unit: string };
const emptyIngredient = (): IngredientDraft => ({ name: '', quantity: '', unit: '' });
function readIngredients(raw: Meal['ingredients']): Ingredient[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): Ingredient[] => {
    if (typeof entry === 'string') return entry.trim() ? [{ name: entry.trim(), quantity: null, unit: null }] : [];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.name !== 'string' || !entry.name.trim()) return [];
    const quantity = entry.quantity ?? entry.qty;
    return [{ name: entry.name.trim(), quantity: typeof quantity === 'number' ? String(quantity) : typeof quantity === 'string' && quantity.trim() ? quantity.trim() : null,
      unit: typeof entry.unit === 'string' && entry.unit.trim() ? entry.unit.trim() : null }];
  });
}
function validSlotReceipt(slot: PlanSlot): boolean {
  return !!slot && typeof slot.id === 'string' && !!slot.id && typeof slot.mealId === 'string' && !!slot.mealId
    && typeof slot.name === 'string' && !!slot.name.trim() && Array.isArray(slot.ingredients)
    && slot.ingredients.every(ingredient => ingredient && typeof ingredient.name === 'string' && !!ingredient.name.trim()
      && (ingredient.quantity === null || typeof ingredient.quantity === 'string') && (ingredient.unit === null || typeof ingredient.unit === 'string'));
}
function ingredientPayload(rows: IngredientDraft[]): Ingredient[] {
  return rows.filter(row => row.name.trim()).map(row => ({ name: row.name.trim(), quantity: row.quantity.trim() || null, unit: row.unit.trim() || null }));
}

function CustomMealFields({ name, setName, ingredients, setIngredients }: {
  name: string; setName: (value: string) => void;
  ingredients: IngredientDraft[]; setIngredients: (value: IngredientDraft[]) => void;
}) {
  const tr = useTranslations();
  return (
    <div className="space-y-4">
      <Field label={tr('meals.mealName')} required>{id => <Input id={id} name="name" value={name} onChange={event => setName(event.target.value)} />}</Field>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{tr('mealsPlanner.ingredients')}</h3>
        <p className="text-xs text-muted">{tr('mealsPlanner.ingredientHint')}</p>
        {ingredients.map((row, index) => (
          <div key={index} className="rounded-lg border border-border p-2">
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2">
                <Field label={tr('mealsPlanner.ingredient') + ' ' + (index + 1)}>{id => <Input id={id} value={row.name} onChange={event => setIngredients(ingredients.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} />}</Field>
              </div>
              <Field label={tr('mealsPlanner.quantity') + ' ' + (index + 1)}>{id => <Input id={id} value={row.quantity} onChange={event => setIngredients(ingredients.map((item, i) => i === index ? { ...item, quantity: event.target.value } : item))} />}</Field>
              <Field label={tr('mealsPlanner.unit') + ' ' + (index + 1)}>{id => <Input id={id} value={row.unit} onChange={event => setIngredients(ingredients.map((item, i) => i === index ? { ...item, unit: event.target.value } : item))} />}</Field>
            </div>
            <button type="button" onClick={() => setIngredients(ingredients.filter((_, i) => i !== index))} className="focus-ring mt-1 min-h-11 text-xs text-muted hover:text-danger">
              {tr('mealsPlanner.removeIngredient', { number: index + 1 })}
            </button>
          </div>
        ))}
        <Button type="button" size="sm" variant="outline" onClick={() => setIngredients([...ingredients, emptyIngredient()])}><Plus className="h-4 w-4" />{tr('mealsPlanner.addIngredient')}</Button>
      </div>
    </div>
  );
}

function MealPicker({ date, mealType, title, library, recipes, choicesLoading, choicesError, retryChoices,
  isScopeCurrent, refreshAndConfirm, readSlot, onClose, onSaved }: {
  date: string; mealType: MealType; title: string; library: Meal[]; recipes: Recipe[];
  choicesLoading: boolean; choicesError: string | null; retryChoices: () => void;
  isScopeCurrent: () => boolean; refreshAndConfirm: () => Promise<QueryRefreshConfirmation>;
  readSlot: (slot: PlanSlot) => boolean; onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const [query, setQuery] = useState(''), [custom, setCustom] = useState(false);
  const [selected, setSelected] = useState<{ kind: 'meal' | 'recipe'; id: string } | null>(null);
  const [name, setName] = useState(''), [ingredients, setIngredients] = useState<IngredientDraft[]>([emptyIngredient()]);
  const [saving, setSaving] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState<PlanSlot | null>(null);
  const alive = useRef(false), closed = useRef(false), pending = useRef(false), attempt = useRef(0), receipt = useRef<PlanSlot | null>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const close = useCallback(() => { closed.current = true; attempt.current++; onCloseRef.current(); }, []);
  const search = query.trim().toLocaleLowerCase();
  const meals = library.filter(meal => meal.name.toLocaleLowerCase().includes(search));
  const recipeChoices = recipes.filter(recipe => recipe.name.toLocaleLowerCase().includes(search));

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!alive.current || closed.current || !isScopeCurrent() || pending.current) return;
    if (!receipt.current && !custom && (!selected || choicesLoading || choicesError)) return;
    if (!receipt.current && custom && (!name.trim() || ingredients.some(row => !row.name.trim() && (row.quantity.trim() || row.unit.trim())))) {
      setFailure(tr('mealsModule.nameRequired')); return;
    }
    pending.current = true; setSaving(true); setFailure(null);
    const id = ++attempt.current;
    const current = () => alive.current && !closed.current && isScopeCurrent() && attempt.current === id;
    try {
      if (!receipt.current) {
        const result = await planMealAction({ date, mealType, ...(custom ? { mealName: name.trim(), ingredients: ingredientPayload(ingredients) }
          : selected?.kind === 'recipe' ? { recipeId: selected.id } : { mealId: selected!.id }) });
        if (!current()) return;
        if (!result.ok) { setFailure(result.error); return; }
        const slot = result.slot;
        if (!validSlotReceipt(slot) || result.id !== slot.id || slot.date !== date || slot.mealType !== mealType
          || (!custom && selected?.kind === 'meal' && slot.mealId !== selected.id)) {
          setFailure(tr('mealsPlanner.saveUnconfirmed')); return;
        }
        receipt.current = slot; setSaved(slot);
      }
      const readback = await refreshAndConfirm();
      if (!current()) return;
      if (!readback.ok) { setFailure(tr('mealsPlanner.readbackFailed')); return; }
      if (!readSlot(receipt.current)) { setFailure(tr('mealsPlanner.saveUnconfirmed')); return; }
      closed.current = true;
      onSaved();
    } catch (cause) {
      if (current()) setFailure(receipt.current ? tr('mealsPlanner.readbackFailed') : describeDbError(cause, tr('mealsPlanner.saveUnconfirmed')));
    } finally {
      if (current()) { pending.current = false; setSaving(false); }
    }
  }

  return (
    <Modal open title={title} onClose={close}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <fieldset disabled={saving || !!saved} className="min-w-0 space-y-4">
          {custom ? <CustomMealFields name={name} setName={setName} ingredients={ingredients} setIngredients={setIngredients} /> : (
            <>
              <Input aria-label={tr('mealsPlanner.search')} value={query} onChange={event => setQuery(event.target.value)} placeholder={tr('mealsPlanner.search')} />
              {choicesLoading ? <p role="status" className="text-sm text-muted">{tr('mealsPlanner.loading')}</p> : choicesError ? (
                <div role="alert" className="space-y-2 text-sm text-danger"><p>{tr('mealsPlanner.choicesUnavailable')}</p><Button type="button" variant="outline" size="sm" onClick={retryChoices}>{tr('mealsPlanner.retry')}</Button></div>
              ) : (
                <div className="max-h-72 space-y-3 overflow-y-auto">
                  {meals.length > 0 && <div><h3 className="mb-1 text-xs font-semibold text-muted">{tr('mealsPlanner.savedMeals')}</h3><div className="space-y-1">
                    {meals.map(meal => <button key={meal.id} type="button" aria-pressed={selected?.kind === 'meal' && selected.id === meal.id}
                      onClick={() => { setSelected({ kind: 'meal', id: meal.id }); setFailure(null); }}
                      className={cn('focus-ring flex min-h-12 w-full items-center gap-2 rounded-lg border px-2 py-2 text-left text-sm', selected?.kind === 'meal' && selected.id === meal.id ? 'border-brand bg-brand/10' : 'border-border hover:bg-elevated')}>
                      <MealImg src={meal.image_url} emoji={MEAL_ICONS[meal.meal_type]} className="h-9 w-9 shrink-0 rounded-lg" /><span className="break-words">{meal.name}</span>
                    </button>)}
                  </div></div>}
                  {recipeChoices.length > 0 && <div><h3 className="mb-1 text-xs font-semibold text-muted">{tr('mealsPlanner.savedRecipes')}</h3><div className="space-y-1">
                    {recipeChoices.map(recipe => <button key={recipe.id} type="button" aria-pressed={selected?.kind === 'recipe' && selected.id === recipe.id}
                      onClick={() => { setSelected({ kind: 'recipe', id: recipe.id }); setFailure(null); }}
                      className={cn('focus-ring flex min-h-12 w-full items-center gap-2 rounded-lg border px-2 py-2 text-left text-sm', selected?.kind === 'recipe' && selected.id === recipe.id ? 'border-brand bg-brand/10' : 'border-border hover:bg-elevated')}>
                      <MealImg src={recipe.photo_url} emoji={MEAL_ICONS.dinner} className="h-9 w-9 shrink-0 rounded-lg" /><span className="break-words">{recipe.name}</span>
                    </button>)}
                  </div></div>}
                  {meals.length === 0 && recipeChoices.length === 0 && <p className="text-sm text-muted">{tr('mealsPlanner.noMatches')}</p>}
                </div>
              )}
            </>
          )}
          <button type="button" onClick={() => { setCustom(value => !value); setFailure(null); }} className="focus-ring min-h-11 text-sm font-medium text-brand-text">
            {tr(custom ? 'mealsPlanner.savedMeals' : 'mealsPlanner.newMeal')}
          </button>
        </fieldset>
        {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={close}>{tr('meals.cancel')}</Button>
          <Button type="submit" loading={saving} disabled={!saved && (custom ? !name.trim() : !selected || choicesLoading || !!choicesError)}>{tr(saved ? 'mealsPlanner.retry' : 'mealsPlanner.save')}</Button>
        </div>
      </form>
    </Modal>
  );
}

function NewMealModal({ isScopeCurrent, refreshAndConfirm, readMeal, onClose, onSaved }: {
  isScopeCurrent: () => boolean; refreshAndConfirm: () => Promise<QueryRefreshConfirmation>;
  readMeal: (meal: Meal) => boolean; onClose: () => void; onSaved: () => void;
}) {
  const tr = useTranslations();
  const [loading, setLoading] = useState(false), [failure, setFailure] = useState<string | null>(null);
  const [name, setName] = useState(''), [ingredients, setIngredients] = useState<IngredientDraft[]>([emptyIngredient()]);
  const [saved, setSaved] = useState<Meal | null>(null);
  const alive = useRef(false), closed = useRef(false), pending = useRef(false);
  const receipt = useRef<Meal | null>(null);
  const onCloseRef = useRef(onClose); onCloseRef.current = onClose;
  useLayoutEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const current = () => alive.current && !closed.current && isScopeCurrent();
  const close = useCallback(() => { closed.current = true; onCloseRef.current(); }, []);
  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!current() || pending.current) return;
    const form = new FormData(event.currentTarget);
    if (!name.trim() || ingredients.some(row => !row.name.trim() && (row.quantity.trim() || row.unit.trim()))) { setFailure(tr('mealsModule.nameRequired')); return; }
    pending.current = true; setLoading(true); setFailure(null);
    try {
      if (!receipt.current) {
      const result = await createMealAction({ name: name.trim(), mealType: String(form.get('meal_type') ?? 'dinner') as MealType,
        imageUrl: String(form.get('image_url') ?? '').trim() || null, recipeUrl: String(form.get('recipe_url') ?? '').trim() || null, ingredients: ingredientPayload(ingredients) });
      if (!current()) return;
      if (!result.ok) { setFailure(result.error); return; }
      if (!result.meal?.id || !result.meal.name) { setFailure(tr('mealsPlanner.saveUnconfirmed')); return; }
      receipt.current = result.meal; setSaved(result.meal);
      }
      const readback = await refreshAndConfirm();
      if (!current()) return;
      if (!readback.ok) { setFailure(tr('mealsPlanner.libraryReadbackFailed')); return; }
      if (!readMeal(receipt.current)) { setFailure(tr('mealsPlanner.saveUnconfirmed')); return; }
      closed.current = true; onSaved();
    } catch (cause) { if (current()) setFailure(receipt.current ? tr('mealsPlanner.libraryReadbackFailed') : describeDbError(cause, tr('mealsPlanner.saveUnconfirmed'))); }
    finally { if (current()) { pending.current = false; setLoading(false); } }
  }
  return (
    <Modal open title={tr('meals.addMeal')} onClose={close}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <fieldset disabled={loading || !!saved} className="min-w-0 space-y-4">
          <CustomMealFields name={name} setName={setName} ingredients={ingredients} setIngredients={setIngredients} />
          <Field label={tr('meals.type')}>{id => <Select id={id} name="meal_type" defaultValue="dinner">{MEAL_TYPES.map(type => <option key={type} value={type}>{tr('mealsPlanner.' + type)}</option>)}</Select>}</Field>
          <Field label={tr('meals.photoUrl')} hint={tr('mealsModule.optional')}>{id => <Input id={id} name="image_url" placeholder="https://" />}</Field>
          <Field label={tr('meals.recipeLink')} hint={tr('mealsModule.optional')}>{id => <Input id={id} name="recipe_url" placeholder="https://" />}</Field>
        </fieldset>
        {failure && <p role="alert" className="text-sm text-danger">{failure}</p>}
        <div className="flex justify-end gap-2"><Button variant="ghost" type="button" onClick={close}>{tr('meals.cancel')}</Button><Button type="submit" loading={loading}>{tr(saved ? 'mealsPlanner.retry' : 'mealsPlanner.save')}</Button></div>
      </form>
    </Modal>
  );
}
