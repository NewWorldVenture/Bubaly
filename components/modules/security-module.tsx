'use client';

import { useMemo, useState } from 'react';
import { ShieldAlert, ShieldCheck, Plus, Trash2, Check, RotateCcw } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ErrorState, SkeletonList, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { SECURITY_KINDS, SECURITY_SEVERITIES, severityMeta, sortEvents, summarizeSecurity, type EventLike } from '@/lib/home/security';
import type { Tables } from '@/lib/database.types';

type Event = Tables<'home_security_events'>;
const blank = () => ({ kind: 'alert', severity: 'info', title: '', detail: '', occurred_at: new Date().toISOString().slice(0, 16) });

export function SecurityModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: events, loading, error, refresh } = useRealtimeQuery<Event>({
    table: 'home_security_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('home_security_events').select('*').eq('family_id', familyId).order('occurred_at', { ascending: false }),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [tab, setTab] = useState<'all' | 'open' | 'resolved'>('all');
  const all = useMemo(() => events ?? [], [events]);
  const sorted = useMemo(() => sortEvents(all as (Event & EventLike)[]), [all]);
  const stats = useMemo(() => summarizeSecurity(all as EventLike[]), [all]);

  const visible = useMemo(() => {
    if (tab === 'open') return sorted.filter(e => !e.resolved);
    if (tab === 'resolved') return sorted.filter(e => e.resolved);
    return sorted;
  }, [sorted, tab]);

  const weekCount = useMemo(() => {
    const cutoff = Date.now() - 7 * 86400_000;
    return all.filter(e => new Date(e.occurred_at).getTime() >= cutoff).length;
  }, [all]);

  // 14-day activity strip (today rightmost).
  const strip = useMemo(() => {
    const days = Array.from({ length: 14 }, (_, i) => {
      const d = new Date(Date.now() - (13 - i) * 86400_000);
      return { key: d.toISOString().slice(0, 10), count: 0, critical: false };
    });
    const byKey = new Map(days.map(d => [d.key, d]));
    for (const e of all) {
      const k = new Date(e.occurred_at).toISOString().slice(0, 10);
      const d = byKey.get(k);
      if (d) { d.count += 1; if (e.severity === 'critical' && !e.resolved) d.critical = true; }
    }
    return days;
  }, [all]);
  const stripMax = Math.max(1, ...strip.map(d => d.count));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !form.title.trim()) return;
    const row = { kind: form.kind, severity: form.severity, title: form.title.trim(), detail: form.detail.trim() || null, occurred_at: new Date(form.occurred_at).toISOString() };
    const { error } = await createClient().from('home_security_events').insert({ ...row, family_id: familyId, created_by: userId });
    if (error) return toastError(describeDbError(error));
    success('Logged'); setForm(null);
  }
  async function toggleResolved(ev: Event) {
    const { error } = await createClient().from('home_security_events').update({ resolved: !ev.resolved, resolved_at: !ev.resolved ? new Date().toISOString() : null }).eq('id', ev.id);
    if (error) toastError(describeDbError(error));
  }
  async function remove(id: string) {
    if (!confirm('Delete this event?')) return;
    const { error } = await createClient().from('home_security_events').delete().eq('id', id);
    if (error) toastError(describeDbError(error)); else success('Deleted');
  }

  if (loading) return <SkeletonList />;
  if (error) return <ErrorState message="Could not load security events. Refresh and try again." onRetry={refresh} />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><ShieldAlert className="h-4 w-4 text-brand-text" /> Security Alerts</h3>
        <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Log event</Button>
      </div>

      <div className={`flex items-center gap-3 rounded-2xl border p-4 ${stats.allClear ? 'border-success/30 bg-success/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
        {stats.allClear ? <ShieldCheck className="h-6 w-6 text-success" /> : <ShieldAlert className="h-6 w-6 text-amber-500" />}
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{stats.allClear ? 'All clear' : `${stats.open} open alert${stats.open === 1 ? '' : 's'}`}</p>
          <p className="text-xs text-muted">{stats.openCritical} critical Â· {stats.openWarning} warning Â· {stats.total} total logged</p>
        </div>
        {/* 14-day activity strip */}
        <div className="hidden items-end gap-0.5 sm:flex" aria-hidden>
          {strip.map(d => (
            <span key={d.key} title={`${d.key}: ${d.count}`}
              className={`w-1.5 rounded-t ${d.critical ? 'bg-danger' : d.count > 0 ? 'bg-brand/70' : 'bg-border'}`}
              style={{ height: `${6 + (d.count / stripMax) * 22}px` }} />
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid-stats">
        {[
          { label: 'Open', value: stats.open, icon: 'ðŸš¨', color: stats.open ? 'text-amber-400' : 'text-success' },
          { label: 'Critical', value: stats.openCritical, icon: 'ðŸ”´', color: stats.openCritical ? 'text-danger' : 'text-muted' },
          { label: 'This week', value: weekCount, icon: 'ðŸ—“ï¸', color: 'text-brand-text' },
          { label: 'Resolved', value: stats.total - stats.open, icon: 'âœ…', color: 'text-success' },
        ].map(s => (
          <div key={s.label} className="stat-card">
            <span className="text-2xl">{s.icon}</span>
            <div>
              <div className={`text-2xl font-bold ${s.color}`}>{s.value}</div>
              <div className="text-[11px] text-muted">{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Filter tabs */}
      <div className="tab-bar">
        {(['all', 'open', 'resolved'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`tab-item capitalize ${tab === t ? 'tab-item-active' : 'tab-item-inactive'}`}>
            {t}{t === 'open' && stats.open > 0 ? ` (${stats.open})` : ''}
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No security events" description="Log alarm triggers, camera events, sensor alerts and tests to keep a clear safety record." />
      ) : (
        <div className="space-y-2">
          {visible.map((ev) => {
            const meta = severityMeta(ev.severity);
            return (
              <div key={ev.id} className={`flex items-start gap-3 rounded-xl border bg-surface/40 p-3 ${ev.resolved ? 'border-border opacity-60' : meta.tone === 'danger' ? 'border-danger/40' : meta.tone === 'warning' ? 'border-amber-500/40' : 'border-border'}`}>
                <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] ${meta.tone === 'danger' ? 'bg-danger/15 text-danger' : meta.tone === 'warning' ? 'bg-amber-500/15 text-amber-500' : 'bg-border/40 text-muted'}`}>{meta.label}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{ev.title} <span className="text-xs font-normal text-muted">Â· {ev.kind}</span></p>
                  {ev.detail && <p className="text-xs text-muted">{ev.detail}</p>}
                  <p className="mt-0.5 text-[11px] text-muted">{fmtDate(ev.occurred_at)}{ev.resolved ? ' Â· resolved' : ''}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button onClick={() => toggleResolved(ev)} className="text-muted hover:text-fg" title={ev.resolved ? 'Reopen' : 'Resolve'}>{ev.resolved ? <RotateCcw className="h-4 w-4" /> : <Check className="h-4 w-4" />}</button>
                  <button onClick={() => remove(ev.id)} className="text-muted hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {form && (
        <Modal open onClose={() => setForm(null)} title="Log security event">
          <form onSubmit={save} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="Type">{(id) => <Select id={id} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>{SECURITY_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</Select>}</Field>
              <Field label="Severity">{(id) => <Select id={id} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>{SECURITY_SEVERITIES.map((s) => <option key={s} value={s}>{severityMeta(s).label}</option>)}</Select>}</Field>
            </div>
            <Field label="Title">{(id) => <Input id={id} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Front door opened at 2am" />}</Field>
            <Field label="When">{(id) => <Input id={id} type="datetime-local" value={form.occurred_at} onChange={(e) => setForm({ ...form, occurred_at: e.target.value })} />}</Field>
            <Field label="Detail">{(id) => <Textarea id={id} value={form.detail} onChange={(e) => setForm({ ...form, detail: e.target.value })} />}</Field>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit">Log it</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
