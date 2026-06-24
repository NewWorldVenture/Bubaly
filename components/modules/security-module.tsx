'use client';

import { useMemo, useState } from 'react';
import { ShieldAlert, ShieldCheck, Plus, Trash2, Check, RotateCcw, Sparkles, X } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import { SECURITY_KINDS, SECURITY_SEVERITIES, severityMeta, sortEvents, summarizeSecurity, type EventLike } from '@/lib/home/security';
import { type SecurityInsights, type SecurityAIResponse } from '@/lib/home/security-ai';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Event = Tables<'home_security_events'>;
const blank = () => ({ kind: 'alert', severity: 'info', title: '', detail: '', occurred_at: new Date().toISOString().slice(0, 16) });

export function SecurityModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const { data: events, loading } = useRealtimeQuery<Event>({
    table: 'home_security_events', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('home_security_events').select('*').eq('family_id', familyId).order('occurred_at', { ascending: false }),
  });

  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const all = useMemo(() => events ?? [], [events]);
  const sorted = useMemo(() => sortEvents(all as (Event & EventLike)[]), [all]);
  const stats = useMemo(() => summarizeSecurity(all as EventLike[]), [all]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<SecurityInsights | null>(null);
  const [aiInsights, setAiInsights] = useState<SecurityAIResponse | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form || !form.title.trim()) return;
    const row = { kind: form.kind, severity: form.severity, title: form.title.trim(), detail: form.detail.trim() || null, occurred_at: new Date(form.occurred_at).toISOString() };
    const { error } = await createClient().from('home_security_events').insert({ ...row, family_id: familyId, created_by: userId });
    if (error) return toastError(error.message);
    success('Logged'); setForm(null);
  }
  async function toggleResolved(ev: Event) {
    const { error } = await createClient().from('home_security_events').update({ resolved: !ev.resolved, resolved_at: !ev.resolved ? new Date().toISOString() : null }).eq('id', ev.id);
    if (error) toastError(error.message);
  }
  async function remove(id: string) {
    if (!confirm('Delete this event?')) return;
    const { error } = await createClient().from('home_security_events').delete().eq('id', id);
    if (error) toastError(error.message); else success('Deleted');
  }

  async function runAiAssist() {
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/security', { method: 'POST' });
      if (!res.ok) throw new Error('AI request failed');
      const data = await res.json();
      setAiAnalysis(data.analysis ?? null);
      setAiInsights(data.aiInsights ?? null);
    } catch {
      toastError('Could not analyze security events');
    }
    setAiLoading(false);
  }

  if (loading) return <LoadingBlock />;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-base font-semibold"><ShieldAlert className="h-4 w-4 text-brand" /> Security Alerts</h3>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={runAiAssist} disabled={aiLoading}>
            <Sparkles className={cn('w-4 h-4 mr-1', aiLoading && 'animate-pulse')} />
            {aiLoading ? 'Analyzing…' : 'AI Assist'}
          </Button>
          <Button onClick={() => setForm(blank())}><Plus className="h-4 w-4" /> Log event</Button>
        </div>
      </div>

      {(aiAnalysis || aiInsights) && (
        <div className="rounded-xl border border-brand/30 bg-brand/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-brand">
              <Sparkles className="h-3.5 w-3.5" /> Security Insights
            </span>
            <button onClick={() => { setAiAnalysis(null); setAiInsights(null); }} className="text-muted hover:text-fg">
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
          {aiAnalysis && (
            <div className="space-y-1.5">
              <p className="text-sm">{aiAnalysis.summary}</p>
              {aiAnalysis.criticalOpen > 0 && (
                <p className="text-xs text-danger font-medium">⚠ {aiAnalysis.criticalOpen} critical event{aiAnalysis.criticalOpen > 1 ? 's' : ''} unresolved</p>
              )}
            </div>
          )}
          {aiInsights && (
            <div className="space-y-2 border-t border-brand/20 pt-2">
              {aiInsights.priorities.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1">Priorities</p>
                  <ul className="space-y-0.5">
                    {aiInsights.priorities.map((p, i) => <li key={i} className="text-xs text-danger">🔴 {p}</li>)}
                  </ul>
                </div>
              )}
              {aiInsights.suggestions.length > 0 && (
                <div>
                  <p className="text-xs font-semibold mb-1">Suggestions</p>
                  <ul className="space-y-0.5">
                    {aiInsights.suggestions.map((s, i) => <li key={i} className="text-xs text-muted">• {s}</li>)}
                  </ul>
                </div>
              )}
              {aiInsights.safetyTip && (
                <p className="text-xs text-muted italic">💡 {aiInsights.safetyTip}</p>
              )}
            </div>
          )}
        </div>
      )}

      <div className={`flex items-center gap-3 rounded-2xl border p-4 ${stats.allClear ? 'border-success/30 bg-success/5' : 'border-amber-500/30 bg-amber-500/5'}`}>
        {stats.allClear ? <ShieldCheck className="h-6 w-6 text-success" /> : <ShieldAlert className="h-6 w-6 text-amber-500" />}
        <div>
          <p className="font-semibold">{stats.allClear ? 'All clear' : `${stats.open} open alert${stats.open === 1 ? '' : 's'}`}</p>
          <p className="text-xs text-muted">{stats.openCritical} critical · {stats.openWarning} warning · {stats.total} total logged</p>
        </div>
      </div>

      {sorted.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No security events" description="Log alarm triggers, camera events, sensor alerts and tests to keep a clear safety record." />
      ) : (
        <div className="space-y-2">
          {sorted.map((ev) => {
            const meta = severityMeta(ev.severity);
            return (
              <div key={ev.id} className={`flex items-start gap-3 rounded-xl border bg-surface/40 p-3 ${ev.resolved ? 'border-border opacity-60' : meta.tone === 'danger' ? 'border-danger/40' : meta.tone === 'warning' ? 'border-amber-500/40' : 'border-border'}`}>
                <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] ${meta.tone === 'danger' ? 'bg-danger/15 text-danger' : meta.tone === 'warning' ? 'bg-amber-500/15 text-amber-500' : 'bg-border/40 text-muted'}`}>{meta.label}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{ev.title} <span className="text-xs font-normal text-muted">· {ev.kind}</span></p>
                  {ev.detail && <p className="text-xs text-muted">{ev.detail}</p>}
                  <p className="mt-0.5 text-[11px] text-muted">{fmtDate(ev.occurred_at)}{ev.resolved ? ' · resolved' : ''}</p>
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
