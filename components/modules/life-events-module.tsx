'use client';

// Life & Milestones (T9) — two halves that deepen the felt moat:
//  1. "What Bubaly has learned": the family's accumulated preferences, routines
//     and traditions (family_facts), shown back to them and fully editable.
//  2. Life-event playbooks: one-tap templates (New Baby, Moving, School Start,
//     Vacation, New Pet, New Job) that materialize a real, dated checklist.
// 100% Supabase-wired + realtime. Launch is atomic via a server action.
import { useMemo, useState } from 'react';
import {
  Sparkles, Plus, Pin, PinOff, Pencil, Trash2, Baby, Truck, GraduationCap, Plane,
  PawPrint, Briefcase, ListChecks, ShoppingCart, CalendarCheck, Bell, FileText,
  HeartPulse, Home, PartyPopper, Check, Archive, CheckCircle2, BookHeart, ChevronRight,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { forgetFactAction, saveFactAction, setFactPinnedAction } from '@/app/(app)/dashboard/knowledge/actions';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SkeletonList, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import { LIFE_EVENT_TEMPLATES } from '@/lib/life-events/templates';
import { launchLifeEventAction, setLifeEventStatusAction } from '@/app/(app)/dashboard/life-event-actions';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Fact = Tables<'family_facts'>;
type Plan = Tables<'life_event_plans'>;
type Item = Tables<'life_event_plan_items'>;

const TEMPLATE_ICON: Record<string, typeof Baby> = {
  'baby': Baby, 'truck': Truck, 'graduation-cap': GraduationCap, 'plane': Plane, 'paw-print': PawPrint, 'briefcase': Briefcase,
};
const ITEM_ICON: Record<string, typeof ListChecks> = {
  plan: ListChecks, buy: ShoppingCart, book: CalendarCheck, notify: Bell, document: FileText, health: HeartPulse, home: Home, celebrate: PartyPopper,
};
// The learned surface focuses on the durable, felt facts (preferences/traditions).
const LEARNED_CATEGORIES = ['preference', 'about', 'important'] as const;
const fmtDate = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');

export function LifeEventsModule() {
  const tr = useTranslations();
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: facts, loading: factsLoading, error: factsError, refresh: refreshFacts } = useRealtimeQuery<Fact>({
    table: 'family_facts', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('family_facts').select('*').eq('family_id', familyId).order('is_pinned', { ascending: false }).order('updated_at', { ascending: false }),
  });
  const { data: plans, loading: plansLoading, error: plansError, refresh: refreshPlans } = useRealtimeQuery<Plan>({
    table: 'life_event_plans', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('life_event_plans').select('*').eq('family_id', familyId).order('event_date', { ascending: true }),
  });
  const { data: items, loading: itemsLoading, error: itemsError, refresh: refreshItems } = useRealtimeQuery<Item>({
    table: 'life_event_plan_items', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('life_event_plan_items').select('*').eq('family_id', familyId).order('sort', { ascending: true }),
  });

  const loading = factsLoading || plansLoading || itemsLoading;
  const error = factsError || plansError || itemsError;
  const refresh = () => { void refreshFacts(); void refreshPlans(); void refreshItems(); };

  const [factModal, setFactModal] = useState<{ open: true; editing: Fact | null } | null>(null);
  const [startTemplate, setStartTemplate] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  const learned = useMemo(
    () => (facts ?? []).filter((f) => (LEARNED_CATEGORIES as readonly string[]).includes(f.category)),
    [facts],
  );
  const itemsByPlan = useMemo(() => {
    const m = new Map<string, Item[]>();
    for (const it of items ?? []) { const a = m.get(it.plan_id) ?? []; a.push(it); m.set(it.plan_id, a); }
    return m;
  }, [items]);
  const activePlans = (plans ?? []).filter((p) => p.status !== 'archived');

  async function launch(eventDate: string | null) {
    if (!startTemplate) return;
    setLaunching(true);
    const res = await launchLifeEventAction(startTemplate, eventDate);
    setLaunching(false);
    if (!res.ok) { toastError(res.error ?? 'Could not start'); return; }
    // A move launches the Move Planner rather than a checklist here, so say where it went.
    success(res.moveId ? tr('lifeEventsModule.moveOnFile') : tr('lifeEventsModule.playbookStartedYourChecklistIs'));
    setStartTemplate(null);
  }

  async function toggleItem(it: Item) {
    const { error } = await createClient().from('life_event_plan_items').update({ is_done: !it.is_done }).eq('id', it.id);
    if (error) toastError(describeDbError(error));
  }
  async function setPlanStatus(planId: string, status: 'active' | 'completed' | 'archived') {
    const res = await setLifeEventStatusAction(planId, status);
    if (!res.ok) toastError(res.error ?? 'Could not update'); else success(status === 'archived' ? 'Archived' : status === 'completed' ? 'Marked complete' : 'Reopened');
  }
  async function togglePin(f: Fact) {
    const res = await setFactPinnedAction(f.id, !f.is_pinned);
    if (!res.ok) toastError(res.error);
  }
  async function removeFact(f: Fact) {
    if (!confirm(tr('lifeEventsModule.removeThis'))) return;
    const res = await forgetFactAction(f.id);
    if (!res.ok) toastError(res.error); else success(tr('lifeEventsModule.removed'));
  }

  if (loading) return <SkeletonList count={5} />;
  if (error) return <ErrorState message={tr('lifeEventsModule.couldNotLoadLifeAnd')} onRetry={refresh} />;

  return (
    <div className="space-y-8">
      <PageHeader
        title={tr('lifeEvents.lifeMilestones')}
        description={tr('lifeEventsModule.whatBubalyHasLearnedAbout')}
      />

      {/* ── What Bubaly has learned ─────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><BookHeart className="h-4 w-4 text-brand-text" /> {tr('lifeEvents.whatBubalyHasLearned')}</h2>
          <Button size="sm" variant="secondary" onClick={() => setFactModal({ open: true, editing: null })}><Plus className="h-4 w-4" /> Add</Button>
        </div>
        {learned.length === 0 ? (
          <EmptyState icon={Sparkles} title={tr('lifeEvents.bubalyIsStillGettingToKnow')} description={tr('lifeEventsModule.preferencesRoutinesAndTraditionsYou')} />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {learned.map((f) => (
              <div key={f.id} className={cn('group rounded-xl border p-3', f.is_pinned ? 'border-brand/40 bg-brand/5' : 'border-border bg-surface/40')}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{f.label}</p>
                    <p className="mt-0.5 text-sm text-muted">{f.value}</p>
                    {f.notes && <p className="mt-1 text-xs text-muted/80">{f.notes}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
                    <button onClick={() => togglePin(f)} aria-label={f.is_pinned ? 'Unpin' : 'Pin'} className="rounded-lg p-1.5 text-muted hover:text-brand-text">{f.is_pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</button>
                    <button onClick={() => setFactModal({ open: true, editing: f })} aria-label={tr('lifeEvents.edit')} className="rounded-lg p-1.5 text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /></button>
                    <button onClick={() => removeFact(f)} aria-label={tr('lifeEvents.remove')} className="rounded-lg p-1.5 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <span className="inline-block rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted">{f.category}</span>
                  {/* §26: the family can see what Bubaly believes and where it
                      got it. The section is titled "What Bubaly has learned"
                      and lists every fact, so without this a preference you
                      typed yourself reads as something Bubaly worked out. */}
                  {(f.source === 'ai_conversation' || f.source === 'ai_inferred') && (
                    <span className="inline-block rounded-full border border-brand/40 bg-brand/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-brand-text">
                      {f.source === 'ai_conversation' ? 'Bubaly kept this' : 'Bubaly worked this out'}
                      {typeof f.confidence === 'number' ? ` · ${f.confidence}%` : ''}
                    </span>
                  )}
                  {f.expires_at && new Date(f.expires_at) <= new Date() && (
                    <span className="inline-block rounded-full border border-warning/40 bg-warning/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-warning">{tr('lifeEvents.outOfDate')}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ── Life-event playbooks ────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{tr('lifeEvents.startALifeEventPlaybook')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {LIFE_EVENT_TEMPLATES.map((t) => {
            const Icon = TEMPLATE_ICON[t.icon] ?? Sparkles;
            return (
              <button key={t.key} onClick={() => setStartTemplate(t.key)}
                className="group flex flex-col rounded-2xl border border-border bg-card p-4 text-left transition hover:border-brand/50 hover:bg-brand/[0.03]">
                <div className="flex items-center gap-3">
                  <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand-text"><Icon className="h-5 w-5" /></span>
                  <span className="font-semibold">{t.title}</span>
                  <ChevronRight className="ml-auto h-4 w-4 text-muted transition group-hover:translate-x-0.5 group-hover:text-brand-text" />
                </div>
                <p className="mt-2 text-xs text-muted">{t.description}</p>
                <p className="mt-2 text-[11px] text-muted/70">{t.items.length} {tr('lifeEvents.guidedSteps')}</p>
              </button>
            );
          })}
        </div>
      </section>

      {/* ── Active plans ────────────────────────────────────────────────────── */}
      {activePlans.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold">{tr('lifeEvents.yourPlaybooks')}</h2>
          <div className="space-y-4">
            {activePlans.map((p) => {
              const pItems = itemsByPlan.get(p.id) ?? [];
              const done = pItems.filter((i) => i.is_done).length;
              const pct = pItems.length ? Math.round((done / pItems.length) * 100) : 0;
              const Icon = TEMPLATE_ICON[LIFE_EVENT_TEMPLATES.find((t) => t.key === p.template_key)?.icon ?? ''] ?? Sparkles;
              return (
                <div key={p.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/10 text-brand-text"><Icon className="h-4.5 w-4.5" /></span>
                      <div>
                        <p className="font-semibold">{p.title}{p.status === 'completed' && <span className="ml-2 text-xs text-emerald-400">complete</span>}</p>
                        <p className="text-xs text-muted">{p.event_date ? `Target ${new Date(`${p.event_date}T00:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}` : 'No date set'} · {done}/{pItems.length} done</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1 text-xs">
                      {p.status !== 'completed'
                        ? <button onClick={() => setPlanStatus(p.id, 'completed')} className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-muted hover:text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" /> {tr('lifeEvents.complete')}</button>
                        : <button onClick={() => setPlanStatus(p.id, 'active')} className="rounded-lg border border-border px-2 py-1 text-muted hover:text-fg">{tr('lifeEvents.reopen')}</button>}
                      <button onClick={() => setPlanStatus(p.id, 'archived')} aria-label={tr('lifeEvents.archive')} className="rounded-lg border border-border p-1.5 text-muted hover:text-fg"><Archive className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                  <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted/10">
                    <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  <ul className="mt-3 space-y-1.5">
                    {pItems.map((it) => {
                      const ItIcon = ITEM_ICON[it.category] ?? ListChecks;
                      return (
                        <li key={it.id}>
                          <button onClick={() => toggleItem(it)} className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition hover:bg-muted/5">
                            <span className={cn('grid h-5 w-5 shrink-0 place-items-center rounded-md border', it.is_done ? 'border-brand bg-brand text-white' : 'border-border text-transparent')}>
                              <Check className="h-3.5 w-3.5" />
                            </span>
                            <ItIcon className={cn('h-3.5 w-3.5 shrink-0', it.is_done ? 'text-muted' : 'text-brand-text')} />
                            <span className={cn('min-w-0 flex-1 truncate', it.is_done && 'text-muted line-through')}>{it.title}</span>
                            {it.due_on && <span className="shrink-0 text-[11px] text-muted">{fmtDate(it.due_on)}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Start-template date modal */}
      {startTemplate && (
        <StartModal
          template={LIFE_EVENT_TEMPLATES.find((t) => t.key === startTemplate)!}
          launching={launching}
          onClose={() => setStartTemplate(null)}
          onLaunch={launch}
        />
      )}

      {/* Add/edit learned fact */}
      {factModal && (
        <FactModal
          familyId={familyId} userId={userId} editing={factModal.editing}
          onClose={() => setFactModal(null)}
          onSaved={() => { setFactModal(null); success(factModal.editing ? 'Updated' : 'Saved'); }}
          onError={toastError}
        />
      )}
    </div>
  );
}

function StartModal({ template, launching, onClose, onLaunch }: {
  template: (typeof LIFE_EVENT_TEMPLATES)[number]; launching: boolean; onClose: () => void; onLaunch: (date: string | null) => void;
}) {
  const tr = useTranslations();
  const defaultDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + template.defaultLeadDays);
    return d.toISOString().slice(0, 10);
  }, [template.defaultLeadDays]);
  const [date, setDate] = useState(defaultDate);
  return (
    <Modal open onClose={onClose} title={`Start: ${template.title}`} description={template.description}>
      <div className="space-y-4">
        <Field label={tr('lifeEvents.whenIsItTheChecklistSchedules')}>
          {(id) => <Input id={id} type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
        </Field>
        <p className="text-xs text-muted">{tr('lifeEvents.creates')} {template.items.length} {tr('lifeEvents.scheduledStepsYouCanCheckOff')}</p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('lifeEvents.cancel')}</Button>
          <Button onClick={() => onLaunch(date || null)} disabled={launching} loading={launching}>{tr('lifeEvents.startPlaybook')}</Button>
        </div>
      </div>
    </Modal>
  );
}

function FactModal({ familyId, userId, editing, onClose, onSaved, onError }: {
  familyId: string; userId: string | null; editing: Fact | null; onClose: () => void; onSaved: () => void; onError: (m: string) => void;
}) {
  const tr = useTranslations();
  const [label, setLabel] = useState(editing?.label ?? '');
  const [value, setValue] = useState(editing?.value ?? '');
  const [category, setCategory] = useState(editing?.category ?? 'preference');
  const [notes, setNotes] = useState(editing?.notes ?? '');
  const [saving, setSaving] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!label.trim() || !value.trim()) { onError(tr('lifeEventsModule.addALabelAndA')); return; }
    setSaving(true);
    const res = await saveFactAction(editing?.id ?? null, {
      label: label.trim(), value: value.trim(), category, notes: notes.trim() || null,
    });
    setSaving(false);
    if (!res.ok) { onError(res.error); return; }
    onSaved();
  }
  return (
    // A person typing here is telling Bubaly, not Bubaly learning — and the
    // row is written with `source: 'user'`, so the old title was the one
    // sentence on this screen the data disagreed with.
    <Modal open onClose={onClose} title={editing ? 'Edit' : 'Tell Bubaly something'}>
      <form onSubmit={submit} className="space-y-3">
        <Field label={tr('lifeEvents.label')}>{(id) => <Input id={id} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={tr('lifeEvents.fridayTradition')} autoFocus />}</Field>
        <Field label={tr('lifeEvents.value')}>{(id) => <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} placeholder={tr('lifeEvents.pizzaMovieNight')} />}</Field>
        <Field label={tr('lifeEvents.kind')}>{(id) => (
          <Select id={id} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="preference">{tr('lifeEvents.preference')}</option>
            <option value="about">{tr('lifeEvents.aboutUs')}</option>
            <option value="important">{tr('lifeEvents.important')}</option>
          </Select>
        )}</Field>
        <Field label={tr('lifeEvents.notesOptional')}>{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>{tr('lifeEvents.cancel')}</Button>
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save' : 'Add'}</Button>
        </div>
      </form>
    </Modal>
  );
}
