'use client';

import { useMemo, useState } from 'react';
import { Stethoscope, Plus, Pencil, Trash2, CalendarClock, MapPin, AlertCircle, Sparkles, X } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { VISIT_KINDS, visitKindMeta, sortByVisitDate, upcomingFollowUps, daysUntilFollowUp, type VisitKind } from '@/lib/health/visits';
import type { Tables } from '@/lib/database.types';
import type { HealthVisitsInsights, HealthVisitsAIResponse } from '@/lib/health/health-visits-ai';

type Visit = Tables<'health_visits'>;

const blank = (kind: VisitKind) => ({ id: '', member_id: '', kind, title: '', provider_name: '', location: '', visit_date: new Date().toISOString().slice(0, 10), reason: '', outcome: '', follow_up_date: '', cost: '' });

export function HealthVisitsModule({ defaultKind, title = 'Visits & History', lockKind = false }: {
  defaultKind?: VisitKind; title?: string; lockKind?: boolean;
}) {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: visits, loading } = useRealtimeQuery<Visit>({
    table: 'health_visits', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('health_visits').select('*').eq('family_id', familyId),
  });

  const [memberFilter, setMemberFilter] = useState('all');
  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<HealthVisitsInsights | null>(null);
  const [aiInsights, setAiInsights] = useState<HealthVisitsAIResponse | null>(null);

  async function runAiAssist() {
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/health-visits', { method: 'POST' });
      const data = await res.json();
      if (data.analysis) setAiAnalysis(data.analysis);
      if (data.aiInsights) setAiInsights(data.aiInsights);
    } catch { /* ignore */ } finally { setAiLoading(false); }
  }

  const scoped = useMemo(() => {
    let list = visits ?? [];
    if (defaultKind) list = list.filter((v) => v.kind === defaultKind);
    if (memberFilter !== 'all') list = list.filter((v) => v.member_id === memberFilter);
    return sortByVisitDate(list);
  }, [visits, defaultKind, memberFilter]);

  const followUps = useMemo(() => upcomingFollowUps(scoped, 90), [scoped]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form?.title.trim()) return;
    const supabase = createClient();
    const row = {
      member_id: form.member_id || null,
      kind: form.kind,
      title: form.title.trim(),
      provider_name: form.provider_name.trim() || null,
      location: form.location.trim() || null,
      visit_date: form.visit_date,
      reason: form.reason.trim() || null,
      outcome: form.outcome.trim() || null,
      follow_up_date: form.follow_up_date || null,
      cost_cents: form.cost ? Math.round(parseFloat(form.cost) * 100) : null,
    };
    const { error } = form.id
      ? await supabase.from('health_visits').update(row).eq('id', form.id)
      : await supabase.from('health_visits').insert({ ...row, family_id: familyId, created_by: userId });
    if (error) return toastError(error.message);
    success(form.id ? 'Visit updated' : 'Visit added');
    setForm(null);
  }

  async function remove(id: string) {
    if (!confirm('Delete this visit record?')) return;
    const { error } = await createClient().from('health_visits').delete().eq('id', id);
    if (error) toastError(error.message); else success('Visit deleted');
  }

  function edit(v: Visit) {
    setForm({
      id: v.id, member_id: v.member_id ?? '', kind: v.kind as VisitKind, title: v.title,
      provider_name: v.provider_name ?? '', location: v.location ?? '', visit_date: v.visit_date,
      reason: v.reason ?? '', outcome: v.outcome ?? '', follow_up_date: v.follow_up_date ?? '',
      cost: v.cost_cents != null ? (v.cost_cents / 100).toString() : '',
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Stethoscope className="h-4 w-4 text-brand" /> {title}</h3>
        <div className="flex items-center gap-2">
          {members.length > 0 && (
            <select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} className="h-9 rounded-lg border border-border bg-surface px-2 text-sm">
              <option value="all">Everyone</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
          )}
          <Button variant="outline" size="sm" onClick={runAiAssist} loading={aiLoading}>
            <Sparkles className="h-4 w-4" /> AI Assist
          </Button>
          <Button size="sm" onClick={() => setForm(blank(defaultKind ?? 'medical'))}><Plus className="h-4 w-4" /> Add visit</Button>
        </div>
      </div>

      {(aiAnalysis || aiInsights) && (
        <div className="rounded-xl border border-brand/30 bg-brand/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand">
              <Sparkles className="h-4 w-4" /> AI Health Insights
            </div>
            <button onClick={() => { setAiAnalysis(null); setAiInsights(null); }} className="text-muted hover:text-fg"><X className="h-4 w-4" /></button>
          </div>
          {aiAnalysis && <p className="mb-2 text-xs text-muted">{aiAnalysis.summary}</p>}
          {aiInsights?.suggestions && aiInsights.suggestions.length > 0 && (
            <div className="mb-2">
              <p className="text-xs font-medium mb-1">Suggestions</p>
              <ul className="space-y-1">{aiInsights.suggestions.map((s, i) => <li key={i} className="text-xs text-muted">• {s}</li>)}</ul>
            </div>
          )}
          {aiInsights?.preventiveTips && aiInsights.preventiveTips.length > 0 && (
            <div className="mb-2">
              <p className="text-xs font-medium mb-1">Preventive Care Tips</p>
              <ul className="space-y-1">{aiInsights.preventiveTips.map((s, i) => <li key={i} className="text-xs text-muted">• {s}</li>)}</ul>
            </div>
          )}
          {aiInsights?.wellnessTip && <p className="text-xs text-muted italic">{aiInsights.wellnessTip}</p>}
        </div>
      )}

      {followUps.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-300"><CalendarClock className="h-3.5 w-3.5" /> Upcoming follow-ups</p>
          <ul className="space-y-1 text-sm">
            {followUps.slice(0, 4).map((v) => {
              const d = daysUntilFollowUp(v)!;
              return <li key={v.id} className="flex items-center gap-2"><span className="font-medium">{v.title}</span><span className="text-xs text-muted">{d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : `in ${d}d`} · {fmtDate(v.follow_up_date!)}</span></li>;
            })}
          </ul>
        </div>
      )}

      {loading ? (
        <LoadingBlock />
      ) : scoped.length === 0 ? (
        <EmptyState icon={Stethoscope} title="No visits logged" description="Add a doctor, dentist, or vaccination visit to build your family's health history." />
      ) : (
        <ul className="space-y-2">
          {scoped.map((v) => {
            const meta = visitKindMeta(v.kind);
            const who = v.member_id ? memberById.get(v.member_id) : undefined;
            return (
              <li key={v.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-elevated text-lg">{meta.icon}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate font-semibold">{v.title}</p>
                      <span className="shrink-0 rounded-full bg-elevated px-2 py-0.5 text-[10px] uppercase tracking-wide text-muted">{meta.label}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted">{fmtDate(v.visit_date)}{v.provider_name ? ` · ${v.provider_name}` : ''}{who ? ` · ${who.display_name}` : ''}</p>
                    {v.reason && <p className="mt-1 text-sm">{v.reason}</p>}
                    {v.outcome && <p className="mt-1 text-sm text-muted">{v.outcome}</p>}
                    <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
                      {v.location && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{v.location}</span>}
                      {v.follow_up_date && <span className="flex items-center gap-1 text-amber-300"><CalendarClock className="h-3 w-3" />Follow-up {fmtDate(v.follow_up_date)}</span>}
                      {v.cost_cents != null && <span>${(v.cost_cents / 100).toFixed(2)}</span>}
                    </div>
                  </div>
                  {who && <Avatar name={who.display_name} color={who.color} size={28} />}
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => edit(v)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => remove(v.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit visit' : 'Add visit'}>
          <form onSubmit={save} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {!lockKind && (
                <Field label="Type">{(id) => (
                  <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as VisitKind })}>
                    {VISIT_KINDS.map((k) => <option key={k.id} value={k.id}>{k.icon} {k.label}</option>)}
                  </Select>
                )}</Field>
              )}
              <Field label="Family member">{(id) => (
                <Select id={id} value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}>
                  <option value="">— Select —</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}</Field>
            </div>
            <Field label="Title" required>{(id) => <Input id={id} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Annual checkup / Cleaning / Flu shot" required />}</Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date">{(id) => <Input id={id} type="date" value={form.visit_date} onChange={(e) => setForm({ ...form, visit_date: e.target.value })} />}</Field>
              <Field label="Follow-up date">{(id) => <Input id={id} type="date" value={form.follow_up_date} onChange={(e) => setForm({ ...form, follow_up_date: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Provider">{(id) => <Input id={id} value={form.provider_name} onChange={(e) => setForm({ ...form, provider_name: e.target.value })} placeholder="Dr. / clinic" />}</Field>
              <Field label="Location">{(id) => <Input id={id} value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />}</Field>
            </div>
            <Field label="Reason / visit for">{(id) => <Input id={id} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />}</Field>
            <Field label="Outcome / notes">{(id) => <Textarea id={id} value={form.outcome} onChange={(e) => setForm({ ...form, outcome: e.target.value })} rows={3} />}</Field>
            <Field label="Cost ($)">{(id) => <Input id={id} type="number" step="0.01" min="0" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />}</Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">{form.id ? 'Save' : 'Add visit'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
