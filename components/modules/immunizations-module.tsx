'use client';

import { useMemo, useState } from 'react';
import { Syringe, Plus, Pencil, Trash2, CalendarClock } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { ErrorState, SkeletonList, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { COMMON_VACCINES, sortByDateGiven, dueImmunizations, dueStatus, daysUntilDue } from '@/lib/health/immunizations';
import type { Tables } from '@/lib/database.types';
import { useTranslations } from '@/components/i18n/locale-provider';

type Immunization = Tables<'immunizations'>;

const blank = () => ({ id: '', member_id: '', vaccine: '', dose_label: '', date_given: '', next_due_date: '', provider_name: '', lot_number: '', notes: '' });

const STATUS_STYLE: Record<string, string> = {
  overdue: 'text-rose-300 bg-rose-500/15',
  due_soon: 'text-amber-300 bg-amber-500/15',
  upcoming: 'text-blue-300 bg-blue-500/15',
};

export function ImmunizationsModule({ title = 'Immunizations' }: { title?: string }) {
  const t = useTranslations();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: shots, loading, error, refresh } = useRealtimeQuery<Immunization>({
    table: 'immunizations', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('immunizations').select('*').eq('family_id', familyId),
  });

  const [memberFilter, setMemberFilter] = useState('all');
  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);

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
    if (error) return toastError(describeDbError(error));
    success(form.id ? 'Record updated' : 'Immunization added');
    setForm(null);
  }

  async function remove(id: string) {
    if (!confirm(t('immunizationsModule.deleteThisImmunizationRecord'))) return;
    const { error } = await createClient().from('immunizations').delete().eq('id', id);
    if (error) toastError(describeDbError(error)); else success(t('immunizationsModule.deleted'));
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
        <h3 className="flex items-center gap-2 text-base font-semibold"><Syringe className="h-4 w-4 text-brand-text" /> {title}</h3>
        <div className="flex items-center gap-2">
          {members.length > 0 && (
            <select value={memberFilter} onChange={(e) => setMemberFilter(e.target.value)} className="h-9 rounded-lg border border-border bg-surface px-2 text-sm">
              <option value="all">{t('immunizations.everyone')}</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </select>
          )}
          <Button size="sm" onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      </div>

      {due.length > 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
          <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-amber-300"><CalendarClock className="h-3.5 w-3.5" /> {t('immunizations.dosesComingDue')}</p>
          <ul className="space-y-1 text-sm">
            {due.slice(0, 4).map((s) => {
              const d = daysUntilDue(s)!;
              return <li key={s.id} className="flex items-center gap-2"><span className="font-medium">{s.vaccine}</span><span className="text-xs text-muted">{d < 0 ? `${-d}d overdue` : d === 0 ? 'today' : `in ${d}d`} · {fmtDate(s.next_due_date!)}</span></li>;
            })}
          </ul>
        </div>
      )}

      {loading ? (
        <SkeletonList />
      ) : error ? (
        <ErrorState message={t('immunizationsModule.couldNotLoadImmunizationRecords')} onRetry={refresh} />
      ) : scoped.length === 0 ? (
        <EmptyState icon={Syringe} title={t('immunizations.noImmunizationsRecorded')} description={t('immunizationsModule.trackVaccinesAndNextDue')} />
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
              <Field label={t('immunizations.vaccine')} required>{(id) => (
                <Select id={id} value={COMMON_VACCINES.includes(form.vaccine) ? form.vaccine : 'Other'} onChange={(e) => setForm({ ...form, vaccine: e.target.value === 'Other' ? '' : e.target.value })}>
                  {COMMON_VACCINES.map((v) => <option key={v} value={v}>{v}</option>)}
                </Select>
              )}</Field>
              <Field label={t('immunizations.familyMember')}>{(id) => (
                <Select id={id} value={form.member_id} onChange={(e) => setForm({ ...form, member_id: e.target.value })}>
                  <option value="">{t('immunizations.select')}</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}</Field>
            </div>
            {!COMMON_VACCINES.includes(form.vaccine) && (
              <Field label={t('immunizations.vaccineName')} required>{(id) => <Input id={id} value={form.vaccine} onChange={(e) => setForm({ ...form, vaccine: e.target.value })} placeholder={t('immunizations.eGTyphoid')} required />}</Field>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('immunizations.dose')}>{(id) => <Input id={id} value={form.dose_label} onChange={(e) => setForm({ ...form, dose_label: e.target.value })} placeholder={t('immunizations.dose1Booster')} />}</Field>
              <Field label={t('immunizations.provider')}>{(id) => <Input id={id} value={form.provider_name} onChange={(e) => setForm({ ...form, provider_name: e.target.value })} />}</Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('immunizations.dateGiven')}>{(id) => <Input id={id} type="date" value={form.date_given} onChange={(e) => setForm({ ...form, date_given: e.target.value })} />}</Field>
              <Field label={t('immunizations.nextDoseDue')}>{(id) => <Input id={id} type="date" value={form.next_due_date} onChange={(e) => setForm({ ...form, next_due_date: e.target.value })} />}</Field>
            </div>
            <Field label={t('immunizations.lotNumber')}>{(id) => <Input id={id} value={form.lot_number} onChange={(e) => setForm({ ...form, lot_number: e.target.value })} />}</Field>
            <Field label={t('immunizations.notes')}>{(id) => <Textarea id={id} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} />}</Field>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>{t('immunizations.cancel')}</Button>
              <Button type="submit">{form.id ? 'Save' : 'Add'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
