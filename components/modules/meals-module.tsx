'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Settings, Check, X as XIcon } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { LoadingBlock, ErrorState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { Tables, MealType } from '@/lib/database.types';

type Meal = Tables<'meals'>;
type Plan = Tables<'meal_plans'> & { meal: Meal | null };

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_LABELS: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks' };
const MEAL_ICONS: Record<MealType, string> = { breakfast: '🌅', lunch: '🥗', dinner: '🍽️', snack: '🍎' };

const MEAL_IDEAS = [
  { label: 'High Protein Meals', emoji: '💪' },
  { label: 'Quick & Easy Dinners', emoji: '⚡' },
  { label: 'Kid Approved Favorites', emoji: '👦' },
];

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

export function MealsModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const [weekOffset, setWeekOffset] = useState(0);
  const [library, setLibrary] = useState<Meal[]>([]);
  const [addCell, setAddCell] = useState<{ date: string; type: MealType } | null>(null);
  const [newMealOpen, setNewMealOpen] = useState(false);

  const monday = useMemo(() => weekStart(weekOffset), [weekOffset]);
  const days = useMemo(() => daysOfWeek(monday), [monday]);

  useEffect(() => {
    createClient().from('meals').select('*').eq('family_id', familyId).order('name')
      .then(({ data }) => setLibrary(data ?? []));
  }, [familyId]);

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

  // Build cell lookup: date+type → plan
  const cellKey = (date: string, type: MealType) => `${date}__${type}`;
  const planMap = useMemo(() => {
    const m = new Map<string, Plan>();
    for (const p of plans) m.set(cellKey(p.plan_date, p.meal_type), p);
    return m;
  }, [plans]);

  async function removePlan(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('meal_plans').delete().eq('id', id);
    if (error) return toastError(error.message);
    void refresh();
  }

  async function addFromLibrary(mealId: string, date: string, mealType: MealType) {
    const supabase = createClient();
    const { error } = await supabase.from('meal_plans').insert({ family_id: familyId, meal_id: mealId, plan_date: date, meal_type: mealType, created_by: userId });
    if (error) return toastError(error.message);
    setAddCell(null); void refresh();
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const dateRange = `${days[0].toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${days[6].toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="module-with-sidebar">
      {/* Main */}
      <div className="module-main overflow-y-auto">
        {/* Header */}
        <div className="flex-shrink-0 border-b border-border px-5 py-4">
          <PageHeader
            title="Meals"
            description="Plan, organize, and enjoy healthy meals together."
            action={
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm">
                  <Settings className="h-4 w-4" /> Plan Settings
                </Button>
                <Button size="sm" onClick={() => setNewMealOpen(true)}>
                  <Plus className="h-4 w-4" /> Add Meal
                </Button>
              </div>
            }
          />

          {/* Tab strip */}
          <div className="tab-bar mt-4">
            {['Meal Plan', 'Recipes', 'Favorites'].map((t, i) => (
              <button key={t} className={cn('tab-item', i === 0 ? 'tab-item-active' : 'tab-item-inactive')}>
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Week navigator */}
        <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <button onClick={() => setWeekOffset(w => w - 1)} className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => setWeekOffset(w => w + 1)} className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronRight className="h-4 w-4" /></button>
          <span className="flex items-center gap-2 text-sm font-semibold">
            📅 {dateRange}
          </span>
          <div className="ml-auto flex items-center gap-1 rounded-lg border border-border bg-surface/40 p-0.5">
            {['Week', 'Month'].map((v, i) => (
              <button key={v} className={cn('rounded-md px-3 py-1 text-xs font-medium capitalize transition', i === 0 ? 'bg-brand text-brand-fg' : 'text-muted hover:text-fg')}>{v}</button>
            ))}
          </div>
          <Button variant="outline" size="sm" className="hidden sm:inline-flex">Filters</Button>
        </div>

        {/* Week meal grid — desktop */}
        <div className="hidden flex-1 px-5 py-4 md:block">
          <div className="overflow-hidden rounded-xl border border-border">
            {/* Day headers */}
            <div className="grid border-b border-border bg-surface/40" style={{ gridTemplateColumns: '100px repeat(7, 1fr)' }}>
              <div className="px-3 py-2" />
              {days.map((d, i) => {
                const dStr = d.toISOString().slice(0, 10);
                const isToday = dStr === todayStr;
                return (
                  <div key={i} className="border-l border-border px-2 py-2 text-center">
                    <div className={cn('text-[10px] font-semibold uppercase tracking-wide', isToday ? 'text-brand' : 'text-muted')}>
                      {d.toLocaleDateString('en-US', { weekday: 'short' })}
                    </div>
                    <div className={cn('text-xs font-bold', isToday ? 'text-brand' : 'text-fg')}>
                      {d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Meal type rows */}
            {MEAL_TYPES.map((type, ti) => (
              <div key={type} className={cn('grid', ti < MEAL_TYPES.length - 1 && 'border-b border-border')} style={{ gridTemplateColumns: '100px repeat(7, 1fr)' }}>
                {/* Row label */}
                <div className="flex flex-col items-center justify-center border-r border-border px-2 py-3">
                  <span className="text-lg">{MEAL_ICONS[type]}</span>
                  <span className="text-[10px] font-semibold text-muted">{MEAL_LABELS[type]}</span>
                </div>

                {/* Day cells */}
                {days.map((d, di) => {
                  const dStr = d.toISOString().slice(0, 10);
                  const plan = planMap.get(cellKey(dStr, type));
                  const isToday = dStr === todayStr;
                  return (
                    <div key={di}
                      className={cn('group relative border-l border-border px-2 py-2 min-h-[80px] transition', isToday && 'bg-brand/5', !plan && 'hover:bg-elevated/30 cursor-pointer')}
                      onClick={() => !plan && setAddCell({ date: dStr, type })}>
                      {plan ? (
                        <div className="relative">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-elevated text-xl mx-auto mb-1">
                            {MEAL_ICONS[type]}
                          </div>
                          <div className="text-center text-[10px] font-medium leading-tight">{plan.meal?.name ?? 'Meal'}</div>
                          <button onClick={(e) => { e.stopPropagation(); removePlan(plan.id); }}
                            className="absolute -right-1 -top-1 hidden rounded-full bg-danger p-0.5 group-hover:flex">
                            <XIcon className="h-2.5 w-2.5 text-brand-fg" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center opacity-0 group-hover:opacity-100 transition">
                          <Plus className="h-4 w-4 text-muted" />
                          <span className="text-[9px] text-muted mt-0.5">Add meal</span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="mt-3 flex justify-end">
            <button className="text-xs text-brand hover:underline">Edit Meal Plan ✏️</button>
          </div>
        </div>

        {/* Week meal grid — mobile (stacked day-by-day) */}
        <div className="flex-1 space-y-3 px-4 py-4 md:hidden">
          {days.map((d, di) => {
            const dStr = d.toISOString().slice(0, 10);
            const isToday = dStr === todayStr;
            return (
              <div key={di} className={cn('overflow-hidden rounded-xl border border-border', isToday && 'border-brand/40')}>
                <div className={cn('flex items-center gap-2 border-b border-border px-3 py-2', isToday ? 'bg-brand/10' : 'bg-surface/40')}>
                  <span className={cn('text-sm font-semibold', isToday ? 'text-brand' : 'text-fg')}>
                    {d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </span>
                  {isToday && <span className="rounded-full bg-brand/20 px-2 py-0.5 text-[10px] font-semibold text-brand">Today</span>}
                </div>
                <div className="divide-y divide-border/50">
                  {MEAL_TYPES.map(type => {
                    const plan = planMap.get(cellKey(dStr, type));
                    return (
                      <div key={type}
                        className={cn('flex items-center gap-3 px-3 py-2.5', !plan && 'cursor-pointer hover:bg-elevated/30')}
                        onClick={() => !plan && setAddCell({ date: dStr, type })}>
                        <span className="text-base">{MEAL_ICONS[type]}</span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[10px] font-semibold uppercase text-muted">{MEAL_LABELS[type]}</div>
                          {plan ? (
                            <div className="text-sm font-medium">{plan.meal?.name ?? 'Meal'}</div>
                          ) : (
                            <div className="text-xs text-muted">Tap to add</div>
                          )}
                        </div>
                        {plan ? (
                          <button onClick={(e) => { e.stopPropagation(); removePlan(plan.id); }}
                            className="rounded-full p-1 text-muted hover:text-danger transition">
                            <XIcon className="h-3.5 w-3.5" />
                          </button>
                        ) : (
                          <Plus className="h-4 w-4 text-muted" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Meal Library */}
        <div className="flex-shrink-0 border-t border-border px-5 py-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-base font-semibold">Your Meal Library</h2>
            <button onClick={() => setNewMealOpen(true)} className="text-xs text-brand hover:underline">+ Add meal</button>
          </div>
          {library.length > 0 ? (
            <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
              {library.slice(0, 10).map((m) => (
                <div key={m.id} className="group cursor-pointer rounded-xl border border-border bg-surface/40 p-3 transition hover:bg-elevated/40">
                  <div className="mb-2 flex h-16 items-center justify-center rounded-lg bg-elevated text-3xl">{MEAL_ICONS[m.meal_type]}</div>
                  <div className="text-xs font-semibold leading-snug">{m.name}</div>
                  <div className="mt-1.5 text-[10px] text-muted capitalize">{m.meal_type}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center py-8 text-center">
              <p className="text-sm text-muted">No meals in your library yet</p>
              <button onClick={() => setNewMealOpen(true)} className="mt-2 text-xs font-semibold text-brand">Add your first meal →</button>
            </div>
          )}
        </div>
      </div>

      {/* Right sidebar */}
      <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
        {/* Shopping List */}
        <div className="sidebar-card">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">Shopping List</p>
            <span className="rounded-full bg-brand/20 px-2 py-0.5 text-[10px] font-semibold text-brand">14 items</span>
          </div>
          <div className="space-y-1.5">
            {['Chicken Breast', 'Salmon Fillets', 'Eggs', 'Avocados', 'Spinach', 'Tomatoes', 'Bananas', 'Greek Yogurt'].map((item, i) => (
              <label key={item} className="flex items-center gap-2 cursor-pointer group">
                <div className={cn('flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border', [2, 3, 6].includes(i) ? 'bg-brand border-brand' : 'border-border group-hover:border-brand/50')}>
                  {[2, 3, 6].includes(i) && <Check className="h-2.5 w-2.5 text-brand-fg" />}
                </div>
                <span className={cn('text-xs', [2, 3, 6].includes(i) ? 'text-muted line-through' : 'text-fg')}>{item}</span>
              </label>
            ))}
          </div>
          <button className="mt-3 text-xs text-brand hover:underline">View full list →</button>
        </div>

        {/* Nutrition Summary */}
        <div className="sidebar-card">
          <div className="mb-3 flex items-center justify-between">
            <p className="text-sm font-semibold">Nutrition Summary</p>
            <span className="text-[10px] text-muted">This Week</span>
          </div>
          <div className="flex items-center gap-3">
            <svg width="70" height="70" viewBox="0 0 70 70">
              <circle cx="35" cy="35" r="28" fill="none" stroke="#1e2d40" strokeWidth="8" />
              <circle cx="35" cy="35" r="28" fill="none" stroke="#7c5dff" strokeWidth="8" strokeDasharray="79 176" strokeDashoffset="70" style={{ transform: 'rotate(-90deg)', transformOrigin: '35px 35px' }} />
              <circle cx="35" cy="35" r="28" fill="none" stroke="#22c55e" strokeWidth="8" strokeDasharray="53 176" strokeDashoffset="-9" style={{ transform: 'rotate(-90deg)', transformOrigin: '35px 35px' }} />
              <circle cx="35" cy="35" r="28" fill="none" stroke="#f59e0b" strokeWidth="8" strokeDasharray="44 176" strokeDashoffset="-62" style={{ transform: 'rotate(-90deg)', transformOrigin: '35px 35px' }} />
              <text x="35" y="33" textAnchor="middle" fill="white" fontSize="11" fontWeight="bold">1,856</text>
              <text x="35" y="43" textAnchor="middle" fill="#94a0b8" fontSize="7">Total Cal</text>
            </svg>
            <div className="space-y-1.5 text-xs">
              {[{ label: 'Carbs', pct: 45, color: '#7c5dff' }, { label: 'Protein', pct: 30, color: '#22c55e' }, { label: 'Fat', pct: 25, color: '#f59e0b' }].map(n => (
                <div key={n.label} className="flex items-center gap-2">
                  <div className="h-2 w-2 rounded-full" style={{ background: n.color }} />
                  <span className="text-muted">{n.label}</span>
                  <span className="ml-auto font-semibold">{n.pct}%</span>
                </div>
              ))}
            </div>
          </div>
          <button className="mt-3 text-xs text-brand hover:underline">View full nutrition →</button>
        </div>

        {/* Meal Ideas */}
        <div className="sidebar-card">
          <p className="mb-3 text-sm font-semibold">Meal Ideas For You</p>
          <div className="space-y-2">
            {MEAL_IDEAS.map(idea => (
              <div key={idea.label} className="flex items-center gap-2.5 rounded-lg border border-border/50 bg-surface/60 px-3 py-2 cursor-pointer hover:bg-elevated transition">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand/20 text-base">{idea.emoji}</div>
                <span className="flex-1 text-xs font-medium">{idea.label}</span>
                <ChevronLeft className="h-3.5 w-3.5 rotate-180 text-muted" />
              </div>
            ))}
          </div>
          <button className="mt-3 text-xs text-brand hover:underline">Explore more ideas →</button>
        </div>
      </div>

      {/* Add meal cell picker */}
      {addCell && (
        <Modal open title={`Add ${MEAL_LABELS[addCell.type]}`} onClose={() => setAddCell(null)}>
          <div className="space-y-3">
            <p className="text-xs text-muted">For {new Date(addCell.date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            {library.filter(m => m.meal_type === addCell.type || true).length === 0 ? (
              <p className="text-sm text-muted">No meals in library yet. Add a meal first.</p>
            ) : (
              <div className="max-h-60 overflow-y-auto space-y-1.5">
                {library.map(m => (
                  <button key={m.id} onClick={() => addFromLibrary(m.id, addCell.date, addCell.type)}
                    className="flex w-full items-center gap-2.5 rounded-lg border border-border bg-surface/40 px-3 py-2.5 text-left hover:bg-elevated transition">
                    <span className="text-base">{MEAL_ICONS[m.meal_type]}</span>
                    <div>
                      <div className="text-sm font-medium">{m.name}</div>
                      <div className="text-[10px] capitalize text-muted">{m.meal_type}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            <button onClick={() => { setAddCell(null); setNewMealOpen(true); }} className="w-full rounded-lg border border-dashed border-border py-2 text-xs text-muted hover:border-brand/50 hover:text-brand transition">
              + Create new meal
            </button>
          </div>
        </Modal>
      )}

      {newMealOpen && (
        <NewMealModal familyId={familyId} userId={userId} onClose={() => setNewMealOpen(false)}
          onSaved={() => { setNewMealOpen(false); createClient().from('meals').select('*').eq('family_id', familyId).order('name').then(({ data }) => setLibrary(data ?? [])); }} />
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
    if (!name) return toastError('Name required');
    setLoading(true);
    const { error } = await createClient().from('meals').insert({ family_id: familyId, name, meal_type, ingredients: [], created_by: userId });
    setLoading(false);
    if (error) return toastError(error.message);
    onSaved();
  }

  return (
    <Modal open title="Add Meal" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Meal name" required>{(id) => <Input id={id} name="name" autoFocus placeholder="Lemon Garlic Chicken" />}</Field>
        <Field label="Type">
          {(id) => <Select id={id} name="meal_type">{MEAL_TYPES.map(t => <option key={t} value={t}>{MEAL_LABELS[t]}</option>)}</Select>}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" type="button" onClick={onClose} size="sm">Cancel</Button>
          <Button type="submit" disabled={loading} loading={loading} size="sm">
            {loading ? 'Saving…' : 'Add Meal'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
