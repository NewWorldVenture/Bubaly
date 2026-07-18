'use client';

// Smart Kitchen Dashboard — the unifying surface of the Family Food OS.
// One tablet-first screen: tonight's dinner, the Family Food Health Score,
// expiring food + leftover intelligence, a grocery snapshot, upcoming meals,
// and the conversational AI Family Chef. Everything is wired to existing food
// data; the Chef and Score tie it all together.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  ChefHat, UtensilsCrossed, Sparkles, Flame, ShoppingCart, Soup, Snowflake, Trash2,
  Plus, Loader2, CalendarDays, TrendingUp, Apple, CheckCircle2, X, Send, Refrigerator,
} from 'lucide-react';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Field, Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils/cn';
import { progressBarA11y } from '@/lib/ui/a11y';
import { expiryStatus } from '@/lib/pantry/logic';
import { leftoverUrgency } from '@/lib/food/leftovers';
import type { FoodScore } from '@/lib/food/score';
import type { ChefReply } from '@/lib/food/chef';
import {
  addLeftoverAction, updateLeftoverStatusAction, deleteLeftoverAction, snapshotFoodScoreAction,
} from '@/app/(app)/dashboard/kitchen/actions';

export type KitchenData = {
  tonight: string | null;
  upcoming: { date: string; mealType: string; dish: string }[];
  pantrySummary: { total: number; expiringSoon: number; expired: number; lowStock: number };
  expiring: { name: string; expires_at: string | null }[];
  leftovers: { id: string; name: string; sourceMeal: string | null; useBy: string | null; location: string }[];
  leftoverNudge: string | null;
  leftoversMissing: boolean;
  groceryOpen: number;
  recipeCount: number;
  foodScore: FoodScore;
};

const TONE: Record<string, string> = {
  danger: 'text-rose-500', warning: 'text-amber-500', caution: 'text-yellow-500', success: 'text-emerald-500', neutral: 'text-muted',
};

function scoreColor(n: number): string {
  if (n >= 85) return 'text-emerald-500';
  if (n >= 70) return 'text-brand-text';
  if (n >= 55) return 'text-amber-500';
  return 'text-rose-500';
}
function scoreRing(n: number): string {
  if (n >= 85) return '#10b981';
  if (n >= 70) return '#6366f1';
  if (n >= 55) return '#f59e0b';
  return '#f43f5e';
}

export function KitchenDashboard({ data }: { data: KitchenData }) {
  const [addingLeftover, setAddingLeftover] = useState(false);
  const [chefOpen, setChefOpen] = useState(false);

  return (
    <div className="module-page">
      <PageHeader
        title="Smart Kitchen"
        description="Your family's food, all in one place — tonight's plan, what's expiring, and your AI Chef."
        action={<Button onClick={() => setChefOpen(true)}><ChefHat className="h-4 w-4" /> Ask the Chef</Button>}
      />

      {/* Hero row: tonight + food score */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {/* Tonight */}
        <div className="lg:col-span-2 overflow-hidden rounded-3xl border border-brand/20 bg-gradient-to-br from-brand/10 via-brand/5 to-transparent p-6">
          <div className="flex items-start justify-between">
            <div>
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-brand-text/70">
                <Flame className="h-3.5 w-3.5" /> Tonight&apos;s dinner
              </p>
              <p className="mt-2 text-3xl font-black tracking-tight">{data.tonight ?? 'Nothing planned yet'}</p>
              {data.leftoverNudge && (
                <p className="mt-2 flex items-center gap-1.5 text-sm text-amber-600"><Soup className="h-4 w-4" /> {data.leftoverNudge}</p>
              )}
            </div>
            <div className="hidden h-14 w-14 flex-shrink-0 place-items-center rounded-2xl bg-brand/15 sm:grid">
              <UtensilsCrossed className="h-7 w-7 text-brand-text" />
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {!data.tonight && (
              <Button size="sm" onClick={() => setChefOpen(true)}><Sparkles className="h-4 w-4" /> Plan with AI Chef</Button>
            )}
            <Link href="/dashboard/meals" className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium hover:bg-elevated transition">
              <CalendarDays className="h-4 w-4" /> Meal plan
            </Link>
            <Link href="/dashboard/grocery" className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium hover:bg-elevated transition">
              <ShoppingCart className="h-4 w-4" /> Grocery {data.groceryOpen > 0 && <span className="rounded-full bg-brand/15 px-1.5 text-xs font-bold text-brand-text">{data.groceryOpen}</span>}
            </Link>
            <Link href="/dashboard/fridge-chef" className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium hover:bg-elevated transition">
              <Refrigerator className="h-4 w-4" /> Fridge Chef
            </Link>
          </div>
        </div>

        {/* Food score */}
        <FoodScoreCard score={data.foodScore} />
      </div>

      {/* Upcoming meals */}
      {data.upcoming.length > 0 && (
        <section className="mt-6">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
            <CalendarDays className="h-4 w-4" /> This week
          </h2>
          <div className="flex gap-2 overflow-x-auto pb-1 no-scrollbar">
            {data.upcoming.map((m, i) => (
              <div key={i} className="min-w-[140px] flex-shrink-0 rounded-2xl border border-border bg-surface/40 p-3">
                <p className="text-[11px] font-semibold uppercase text-muted">
                  {new Date(m.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short' })} · {m.mealType}
                </p>
                <p className="mt-1 text-sm font-medium leading-tight">{m.dish}</p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Expiring + leftovers */}
      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Expiring food */}
        <section className="rounded-2xl border border-border bg-surface/40 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
              <Apple className="h-4 w-4" /> Use it up
            </h2>
            <Link href="/dashboard/pantry" className="text-xs font-semibold text-brand-text hover:underline">Pantry →</Link>
          </div>
          {data.expiring.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted">Nothing expiring soon. 👍</p>
          ) : (
            <div className="space-y-1.5">
              {data.expiring.map((e, i) => {
                const st = expiryStatus(e.expires_at);
                return (
                  <div key={i} className="flex items-center justify-between rounded-xl border border-border bg-bg/40 px-3 py-2">
                    <span className="text-sm font-medium">{e.name}</span>
                    <span className={cn('text-xs font-semibold', TONE[st.tone])}>{st.label}</span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Leftover intelligence */}
        <LeftoverSection data={data} onAdd={() => setAddingLeftover(true)} />
      </div>

      {addingLeftover && <AddLeftoverModal onClose={() => setAddingLeftover(false)} />}
      {chefOpen && <ChefModal onClose={() => setChefOpen(false)} />}
    </div>
  );
}

// ─── Food Score Card ──────────────────────────────────────────────────────────

function FoodScoreCard({ score }: { score: FoodScore }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const pct = score.overall;
  const circumference = 2 * Math.PI * 42;

  async function save() {
    setSaving(true);
    const res = await snapshotFoodScoreAction({
      overall: score.overall, grade: score.grade, subScores: score.subScores, coaching: score.coaching,
    });
    setSaving(false);
    if (!res.ok) return toastError(res.error);
    success('Food score saved');
    router.refresh();
  }

  return (
    <div className="rounded-3xl border border-border bg-surface/40 p-5">
      <div className="flex items-center gap-4">
        <div className="relative h-24 w-24 flex-shrink-0">
          <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
            <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="8" className="text-border/40" />
            <circle cx="50" cy="50" r="42" fill="none" stroke={scoreRing(pct)} strokeWidth="8" strokeLinecap="round"
              strokeDasharray={circumference} strokeDashoffset={circumference * (1 - pct / 100)} className="transition-all duration-700" />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={cn('text-2xl font-black leading-none', scoreColor(pct))}>{pct}</span>
            <span className="text-[10px] font-bold text-muted">{score.grade}</span>
          </div>
        </div>
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-widest text-muted">
            <TrendingUp className="h-3.5 w-3.5" /> Food Health
          </p>
          <p className="mt-1 text-sm font-medium leading-snug">{score.headline}</p>
        </div>
      </div>

      {/* Sub-scores */}
      {score.subScores.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2">
          {score.subScores.map((s) => (
            <div key={s.key}>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-muted">{s.label}</span>
                <span className={cn('font-bold', scoreColor(s.score))}>{s.score}</span>
              </div>
              <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-border/50" {...progressBarA11y(s.score, `${s.label}: ${s.score} of 100`)}>
                <div className="h-full rounded-full transition-all" style={{ width: `${s.score}%`, background: scoreRing(s.score) }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Coaching */}
      {score.coaching.length > 0 && (
        <ul className="mt-4 space-y-1">
          {score.coaching.map((c, i) => (
            <li key={i} className="flex gap-1.5 text-xs text-muted"><span className="text-brand-text">•</span> {c}</li>
          ))}
        </ul>
      )}

      <button onClick={save} disabled={saving}
        className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-border py-2 text-xs font-semibold hover:bg-elevated transition disabled:opacity-60">
        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />} Save today&apos;s score
      </button>
    </div>
  );
}

// ─── Leftover Section ─────────────────────────────────────────────────────────

function LeftoverSection({ data, onAdd }: { data: KitchenData; onAdd: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  async function setStatus(id: string, status: string) {
    setBusy(id);
    const res = await updateLeftoverStatusAction({ id, status });
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    success(status === 'eaten' ? 'Marked eaten 🎉' : status === 'frozen' ? 'Frozen ❄️' : 'Updated');
    router.refresh();
  }
  async function remove(id: string) {
    setBusy(id);
    const res = await deleteLeftoverAction({ id });
    setBusy(null);
    if (!res.ok) return toastError(res.error);
    router.refresh();
  }

  return (
    <section className="rounded-2xl border border-border bg-surface/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-widest text-muted">
          <Refrigerator className="h-4 w-4" /> Leftovers
        </h2>
        <button onClick={onAdd} disabled={data.leftoversMissing}
          className="flex items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-brand/90 transition disabled:opacity-50">
          <Plus className="h-3.5 w-3.5" /> Log
        </button>
      </div>
      {data.leftoversMissing ? (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted">
          Leftover tracking turns on once the food migration is applied.
        </p>
      ) : data.leftovers.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted">No leftovers logged. Log one after dinner to cut waste.</p>
      ) : (
        <div className="space-y-1.5">
          {data.leftovers.map((l) => {
            const u = leftoverUrgency(l.useBy);
            return (
              <div key={l.id} className="flex items-center gap-2 rounded-xl border border-border bg-bg/40 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{l.sourceMeal || l.name}</p>
                  <p className={cn('text-[11px] font-semibold', TONE[u.tone])}>{u.label}</p>
                </div>
                <div className="flex flex-shrink-0 items-center gap-0.5">
                  <button onClick={() => setStatus(l.id, 'eaten')} disabled={busy === l.id} title="Mark eaten"
                    className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-emerald-500 transition">
                    {busy === l.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                  </button>
                  <button onClick={() => setStatus(l.id, 'frozen')} disabled={busy === l.id} title="Freeze"
                    className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-sky-500 transition">
                    <Snowflake className="h-3.5 w-3.5" />
                  </button>
                  <button onClick={() => remove(l.id)} disabled={busy === l.id} title="Remove"
                    className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-rose-500 transition">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function AddLeftoverModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    if (!name) return toastError('Give the leftover a name.');
    setLoading(true);
    const res = await addLeftoverAction({
      name,
      sourceMeal: String(form.get('source') ?? '').trim() || null,
      quantity: String(form.get('qty') ?? '').trim() || null,
      useBy: String(form.get('useBy') ?? '') || null,
      location: String(form.get('location') ?? 'fridge'),
    });
    setLoading(false);
    if (!res.ok) return toastError(res.error);
    success('Leftover logged');
    onClose();
    router.refresh();
  }

  return (
    <Modal open onClose={onClose} title="Log a leftover">
      <form onSubmit={submit} className="space-y-4">
        <Field label="What is it?" required>{(id) => <Input id={id} name="name" autoFocus placeholder="Roast chicken" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="From which meal?">{(id) => <Input id={id} name="source" placeholder="Sunday dinner" />}</Field>
          <Field label="How much?">{(id) => <Input id={id} name="qty" placeholder="2 servings" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Eat by">{(id) => <Input id={id} name="useBy" type="date" />}</Field>
          <Field label="Where">{(id) => (
            <select id={id} name="location" className="h-11 w-full rounded-xl border border-border bg-bg px-3 text-sm focus-ring">
              <option value="fridge">Fridge</option>
              <option value="freezer">Freezer</option>
              <option value="counter">Counter</option>
              <option value="other">Other</option>
            </select>
          )}</Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Log leftover</Button>
        </div>
      </form>
    </Modal>
  );
}

// ─── AI Family Chef ───────────────────────────────────────────────────────────

const CHEF_PROMPTS = [
  'Plan quick dinners this week under $150',
  'Use what we already have in the pantry',
  'We have soccer Tuesday — keep dinners under 30 minutes',
  'Healthy lunches the kids will actually eat',
];

function ChefModal({ onClose }: { onClose: () => void }) {
  const { error: toastError } = useToast();
  const [request, setRequest] = useState('');
  const [loading, setLoading] = useState(false);
  const [reply, setReply] = useState<ChefReply | null>(null);
  const [source, setSource] = useState<'ai' | 'fallback' | null>(null);

  async function ask(prompt?: string) {
    const q = (prompt ?? request).trim();
    if (!q) return;
    setRequest(q);
    setLoading(true);
    try {
      const res = await fetch('/api/ai/chef', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ request: q }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'The chef could not respond.'); return; }
      setReply(json.reply);
      setSource(json.source);
    } catch {
      toastError('Network problem — please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="AI Family Chef" className="max-w-2xl">
      <div className="space-y-4">
        {!reply && (
          <div className="flex flex-wrap gap-1.5">
            {CHEF_PROMPTS.map((p) => (
              <button key={p} type="button" onClick={() => ask(p)} disabled={loading}
                className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted hover:border-brand/40 hover:text-brand-text transition disabled:opacity-50">
                {p}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2">
          <textarea value={request} onChange={(e) => setRequest(e.target.value)} rows={2}
            placeholder="Ask the chef anything… e.g. plan dinners with the leftover chicken"
            className="flex-1 rounded-xl border border-border bg-bg px-3 py-2 text-sm focus-ring"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) ask(); }} />
          <Button onClick={() => ask()} loading={loading} className="flex-shrink-0">
            <Send className="h-4 w-4" />
          </Button>
        </div>

        {reply && (
          <div className="space-y-4 border-t border-border pt-4">
            {source === 'fallback' && (
              <p className="rounded-lg border border-border bg-surface/40 px-3 py-2 text-[11px] text-muted">
                AI isn&apos;t configured — showing a plan from your own recipes & leftovers. Connect a provider for fully tailored weeks.
              </p>
            )}
            {reply.message && <p className="text-sm font-medium">{reply.message}</p>}

            {reply.meals.length > 0 && (
              <div className="space-y-1.5">
                {reply.meals.map((m, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-xl border border-border bg-surface/40 p-3">
                    <span className="mt-0.5 w-10 flex-shrink-0 text-xs font-bold uppercase text-muted">{m.day}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">{m.dish}</p>
                      <p className="text-xs text-muted">{m.reason}</p>
                    </div>
                    <div className="flex flex-shrink-0 flex-col items-end gap-0.5">
                      {m.estCostCents != null && m.estCostCents > 0 && <span className="text-xs font-semibold">${(m.estCostCents / 100).toFixed(0)}</span>}
                      <div className="flex gap-1">
                        {m.quick && <span className="rounded bg-emerald-500/15 px-1 text-[9px] font-bold uppercase text-emerald-500">Quick</span>}
                        {m.usesExpiring && <span className="rounded bg-amber-500/15 px-1 text-[9px] font-bold uppercase text-amber-500">Uses up</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {reply.groceryAdds.length > 0 && (
              <div>
                <h4 className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted"><ShoppingCart className="h-3.5 w-3.5" /> Add to grocery</h4>
                <div className="flex flex-wrap gap-1.5">
                  {reply.groceryAdds.map((g, i) => <span key={i} className="rounded-full border border-border bg-bg/40 px-2.5 py-1 text-xs">{g}</span>)}
                </div>
              </div>
            )}

            {reply.tips.length > 0 && (
              <ul className="space-y-1">
                {reply.tips.map((t, i) => <li key={i} className="flex gap-1.5 text-xs text-muted"><span className="text-brand-text">•</span> {t}</li>)}
              </ul>
            )}

            <div className="flex justify-between border-t border-border pt-3">
              <Button variant="ghost" onClick={() => { setReply(null); setSource(null); }}>Ask again</Button>
              <Link href="/dashboard/meals" className="inline-flex items-center gap-1.5 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white hover:bg-brand/90 transition" onClick={onClose}>
                <CalendarDays className="h-4 w-4" /> Open meal plan
              </Link>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
