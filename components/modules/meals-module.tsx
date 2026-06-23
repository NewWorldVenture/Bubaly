'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, Plus, Check, X as XIcon, Sparkles, Vote, Activity } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { LoadingBlock, ErrorState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import {
  normalizeOptions, castVote, totalVotes, memberVote, votePercent, winnerLabel,
  type PollOption,
} from '@/lib/meals/voting';
import {
  NUTRIENT_LABELS, dailyValuePct, fmtAmount, type Nutrition,
} from '@/lib/meals/nutrition';
import type { Tables, MealType } from '@/lib/database.types';

type Meal = Tables<'meals'>;
type Plan = Tables<'meal_plans'> & { meal: Meal | null };
type GroceryItem = Tables<'grocery_items'>;

const MEAL_TYPES: MealType[] = ['breakfast', 'lunch', 'dinner', 'snack'];
const MEAL_LABELS: Record<MealType, string> = { breakfast: 'Breakfast', lunch: 'Lunch', dinner: 'Dinner', snack: 'Snacks' };
const MEAL_ICONS: Record<MealType, string> = { breakfast: '🌅', lunch: '🥗', dinner: '🍽️', snack: '🍎' };

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
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();
  const [weekOffset, setWeekOffset] = useState(0);
  const [library, setLibrary] = useState<Meal[]>([]);
  const [addCell, setAddCell] = useState<{ date: string; type: MealType } | null>(null);
  const [newMealOpen, setNewMealOpen] = useState(false);
  const [autoPlanOpen, setAutoPlanOpen] = useState(false);

  const monday = useMemo(() => weekStart(weekOffset), [weekOffset]);
  const days = useMemo(() => daysOfWeek(monday), [monday]);
  const weekStartStr = useMemo(() => monday.toISOString().slice(0, 10), [monday]);

  useEffect(() => {
    createClient().from('meals').select('*').eq('family_id', familyId).order('name')
      .then(({ data }) => setLibrary(data ?? []));
  }, [familyId]);

  const { data: plans, loading: plansLoading, error: plansError, refresh } = useRealtimeQuery<Plan>({
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
  const { data: groceryItems, loading: groceryLoading, error: groceryError } = useRealtimeQuery<GroceryItem>({
    table: 'grocery_items', familyId, deps: [familyId],
    fetcher: (supabase) => supabase.from('grocery_items').select('*').eq('family_id', familyId).order('created_at', { ascending: false }).limit(8),
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

  if (plansLoading || groceryLoading) return <LoadingBlock />;
  if (plansError || groceryError) return <ErrorState message={plansError || groceryError || 'Could not load meals'} onRetry={refresh} />;

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
                <Button size="sm" variant="outline" onClick={() => setAutoPlanOpen(true)}>
                  <Sparkles className="h-4 w-4" /> <span className="hidden sm:inline">Auto-plan week</span>
                </Button>
                <Button size="sm" onClick={() => setNewMealOpen(true)}>
                  <Plus className="h-4 w-4" /> Add Meal
                </Button>
              </div>
            }
          />

          {/* Tab strip */}
          <div className="tab-bar mt-4">
            <span className="tab-item tab-item-active">Meal Plan</span>
            <Link href="/dashboard/recipes" className="tab-item tab-item-inactive">Recipes</Link>
          </div>
        </div>

        {/* Week navigator */}
        <div className="flex flex-shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-3">
          <button onClick={() => setWeekOffset(w => w - 1)} className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronLeft className="h-4 w-4" /></button>
          <button onClick={() => setWeekOffset(w => w + 1)} className="rounded-lg p-1.5 hover:bg-elevated transition"><ChevronRight className="h-4 w-4" /></button>
          <span className="flex items-center gap-2 text-sm font-semibold">
            📅 {dateRange}
          </span>
          <span className="ml-auto rounded-md bg-brand px-3 py-1 text-xs font-medium text-brand-fg">Week</span>
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
            <span className="rounded-full bg-brand/20 px-2 py-0.5 text-[10px] font-semibold text-brand">{groceryItems.length} shown</span>
          </div>
          <div className="space-y-1.5">
            {groceryItems.map((item) => (
              <div key={item.id} className="flex items-center gap-2">
                <div className={cn('flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border', item.is_checked ? 'bg-brand border-brand' : 'border-border')}>
                  {item.is_checked && <Check className="h-2.5 w-2.5 text-brand-fg" />}
                </div>
                <span className={cn('text-xs', item.is_checked ? 'text-muted line-through' : 'text-fg')}>{item.name}</span>
              </div>
            ))}
            {groceryItems.length === 0 && <p className="text-xs text-muted">No grocery items saved.</p>}
          </div>
          <Link href="/dashboard/grocery" className="mt-3 inline-block text-xs text-brand hover:underline">View full list →</Link>
        </div>

        {/* Family meal vote */}
        <MealVotePanel familyId={familyId} userId={userId}
          memberId={selfMember?.id ?? null} library={library} />

        {/* Weekly nutrition */}
        <WeekNutritionPanel weekStart={weekStartStr} planCount={plans.length} />
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

      {autoPlanOpen && (
        <AutoPlanModal weekStart={weekStartStr} mealTypes={MEAL_TYPES}
          onClose={() => setAutoPlanOpen(false)}
          onPlanned={() => { setAutoPlanOpen(false); void refresh(); }} />
      )}
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
      description="Our planner fills the week from your saved meals & recipes, weighted by family votes, honoring your diet and using up food before it expires.">
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-sm font-medium">Which meals?</p>
          <div className="flex flex-wrap gap-2">
            {mealTypes.map((t) => (
              <button key={t} type="button" onClick={() => toggleType(t)}
                className={cn('rounded-lg border px-3 py-1.5 text-xs font-medium capitalize transition',
                  selected.includes(t) ? 'border-brand bg-brand/10 text-brand' : 'border-border hover:bg-elevated')}>
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

type MealPoll = Tables<'meal_polls'>;

/** Family Meal Voting — an open poll the whole family votes on (single choice). */
function MealVotePanel({ familyId, userId, memberId, library }: {
  familyId: string; userId: string; memberId: string | null; library: Meal[];
}) {
  const { success, error: toastError } = useToast();
  const [poll, setPoll] = useState<MealPoll | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    const { data } = await createClient().from('meal_polls').select('*')
      .eq('family_id', familyId).eq('status', 'open')
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    setPoll(data ?? null);
    setLoading(false);
  }, [familyId]);

  useEffect(() => { void load(); }, [load]);

  const options = useMemo(() => normalizeOptions(poll?.options), [poll]);

  async function vote(optionId: string) {
    if (!poll || !memberId) return toastError('Only family members can vote');
    const next = castVote(options, optionId, memberId);
    setPoll({ ...poll, options: next as unknown as MealPoll['options'] });   // optimistic
    const { error } = await createClient().from('meal_polls').update({ options: next as never }).eq('id', poll.id);
    if (error) { toastError(error.message); void load(); }
  }

  async function closePoll() {
    if (!poll) return;
    const win = winnerLabel(options);
    const { error } = await createClient().from('meal_polls')
      .update({ status: 'closed', winner_label: win }).eq('id', poll.id);
    if (error) return toastError(error.message);
    success(win ? `"${win}" wins! 🎉` : 'Poll closed');
    setPoll(null);
  }

  if (loading) return null;

  return (
    <div className="sidebar-card">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Vote className="h-4 w-4 text-brand" /> Family Vote</p>
        {poll && <span className="text-[10px] text-muted">{totalVotes(options)} vote{totalVotes(options) !== 1 ? 's' : ''}</span>}
      </div>

      {!poll ? (
        creating ? (
          <NewPollForm familyId={familyId} userId={userId} library={library}
            onCancel={() => setCreating(false)}
            onCreated={(p) => { setCreating(false); setPoll(p); }} />
        ) : (
          <div className="text-center">
            <p className="mb-2 text-xs text-muted">No active poll. Let the family pick what&apos;s for dinner.</p>
            <Button size="sm" variant="outline" onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> Start a poll</Button>
          </div>
        )
      ) : (
        <div className="space-y-2.5">
          <p className="text-sm font-medium">{poll.title}</p>
          {options.map((o) => {
            const pct = votePercent(options, o.id);
            const mine = memberId ? memberVote(options, memberId) === o.id : false;
            return (
              <button key={o.id} onClick={() => vote(o.id)}
                className={cn('relative w-full overflow-hidden rounded-lg border px-3 py-2 text-left transition',
                  mine ? 'border-brand bg-brand/5' : 'border-border hover:bg-elevated')}>
                <div className="absolute inset-y-0 left-0 bg-brand/10" style={{ width: `${pct}%` }} />
                <div className="relative flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{o.emoji ? `${o.emoji} ` : ''}{o.label}</span>
                  <span className="flex items-center gap-1.5 text-[10px] text-muted">
                    {o.voter_ids.length > 0 && <span>{o.voter_ids.length}</span>}
                    {mine && <Check className="h-3 w-3 text-brand" />}
                    <span>{pct}%</span>
                  </span>
                </div>
              </button>
            );
          })}
          <button onClick={closePoll} className="mt-1 w-full text-center text-[11px] text-muted hover:text-brand">Close poll &amp; pick the winner</button>
        </div>
      )}
    </div>
  );
}

function NewPollForm({ familyId, userId, library, onCancel, onCreated }: {
  familyId: string; userId: string; library: Meal[];
  onCancel: () => void; onCreated: (p: MealPoll) => void;
}) {
  const { error: toastError } = useToast();
  const [title, setTitle] = useState("What's for dinner?");
  const [picks, setPicks] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  function togglePick(id: string) {
    setPicks((p) => p.includes(id) ? p.filter((x) => x !== id) : p.length < 6 ? [...p, id] : p);
  }

  async function create() {
    const opts: PollOption[] = picks.map((id) => {
      const m = library.find((x) => x.id === id);
      return { id: `meal_${id.slice(0, 8)}`, label: m?.name ?? 'Meal', meal_id: id, emoji: MEAL_ICONS[m?.meal_type ?? 'dinner'], voter_ids: [] };
    });
    if (opts.length < 2) return toastError('Pick at least two meals to vote on');
    setSaving(true);
    const { data, error } = await createClient().from('meal_polls')
      .insert({ family_id: familyId, title: title.trim() || "What's for dinner?", options: opts as never, created_by: userId })
      .select('*').single();
    setSaving(false);
    if (error || !data) return toastError(error?.message ?? 'Could not create poll');
    onCreated(data);
  }

  return (
    <div className="space-y-3">
      <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Poll question" />
      {library.length < 2 ? (
        <p className="text-xs text-muted">Add at least two meals to your library first.</p>
      ) : (
        <div className="max-h-40 space-y-1 overflow-y-auto">
          {library.map((m) => (
            <button key={m.id} onClick={() => togglePick(m.id)}
              className={cn('flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition',
                picks.includes(m.id) ? 'border-brand bg-brand/10' : 'border-border hover:bg-elevated')}>
              <span>{MEAL_ICONS[m.meal_type]}</span>
              <span className="flex-1 truncate">{m.name}</span>
              {picks.includes(m.id) && <Check className="h-3 w-3 text-brand" />}
            </button>
          ))}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button size="sm" loading={saving} onClick={create} disabled={picks.length < 2}>Start vote</Button>
      </div>
    </div>
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

  // Reset when the week changes so stale numbers never show for the wrong week.
  useEffect(() => { setData(null); setCached(false); }, [weekStart]);

  return (
    <div className="sidebar-card">
      <div className="mb-3 flex items-center justify-between">
        <p className="flex items-center gap-1.5 text-sm font-semibold"><Activity className="h-4 w-4 text-success" /> Nutrition</p>
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
          <button onClick={() => analyze(true)} className="w-full pt-1 text-center text-[11px] text-muted hover:text-brand" disabled={loading}>
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
