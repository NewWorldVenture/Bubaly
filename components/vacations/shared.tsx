'use client';

import { useMemo, useState } from 'react';
import { Plus, Pencil, Trash2, type LucideIcon } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError, wroteNoRows } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingBlock, EmptyState } from '@/components/ui/states';
import { useTranslations } from '@/components/i18n/locale-provider';
import { useFamilyClock } from '@/components/i18n/use-format';
import { datetimeLocalToInstant, instantToDatetimeLocal } from '@/lib/time/datetime-local';
import { tripLabel } from '@/components/vacations/trip-labels';

// ---- small presentational helpers reused across trip pages ----

export function SectionHeader({ icon: Icon, title, action }: { icon: LucideIcon; title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex items-center gap-2 text-lg font-semibold"><Icon className="h-5 w-5 text-brand-text" /> {title}</h2>
      {action}
    </div>
  );
}

export function StatPill({ label, value, tone = '' }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-surface/40 p-3 ${tone}`}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold">{value}</p>
    </div>
  );
}

export function Progress({ pct, tone = 'bg-brand' }: { pct: number; tone?: string }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-elevated">
      <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

// ---- schema-driven CRUD section ----

export type FieldType = 'text' | 'textarea' | 'number' | 'money' | 'date' | 'datetime' | 'time' | 'select' | 'checkbox' | 'member';
export type FieldDef = {
  name: string;
  label: string;
  type: FieldType;
  options?: { value: string; label: string }[];
  required?: boolean;
  half?: boolean;
  placeholder?: string;
};

type Row = Record<string, unknown> & { id: string };

function blankFrom(fields: FieldDef[]): Record<string, string | boolean> {
  const o: Record<string, string | boolean> = { id: '' };
  for (const f of fields) o[f.name] = f.type === 'checkbox' ? false : '';
  return o;
}

/**
 * Convert the form's string values into a DB row, honoring field types.
 *
 * A `datetime` field is the naive `YYYY-MM-DDTHH:mm` of a `datetime-local`
 * input — a reading on the FAMILY's clock. Written raw into a `timestamptz`
 * column it was resolved in the database's zone (UTC), so a Los Angeles
 * parent's 2:30 PM flight was stored as 14:30Z and shown as 7:30 AM (TIME-003).
 * It is resolved into the instant it names in `timeZone` here.
 */
export function toRow(form: Record<string, string | boolean>, fields: FieldDef[], timeZone: string): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const f of fields) {
    const v = form[f.name];
    if (f.type === 'checkbox') { row[f.name] = !!v; continue; }
    const s = (v as string ?? '').trim();
    if (f.type === 'money') row[f.name] = s ? Math.round(parseFloat(s) * 100) : null;
    else if (f.type === 'number') row[f.name] = s ? Math.round(parseFloat(s)) : null;
    else if (f.type === 'datetime') row[f.name] = s ? datetimeLocalToInstant(s, timeZone) : null;
    else row[f.name] = s || null;
  }
  return row;
}

/** Hydrate the form from an existing row for editing; a stored instant comes back as the family's wall clock. */
export function fromRow(row: Row, fields: FieldDef[], timeZone: string): Record<string, string | boolean> {
  const o: Record<string, string | boolean> = { id: row.id };
  for (const f of fields) {
    const v = row[f.name];
    if (f.type === 'checkbox') o[f.name] = !!v;
    else if (f.type === 'money') o[f.name] = v == null ? '' : String((v as number) / 100);
    else if (f.type === 'datetime') o[f.name] = v ? instantToDatetimeLocal(String(v), timeZone) : '';
    else if (f.type === 'time') o[f.name] = v ? String(v).slice(0, 5) : '';
    else o[f.name] = v == null ? '' : String(v);
  }
  return o;
}

export function TripCrudSection<T extends Row>({
  table, vacationId, title, icon, fields, renderRow, emptyText, addLabel = 'Add', orderBy,
}: {
  table: string;
  vacationId: string;
  title: string;
  icon: LucideIcon;
  fields: FieldDef[];
  renderRow: (row: T, members: Map<string, { display_name: string; color: string | null }>) => React.ReactNode;
  emptyText: string;
  addLabel?: string;
  orderBy?: (a: T, b: T) => number;
}) {
  const t = useTranslations();
  const tr = useTranslations();
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const clock = useFamilyClock();
  const memberMap = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data, loading, error, refresh } = useRealtimeQuery<T>({
    table, familyId, deps: [familyId, vacationId],
    // Generic over an arbitrary table name, so we step outside the typed client here.
    fetcher: (sb) => (sb as never as { from: (t: string) => { select: (c: string) => { eq: (k: string, v: string) => { eq: (k: string, v: string) => PromiseLike<{ data: T[] | null; error: { message: string } | null }> } } } })
      .from(table).select('*').eq('family_id', familyId).eq('vacation_id', vacationId),
  });

  const rows = useMemo(() => (orderBy ? [...data].sort(orderBy) : data), [data, orderBy]);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<Record<string, string | boolean> | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    // A pending button AND a re-entrance guard. The guard is not redundant:
    // `disabled` covers the click, this covers the ENTER KEY, which submits the
    // form without touching the button at all.
    //
    // preventDefault() stays ABOVE it. Returning before it on the second submit
    // would hand the form to the browser's own native submission — a full page
    // navigation — which is worse than the double insert this exists to stop.
    if (saving) return;
    setSaving(true);
    try {
      if (!form) return;
      const req = fields.find((f) => f.required && !String(form[f.name] ?? '').trim());
      if (req) return toastError(t('trips.fieldIsRequired', { field: tripLabel(t, req.label) }));
      const supabase = createClient() as any;
      const row = toRow(form, fields, clock.timeZone);
      const id = form.id as string;
      // Under RLS a refused row comes back with no error and zero rows, which this used to report as done. Audit C1-S9-84.
      const { data: saved, error } = id
        ? await supabase.from(table).update(row).eq('id', id).select('id')
        : await supabase.from(table).insert({ ...row, family_id: familyId, vacation_id: vacationId, created_by: userId }).select('id');
      if (error) return toastError(describeDbError(error));
      if (wroteNoRows(saved)) return toastError(tr('errors.thatChangeWasNotSaved'));
      success(id ? 'Saved' : 'Added');
      setForm(null);
      // No `vacation_*` table is in the realtime publication, so nothing else
      // will bring the new row onto the screen: the list is re-read here.
      void refresh();
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!confirm(t('shared.deleteThisItem'))) return;
    const { data: removed, error } = await (createClient() as any).from(table).delete().eq('id', id).select('id');
    if (error) toastError(describeDbError(error));
    else if (wroteNoRows(removed)) toastError(tr('errors.thatChangeWasNotSaved'));
    else {
      success(t('shared.deleted'));
      void refresh();
    }
  }

  return (
    <div className="space-y-4">
      <SectionHeader icon={icon} title={title} action={
        <Button size="sm" onClick={() => setForm(blankFrom(fields))}><Plus className="h-4 w-4" /> {tripLabel(t, addLabel)}</Button>
      } />
      {loading ? <LoadingBlock /> : error ? <ErrorState message={t('shared.sectionLoadFailed')} onRetry={refresh} /> : rows.length === 0 ? (
        <EmptyState icon={icon} title={emptyText} description={t('shared.addYourFirstOneTo')} />
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li key={row.id} className="rounded-2xl border border-border bg-surface/40 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">{renderRow(row, memberMap)}</div>
                <div className="flex shrink-0 gap-1">
                  <button aria-label={t('a11y.edit')} onClick={() => setForm(fromRow(row, fields, clock.timeZone))} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-fg"><Pencil className="h-4 w-4" /></button>
                  <button aria-label={t('a11y.delete')} onClick={() => remove(row.id)} className="rounded-lg p-1.5 text-muted hover:bg-elevated hover:text-danger"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? t('trips.editSection', { section: title }) : t('trips.addSection', { section: title })}>
          <form onSubmit={save} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {fields.map((f) => {
                const span = f.half ? '' : 'col-span-2';
                const set = (val: string | boolean) => setForm({ ...form, [f.name]: val });
                if (f.type === 'checkbox') return (
                  <label key={f.name} className={`${span} flex items-center gap-2 text-sm`}>
                    <input type="checkbox" checked={!!form[f.name]} onChange={(e) => set(e.target.checked)} className="h-4 w-4 rounded border-border" />
                    {tripLabel(t, f.label)}
                  </label>
                );
                return (
                  <div key={f.name} className={span}>
                    <Field label={tripLabel(t, f.label)} required={f.required}>{(id) => {
                      const val = String(form[f.name] ?? '');
                      if (f.type === 'textarea') return <Textarea id={id} value={val} onChange={(e) => set(e.target.value)} rows={2} placeholder={f.placeholder} />;
                      if (f.type === 'select') return (
                        <Select id={id} value={val} onChange={(e) => set(e.target.value)}>
                          {!f.required && <option value="">—</option>}
                          {f.options?.map((o) => <option key={o.value} value={o.value}>{tripLabel(t, o.label)}</option>)}
                        </Select>
                      );
                      if (f.type === 'member') return (
                        <Select id={id} value={val} onChange={(e) => set(e.target.value)}>
                          <option value="">{t('shared.select')}</option>
                          {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                        </Select>
                      );
                      const inputType = f.type === 'money' || f.type === 'number' ? 'number' : f.type === 'datetime' ? 'datetime-local' : f.type;
                      return <Input id={id} type={inputType} step={f.type === 'money' ? '0.01' : undefined} value={val} onChange={(e) => set(e.target.value)} placeholder={f.placeholder} />;
                    }}</Field>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>{tr('shared.cancel')}</Button>
              <Button type="submit" loading={saving}>{form.id ? 'Save' : 'Add'}</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}

