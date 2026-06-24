'use client';

import { useMemo, useState } from 'react';
import { Syringe, Plus, Pencil, Trash2, CalendarClock, Sparkles, X } from 'lucide-react';
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
import { COMMON_VACCINES, sortByDateGiven, dueImmunizations, dueStatus, daysUntilDue } from '@/lib/health/immunizations';
import type { Tables } from '@/lib/database.types';
import type { ImmunizationsInsights, ImmunizationsAIResponse } from '@/lib/health/immunizations-ai';

type Immunization = Tables<'immunizations'>;

const blank = () => ({ id: '', member_id: '', vaccine: '', dose_label: '', date_given: '', next_due_date: '', provider_name: '', lot_number: '', notes: '' });

const STATUS_STYLE: Record<string, string> = {
  overdue: 'text-rose-300 bg-rose-500/15',
  due_soon: 'text-amber-300 bg-amber-500/15',
  upcoming: 'text-blue-300 bg-blue-500/15',
};

export function ImmunizationsModule({ title = 'Immunizations' }: { title?: string }) {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: shots, loading } = useRealtimeQuery<Immunization>({
    table: 'immunizations', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('immunizations').select('*').eq('family_id', familyId),
  });

  const [memberFilter, setMemberFilter] = useState('all');
  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<ImmunizationsInsights | null>(null);
  const [aiInsights, setAiInsights] = useState<ImmunizationsAIResponse | null>(null);

  async function runAiAssist() {
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/immunizations', { method: 'POST' });
      const data = await res.json();
      if (data.analysis) setAiAnalysis(data.analysis);
      if (data.aiInsights) setAiInsights(data.aiInsights);
    } catch { /* ignore */ } finally { setAiLoading(false); }
  }

  const scoped = useMemo(() => {
    let list = shots ?? [];
    if (memberFilter !== 'all') list = list.filter((s) => s.member_id === memberFilter);
    return sortByDateGiven(list);
  }, [shots, memberFilter]);
  const due = useMemo(() => dueImmunizations(scoped, 90), [scoped]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form?.vaccine.trim()) return;
    const supabase = createClient();
    const row = {
      member_id: form.member_id || null,
      vaccine: form.vaccine.trim(),
      dose_label: form.dose_label.trim() || null,
      date_given: form.date_given || null,
      next_due_date: form.next_due_date || null,
      provider_name: form.provider_name.trim() || null,
      lot_number: form.lot_number.trim() || null,
      notes: form.notes.trim() || null,
    };
    const { error } = form.id
      ? await supabase.from('immunizations').update(row).eq('id', form.id)
      : await supabase.from('immunizations').insert({ ...row, family_id: familyId, created_by: userId });
    if (error) return toastError(error.message);
    success(form.id ? 'Record updated' : 'Immunization added');
    setForm(null);
  }

  async function remove(id: string) {
    if (!confirm('Delete this immunization record?')) return;
    const { error } = await createClient().from('immunizations').delete().eq('id', id);
    if (error) toastError(error.message); else success('Deleted');
  }

  function edit(s: Immunization) {
    setForm({
      id: s.id, member_id: s.member_id ?? '', vaccine: s.vaccine, dose_label: s.dose_label ?? '',
      date_given: s.date_given ?? '', next_due_date: s.next_due_date ?? '', provider_name: s.provider_name ?? '',
      lot_number: s.lot_number ?? '', notes: s.notes ?? '',
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><Syringe className="h-4 w-4 text-brand" /> {title}</h3>
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
          <Button size="sm" onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      </div>

      {(aiAnalysis || aiInsights) && (
        <div className="rounded-xl border border-brand/30 bg-brand/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand">
              <Sparkles className="h-4 w-4" /> AI Immunization Insights
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
          {aiInsights?.scheduleTips && aiInsights.scheduleTips.length > 0 && (
            <div className="mb-2">
              <p className="text-xs font-medium mb-1">Schedule Tips</p>
              <ul className="space-y-1">{aiInsights.scheduleTips.map((s, i) => <li key={i} className="text-xs text-muted">• {s}</li>)}</ul>
            </div>
          )}
          {aiInsights?.reminderTip && <p className="text-xs text-muted italic">{aiInsights.reminderTip}</p>}
        </div>
      )}

      {due.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-300"><CalendarClock className="h-3.5 w-3.5" /> Doses coming due</p>
          <ul className="space-y-1 text-sm">
            {due.slice(0, 4).map((s) => {
              const d = daysUntilDue(s)!;
              return <li key={s.id} className="flex items-center gap-2"><span className="font-medium">{s.vaccine}</span><span className="text-xs text-muted">{d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : `in ${d}d`} · {fmtDate(s.next_due_date!)}</span></li>;
            })}
          </ul>
        </div>
      )}

      {loading ? (
        <LoadingBlock />
      ) : scoped.length === 0 ? (
        <EmptyState icon={Syringe} title="No immunizations recorded" description="Track vaccines and next-due dates — handy for school, camp, and travel forms." />
      ) : (
        <ul className="space-y-2">
          {scoped.map((s) => {
            const who = s.member_id ? memberById.get(s.member_id) : undefined;
            const status = dueStatus(s);
            return (
              <li key={s.id} className="rounded-2xl border border-border bg-surface/40 p-4">
                <div className="flex items-start gap-3">
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-elevated text-lg">💉</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-semibold">{s.vaccine}{s.dose_label ? <span className="ml-1 text-xs font-normal text-muted">· {s.dose_label}</span> : null}</p>
                      {status !== 'none' && <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[status]}`}>{status === 'overdue' ? 'Overdue' : status === 'due_soon' ? 'Due soon' : 'Upcoming dose'}</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      {s.date_given ? `Given ${fmtDate(s.date_given)}` : 'Date not set'}{s.next_due_date ? ` · Next ${fmtDate(s.next_due_date)}` : ''}{who ? ` · ${who.display_name}` : ''}{s.provider_name ? ` · ${s.provider_name}` : ''}
                    </p>
                    {(s.lot_number || s.notes) && <p className="mt-1 text-sm text-muted">{[s.lot_number ? `Lot ${s.lot_number}` : '', s.notes].filter(Boolean).join(' · ')}</p>}
                  </div>
                  {who && <Avatar name={who.display_name} color={who.color} size={28} />}
                  <div className="flex shrink-0 gap-1">
                    <button onClick={() => edit(s)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-4 w-4" /></button>
                    <button onClick={() => remove(s.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit immunization' : 'Add immunization'}>
          <form onSubmit={save} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Vaccine" required>{(id) => (
                <Select id={id} value={COMMON_VACCINES.includes(form.vaccine) ? form.vaccine : 'Other'} onChange={(e) => setForm({ ...form, vaccine: e.target.value === 'Other' ? '' : e.target.value })}>
                  {COMMON_VACCINES.map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              )}</Field>
              <Field label="Family member">{(id) => (
                <Select id={id} value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}>
                  <option value="">— Select —</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}</Field>
            </div>
            {!COMMON_VACCINES.includes(form.vaccine) && (
              <Field label="Vaccine name" required>{(id) => <Input id={id} value={form.vaccine} onChange={(e) => setForm({ ...form, vaccine: e.target.value })} placeholder="e.g. Typhoid" required />}</Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label="Dose">{(id) => <Input id={id} value={form.dose_label} onChange={(e) => setForm({ ...form, dose_label: e.target.value })} placeholder="Dose 1 / Booster" />}</Field>
              <Field label="Provider">{(id) => <Input id={id} value={form.provider_name} onChange={(e) => setForm({ ...form, provider_name: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date given">{(id) => <Input id={id} type="date" value={form.date_given} onChange={(e) => setForm({ ...form, date_given: e.target.value })} />}</Field>
              <Field label="Next dose due">{(id) => <Input id={id} type="date" value={form.next_due_date} onChange={(e) => setForm({ ...form, next_due_date: e.target.value })} />}</Field>
            </div>
            <Field label="Lot number">{(id) => <Input id={id} value={form.lot_number} onChange={(e) => setForm({ ...form, lot_number: e.target.value })} />}</Field>
            <Field label="Notes">{(id) => <Textarea id={id} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />}</Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">{form.id ? 'Save' : 'Add'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
