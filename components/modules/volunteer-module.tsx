'use client';

import { useMemo, useState } from 'react';
import {
  Plus, Trash2, Sparkles, ChevronRight, Phone, Mail, Clock,
  MapPin, CalendarDays, Users, X,
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
import type { VolunteerInsights, VolunteerAIResponse } from '@/lib/volunteer/volunteer-ai';
import {
  CATEGORIES, STATUSES, categoryMeta, statusMeta,
  totalHours, hoursByCategory, upcomingOpportunities,
  volunteerSummary, fmtDate,
} from '@/lib/volunteer/tracking';

type Opportunity = Tables<'volunteer_opportunities'>;
type HourEntry = Tables<'volunteer_hours'>;

const STATUS_STYLE: Record<string, string> = {
  active: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  upcoming: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
  completed: 'bg-gray-500/10 text-gray-400 border-gray-500/30',
  cancelled: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
};

export function VolunteerModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const opportunities = useRealtimeQuery<Opportunity>({
    table: 'volunteer_opportunities', familyId,
    fetcher: (s) => s.from('volunteer_opportunities').select('*').eq('family_id', familyId).eq('is_active', true).order('start_date'),
    deps: [familyId],
  });

  const hours = useRealtimeQuery<HourEntry>({
    table: 'volunteer_hours', familyId,
    fetcher: (s) => s.from('volunteer_hours').select('*').eq('family_id', familyId).order('log_date', { ascending: false }),
    deps: [familyId],
  });

  const [addOppOpen, setAddOppOpen] = useState(false);
  const [addHoursOpen, setAddHoursOpen] = useState(false);
  const [selectedOpp, setSelectedOpp] = useState<Opportunity | null>(null);

  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<VolunteerInsights | null>(null);
  const [aiInsights, setAiInsights] = useState<VolunteerAIResponse | null>(null);

  async function runAiAssist() {
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/volunteer', { method: 'POST' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'AI analysis failed');
      setAiAnalysis(json.analysis ?? null);
      setAiInsights(json.aiInsights ?? null);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'AI analysis failed');
    } finally {
      setAiLoading(false);
    }
  }

  const summary = useMemo(() => {
    if (!opportunities.data || !hours.data) return null;
    return volunteerSummary(opportunities.data, hours.data);
  }, [opportunities.data, hours.data]);

  const upcoming = useMemo(() => {
    if (!opportunities.data) return [];
    return upcomingOpportunities(opportunities.data);
  }, [opportunities.data]);

  const catHours = useMemo(() => {
    if (!hours.data || !opportunities.data) return [];
    return hoursByCategory(hours.data, opportunities.data);
  }, [hours.data, opportunities.data]);

  if (opportunities.loading) return <LoadingBlock />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Volunteer Hub"
        action={
          <Button variant="outline" onClick={runAiAssist} loading={aiLoading}>
            <Sparkles className="h-4 w-4 text-brand" /> AI Assist
          </Button>
        }
      />

      {(aiAnalysis || aiInsights) && (
        <div className="rounded-2xl border border-brand/30 bg-brand/5 p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="flex items-center gap-2 text-sm font-bold">
              <Sparkles className="h-4 w-4 text-brand" /> AI Volunteer Insights
            </p>
            <button onClick={() => { setAiAnalysis(null); setAiInsights(null); }}><X className="h-4 w-4 text-muted" /></button>
          </div>
          {aiAnalysis && <p className="mb-3 text-sm text-muted">{aiAnalysis.summary}</p>}
          {aiInsights && (
            <div className="space-y-2">
              {aiInsights.suggestions.map((s, i) => (
                <p key={i} className="text-sm">• {s}</p>
              ))}
              {aiInsights.impactTips.length > 0 && (
                <div className="mt-2 pt-2 border-t border-brand/20">
                  <p className="text-xs font-semibold text-brand mb-1">Impact Tips</p>
                  {aiInsights.impactTips.map((t, i) => <p key={i} className="text-xs text-muted">• {t}</p>)}
                </div>
              )}
              {aiInsights.opportunityIdea && <p className="mt-2 text-xs text-muted italic">Opportunity idea: {aiInsights.opportunityIdea}</p>}
            </div>
          )}
        </div>
      )}

      {/* Summary card */}
      {summary && (
        <div className="rounded-xl border border-border bg-surface/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{summary.totalOpportunities} opportunit{summary.totalOpportunities !== 1 ? 'ies' : 'y'}</span>
            {summary.totalHours > 0 && (
              <span className="text-sm font-semibold flex items-center gap-1"><Clock className="w-3.5 h-3.5" /> {summary.totalHours.toFixed(1)}h total</span>
            )}
          </div>
          <p className="text-sm font-medium">{summary.text}</p>
        </div>
      )}

      {/* Hours by category */}
      {catHours.length > 0 && (
        <div className="rounded-xl border border-border bg-surface/60 p-4 space-y-2">
          <p className="text-xs text-muted font-semibold uppercase tracking-wide">Hours by category</p>
          <div className="flex flex-wrap gap-2">
            {catHours.map(({ category, hours: h }) => {
              const m = categoryMeta(category);
              return (
                <span key={category} className="text-xs px-2 py-1 rounded-lg border border-border bg-surface/40">
                  {m.emoji} {m.label}: {h.toFixed(1)}h
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setAddHoursOpen(true)}><Clock className="w-4 h-4 mr-1" /> Log Hours</Button>
        <Button size="sm" onClick={() => setAddOppOpen(true)}><Plus className="w-4 h-4 mr-1" /> Add Opportunity</Button>
      </div>

      {/* Opportunity grid */}
      {(!opportunities.data || opportunities.data.length === 0) ? (
        <EmptyState title="No volunteer activities" description="Track your family's volunteer commitments and hours." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {opportunities.data.map((o) => {
            const meta = categoryMeta(o.category);
            return (
              <button key={o.id} onClick={() => setSelectedOpp(o)}
                className="text-left rounded-xl border border-border bg-surface/60 p-4 hover:border-primary/40 transition-colors">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{meta.emoji}</span>
                    <div>
                      <p className="text-sm font-semibold">{o.title}</p>
                      <p className="text-xs text-muted">{o.organization}</p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted" />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <span className={cn('text-xs px-2 py-0.5 rounded-full border', STATUS_STYLE[o.status] || STATUS_STYLE.upcoming)}>
                    {statusMeta(o.status).label}
                  </span>
                  {o.start_date && <span className="text-xs text-muted">{fmtDate(o.start_date)}</span>}
                  {o.recurring && <span className="text-xs text-muted">🔄 Recurring</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Modals */}
      {addOppOpen && (
        <AddOpportunityModal familyId={familyId} userId={userId}
          onClose={() => setAddOppOpen(false)}
          onSuccess={() => { setAddOppOpen(false); success('Opportunity added'); }} />
      )}
      {addHoursOpen && (
        <LogHoursModal familyId={familyId} opportunities={opportunities.data ?? []} members={members}
          onClose={() => setAddHoursOpen(false)}
          onSuccess={() => { setAddHoursOpen(false); success('Hours logged'); }} />
      )}
      {selectedOpp && (
        <OpportunityDetailModal opp={selectedOpp} familyId={familyId}
          onClose={() => setSelectedOpp(null)}
          onDelete={() => { setSelectedOpp(null); success('Opportunity removed'); }} />
      )}
    </div>
  );
}

/* ── Add Opportunity Modal ───────────────────────────────────────────── */

function AddOpportunityModal({ familyId, userId, onClose, onSuccess }: {
  familyId: string; userId: string; onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('volunteer_opportunities').insert({
      family_id: familyId,
      created_by: userId,
      title: String(f.get('title') ?? ''),
      organization: String(f.get('organization') ?? ''),
      category: String(f.get('category') ?? 'community') as Opportunity['category'],
      status: String(f.get('status') ?? 'upcoming') as Opportunity['status'],
      description: String(f.get('description') ?? ''),
      location: String(f.get('location') ?? ''),
      contact_name: String(f.get('contact_name') ?? ''),
      contact_phone: String(f.get('contact_phone') ?? ''),
      contact_email: String(f.get('contact_email') ?? ''),
      start_date: String(f.get('start_date') ?? '') || null,
      end_date: String(f.get('end_date') ?? '') || null,
      recurring: f.get('recurring') === 'on',
      notes: String(f.get('notes') ?? ''),
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  return (
    <Modal open onClose={onClose} title="Add Volunteer Opportunity">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title" required>{(id) => <Input id={id} name="title" autoFocus />}</Field>
        <Field label="Organization">{(id) => <Input id={id} name="organization" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">{(id) =>
            <Select id={id} name="category" defaultValue="community">
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.emoji} {c.label}</option>)}
            </Select>
          }</Field>
          <Field label="Status">{(id) =>
            <Select id={id} name="status" defaultValue="upcoming">
              {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
          }</Field>
        </div>
        <Field label="Description">{(id) => <Textarea id={id} name="description" rows={2} />}</Field>
        <Field label="Location">{(id) => <Input id={id} name="location" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start Date">{(id) => <Input id={id} name="start_date" type="date" />}</Field>
          <Field label="End Date">{(id) => <Input id={id} name="end_date" type="date" />}</Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="recurring" className="rounded border-border" />
          Recurring commitment
        </label>
        <Field label="Contact Name">{(id) => <Input id={id} name="contact_name" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact Phone">{(id) => <Input id={id} name="contact_phone" type="tel" />}</Field>
          <Field label="Contact Email">{(id) => <Input id={id} name="contact_email" type="email" />}</Field>
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

/* ── Log Hours Modal ─────────────────────────────────────────────────── */

function LogHoursModal({ familyId, opportunities, members, onClose, onSuccess }: {
  familyId: string;
  opportunities: Opportunity[];
  members: { id: string; display_name: string }[];
  onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('volunteer_hours').insert({
      family_id: familyId,
      opportunity_id: String(f.get('opportunity_id') ?? '') || null,
      member_id: String(f.get('member_id') ?? '') || null,
      hours: Number(f.get('hours') ?? 0),
      log_date: String(f.get('log_date') ?? '') || new Date().toISOString().slice(0, 10),
      description: String(f.get('description') ?? ''),
      notes: String(f.get('notes') ?? ''),
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  return (
    <Modal open onClose={onClose} title="Log Volunteer Hours">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Opportunity">{(id) =>
          <Select id={id} name="opportunity_id" defaultValue="">
            <option value="">General volunteering</option>
            {opportunities.map((o) => <option key={o.id} value={o.id}>{o.title}</option>)}
          </Select>
        }</Field>
        <Field label="Family Member">{(id) =>
          <Select id={id} name="member_id" defaultValue="">
            <option value="">Anyone</option>
            {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
          </Select>
        }</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hours" required>{(id) => <Input id={id} name="hours" type="number" step="0.25" min="0" autoFocus />}</Field>
          <Field label="Date">{(id) => <Input id={id} name="log_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />}</Field>
        </div>
        <Field label="Description">{(id) => <Input id={id} name="description" placeholder="What did you do?" />}</Field>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Log Hours</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Opportunity Detail Modal ────────────────────────────────────────── */

function OpportunityDetailModal({ opp, familyId, onClose, onDelete }: {
  opp: Opportunity; familyId: string; onClose: () => void; onDelete: () => void;
}) {
  const { error: toastError } = useToast();
  const meta = categoryMeta(opp.category);

  async function handleDelete() {
    const { error } = await createClient().from('volunteer_opportunities').update({ is_active: false }).eq('id', opp.id);
    if (error) { toastError(error.message); return; }
    onDelete();
  }

  const rows: [string, string][] = [
    ['Organization', opp.organization || '—'],
    ['Category', `${meta.emoji} ${meta.label}`],
    ['Status', statusMeta(opp.status).label],
    ['Start', fmtDate(opp.start_date)],
    ['End', fmtDate(opp.end_date)],
    ['Recurring', opp.recurring ? 'Yes' : 'No'],
    ['Location', opp.location || '—'],
  ];

  return (
    <Modal open onClose={onClose} title={opp.title}>
      <div className="space-y-4">
        {opp.description && <p className="text-sm text-muted">{opp.description}</p>}

        <div className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted">{k}</span>
              <span className="font-medium">{v}</span>
            </div>
          ))}
        </div>

        {(opp.contact_name || opp.contact_phone || opp.contact_email) && (
          <div className="rounded-lg border border-border bg-surface/40 p-3 space-y-1">
            <p className="text-xs text-muted font-semibold uppercase tracking-wide">Contact</p>
            {opp.contact_name && <p className="text-sm font-medium">{opp.contact_name}</p>}
            {opp.contact_phone && (
              <a href={`tel:${opp.contact_phone}`} className="flex items-center gap-1 text-sm text-primary hover:underline">
                <Phone className="w-3.5 h-3.5" /> {opp.contact_phone}
              </a>
            )}
            {opp.contact_email && (
              <a href={`mailto:${opp.contact_email}`} className="flex items-center gap-1 text-sm text-primary hover:underline">
                <Mail className="w-3.5 h-3.5" /> {opp.contact_email}
              </a>
            )}
          </div>
        )}

        {opp.notes && (
          <div className="rounded-lg border border-border bg-surface/40 p-3">
            <p className="text-xs text-muted mb-1">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{opp.notes}</p>
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
