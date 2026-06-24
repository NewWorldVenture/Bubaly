'use client';

import { useMemo, useState } from 'react';
import {
  Plus, Trash2, Sparkles, ChevronRight, Receipt, X,
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
import type { DonationsInsights, DonationsAIResponse } from '@/lib/donations/donations-ai';
import {
  DONATION_TYPES, donationTypeMeta,
  givingByYear, givingByOrg,
  donationSummary, fmtMoney, fmtDate,
} from '@/lib/donations/giving';

type Donation = Tables<'family_donations'>;

export function DonationsModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const donations = useRealtimeQuery<Donation>({
    table: 'family_donations', familyId,
    fetcher: (s) => s.from('family_donations').select('*').eq('family_id', familyId).eq('is_active', true).order('donation_date', { ascending: false }),
    deps: [familyId],
  });

  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<Donation | null>(null);
  const [yearFilter, setYearFilter] = useState<number | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiAnalysis, setAiAnalysis] = useState<DonationsInsights | null>(null);
  const [aiInsights, setAiInsights] = useState<DonationsAIResponse | null>(null);

  async function runAiAssist() {
    setAiLoading(true);
    try {
      const res = await fetch('/api/ai/donations', { method: 'POST' });
      const data = await res.json();
      if (data.analysis) setAiAnalysis(data.analysis);
      if (data.aiInsights) setAiInsights(data.aiInsights);
    } catch { /* ignore */ } finally { setAiLoading(false); }
  }

  const summary = useMemo(() => {
    if (!donations.data) return null;
    return donationSummary(donations.data);
  }, [donations.data]);

  const byYear = useMemo(() => {
    if (!donations.data) return [];
    return givingByYear(donations.data);
  }, [donations.data]);

  const byOrg = useMemo(() => {
    if (!donations.data) return [];
    const filtered = yearFilter ? donations.data.filter((d) => d.tax_year === yearFilter) : donations.data;
    return givingByOrg(filtered);
  }, [donations.data, yearFilter]);

  const filteredDonations = useMemo(() => {
    if (!donations.data) return [];
    return yearFilter ? donations.data.filter((d) => d.tax_year === yearFilter) : donations.data;
  }, [donations.data, yearFilter]);

  if (donations.loading) return <LoadingBlock />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Donation Tracker"
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
              <Sparkles className="h-4 w-4" /> AI Donation Insights
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
          {aiInsights?.taxTips && aiInsights.taxTips.length > 0 && (
            <div className="mb-2">
              <p className="text-xs font-medium mb-1">Tax Tips</p>
              <ul className="space-y-1">{aiInsights.taxTips.map((s, i) => <li key={i} className="text-xs text-muted">{'•'} {s}</li>)}</ul>
            </div>
          )}
          {aiInsights?.givingStrategy && <p className="text-xs text-muted italic">{aiInsights.givingStrategy}</p>}
        </div>
      )}

      {/* Summary card */}
      {summary && summary.count > 0 && (
        <div className="rounded-xl border border-border bg-surface/60 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-2xl font-bold">{fmtMoney(summary.totalGiving)}</p>
              <p className="text-xs text-muted">Lifetime giving · {summary.count} donation{summary.count !== 1 ? 's' : ''}</p>
            </div>
            {summary.taxDeductible > 0 && (
              <div className="text-right">
                <p className="text-lg font-semibold text-emerald-400">{fmtMoney(summary.taxDeductible)}</p>
                <p className="text-xs text-muted">Tax-deductible</p>
              </div>
            )}
          </div>
          <p className="text-sm font-medium">{summary.text}</p>
        </div>
      )}

      {/* Year breakdown */}
      {byYear.length > 0 && (
        <div className="rounded-xl border border-border bg-surface/60 p-4 space-y-2">
          <p className="text-xs text-muted font-semibold uppercase tracking-wide">By tax year</p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setYearFilter(null)}
              className={cn('text-xs px-3 py-1 rounded-lg border transition-colors',
                !yearFilter ? 'bg-primary text-primary-foreground border-primary' : 'border-border bg-surface/40 hover:border-primary/40')}
            >All</button>
            {byYear.map(({ year, total }) => (
              <button key={year}
                onClick={() => setYearFilter(yearFilter === year ? null : year)}
                className={cn('text-xs px-3 py-1 rounded-lg border transition-colors',
                  yearFilter === year ? 'bg-primary text-primary-foreground border-primary' : 'border-border bg-surface/40 hover:border-primary/40')}
              >{year}: {fmtMoney(total)}</button>
            ))}
          </div>
        </div>
      )}

      {/* Top orgs */}
      {byOrg.length > 0 && (
        <div className="rounded-xl border border-border bg-surface/60 p-4 space-y-2">
          <p className="text-xs text-muted font-semibold uppercase tracking-wide">Top recipients</p>
          <div className="space-y-1">
            {byOrg.slice(0, 5).map(({ org, total, count }) => (
              <div key={org} className="flex justify-between text-sm">
                <span>{org} <span className="text-xs text-muted">({count})</span></span>
                <span className="font-medium">{fmtMoney(total)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex justify-end">
        <Button size="sm" onClick={() => setAddOpen(true)}><Plus className="w-4 h-4 mr-1" /> Add Donation</Button>
      </div>

      {/* Donation list */}
      {filteredDonations.length === 0 ? (
        <EmptyState title="No donations" description="Track your family's charitable giving for tax and impact reporting." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {filteredDonations.map((d) => {
            const meta = donationTypeMeta(d.donation_type);
            return (
              <button key={d.id} onClick={() => setSelected(d)}
                className="text-left rounded-xl border border-border bg-surface/60 p-4 hover:border-primary/40 transition-colors">
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">{meta.emoji}</span>
                    <div>
                      <p className="text-sm font-semibold">{d.organization}</p>
                      <p className="text-xs text-muted">{fmtDate(d.donation_date)}</p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-muted" />
                </div>
                <div className="mt-2 flex items-center gap-2">
                  {d.amount != null && <span className="text-sm font-semibold">{fmtMoney(d.amount)}</span>}
                  {d.is_tax_deductible && (
                    <span className="text-xs px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                      Tax-deductible
                    </span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}

      {addOpen && (
        <AddDonationModal familyId={familyId} userId={userId}
          onClose={() => setAddOpen(false)}
          onSuccess={() => { setAddOpen(false); success('Donation recorded'); }} />
      )}
      {selected && (
        <DonationDetailModal donation={selected} familyId={familyId}
          onClose={() => setSelected(null)}
          onDelete={() => { setSelected(null); success('Donation removed'); }} />
      )}
    </div>
  );
}

/* ── Add Donation Modal ──────────────────────────────────────────────── */

function AddDonationModal({ familyId, userId, onClose, onSuccess }: {
  familyId: string; userId: string; onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLoading(true);
    const f = new FormData(e.currentTarget);
    const { error } = await createClient().from('family_donations').insert({
      family_id: familyId,
      created_by: userId,
      organization: String(f.get('organization') ?? ''),
      donation_type: String(f.get('donation_type') ?? 'monetary') as Donation['donation_type'],
      amount: f.get('amount') ? Number(f.get('amount')) : null,
      description: String(f.get('description') ?? ''),
      donation_date: String(f.get('donation_date') ?? '') || new Date().toISOString().slice(0, 10),
      tax_year: Number(f.get('tax_year') ?? new Date().getFullYear()),
      is_tax_deductible: f.get('is_tax_deductible') === 'on',
      ein: String(f.get('ein') ?? ''),
      category: String(f.get('category') ?? ''),
      notes: String(f.get('notes') ?? ''),
    });
    setLoading(false);
    if (error) return toastError(error.message);
    onSuccess();
  }

  const thisYear = new Date().getFullYear();

  return (
    <Modal open onClose={onClose} title="Record Donation">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Organization" required>{(id) => <Input id={id} name="organization" autoFocus placeholder="Red Cross, Habitat for Humanity..." />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{(id) =>
            <Select id={id} name="donation_type" defaultValue="monetary">
              {DONATION_TYPES.map((t) => <option key={t.value} value={t.value}>{t.emoji} {t.label}</option>)}
            </Select>
          }</Field>
          <Field label="Amount">{(id) => <Input id={id} name="amount" type="number" step="0.01" min="0" placeholder="100" />}</Field>
        </div>
        <Field label="Description">{(id) => <Input id={id} name="description" placeholder="What was donated" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">{(id) => <Input id={id} name="donation_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} />}</Field>
          <Field label="Tax Year">{(id) => <Input id={id} name="tax_year" type="number" defaultValue={thisYear} />}</Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="is_tax_deductible" defaultChecked className="rounded border-border" />
          Tax-deductible
        </label>
        <Field label="EIN (Tax ID)">{(id) => <Input id={id} name="ein" placeholder="XX-XXXXXXX" />}</Field>
        <Field label="Category">{(id) => <Input id={id} name="category" placeholder="Education, Health, Environment..." />}</Field>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Donation Detail Modal ───────────────────────────────────────────── */

function DonationDetailModal({ donation, familyId, onClose, onDelete }: {
  donation: Donation; familyId: string; onClose: () => void; onDelete: () => void;
}) {
  const { error: toastError } = useToast();
  const meta = donationTypeMeta(donation.donation_type);

  async function handleDelete() {
    const { error } = await createClient().from('family_donations').update({ is_active: false }).eq('id', donation.id);
    if (error) { toastError(error.message); return; }
    onDelete();
  }

  const rows: [string, string][] = [
    ['Organization', donation.organization || '—'],
    ['Type', `${meta.emoji} ${meta.label}`],
    ['Amount', fmtMoney(donation.amount)],
    ['Date', fmtDate(donation.donation_date)],
    ['Tax Year', String(donation.tax_year)],
    ['Tax-Deductible', donation.is_tax_deductible ? 'Yes' : 'No'],
    ['EIN', donation.ein || '—'],
    ['Category', donation.category || '—'],
  ];

  return (
    <Modal open onClose={onClose} title={donation.organization || 'Donation'}>
      <div className="space-y-4">
        {donation.description && <p className="text-sm text-muted">{donation.description}</p>}

        <div className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted">{k}</span>
              <span className="font-medium">{v}</span>
            </div>
          ))}
        </div>

        {donation.notes && (
          <div className="rounded-lg border border-border bg-surface/40 p-3">
            <p className="text-xs text-muted mb-1">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{donation.notes}</p>
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
