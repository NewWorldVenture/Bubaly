'use client';

import { useEffect, useMemo, useState } from 'react';
import { UtensilsCrossed, Plus, Trash2, BookOpen } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { LoadingBlock, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';

type Meal = Tables<'meals'>;
type Plan = Tables<'meal_plans'> & { meal: Meal | null };

function weekDays(): { date: string; label: string }[] {
  const now = new Date();
  const day = (now.getDay() + 6) % 7;
  const monday = new Date(now); monday.setDate(now.getDate() - day); monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    return { date: d.toISOString().slice(0, 10), label: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }) };
  });
}

export function MealsModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();
  const days = useMemo(weekDays, []);
  const [library, setLibrary] = useState<Meal[]>([]);
  const [planFor, setPlanFor] = useState<string | null>(null);
  const [showMeal, setShowMeal] = useState(false);

  const loadLibrary = async () => {
    const supabase = createClient();
    const { data } = await supabase.from('meals').select('*').eq('family_id', familyId).order('name');
    setLibrary(data ?? []);
  };
  useEffect(() => { void loadLibrary(); }, [familyId]); // eslint-disable-line react-hooks/exhaustive-deps

  const { data: plans, loading, error, refresh } = useRealtimeQuery<Plan>({
    table: 'meal_plans',
    familyId,
    deps: [familyId, days[0].date],
    fetcher: async (supabase) => {
      const { data, error } = await supabase.from('meal_plans').select('*').eq('family_id', familyId)
        .gte('plan_date', days[0].date).lte('plan_date', days[6].date);
      if (error) return { data: null, error };
      const ids = [...new Set(data.map((p) => p.meal_id).filter((x): x is string => !!x))];
      const { data: meals } = ids.length ? await supabase.from('meals').select('*').in('id', ids) : { data: [] as Meal[] };
      const byId = new Map((meals ?? []).map((m) => [m.id, m]));
      return { data: data.map((p) => ({ ...p, meal: byId.get(p.meal_id ?? '') ?? null })), error: null };
    },
  });

  const plansByDay = useMemo(() => {
    const map = new Map<string, Plan[]>();
    for (const p of plans) {
      if (!map.has(p.plan_date)) map.set(p.plan_date, []);
      map.get(p.plan_date)!.push(p);
    }
    return map;
  }, [plans]);

  async function planExisting(date: string, mealId: string, mealType: string) {
    const supabase = createClient();
    const { error } = await supabase.from('meal_plans').insert({
      family_id: familyId, created_by: userId, meal_id: mealId, plan_date: date, meal_type: mealType as Plan['meal_type'],
    });
    if (error) return toastError(error.message);
    setPlanFor(null);
    success('Meal planned');
    void refresh();
  }

  async function removePlan(id: string) {
    const supabase = createClient();
    await supabase.from('meal_plans').delete().eq('id', id);
    void refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Meals"
        description="Plan the week — then build your grocery list from it."
        action={<Button variant="secondary" onClick={() => setShowMeal(true)}><BookOpen className="h-4 w-4" /> New recipe</Button>}
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {days.map((d) => {
          const dayPlans = plansByDay.get(d.date) ?? [];
          return (
            <Card key={d.date} className="flex flex-col">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-sm font-semibold">{d.label}</h3>
                <button onClick={() => setPlanFor(d.date)} className="rounded-lg p-1 text-muted hover:text-brand" aria-label="Plan meal">
                  <Plus className="h-4 w-4" />
                </button>
              </div>
              {dayPlans.length === 0 ? (
                <button onClick={() => setPlanFor(d.date)} className="rounded-lg border border-dashed border-border py-3 text-xs text-muted hover:text-fg">
                  Plan a meal
                </button>
              ) : (
                <ul className="space-y-1.5">
                  {dayPlans.map((p) => (
                    <li key={p.id} className="group flex items-center justify-between gap-2 rounded-lg bg-surface/50 px-2 py-1.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium">{p.meal?.name ?? 'Meal'}</p>
                        <span className="text-[10px] uppercase tracking-wide text-muted">{p.meal_type}</span>
                      </div>
                      <button onClick={() => removePlan(p.id)} className="text-muted opacity-0 group-hover:opacity-100 hover:text-danger" aria-label="Remove">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <UtensilsCrossed className="h-5 w-5 text-brand" />
          <h2 className="text-base font-semibold">Recipe library <span className="text-muted">({library.length})</span></h2>
        </div>
        {library.length === 0 ? (
          <p className="text-sm text-muted">No saved recipes yet. Add one to plan it through the week.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {library.map((m) => {
              const ings = Array.isArray(m.ingredients) ? m.ingredients.length : 0;
              return (
                <div key={m.id} className="rounded-xl border border-border bg-surface/50 px-3 py-2">
                  <p className="text-sm font-medium">{m.name}</p>
                  <p className="text-xs text-muted">{m.meal_type}{ings ? ` · ${ings} ingredients` : ''}</p>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {planFor && (
        <PlanModal
          date={planFor}
          library={library}
          onClose={() => setPlanFor(null)}
          onPick={(mealId, type) => planExisting(planFor, mealId, type)}
          onCreateRecipe={() => { setPlanFor(null); setShowMeal(true); }}
        />
      )}
      {showMeal && (
        <NewMealModal
          familyId={familyId} userId={userId}
          onClose={() => setShowMeal(false)}
          onCreated={async () => { setShowMeal(false); await loadLibrary(); }}
        />
      )}
    </div>
  );
}

function PlanModal({ date, library, onClose, onPick, onCreateRecipe }: {
  date: string; library: Meal[]; onClose: () => void;
  onPick: (mealId: string, type: string) => void; onCreateRecipe: () => void;
}) {
  const [type, setType] = useState('dinner');
  return (
    <Modal open onClose={onClose} title={`Plan a meal — ${fmtDate(date, 'EEE, MMM d')}`}>
      <div className="space-y-4">
        <Field label="Meal">{(id) => (
          <Select id={id} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="breakfast">Breakfast</option>
            <option value="lunch">Lunch</option>
            <option value="dinner">Dinner</option>
            <option value="snack">Snack</option>
          </Select>
        )}</Field>
        {library.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-4 text-center text-sm text-muted">
            No recipes yet. <button onClick={onCreateRecipe} className="font-medium text-brand hover:underline">Create one</button>.
          </div>
        ) : (
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {library.map((m) => (
              <button key={m.id} onClick={() => onPick(m.id, type)} className="flex w-full items-center justify-between rounded-lg border border-border bg-surface/50 px-3 py-2 text-left text-sm hover:border-brand">
                <span>{m.name}</span>
                <Badge tone="neutral">{m.meal_type}</Badge>
              </button>
            ))}
          </div>
        )}
        <button onClick={onCreateRecipe} className="text-sm font-medium text-brand hover:underline">+ New recipe</button>
      </div>
    </Modal>
  );
}

function NewMealModal({ familyId, userId, onClose, onCreated }: {
  familyId: string; userId: string; onClose: () => void; onCreated: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const name = String(fd.get('name') ?? '').trim();
    if (!name) return toastError('Name is required');
    const ingredients = String(fd.get('ingredients') ?? '')
      .split('\n').map((l) => l.trim()).filter(Boolean)
      .map((line) => { const [n, qty] = line.split('—').map((s) => s.trim()); return { name: n, qty: qty ?? '' }; });

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('meals').insert({
      family_id: familyId, created_by: userId, name,
      meal_type: String(fd.get('meal_type') ?? 'dinner') as Meal['meal_type'],
      ingredients,
    });
    setLoading(false);
    if (error) return toastError(error.message);
    success('Recipe saved');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title="New recipe">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Name" required>{(id) => <Input id={id} name="name" placeholder="Taco night" autoFocus />}</Field>
        <Field label="Type">{(id) => (
          <Select id={id} name="meal_type" defaultValue="dinner">
            <option value="breakfast">Breakfast</option><option value="lunch">Lunch</option>
            <option value="dinner">Dinner</option><option value="snack">Snack</option>
          </Select>
        )}</Field>
        <Field label="Ingredients" hint="One per line. Use “name — quantity”, e.g. Ground beef — 1 lb">
          {(id) => <Textarea id={id} name="ingredients" rows={5} placeholder={'Ground beef — 1 lb\nTortillas — 8\nCheese — 1 cup'} />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save recipe</Button>
        </div>
      </form>
    </Modal>
  );
}
