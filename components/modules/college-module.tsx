'use client';

import { useMemo, useState } from 'react';
import {
  Plus, Trash2, Sparkles, ChevronRight, GraduationCap, Award,
  AlertTriangle, CalendarClock, X,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import type { CollegeInsights, CollegeAIResponse } from '@/lib/college/college-ai';
import {
  APP_STATUSES, SCHOLARSHIP_STATUSES, appStatusMeta, scholarshipStatusMeta,
  deadlineUrgency, upcomingDeadlines, netCost, totalScholarships,
  collegeSummary, fmtMoney, fmtDate, type DeadlineUrgency,
} from '@/lib/college/planner';

type CollegeApp = Tables<'college_applications'>;
type Scholarship = Tables<'scholarships'>;

const STATUS_STYLE: Record<string, string> = {
  researching: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  applying: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  submitted: 'bg-purple-500/10 text-purple-400 border-purple-500/30',
  accepted: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  waitlisted: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  rejected: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
  enrolled: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  declined: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
  awarded: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  denied: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
};

const URGENCY_STYLE: Record<DeadlineUrgency, string> = {
  past: 'text-rose-400',
  urgent: 'text-amber-400',
  upcoming: 'text-muted',
  none: 'text-muted',
};

export function CollegeModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const apps = useRealtimeQuery<CollegeApp>({
    table: 'college_applications', familyId,
    fetcher: (s) => s.from('college_applications').select('*').eq('family_id', familyId).eq('is_active', true).order('deadline'),
    deps: [familyId],
  });

  const scholarships = useRealtimeQuery<Scholarship>({
    table: 'scholarships', familyId,
    fetcher: (s) => s.from('scholarships').select('*').eq('family_id', familyId).eq('is_active', true).order('deadline'),
    deps: [familyId],
  });

  const [tab, setTab] = useState<'applications' | 'scholarships'>('applications');
  const [addAppOpen, setAddAppOpen] = useState(false);
  const [addScholarshipOpen, setAddScholarshipOpen] = useState(false);
  const [selectedApp, setSelectedApp] = useState<CollegeApp | null>(null);
  const [selectedScholarship, setSelectedScholarship] = useState<Scholarship | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<CollegeInsights | null>(null);
  const [aiInsights, setAiInsights] = useState<CollegeAIResponse | null>(null);

  async function runAiAssist() {
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/college', { method: 'POST' });
      const data = await res.json();
      if (data.analysis) setAiAnalysis(data.analysis);
      if (data.aiInsights) setAiInsights(data.aiInsights);
    } catch { /* ignore */ } finally { setAiLoading(false); }
  }

  const summary = useMemo(() => {
    if (!apps.data || !scholarships.data) return null;
    return collegeSummary(apps.data, scholarships.data);
  }, [apps.data, scholarships.data]);

  const deadlines = useMemo(() => {
    if (!apps.data) return [];
    return upcomingDeadlines(apps.data);
  }, [apps.data]);

  if (apps.loading) return <LoadingBlock />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="College & Scholarship Planner"
        action={
          <Button variant="outline" size="sm" onClick={runAiAssist} loading={aiLoading}>
            <Sparkles className="h-4 w-4" /> AI Assist
          </Button>
        }
      />

      {(aiAnalysis || aiInsights) && (
        <div className="mb-5 rounded-xl border border-brand/30 bg-brand/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand">
              <Sparkles className="h-4 w-4" /> AI College Insights
            </div>
            <button onClick={() => { setAiAnalysis(null); setAiInsights(null); }} className="text-muted hover:text-fg"><X className="h-4 w-4" /></button>
          </div>
          {aiAnalysis && <p className="mb-2 text-xs text-muted">{aiAnalysis.summary}</p>}
          {aiInsights?.suggestions && aiInsights.suggestions.length > 0 && (
            <div className="mb-2">
              <p className="text-xs font-medium mb-1">Suggestions</p>
              <ul className="space-y-1">{aiInsights.suggestions.map((s, i) => <li key={i} className="text-xs text-muted">{'•'} {s}</li>)}</ul>
            </div>
          )}
          {aiInsights?.deadlineTips && aiInsights.deadlineTips.length > 0 && (
            <div className="mb-2">
              <p className="text-xs font-medium mb-1">Deadline Tips</p>
              <ul className="space-y-1">{aiInsights.deadlineTips.map((s, i) => <li key={i} className="text-xs text-muted">{'•'} {s}</li>)}</ul>
            </div>
          )}
          {aiInsights?.strategyTip && <p className="text-xs text-muted italic">{aiInsights.strategyTip}</p>}
        </div>
      )}

      {/* Summary */}
      {summary && summary.totalApps > 0 && (
        <div className="rounded-xl border border-border bg-surface/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{summary.totalApps} application{summary.totalApps !== 1 ? 's' : ''}</span>
            {summary.scholarshipTotal > 0 && (
              <span className="text-sm font-semibold flex items-center gap-1">
                <Award className="w-3.5 h-3.5" /> {fmtMoney(summary.scholarshipTotal)} awarded
              </span>
            )}
          </div>
          <p className="text-sm font-medium">{summary.text}</p>
        </div>
      )}

      {/* Deadline alerts */}
      {deadlines.filter((d) => d.urgency === 'urgent').length > 0 && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-2">
          <div className="flex items-center gap-2 text-amber-400">
            <AlertTriangle className="w-4 h-4" />
            <span className="text-sm font-semibold">Upcoming deadlines</span>
          </div>
          {deadlines.filter((d) => d.urgency === 'urgent').map((d) => (
            <div key={d.id} className="text-xs text-amber-300">
              {d.name} — {fmtDate(d.deadline)} ({d.daysUntil}d)
            </div>
          ))}
        </div>
      )}

      {/* Tab selector */}
      <div className="flex gap-2">
        <button onClick={() => setTab('applications')}
          className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
            tab === 'applications' ? 'bg-primary text-primary-foreground' : 'bg-surface/60 text-muted hover:text-foreground')}>
          <GraduationCap className="w-3.5 h-3.5 inline mr-1" /> Applications
        </button>
        <button onClick={() => setTab('scholarships')}
          className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
            tab === 'scholarships' ? 'bg-primary text-primary-foreground' : 'bg-surface/60 text-muted hover:text-foreground')}>
          <Award className="w-3.5 h-3.5 inline mr-1" /> Scholarships
        </button>
      </div>

      {/* Applications tab */}
      {tab === 'applications' && (
        <>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAddAppOpen(true)}><Plus className="w-4 h-4 mr-1" /> Add Application</Button>
          </div>
          {(!apps.data || apps.data.length === 0) ? (
            <EmptyState title="No applications" description="Track college applications, deadlines, and decisions." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {apps.data.map((a) => {
                const meta = appStatusMeta(a.status);
                const urg = deadlineUrgency(a.deadline);
                const cost = netCost(a);
                return (
                  <button key={a.id} onClick={() => setSelectedApp(a)}
                    className="text-left rounded-xl border border-border bg-surface/60 p-4 hover:border-primary/40 transition-colors">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm font-semibold">{a.school_name}</p>
                        <p className="text-xs text-muted">{a.program || a.location || 'No program set'}</p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted" />
                    </div>
                    <div className="mt-2 flex items-center gap-2 flex-wrap">
                      <span className={cn('text-xs px-2 py-0.5 rounded-full border', STATUS_STYLE[a.status] || STATUS_STYLE.researching)}>
                        {meta.emoji} {meta.label}
                      </span>
                      {a.deadline && urg !== 'none' && (
                        <span className={cn('text-xs', URGENCY_STYLE[urg])}>
                          <CalendarClock className="w-3 h-3 inline" /> {fmtDate(a.deadline)}
                        </span>
                      )}
                      {cost != null && <span className="text-xs text-muted">Net: {fmtMoney(cost)}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Scholarships tab */}
      {tab === 'scholarships' && (
        <>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAddScholarshipOpen(true)}><Plus className="w-4 h-4 mr-1" /> Add Scholarship</Button>
          </div>
          {(!scholarships.data || scholarships.data.length === 0) ? (
            <EmptyState title="No scholarships" description="Track scholarship applications and awards." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {scholarships.data.map((s) => {
                const meta = scholarshipStatusMeta(s.status);
                return (
                  <button key={s.id} onClick={() => setSelectedScholarship(s)}
                    className="text-left rounded-xl border border-border bg-surface/60 p-4 hover:border-primary/40 transition-colors">
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm font-semibold">{s.name}</p>
                        <p className="text-xs text-muted">{s.provider}</p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted" />
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <span className={cn('text-xs px-2 py-0.5 rounded-full border', STATUS_STYLE[s.status] || STATUS_STYLE.researching)}>
                        {meta.emoji} {meta.label}
                      </span>
                      {s.amount != null && <span className="text-sm font-semibold">{fmtMoney(s.amount)}</span>}
                      {s.renewable && <span className="text-xs text-muted">🔄 Renewable</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Modals */}
      {addAppOpen && (
        <AddAppModal familyId={familyId} userId={userId} members={members}
          onClose={() => setAddAppOpen(false)}
          onSuccess={() => { setAddAppOpen(false); success('Application added'); }} />
      )}
      {addScholarshipOpen && (
        <AddScholarshipModal familyId={familyId} userId={userId} members={members}
          onClose={() => setAddScholarshipOpen(false)}
          onSuccess={() => { setAddScholarshipOpen(false); success('Scholarship added'); }} />
      )}
      {selectedApp && (
        <AppDetailModal app={selectedApp} familyId={familyId}
          onClose={() => setSelectedApp(null)}
          onDelete={() => { setSelectedApp(null); success('Application removed'); }} />
      )}
      {selectedScholarship && (
        <ScholarshipDetailModal scholarship={selectedScholarship} familyId={familyId}
          onClose={() => setSelectedScholarship(null)}
          onDelete={() => { setSelectedScholarship(null); success('Scholarship removed'); }} />
      )}
    </div>
  );
}

/* ── Add Application Modal ───────────────────────────────────────────── */

function AddAppModal({ familyId, userId, members, onClose, onSuccess }: {
  familyId: string; userId: string; members: { id: string; display_name: string }[];
  onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('college_applications').insert({
      family_id: familyId,
      created_by: userId,
      member_id: String(f.get('member_id') ?? '') || null,
      school_name: String(f.get('school_name') ?? ''),
      location: String(f.get('location') ?? ''),
      program: String(f.get('program') ?? ''),
      status: String(f.get('status') ?? 'researching') as CollegeApp['status'],
      deadline: String(f.get('deadline') ?? '') || null,
      decision_date: String(f.get('decision_date') ?? '') || null,
      tuition: f.get('tuition') ? Number(f.get('tuition')) : null,
      financial_aid: f.get('financial_aid') ? Number(f.get('financial_aid')) : null,
      notes: String(f.get('notes') ?? ''),
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  return (
    <Modal open onClose={onClose} title="Add College Application">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="School Name" required>{(id) => <Input id={id} name="school_name" autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Location">{(id) => <Input id={id} name="location" placeholder="City, State" />}</Field>
          <Field label="Program">{(id) => <Input id={id} name="program" placeholder="Computer Science" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">{(id) =>
            <Select id={id} name="status" defaultValue="researching">
              {APP_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.emoji} {s.label}</option>)}
            </Select>
          }</Field>
          <Field label="For">{(id) =>
            <Select id={id} name="member_id" defaultValue="">
              <option value="">Anyone</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </Select>
          }</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Deadline">{(id) => <Input id={id} name="deadline" type="date" />}</Field>
          <Field label="Decision Date">{(id) => <Input id={id} name="decision_date" type="date" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tuition">{(id) => <Input id={id} name="tuition" type="number" step="1" min="0" />}</Field>
          <Field label="Financial Aid">{(id) => <Input id={id} name="financial_aid" type="number" step="1" min="0" />}</Field>
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Add Scholarship Modal ───────────────────────────────────────────── */

function AddScholarshipModal({ familyId, userId, members, onClose, onSuccess }: {
  familyId: string; userId: string; members: { id: string; display_name: string }[];
  onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('scholarships').insert({
      family_id: familyId,
      created_by: userId,
      member_id: String(f.get('member_id') ?? '') || null,
      name: String(f.get('name') ?? ''),
      provider: String(f.get('provider') ?? ''),
      amount: f.get('amount') ? Number(f.get('amount')) : null,
      status: String(f.get('status') ?? 'researching') as Scholarship['status'],
      deadline: String(f.get('deadline') ?? '') || null,
      renewable: f.get('renewable') === 'on',
      requirements: String(f.get('requirements') ?? ''),
      notes: String(f.get('notes') ?? ''),
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  return (
    <Modal open onClose={onClose} title="Add Scholarship">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Scholarship Name" required>{(id) => <Input id={id} name="name" autoFocus />}</Field>
        <Field label="Provider / Organization">{(id) => <Input id={id} name="provider" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Amount">{(id) => <Input id={id} name="amount" type="number" step="1" min="0" />}</Field>
          <Field label="Status">{(id) =>
            <Select id={id} name="status" defaultValue="researching">
              {SCHOLARSHIP_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.emoji} {s.label}</option>)}
            </Select>
          }</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Deadline">{(id) => <Input id={id} name="deadline" type="date" />}</Field>
          <Field label="For">{(id) =>
            <Select id={id} name="member_id" defaultValue="">
              <option value="">Anyone</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </Select>
          }</Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="renewable" className="rounded border-border" />
          Renewable each year
        </label>
        <Field label="Requirements">{(id) => <Textarea id={id} name="requirements" rows={2} />}</Field>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── App Detail Modal ────────────────────────────────────────────────── */

function AppDetailModal({ app: a, familyId, onClose, onDelete }: {
  app: CollegeApp; familyId: string; onClose: () => void; onDelete: () => void;
}) {
  const { error: toastError } = useToast();
  const meta = appStatusMeta(a.status);
  const cost = netCost(a);

  async function handleDelete() {
    const { error } = await createClient().from('college_applications').update({ is_active: false }).eq('id', a.id);
    if (error) { toastError(error.message); return; }
    onDelete();
  }

  const rows: [string, string][] = [
    ['Location', a.location || '—'],
    ['Program', a.program || '—'],
    ['Status', `${meta.emoji} ${meta.label}`],
    ['Deadline', fmtDate(a.deadline)],
    ['Decision Date', fmtDate(a.decision_date)],
    ['Tuition', fmtMoney(a.tuition)],
    ['Financial Aid', fmtMoney(a.financial_aid)],
    ['Net Cost', cost != null ? fmtMoney(cost) : '—'],
  ];

  return (
    <Modal open onClose={onClose} title={a.school_name}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted">{k}</span>
              <span className="font-medium">{v}</span>
            </div>
          ))}
        </div>
        {a.notes && (
          <div className="rounded-lg border border-border bg-surface/40 p-3">
            <p className="text-xs text-muted mb-1">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{a.notes}</p>
          </div>
        )}
        <div className="flex justify-between pt-2 border-t border-border">
          <Button variant="ghost" size="sm" className="text-rose-400" onClick={handleDelete}>
            <Trash2 className="w-4 h-4 mr-1" /> Remove
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Scholarship Detail Modal ────────────────────────────────────────── */

function ScholarshipDetailModal({ scholarship: s, familyId, onClose, onDelete }: {
  scholarship: Scholarship; familyId: string; onClose: () => void; onDelete: () => void;
}) {
  const { error: toastError } = useToast();
  const meta = scholarshipStatusMeta(s.status);

  async function handleDelete() {
    const { error } = await createClient().from('scholarships').update({ is_active: false }).eq('id', s.id);
    if (error) { toastError(error.message); return; }
    onDelete();
  }

  const rows: [string, string][] = [
    ['Provider', s.provider || '—'],
    ['Amount', fmtMoney(s.amount)],
    ['Status', `${meta.emoji} ${meta.label}`],
    ['Deadline', fmtDate(s.deadline)],
    ['Renewable', s.renewable ? 'Yes' : 'No'],
  ];

  return (
    <Modal open onClose={onClose} title={s.name}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted">{k}</span>
              <span className="font-medium">{v}</span>
            </div>
          ))}
        </div>
        {s.requirements && (
          <div className="rounded-lg border border-border bg-surface/40 p-3">
            <p className="text-xs text-muted mb-1">Requirements</p>
            <p className="text-sm whitespace-pre-wrap">{s.requirements}</p>
          </div>
        )}
        {s.notes && (
          <div className="rounded-lg border border-border bg-surface/40 p-3">
            <p className="text-xs text-muted mb-1">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{s.notes}</p>
          </div>
        )}
        <div className="flex justify-between pt-2 border-t border-border">
          <Button variant="ghost" size="sm" className="text-rose-400" onClick={handleDelete}>
            <Trash2 className="w-4 h-4 mr-1" /> Remove
          </Button>
          <Button variant="ghost" onClick={onClose}>Close</Button>
        </div>
      </div>
    </Modal>
  );
}
