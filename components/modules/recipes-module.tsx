'use client';

import { useMemo, useState } from 'react';
import {
  ChefHat, Plus, Star, StarOff, Trash2, Edit2, Clock, Users,
  Search, Filter, Sparkles, ShoppingCart, Heart, ExternalLink, Vote,
  BookOpen, Flame, X, Check, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { RECIPE_AI_ACTIONS } from '@/lib/recipes/ai-actions';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Recipe = Tables<'family_recipes'>;

interface Ingredient { name: string; quantity: string; unit: string; }

/** Scale a recipe quantity by a serving multiplier. Non-numeric values (e.g.
 *  "to taste") and bad data ("NaN") never render as "NaN" — numbers scale,
 *  real words pass through, junk is dropped. */
function scaleQuantity(quantity: string | null | undefined, multiplier: number): string {
  if (!quantity) return '';
  const n = parseFloat(quantity);
  if (Number.isFinite(n)) return (n * multiplier).toFixed(1).replace(/\.0$/, '');
  return /^\s*nan\s*$/i.test(quantity) ? '' : quantity.trim();
}
interface InstructionStep { step: number; text: string; }

const CATEGORIES = [
  { id: 'breakfast', label: 'Breakfast', emoji: '🥞', color: 'text-warning' },
  { id: 'lunch', label: 'Lunch', emoji: '🥗', color: 'text-success' },
  { id: 'dinner', label: 'Dinner', emoji: '🍝', color: 'text-accent' },
  { id: 'snack', label: 'Snack', emoji: '🍎', color: 'text-green-400' },
  { id: 'dessert', label: 'Dessert', emoji: '🍰', color: 'text-pink-400' },
  { id: 'drink', label: 'Drink', emoji: '🧃', color: 'text-blue-400' },
  { id: 'side', label: 'Side', emoji: '🥦', color: 'text-teal-400' },
  { id: 'appetizer', label: 'Appetizer', emoji: '🧆', color: 'text-purple-400' },
  { id: 'other', label: 'Other', emoji: '🍽️', color: 'text-muted' },
] as const;

const DIFFICULTIES = [
  { id: 'easy', label: 'Easy', color: 'text-success', badge: 'success' },
  { id: 'medium', label: 'Medium', color: 'text-warning', badge: 'warning' },
  { id: 'hard', label: 'Hard', color: 'text-danger', badge: 'danger' },
] as const;

const ALLERGY_FLAGS = ['Gluten-free', 'Dairy-free', 'Nut-free', 'Vegan', 'Vegetarian', 'Egg-free', 'Soy-free', 'Low-carb'];

function categoryMeta(id: string) { return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1]; }
function difficultyMeta(id: string) { return DIFFICULTIES.find((d) => d.id === id) ?? DIFFICULTIES[1]; }

export function RecipesModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const [tab, setTab] = useState<'all' | 'favorites' | 'recent'>('all');
  const [filterCategory, setFilterCategory] = useState('all');
  const [search, setSearch] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [viewing, setViewing] = useState<Recipe | null>(null);
  const [editing, setEditing] = useState<Recipe | null>(null);
  const [servingsOverride, setServingsOverride] = useState<number | null>(null);
  const [aiBusy, setAiBusy] = useState<string | null>(null);
  const [tonightOpen, setTonightOpen] = useState(false);
  const [tonightConstraint, setTonightConstraint] = useState('');
  const [tonightBusy, setTonightBusy] = useState(false);
  const [tonightPicks, setTonightPicks] = useState<{ id: string; name: string; cuisine: string | null; reason: string }[] | null>(null);

  async function suggestTonight() {
    setTonightBusy(true);
    setTonightPicks(null);
    try {
      const res = await fetch('/api/recipes/suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ constraint: tonightConstraint }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not get suggestions');
      setTonightPicks(json.picks ?? []);
    } catch (err) {
      toastError(describeDbError(err, 'Could not get suggestions'));
    } finally {
      setTonightBusy(false);
    }
  }
  // When adding a recipe to the grocery list but none exists yet, prompt to
  // create + name one inline rather than failing.
  const [groceryPrompt, setGroceryPrompt] = useState<Recipe | null>(null);
  const [newListName, setNewListName] = useState('Groceries');
  const [creatingList, setCreatingList] = useState(false);

  const { data: recipes, loading, error, refresh } = useRealtimeQuery<Recipe>({
    table: 'family_recipes', familyId, deps: [familyId],
    fetcher: (sb) =>
      sb.from('family_recipes').select('*').eq('family_id', familyId)
        .order('is_favorite', { ascending: false })
        .order('updated_at', { ascending: false }),
  });

  const filtered = useMemo(() => {
    let rows = recipes;
    if (tab === 'favorites') rows = rows.filter((r) => r.is_favorite);
    if (tab === 'recent') rows = rows.filter((r) => r.last_made_at).sort((a, b) =>
      new Date(b.last_made_at!).getTime() - new Date(a.last_made_at!).getTime()
    ).slice(0, 20);
    if (filterCategory !== 'all') rows = rows.filter((r) => r.category === filterCategory);
    if (search) rows = rows.filter((r) =>
      r.name.toLowerCase().includes(search.toLowerCase()) ||
      r.description?.toLowerCase().includes(search.toLowerCase()) ||
      r.cuisine?.toLowerCase().includes(search.toLowerCase()) ||
      r.tags?.some((t) => t.toLowerCase().includes(search.toLowerCase()))
    );
    return rows;
  }, [recipes, tab, filterCategory, search]);

  async function toggleFavorite(r: Recipe) {
    const supabase = createClient();
    await supabase.from('family_recipes').update({ is_favorite: !r.is_favorite }).eq('id', r.id);
    void refresh();
  }

  async function remix(recipe: Recipe, actionId: string) {
    setAiBusy(actionId);
    try {
      const res = await fetch('/api/recipes/transform', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipeId: recipe.id, actionId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Could not generate variant');
      success('AI variant saved to your recipes');
      setViewing(null);
    } catch (err) {
      toastError(describeDbError(err, 'Could not generate variant'));
    } finally {
      setAiBusy(null);
    }
  }

  async function markMade(r: Recipe) {
    const supabase = createClient();
    await supabase.from('family_recipes').update({
      times_made: (r.times_made ?? 0) + 1,
      last_made_at: new Date().toISOString(),
    }).eq('id', r.id);
    success('Marked as made today! 🍴');
    void refresh();
  }

  async function deleteRecipe(id: string) {
    const supabase = createClient();
    await supabase.from('family_recipes').delete().eq('id', id);
    void refresh();
    setViewing(null);
  }

  async function addItemsToList(recipe: Recipe, listId: string): Promise<boolean> {
    const supabase = createClient();
    const ingredients = (recipe.ingredients as unknown as Ingredient[]) ?? [];
    const multiplier = (servingsOverride ?? recipe.servings) / recipe.servings;
    const items = ingredients.map((ing) => {
      const qty = scaleQuantity(ing.quantity, multiplier);
      return {
        family_id: familyId,
        list_id: listId,
        name: ing.name,
        quantity: qty ? `${qty} ${ing.unit ?? ''}`.trim() : null,
        category: 'Pantry',
        created_by: userId,
      };
    });
    const { error } = await supabase.from('grocery_items').insert(items);
    if (error) { toastError(describeDbError(error)); return false; }
    success(`${items.length} ingredients added to your grocery list!`);
    return true;
  }

  async function addToGrocery(recipe: Recipe) {
    const supabase = createClient();
    const { data: list } = await supabase
      .from('grocery_lists').select('id')
      .eq('family_id', familyId).eq('is_archived', false)
      .order('created_at').limit(1).maybeSingle();
    if (!list) { setNewListName('Groceries'); setGroceryPrompt(recipe); return; } // offer to create one
    await addItemsToList(recipe, list.id);
  }

  async function createListAndAdd() {
    if (!groceryPrompt) return;
    const name = newListName.trim() || 'Groceries';
    setCreatingList(true);
    const supabase = createClient();
    const { data: created, error } = await supabase
      .from('grocery_lists')
      .insert({ family_id: familyId, name, created_by: userId })
      .select('id').single();
    if (error || !created) { setCreatingList(false); toastError(describeDbError(error, 'Could not create list')); return; }
    const ok = await addItemsToList(groceryPrompt, created.id);
    setCreatingList(false);
    if (ok) setGroceryPrompt(null);
  }

  const stats = {
    total: recipes.length,
    favorites: recipes.filter((r) => r.is_favorite).length,
    timesCooked: recipes.reduce((a, r) => a + (r.times_made ?? 0), 0),
  };

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load family recipes. Refresh and try again." onRetry={refresh} />;

  return (
    <div className="module-page">
      <PageHeader
        title="Family Recipes"
        description="Your family's cookbook — organized, searchable, and always at hand."
        action={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/60 px-3 py-2">
              <Search className="h-4 w-4 text-muted" />
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Search recipes…"
                className="w-28 bg-transparent text-sm placeholder:text-muted outline-none sm:w-40" />
              {search && <button onClick={() => setSearch('')}><X className="h-3.5 w-3.5 text-muted" /></button>}
            </div>
            <button onClick={() => { setTonightOpen(true); setTonightPicks(null); }} className="inline-flex items-center gap-1.5 rounded-xl border border-brand/30 bg-brand/10 px-3 py-2 text-sm font-semibold text-brand-text hover:bg-brand/15"><Sparkles className="h-4 w-4" /> Tonight?</button>
            <a href="/dashboard/recipes/vote" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm font-semibold hover:bg-elevated"><Vote className="h-4 w-4" /> Vote</a>
            <a href="/dashboard/recipes/discover" className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm font-semibold hover:bg-elevated"><Search className="h-4 w-4" /> Discover</a>
            <AiInsight kind="recipes" iconOnly />
            <Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add Recipe</Button>
          </div>
        }
      />

      {/* Stats */}
      <div className="grid-stats">
        {[
          { label: 'Total Recipes', value: stats.total, icon: '📖', color: 'text-brand-text' },
          { label: 'Favorites', value: stats.favorites, icon: '⭐', color: 'text-warning' },
          { label: 'Times Cooked', value: stats.timesCooked, icon: '🍳', color: 'text-accent' },
          { label: 'Categories', value: [...new Set(recipes.map((r) => r.category))].length, icon: '🗂️', color: 'text-muted' },
        ].map((s) => (
          <div key={s.label} className="stat-card">
            <span className="text-2xl">{s.icon}</span>
            <div>
              <div className={cn('text-xl font-bold', s.color)}>{s.value}</div>
              <div className="text-[11px] text-muted">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs + category filter */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="tab-bar">
          {(['all', 'favorites', 'recent'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={cn('tab-item capitalize', tab === t ? 'tab-item-active' : 'tab-item-inactive')}>
              {t === 'favorites' ? '⭐ Favorites' : t === 'recent' ? '🍳 Recently Made' : 'All Recipes'}
            </button>
          ))}
        </div>
        <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}
          className="rounded-xl border border-border bg-surface/60 px-3 py-2 text-xs text-muted focus:outline-none">
          <option value="all">All categories</option>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
        </select>
      </div>

      {/* Recipe grid */}
      {filtered.length === 0 ? (
        <EmptyState icon={ChefHat} title="No recipes yet"
          description="Add your family's favorite recipes and they'll appear here."
          action={<Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add First Recipe</Button>} />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((recipe) => {
            const cat = categoryMeta(recipe.category);
            const diff = difficultyMeta(recipe.difficulty);
            const totalTime = (recipe.prep_time_mins ?? 0) + (recipe.cook_time_mins ?? 0);

            return (
              <div key={recipe.id}
                className="group glass-card flex cursor-pointer flex-col overflow-hidden p-0 transition hover:-translate-y-0.5"
                onClick={() => setViewing(recipe)}>
                {/* Photo / placeholder */}
                <div className="relative aspect-video overflow-hidden rounded-t-2xl bg-gradient-to-br from-elevated to-surface">
                  {recipe.photo_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={recipe.photo_url} alt={recipe.name} className="h-full w-full object-cover transition group-hover:scale-105" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-5xl opacity-30">{cat.emoji}</div>
                  )}
                  {/* Badges */}
                  <div className="absolute left-2 top-2 flex gap-1.5">
                    <span className="rounded-lg bg-black/50 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
                      {cat.emoji} {cat.label}
                    </span>
                    {recipe.ai_generated && (
                      <span className="rounded-lg bg-brand/80 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
                        <Sparkles className="inline h-2.5 w-2.5 mr-0.5" />AI
                      </span>
                    )}
                  </div>
                  {/* Favorite */}
                  <button onClick={(e) => { e.stopPropagation(); toggleFavorite(recipe); }}
                    className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60">
                    <Heart className={cn('h-4 w-4', recipe.is_favorite && 'fill-red-400 text-red-400')} />
                  </button>
                </div>

                {/* Info */}
                <div className="flex flex-1 flex-col p-4">
                  <h3 className="mb-1 line-clamp-2 font-semibold leading-tight">{recipe.name}</h3>
                  {recipe.description && <p className="mb-2 line-clamp-2 text-xs text-muted">{recipe.description}</p>}

                  <div className="mt-auto flex flex-wrap items-center gap-2 text-xs text-muted">
                    {totalTime > 0 && (
                      <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {totalTime} min</span>
                    )}
                    <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {recipe.servings}</span>
                    <Badge tone={diff.badge as 'neutral'}>{diff.label}</Badge>
                    {recipe.times_made > 0 && (
                      <span className="ml-auto text-success">{recipe.times_made}× made</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Recipe Detail Modal ────────────────────────────────── */}
      {viewing && (
        <Modal open onClose={() => { setViewing(null); setServingsOverride(null); }} title="">
          <div className="max-h-[80vh] overflow-y-auto -m-2 p-2">
            {/* Header */}
            <div className="relative mb-5">
              {viewing.photo_url && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={viewing.photo_url} alt={viewing.name} className="mb-4 h-48 w-full rounded-2xl object-cover" />
              )}
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold">{viewing.name}</h2>
                  {viewing.description && <p className="mt-1 text-sm text-muted">{viewing.description}</p>}
                </div>
                <div className="flex gap-1">
                  <button onClick={() => toggleFavorite(viewing)}
                    className="rounded-xl p-2 hover:bg-elevated transition">
                    <Heart className={cn('h-5 w-5', viewing.is_favorite ? 'fill-red-400 text-red-400' : 'text-muted')} />
                  </button>
                  <button onClick={() => { setEditing(viewing); setViewing(null); }}
                    className="rounded-xl p-2 text-muted hover:bg-elevated hover:text-fg transition">
                    <Edit2 className="h-5 w-5" />
                  </button>
                  <button onClick={() => { if (confirm('Delete this recipe?')) deleteRecipe(viewing.id); }}
                    className="rounded-xl p-2 text-muted hover:bg-elevated hover:text-danger transition">
                    <Trash2 className="h-5 w-5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Meta */}
            <div className="mb-5 flex flex-wrap gap-3">
              {(() => { const cat = categoryMeta(viewing.category); return (
                <span className="flex items-center gap-1 rounded-lg bg-elevated px-3 py-1.5 text-sm">
                  {cat.emoji} {cat.label}
                </span>
              ); })()}
              {viewing.prep_time_mins && (
                <span className="flex items-center gap-1 rounded-lg bg-elevated px-3 py-1.5 text-sm">
                  <Clock className="h-4 w-4 text-muted" /> Prep {viewing.prep_time_mins} min
                </span>
              )}
              {viewing.cook_time_mins && (
                <span className="flex items-center gap-1 rounded-lg bg-elevated px-3 py-1.5 text-sm">
                  <Flame className="h-4 w-4 text-accent" /> Cook {viewing.cook_time_mins} min
                </span>
              )}
              {viewing.cuisine && <span className="rounded-lg bg-elevated px-3 py-1.5 text-sm">{viewing.cuisine}</span>}
              {viewing.allergy_flags?.map((f) => <Badge key={f} tone="neutral">{f}</Badge>)}
            </div>

            {/* Servings adjuster */}
            <div className="mb-5 flex items-center gap-4 rounded-2xl border border-border bg-elevated/50 p-4">
              <span className="text-sm font-semibold">Servings</span>
              <div className="flex items-center gap-3">
                <button onClick={() => setServingsOverride((s) => Math.max(1, (s ?? viewing.servings) - 1))}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-border hover:bg-elevated transition text-lg font-bold">−</button>
                <span className="text-lg font-bold">{servingsOverride ?? viewing.servings}</span>
                <button onClick={() => setServingsOverride((s) => (s ?? viewing.servings) + 1)}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-border hover:bg-elevated transition text-lg font-bold">+</button>
              </div>
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => addToGrocery(viewing)}>
                <ShoppingCart className="h-4 w-4" /> Add to Grocery List
              </Button>
            </div>

            {/* AI Remix — saves a transformed variant to your recipes */}
            <div className="mb-5 rounded-2xl border border-brand/25 bg-brand/5 p-3">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> AI Remix</p>
              <div className="flex flex-wrap gap-2">
                {RECIPE_AI_ACTIONS.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => remix(viewing, a.id)}
                    disabled={aiBusy !== null}
                    className="rounded-full border border-border bg-surface px-3 py-1.5 text-xs font-medium transition hover:border-brand/50 hover:bg-elevated disabled:opacity-50"
                  >
                    {aiBusy === a.id ? 'Working…' : a.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-muted">Creates a new variant in your recipes. AI amounts/nutrition are estimates — not medical advice.</p>
            </div>

            {/* Ingredients */}
            <div className="mb-5">
              <h3 className="mb-3 text-base font-bold">Ingredients</h3>
              <div className="space-y-2">
                {((viewing.ingredients as unknown as Ingredient[]) ?? []).map((ing, i) => {
                  const multiplier = (servingsOverride ?? viewing.servings) / viewing.servings;
                  const qty = scaleQuantity(ing.quantity, multiplier);
                  return (
                    <div key={i} className="flex items-center gap-3 rounded-xl bg-elevated/40 px-3 py-2.5 text-sm">
                      <span className="h-2 w-2 rounded-full bg-brand flex-shrink-0" />
                      {qty && <span className="font-semibold w-12 flex-shrink-0">{qty} {ing.unit}</span>}
                      <span>{ing.name}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Instructions */}
            <div className="mb-5">
              <h3 className="mb-3 text-base font-bold">Instructions</h3>
              <div className="space-y-3">
                {((viewing.instructions as unknown as InstructionStep[]) ?? []).map((step, i) => (
                  <div key={i} className="flex gap-4 text-sm">
                    <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-brand-fg">
                      {step.step ?? i + 1}
                    </div>
                    <p className="flex-1 leading-relaxed text-muted pt-0.5">{step.text}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Notes */}
            {viewing.notes && (
              <div className="mb-5 rounded-xl bg-warning/10 p-4 text-sm">
                <p className="font-semibold text-warning mb-1">Chef&apos;s Notes</p>
                <p className="text-muted">{viewing.notes}</p>
              </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between pt-2">
              {viewing.source_url && (
                <a href={viewing.source_url} target="_blank" rel="noreferrer"
                  className="flex items-center gap-1 text-sm text-brand-text hover:underline">
                  <ExternalLink className="h-3.5 w-3.5" /> View original
                </a>
              )}
              <Button onClick={() => markMade(viewing)} className="ml-auto">
                <Check className="h-4 w-4" /> Made it today!
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* Add/Edit modal */}
      {(addOpen || editing) && (
        <RecipeFormModal
          recipe={editing}
          familyId={familyId}
          userId={userId}
          onClose={() => { setAddOpen(false); setEditing(null); }}
          onSaved={() => { setAddOpen(false); setEditing(null); void refresh(); }}
        />
      )}

      {groceryPrompt && (
        <Modal open onClose={() => setGroceryPrompt(null)} title="Create a grocery list">
          <form onSubmit={(e) => { e.preventDefault(); void createListAndAdd(); }} className="space-y-4">
            <p className="text-sm text-muted">You don&apos;t have a grocery list yet. Name one and we&apos;ll add the ingredients from <span className="font-medium text-fg">{groceryPrompt.name}</span> to it.</p>
            <Field label="List name">
              {(id) => <Input id={id} autoFocus value={newListName} onChange={(e) => setNewListName(e.target.value)} placeholder="Groceries" />}
            </Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setGroceryPrompt(null)}>Cancel</Button>
              <Button type="submit" loading={creatingList} disabled={!newListName.trim()}>Create &amp; add</Button>
            </div>
          </form>
        </Modal>
      )}

      {tonightOpen && (
        <Modal open onClose={() => setTonightOpen(false)} title="What can we make tonight?">
          <div className="space-y-4">
            <p className="text-sm text-muted">We&apos;ll pick from your saved recipes. Optionally tell us what you have or need.</p>
            <Input value={tonightConstraint} onChange={(e) => setTonightConstraint(e.target.value)}
              placeholder="e.g. we have chicken & rice · quick · no dairy" />
            <Button onClick={suggestTonight} loading={tonightBusy} className="w-full">
              <Sparkles className="h-4 w-4" /> {tonightBusy ? 'Thinking…' : 'Suggest dinner'}
            </Button>

            {tonightPicks && tonightPicks.length === 0 && (
              <p className="rounded-xl border border-dashed border-border py-6 text-center text-sm text-muted">
                No matches yet — save a few recipes (try Discover) and ask again.
              </p>
            )}
            {tonightPicks && tonightPicks.length > 0 && (
              <ul className="space-y-2">
                {tonightPicks.map((p) => {
                  const recipe = (recipes ?? []).find((r) => r.id === p.id);
                  return (
                    <li key={p.id}>
                      <button
                        onClick={() => { if (recipe) { setViewing(recipe); setTonightOpen(false); } }}
                        className="w-full rounded-xl border border-border bg-surface/40 p-3 text-left transition hover:border-brand/40"
                      >
                        <p className="text-sm font-semibold">{p.name}{p.cuisine ? <span className="ml-1 text-xs font-normal text-muted">· {p.cuisine}</span> : null}</p>
                        <p className="mt-0.5 text-xs text-muted">{p.reason}</p>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function RecipeFormModal({ recipe, familyId, userId, onClose, onSaved }: {
  recipe: Recipe | null; familyId: string; userId: string;
  onClose: () => void; onSaved: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);
  const [ingredients, setIngredients] = useState<Ingredient[]>(
    recipe ? (recipe.ingredients as unknown as Ingredient[]) : [{ name: '', quantity: '', unit: '' }]
  );
  const [instructions, setInstructions] = useState<InstructionStep[]>(
    recipe ? (recipe.instructions as unknown as InstructionStep[]) : [{ step: 1, text: '' }]
  );
  const [selectedFlags, setSelectedFlags] = useState<string[]>(recipe?.allergy_flags ?? []);

  function addIngredient() { setIngredients((p) => [...p, { name: '', quantity: '', unit: '' }]); }
  function addStep() { setInstructions((p) => [...p, { step: p.length + 1, text: '' }]); }
  function updateIngredient(i: number, f: keyof Ingredient, v: string) {
    setIngredients((p) => p.map((ing, idx) => idx === i ? { ...ing, [f]: v } : ing));
  }
  function updateStep(i: number, text: string) {
    setInstructions((p) => p.map((s, idx) => idx === i ? { ...s, text } : s));
  }
  function removeIngredient(i: number) { setIngredients((p) => p.filter((_, idx) => idx !== i)); }
  function removeStep(i: number) { setInstructions((p) => p.filter((_, idx) => idx !== i).map((s, idx) => ({ ...s, step: idx + 1 }))); }
  function toggleFlag(f: string) { setSelectedFlags((p) => p.includes(f) ? p.filter((x) => x !== f) : [...p, f]); }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const g = (k: string) => String(form.get(k) ?? '').trim() || null;
    const payload = {
      name: g('name') ?? '',
      description: g('description'),
      category: g('category') ?? 'dinner',
      cuisine: g('cuisine'),
      servings: Number(form.get('servings') ?? 4),
      prep_time_mins: form.get('prep_time_mins') ? Number(form.get('prep_time_mins')) : null,
      cook_time_mins: form.get('cook_time_mins') ? Number(form.get('cook_time_mins')) : null,
      difficulty: g('difficulty') ?? 'medium',
      notes: g('notes'),
      source_url: g('source_url'),
      photo_url: g('photo_url'),
      ingredients: ingredients.filter((i) => i.name.trim()),
      instructions: instructions.filter((s) => s.text.trim()),
      allergy_flags: selectedFlags,
    };
    if (!payload.name) return toastError('Recipe name is required');
    setLoading(true);
    const supabase = createClient();
    const { error } = recipe
      ? await supabase.from('family_recipes').update(payload as never).eq('id', recipe.id)
      : await supabase.from('family_recipes').insert({ ...payload, family_id: familyId, created_by: userId } as never);
    setLoading(false);
    if (error) { toastError(describeDbError(error)); return; }
    success(recipe ? 'Recipe updated' : 'Recipe added');
    onSaved();
  }

  return (
    <Modal open onClose={onClose} title={recipe ? 'Edit Recipe' : 'New Recipe'}>
      <form onSubmit={onSubmit} className="max-h-[75vh] space-y-4 overflow-y-auto pr-1">
        <Field label="Recipe name" required>
          {(id) => <Input id={id} name="name" defaultValue={recipe?.name ?? ''} placeholder="Grandma's Spaghetti, Taco Tuesday…" autoFocus />}
        </Field>
        <Field label="Description">
          {(id) => <Textarea id={id} name="description" defaultValue={recipe?.description ?? ''} placeholder="A brief description of this dish…" className="min-h-[60px]" />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Category">
            {(id) => (
              <select id={id} name="category" defaultValue={recipe?.category ?? 'dinner'}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.emoji} {c.label}</option>)}
              </select>
            )}
          </Field>
          <Field label="Difficulty">
            {(id) => (
              <select id={id} name="difficulty" defaultValue={recipe?.difficulty ?? 'medium'}
                className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2.5 text-sm focus:border-brand/50 focus:outline-none">
                {DIFFICULTIES.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
              </select>
            )}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Servings">
            {(id) => <Input id={id} name="servings" type="number" min={1} defaultValue={recipe?.servings ?? 4} />}
          </Field>
          <Field label="Prep time (min)">
            {(id) => <Input id={id} name="prep_time_mins" type="number" min={0} defaultValue={recipe?.prep_time_mins ?? ''} placeholder="15" />}
          </Field>
          <Field label="Cook time (min)">
            {(id) => <Input id={id} name="cook_time_mins" type="number" min={0} defaultValue={recipe?.cook_time_mins ?? ''} placeholder="30" />}
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Cuisine">
            {(id) => <Input id={id} name="cuisine" defaultValue={recipe?.cuisine ?? ''} placeholder="Italian, Mexican, American…" />}
          </Field>
          <Field label="Photo URL">
            {(id) => <Input id={id} name="photo_url" defaultValue={recipe?.photo_url ?? ''} placeholder="https://…" />}
          </Field>
        </div>

        {/* Ingredients */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium">Ingredients</label>
            <button type="button" onClick={addIngredient} className="text-xs text-brand-text hover:underline">+ Add ingredient</button>
          </div>
          <div className="space-y-2">
            {ingredients.map((ing, i) => (
              <div key={i} className="flex gap-2">
                <Input value={ing.quantity} onChange={(e) => updateIngredient(i, 'quantity', e.target.value)} placeholder="2" className="w-16 flex-shrink-0" />
                <Input value={ing.unit} onChange={(e) => updateIngredient(i, 'unit', e.target.value)} placeholder="cups" className="w-20 flex-shrink-0" />
                <Input value={ing.name} onChange={(e) => updateIngredient(i, 'name', e.target.value)} placeholder="Ingredient name" className="flex-1" />
                <button type="button" onClick={() => removeIngredient(i)} className="rounded-lg p-2 text-muted hover:text-danger"><X className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        </div>

        {/* Instructions */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <label className="text-sm font-medium">Instructions</label>
            <button type="button" onClick={addStep} className="text-xs text-brand-text hover:underline">+ Add step</button>
          </div>
          <div className="space-y-2">
            {instructions.map((step, i) => (
              <div key={i} className="flex gap-3">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-brand text-xs font-bold text-brand-fg">
                  {step.step}
                </div>
                <Textarea value={step.text} onChange={(e) => updateStep(i, e.target.value)}
                  placeholder={`Step ${step.step}…`} className="flex-1 min-h-[60px]" />
                <button type="button" onClick={() => removeStep(i)} className="rounded-lg p-2 text-muted hover:text-danger self-start"><X className="h-4 w-4" /></button>
              </div>
            ))}
          </div>
        </div>

        {/* Allergy flags */}
        <div>
          <label className="mb-2 block text-sm font-medium">Dietary flags</label>
          <div className="flex flex-wrap gap-2">
            {ALLERGY_FLAGS.map((f) => (
              <button key={f} type="button" onClick={() => toggleFlag(f)}
                className={cn('rounded-lg border px-2.5 py-1 text-xs font-medium transition',
                  selectedFlags.includes(f) ? 'border-success/60 bg-success/10 text-success' : 'border-border hover:bg-elevated')}>
                {selectedFlags.includes(f) && <Check className="mr-1 inline h-3 w-3" />}
                {f}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Notes">
            {(id) => <Textarea id={id} name="notes" defaultValue={recipe?.notes ?? ''} placeholder="Chef's tips, substitutions…" className="min-h-[60px]" />}
          </Field>
          <Field label="Source URL">
            {(id) => <Input id={id} name="source_url" defaultValue={recipe?.source_url ?? ''} placeholder="https://…" />}
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{recipe ? 'Save Recipe' : 'Add Recipe'}</Button>
        </div>
      </form>
    </Modal>
  );
}
