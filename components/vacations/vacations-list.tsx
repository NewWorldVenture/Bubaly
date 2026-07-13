'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus, Plane, Sparkles, MapPin, CalendarDays, Users, Gauge } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { VACATION_KINDS, VACATION_STATUSES, lookup } from '@/lib/vacations/meta';
import { countdownLabel, daysUntil, isActive } from '@/lib/vacations/dates';
import type { Tables } from '@/lib/database.types';

type Vacation = Tables<'vacations'>;
type Member = Tables<'vacation_members'>;
type Score = Tables<'vacation_travel_scores'>;

const blank = () => ({ title: '', kind: 'domestic', destination: '', start_date: '', end_date: '', budget: '', description: '', is_international: false });

export function VacationsList({ openCreate = false }: { openCreate?: boolean }) {
  const { familyId, userId } = useApp();
  const router = useRouter();
  const { success, error: toastError } = useToast();

  const { data: trips, loading } = useRealtimeQuery<Vacation>({
    table: 'vacations', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('vacations').select('*').eq('family_id', familyId),
  });
  const { data: vmembers } = useRealtimeQuery<Member>({
    table: 'vacation_members', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('vacation_members').select('*').eq('family_id', familyId),
  });
  const { data: scores } = useRealtimeQuery<Score>({
    table: 'vacation_travel_scores', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('vacation_travel_scores').select('*').eq('family_id', familyId),
  });

  const memberCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of vmembers) m.set(v.vacation_id, (m.get(v.vacation_id) ?? 0) + 1);
    return m;
  }, [vmembers]);
  const latestScore = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of [...scores].sort((a, b) => (a.computed_at < b.computed_at ? -1 : 1))) m.set(s.vacation_id, s.score);
    return m;
  }, [scores]);

  const sorted = useMemo(() => {
    const rank = (v: Vacation) => (v.status === 'cancelled' || v.status === 'completed' ? 1 : 0);
    return [...trips].sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      const da = daysUntil(a.start_date) ?? 99999, db = daysUntil(b.start_date) ?? 99999;
      return da - db;
    });
  }, [trips]);

  const upcoming = sorted.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
  const current = upcoming.find((t) => isActive(t.start_date, t.end_date)) ?? upcoming[0];

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(openCreate ? blank() : null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!form?.title.trim()) return toastError('Give your trip a name');
    const { data, error } = await createClient().from('vacations').insert({
      family_id: familyId, created_by: userId,
      title: form.title.trim(),
      kind: form.kind as Vacation['kind'],
      destination: form.destination.trim() || null,
      start_date: form.start_date || null,
      end_date: form.end_date || null,
      budget_cents: form.budget ? Math.round(parseFloat(form.budget) * 100) : null,
      description: form.description.trim() || null,
      is_international: form.is_international,
    }).select('id').single();
    if (error) return toastError(error.message);
    success('Trip created');
    setForm(null);
    router.push(`/dashboard/vacations/${data.id}/overview`);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold"><Plane className="h-6 w-6 text-brand-text" /> Vacation Planner</h1>
          <p className="text-sm text-muted">Plan, coordinate, and pack for every family trip — with an AI travel concierge.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard/vacations/calendar"><Button variant="secondary" size="sm"><CalendarDays className="h-4 w-4" /> Calendar</Button></Link>
          <Button size="sm" onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> New trip</Button>
        </div>
      </div>

      {current && (
        <Link href={`/dashboard/vacations/${current.id}/overview`} className="block">
          <div className="rounded-2xl border border-brand/30 bg-gradient-to-br from-brand/10 to-transparent p-5 transition hover:border-brand/50">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-brand-text">{isActive(current.start_date, current.end_date) ? 'Current trip' : 'Next trip'}</p>
                <h2 className="mt-1 flex items-center gap-2 text-xl font-bold">{lookup(VACATION_KINDS, current.kind).emoji} {current.title}</h2>
                <p className="mt-0.5 flex items-center gap-3 text-sm text-muted">
                  {current.destination && <span className="flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> {current.destination}</span>}
                  <span className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> {countdownLabel(current.start_date)}</span>
                </p>
              </div>
              <ReadinessRing score={latestScore.get(current.id) ?? null} />
            </div>
          </div>
        </Link>
      )}

      {loading ? <LoadingBlock /> : sorted.length === 0 ? (
        <EmptyState icon={Plane} title="No trips yet" description="Create your first vacation — or let the AI builder plan one for you." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {sorted.map((t) => {
            const st = VACATION_STATUSES.find((s) => s.value === t.status) ?? VACATION_STATUSES[0];
            return (
              <Link key={t.id} href={`/dashboard/vacations/${t.id}/overview`} className="group block rounded-2xl border border-border bg-surface/40 p-4 transition hover:border-brand/40">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-2xl">{lookup(VACATION_KINDS, t.kind).emoji}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${(VACATION_STATUSES.find((s) => s.value === t.status))?.tone}`}>{st.label}</span>
                </div>
                <h3 className="mt-2 truncate font-semibold group-hover:text-brand-text">{t.title}</h3>
                <p className="mt-0.5 truncate text-sm text-muted">{t.destination || lookup(VACATION_KINDS, t.kind).label}</p>
                <div className="mt-3 flex items-center justify-between text-xs text-muted">
                  <span className="flex items-center gap-1"><CalendarDays className="h-3.5 w-3.5" /> {t.start_date ? fmtDate(t.start_date) : 'No dates'}</span>
                  <span className="flex items-center gap-1"><Users className="h-3.5 w-3.5" /> {memberCount.get(t.id) ?? 0}</span>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Gauge className="h-3.5 w-3.5 text-muted" />
                  <span className="text-xs text-muted">Readiness {latestScore.get(t.id) ?? '—'}{latestScore.has(t.id) ? '%' : ''}</span>
                  <span className="ml-auto text-xs font-medium text-brand-text">{countdownLabel(t.start_date)}</span>
                </div>
              </Link>
            );
          })}
        </div>
      )}

      {form && (
        <Modal open onClose={() => setForm(null)} title="New trip">
          <form onSubmit={create} className="space-y-3">
            <Field label="Trip name" required>{(id) => <Input id={id} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Summer at Disney World" required />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">{(id) => <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{VACATION_KINDS.map((k) => <option key={k.value} value={k.value}>{k.emoji} {k.label}</option>)}</Select>}</Field>
              <Field label="Destination">{(id) => <Input id={id} value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })} placeholder="Orlando, FL" />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Start date">{(id) => <Input id={id} type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />}</Field>
              <Field label="End date">{(id) => <Input id={id} type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Budget ($)">{(id) => <Input id={id} type="number" step="0.01" value={form.budget} onChange={(e) => setForm({ ...form, budget: e.target.value })} placeholder="5000" />}</Field>
              <label className="mt-7 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={form.is_international} onChange={(e) => setForm({ ...form, is_international: e.target.checked })} className="h-4 w-4 rounded border-border" /> International
              </label>
            </div>
            <Field label="Notes">{(id) => <Textarea id={id} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />}</Field>
            <div className="rounded-xl border border-border bg-elevated/40 p-3 text-xs text-muted">
              <Sparkles className="mr-1 inline h-3.5 w-3.5 text-brand-text" /> Tip: after creating, open the AI Concierge to auto-build a full itinerary, packing list, and budget.
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">Create trip</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

export function ReadinessRing({ score }: { score: number | null }) {
  const pct = score ?? 0;
  const tone = pct >= 90 ? 'text-emerald-400' : pct >= 65 ? 'text-brand-text' : pct >= 30 ? 'text-amber-400' : 'text-rose-400';
  return (
    <div className="relative grid h-16 w-16 place-items-center">
      <svg className="h-16 w-16 -rotate-90" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor" strokeWidth="3" className="text-elevated" />
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="currentColor" strokeWidth="3" strokeDasharray={`${pct}, 100`} strokeLinecap="round" className={tone} />
      </svg>
      <span className="absolute text-sm font-bold">{score ?? '—'}</span>
    </div>
  );
}
