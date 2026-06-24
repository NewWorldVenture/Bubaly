'use client';

import { useMemo, useState } from 'react';
import { MonitorSmartphone, Plus, Trash2, Flame, Gauge, Settings2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { AiInsight } from '@/components/ai/ai-insight';
import { fmtDate } from '@/lib/utils/format';
import {
  SCREEN_CATEGORIES, categoryMeta, formatMinutes, minutesOnDate, minutesInWindow,
  categoryBreakdown, balanceScore, limitProgress, underLimitStreak, type ScreenEntryLike,
} from '@/lib/screen-time/insights';
import type { Tables } from '@/lib/database.types';

type Entry = Tables<'screen_time_entries'>;
type Limit = Tables<'screen_time_limits'>;

const today = () => new Date().toISOString().slice(0, 10);
const blank = () => ({ id: '', member_id: '', entry_date: today(), minutes: '30', category: 'entertainment', device: '', note: '' });

export function ScreenTimeModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: entries, loading } = useRealtimeQuery<Entry>({
    table: 'screen_time_entries', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('screen_time_entries').select('*').eq('family_id', familyId).order('entry_date', { ascending: false }),
  });
  const { data: limits } = useRealtimeQuery<Limit>({
    table: 'screen_time_limits', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('screen_time_limits').select('*').eq('family_id', familyId),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [limitFor, setLimitFor] = useState<{ memberId: string; minutes: string } | null>(null);

  const all = useMemo(() => entries ?? [], [entries]);
  const limitByMember = useMemo(() => new Map((limits ?? []).map((l) => [l.member_id, l.daily_minutes])), [limits]);

  const memberIds = useMemo(() => {
    const ids = new Set<string>();
    for (const e of all) if (e.member_id) ids.add(e.member_id);
    for (const m of members) ids.add(m.id);
    return [...ids];
  }, [all, members]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    const supabase = createClient();
    const row = {
      member_id: form.member_id || null,
      entry_date: form.entry_date,
      minutes: Math.max(0, Math.min(1440, parseInt(form.minutes, 10) || 0)),
      category: form.category,
      device: form.device.trim() || null,
      note: form.note.trim() || null,
    };
    const { error } = form.id
      ? await supabase.from('screen_time_entries').update(row).eq('id', form.id)
      : await supabase.from('screen_time_entries').insert({ ...row, family_id: familyId, logged_by: userId });
    if (error) return toastError(error.message);
    success(form.id ? 'Updated' : 'Logged');
    setForm(null);
  }

  async function remove(id: string) {
    if (!confirm('Delete this entry?')) return;
    const { error } = await createClient().from('screen_time_entries').delete().eq('id', id);
    if (error) toastError(error.message); else success('Deleted');
  }

  async function saveLimit(e: React.FormEvent) {
    e.preventDefault();
    if (!limitFor) return;
    const minutes = Math.max(0, Math.min(1440, parseInt(limitFor.minutes, 10) || 0));
    const { error } = await createClient()
      .from('screen_time_limits')
      .upsert({ family_id: familyId, member_id: limitFor.memberId, daily_minutes: minutes, created_by: userId }, { onConflict: 'family_id,member_id' });
    if (error) return toastError(error.message);
    success('Daily limit saved');
    setLimitFor(null);
  }

  if (loading) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><MonitorSmartphone className="h-4 w-4 text-brand" /> Screen Time & Balance</h3>
        <div className="flex items-center gap-2">
          <AiInsight kind="screen_time" iconOnly />
          <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Log time</Button>
        </div>
      </div>

      {/* Per-child cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {memberIds.map((mid) => {
          const mEntries = all.filter((e) => e.member_id === mid) as ScreenEntryLike[];
          const m = memberById.get(mid);
          const usedToday = minutesOnDate(mEntries, today());
          const week = minutesInWindow(mEntries, 7);
          const limit = limitByMember.get(mid) ?? 0;
          const prog = limitProgress(usedToday, limit);
          const streak = underLimitStreak(mEntries, limit);
          const balance = balanceScore(mEntries.filter((e) => minutesInWindow([e], 7) > 0));
          const breakdown = categoryBreakdown(mEntries).slice(0, 3);
          return (
            <div key={mid} className="rounded-2xl border border-border bg-surface/40 p-4">
              <div className="flex items-center gap-2">
                <Avatar name={m?.display_name ?? 'Member'} size={28} />
                <p className="font-semibold">{m?.display_name ?? 'Member'}</p>
                <button onClick={() => setLimitFor({ memberId: mid, minutes: String(limit || 120) })} className="ml-auto text-muted hover:text-fg" title="Set daily limit">
                  <Settings2 className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-3 flex items-end justify-between">
                <div>
                  <p className="text-2xl font-bold">{formatMinutes(usedToday)}</p>
                  <p className="text-xs text-muted">today{limit > 0 ? ` / ${formatMinutes(limit)}` : ''}</p>
                </div>
                <div className="text-right text-xs">
                  <p className="inline-flex items-center gap-1"><Gauge className="h-3 w-3 text-brand" /> {balance}/100 balance</p>
                  <p className="text-muted">{formatMinutes(week)} this week</p>
                </div>
              </div>
              {limit > 0 && (
                <div className="mt-3">
                  <div className="h-2 overflow-hidden rounded-full bg-border/50">
                    <div className={`h-full rounded-full ${prog.over ? 'bg-danger' : 'bg-success'}`} style={{ width: `${prog.pct}%` }} />
                  </div>
                  <p className="mt-1 flex items-center justify-between text-[11px] text-muted">
                    <span>{prog.over ? `Over by ${formatMinutes(prog.used - prog.limit)}` : `${formatMinutes(prog.remaining)} left`}</span>
                    {streak > 0 && <span className="inline-flex items-center gap-1 text-amber-500"><Flame className="h-3 w-3" /> {streak}d under</span>}
                  </p>
                </div>
              )}
              {breakdown.length > 0 && (
                <div className="mt-3 space-y-1">
                  {breakdown.map((b) => (
                    <p key={b.category} className="flex items-center justify-between text-xs">
                      <span className={categoryMeta(b.category).productive ? 'text-success' : 'text-muted'}>{categoryMeta(b.category).label}</span>
                      <span className="text-muted">{formatMinutes(b.minutes)}</span>
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Recent entries */}
      <div className="space-y-2">
        {all.length === 0 ? (
          <EmptyState icon={MonitorSmartphone} title="No screen time logged" description="Log time by category to track balance and limits." />
        ) : all.slice(0, 50).map((e) => {
          const m = e.member_id ? memberById.get(e.member_id) : null;
          return (
            <div key={e.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 p-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm">
                  <span className="font-medium">{formatMinutes(e.minutes)}</span> · <span className={categoryMeta(e.category).productive ? 'text-success' : ''}>{categoryMeta(e.category).label}</span>
                  {m ? ` · ${m.display_name}` : ''}{e.device ? ` · ${e.device}` : ''}
                </p>
                {e.note && <p className="text-xs text-muted">{e.note}</p>}
                <p className="mt-0.5 text-[11px] text-muted">{fmtDate(e.entry_date)}</p>
              </div>
              <button onClick={() => remove(e.id)} className="text-muted hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
            </div>
          );
        })}
      </div>

      {form && (
        <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit screen time' : 'Log screen time'}>
          <form onSubmit={save} className="space-y-3">
            <Field label="Child">
              {(id) => (
                <Select id={id} value={form.member_id} onChange={(ev) => setForm({ ...form, member_id: ev.target.value })}>
                  <option value="">— Select —</option>
                  {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
                </Select>
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Date">{(id) => <Input id={id} type="date" value={form.entry_date} onChange={(ev) => setForm({ ...form, entry_date: ev.target.value })} />}</Field>
              <Field label="Minutes">{(id) => <Input id={id} type="number" min="0" max="1440" value={form.minutes} onChange={(ev) => setForm({ ...form, minutes: ev.target.value })} />}</Field>
            </div>
            <Field label="Category">
              {(id) => (
                <Select id={id} value={form.category} onChange={(ev) => setForm({ ...form, category: ev.target.value })}>
                  {SCREEN_CATEGORIES.map((c) => <option key={c} value={c}>{categoryMeta(c).label}</option>)}
                </Select>
              )}
            </Field>
            <Field label="Device (optional)">{(id) => <Input id={id} value={form.device} onChange={(ev) => setForm({ ...form, device: ev.target.value })} placeholder="iPad, Switch, TV…" />}</Field>
            <Field label="Note (optional)">{(id) => <Textarea id={id} value={form.note} onChange={(ev) => setForm({ ...form, note: ev.target.value })} />}</Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">{form.id ? 'Save' : 'Log it'}</Button>
            </div>
          </form>
        </Modal>
      )}

      {limitFor && (
        <Modal open onClose={() => setLimitFor(null)} title="Daily screen-time limit">
          <form onSubmit={saveLimit} className="space-y-3">
            <Field label="Daily limit (minutes)">
              {(id) => <Input id={id} type="number" min="0" max="1440" value={limitFor.minutes} onChange={(ev) => setLimitFor({ ...limitFor, minutes: ev.target.value })} />}
            </Field>
            <p className="text-xs text-muted">Set 0 to remove the limit.</p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setLimitFor(null)}>Cancel</Button>
              <Button type="submit">Save limit</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
