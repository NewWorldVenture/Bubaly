'use client';

import { useMemo, useState } from 'react';
import {
  ShieldCheck, Plus, Trash2, CalendarClock, AlertTriangle, Sparkles,
  X, ChevronRight, Phone, Wallet, ShieldAlert,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { AiInsight } from '@/components/ai/ai-insight';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { SkeletonList, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import {
  POLICY_TYPES, PREMIUM_FREQUENCIES, policyTypeMeta, frequencyMeta,
  annualPremium, renewalUrgency, upcomingRenewals, premiumByType,
  insuranceSummary, fmtMoney, type RenewalUrgency,
} from '@/lib/insurance/policies';

type Policy = Tables<'family_insurance_policies'>;

const URGENCY_STYLE: Record<RenewalUrgency, string> = {
  lapsed: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  due_soon: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  upcoming: 'border-border bg-surface/50 text-muted',
  none: 'border-border bg-surface/50 text-muted',
};

function fmtDate(d: string): string {
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function InsuranceModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();

  const policies = useRealtimeQuery<Policy>({
    table: 'family_insurance_policies', familyId,
    fetcher: (s) => s.from('family_insurance_policies').select('*').eq('family_id', familyId).eq('is_active', true).order('policy_type'),
    deps: [familyId],
  });

  const [addOpen, setAddOpen] = useState(false);
  const [selected, setSelected] = useState<Policy | null>(null);

  const summary = useMemo(() => insuranceSummary(policies.data, new Date()), [policies.data]);
  const renewals = useMemo(() => upcomingRenewals(policies.data).filter((r) => r.urgency !== 'upcoming').slice(0, 6), [policies.data]);
  const byType = useMemo(() => premiumByType(policies.data).slice(0, 5), [policies.data]);

  async function removePolicy(id: string) {
    if (!confirm('Remove this policy?')) return;
    const { error } = await createClient().from('family_insurance_policies').update({ is_active: false }).eq('id', id);
    if (error) return toastError(describeDbError(error));
    setSelected(null);
    success('Policy removed');
  }

  const memberName = (id: string | null) => (id ? members.find((m) => m.id === id)?.display_name ?? null : null);

  if (policies.loading) return <SkeletonList />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Insurance Hub"
        description="Every household policy in one place, with AI-managed renewal and coverage awareness."
        action={<div className="flex items-center gap-2"><AiInsight kind="insurance" iconOnly /><Button onClick={() => setAddOpen(true)}><Plus className="h-4 w-4" /> Add policy</Button></div>}
      />

      {policies.data.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-3">
          {/* Spend */}
          <div className="rounded-2xl border border-border bg-surface/40 p-5">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Wallet className="h-4 w-4 text-brand-text" /> Annual premiums
            </div>
            <p className="mt-2 text-2xl font-bold">{fmtMoney(summary.annualPremium)}</p>
            <p className="mt-1 text-xs text-muted">≈ {fmtMoney(summary.monthlyPremium)}/mo across {summary.count} {summary.count === 1 ? 'policy' : 'policies'}</p>
            {byType.length > 0 && (
              <ul className="mt-3 space-y-1.5">
                {byType.map((b) => (
                  <li key={b.type} className="flex items-center justify-between text-xs">
                    <span className="text-muted">{policyTypeMeta(b.type).emoji} {policyTypeMeta(b.type).label}</span>
                    <span className="font-medium">{fmtMoney(b.annual)}/yr</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* AI awareness */}
          <div className="rounded-2xl border border-brand/20 bg-brand/5 p-5 lg:col-span-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-brand-text">
              <Sparkles className="h-4 w-4" /> Insurance awareness
            </div>
            <p className={cn('mt-2 text-lg font-bold', summary.lapsed > 0 ? 'text-rose-300' : summary.dueSoon > 0 || summary.gaps.length > 0 ? 'text-amber-300' : 'text-emerald-300')}>
              {summary.text}
            </p>

            {summary.gaps.length > 0 && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
                <div className="text-xs text-amber-200">
                  <span className="font-medium">Possible coverage gaps: </span>
                  {summary.gaps.map((g) => `${policyTypeMeta(g).emoji} ${policyTypeMeta(g).label}`).join(', ')}.
                  <span className="text-amber-200/70"> No active policy on file — add one if you&apos;re covered elsewhere.</span>
                </div>
              </div>
            )}

            {renewals.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {renewals.map((r) => (
                  <li key={r.id} className={cn('flex items-center gap-3 rounded-xl border px-3 py-2', URGENCY_STYLE[r.urgency])}>
                    <CalendarClock className="h-4 w-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">{policyTypeMeta(r.policyType).label} · {r.insurer}</p>
                      <p className="text-xs opacity-90">
                        {r.urgency === 'lapsed' ? `Lapsed ${Math.abs(r.daysUntil)} day${Math.abs(r.daysUntil) === 1 ? '' : 's'} ago` : `Renews in ${r.daysUntil} day${r.daysUntil === 1 ? '' : 's'} (${fmtDate(r.renewalDate)})`}
                      </p>
                    </div>
                    {r.urgency === 'lapsed' && <AlertTriangle className="h-4 w-4 shrink-0" />}
                  </li>
                ))}
              </ul>
            ) : (
              summary.gaps.length === 0 && <p className="mt-2 text-sm text-muted">No renewals due soon. Upcoming renewals appear here within 30 days.</p>
            )}
          </div>
        </div>
      )}

      {policies.data.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No policies yet" description="Add your health, auto, home, life, and other policies to track renewals, premiums, and coverage." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {policies.data.map((p) => {
            const meta = policyTypeMeta(p.policy_type);
            const u = renewalUrgency(p.renewal_date);
            const covers = memberName(p.member_id);
            return (
              <button
                key={p.id}
                onClick={() => setSelected(p)}
                className="flex items-center gap-4 rounded-2xl border border-border bg-surface/40 p-4 text-left transition hover:bg-elevated"
              >
                <span className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-brand/10 text-3xl">{meta.emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{meta.label}</p>
                  <p className="truncate text-xs text-muted">{p.insurer}{covers ? ` · ${covers}` : ''}</p>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {p.premium_amount != null && (
                      <span className="inline-flex rounded-full border border-border px-2 py-0.5 text-[10px] text-muted">
                        {fmtMoney(p.premium_amount)}/{frequencyMeta(p.premium_frequency).label.toLowerCase().replace('every 6 months', '6mo')}
                      </span>
                    )}
                    {p.renewal_date && u !== 'upcoming' && (
                      <span className={cn('inline-flex rounded-full border px-2 py-0.5 text-[10px]', URGENCY_STYLE[u])}>
                        {u === 'lapsed' ? 'Lapsed' : `Renews ${fmtDate(p.renewal_date)}`}
                      </span>
                    )}
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-muted" />
              </button>
            );
          })}
        </div>
      )}

      {addOpen && (
        <PolicyForm
          familyId={familyId} userId={userId} members={members}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); success('Policy added'); }}
        />
      )}

      {selected && (
        <PolicyDetail
          policy={selected}
          coversName={memberName(selected.member_id)}
          onClose={() => setSelected(null)}
          onRemove={() => removePolicy(selected.id)}
        />
      )}
    </div>
  );
}

function PolicyForm({ familyId, userId, members, onClose, onSaved }: {
  familyId: string; userId: string; members: { id: string; display_name: string }[];
  onClose: () => void; onSaved: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const insurer = String(f.get('insurer') ?? '').trim();
    if (!insurer) return toastError('Insurer is required');
    setLoading(true);
    const { error } = await createClient().from('family_insurance_policies').insert({
      family_id: familyId,
      policy_type: String(f.get('policy_type') ?? 'other') as Policy['policy_type'],
      insurer,
      policy_number: String(f.get('policy_number') ?? '').trim() || null,
      member_id: String(f.get('member_id') ?? '') || null,
      premium_amount: f.get('premium_amount') ? Number(f.get('premium_amount')) : null,
      premium_frequency: String(f.get('premium_frequency') ?? 'monthly') as Policy['premium_frequency'],
      coverage_amount: f.get('coverage_amount') ? Number(f.get('coverage_amount')) : null,
      deductible: f.get('deductible') ? Number(f.get('deductible')) : null,
      effective_date: String(f.get('effective_date') ?? '') || null,
      renewal_date: String(f.get('renewal_date') ?? '') || null,
      agent_name: String(f.get('agent_name') ?? '').trim() || null,
      agent_phone: String(f.get('agent_phone') ?? '').trim() || null,
      claim_phone: String(f.get('claim_phone') ?? '').trim() || null,
      notes: String(f.get('notes') ?? '').trim() || null,
      created_by: userId,
    });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title="Add a policy" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">{(id) => <Select id={id} name="policy_type" defaultValue="auto">{POLICY_TYPES.map((t) => <option key={t.value} value={t.value}>{t.emoji} {t.label}</option>)}</Select>}</Field>
          <Field label="Insurer" required>{(id) => <Input id={id} name="insurer" autoFocus placeholder="State Farm" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Policy number">{(id) => <Input id={id} name="policy_number" placeholder="Optional" />}</Field>
          <Field label="Covers">{(id) => <Select id={id} name="member_id" defaultValue=""><option value="">Whole family</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Premium">{(id) => <Input id={id} name="premium_amount" type="number" step="0.01" min="0" placeholder="150" />}</Field>
          <Field label="Billed">{(id) => <Select id={id} name="premium_frequency" defaultValue="monthly">{PREMIUM_FREQUENCIES.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}</Select>}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Coverage amount">{(id) => <Input id={id} name="coverage_amount" type="number" step="1" min="0" placeholder="250000" />}</Field>
          <Field label="Deductible">{(id) => <Input id={id} name="deductible" type="number" step="1" min="0" placeholder="1000" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Effective date">{(id) => <Input id={id} name="effective_date" type="date" />}</Field>
          <Field label="Renewal date" hint="Powers renewal reminders">{(id) => <Input id={id} name="renewal_date" type="date" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Agent name">{(id) => <Input id={id} name="agent_name" placeholder="Optional" />}</Field>
          <Field label="Agent phone">{(id) => <Input id={id} name="agent_phone" type="tel" placeholder="(555) 000-0000" />}</Field>
        </div>
        <Field label="Claims phone">{(id) => <Input id={id} name="claim_phone" type="tel" placeholder="Optional" />}</Field>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" placeholder="Coverage details, riders…" />}</Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add policy</Button>
        </div>
      </form>
    </Modal>
  );
}

function PolicyDetail({ policy, coversName, onClose, onRemove }: {
  policy: Policy; coversName: string | null; onClose: () => void; onRemove: () => void;
}) {
  const meta = policyTypeMeta(policy.policy_type);
  const annual = annualPremium(policy.premium_amount, policy.premium_frequency);
  const u = renewalUrgency(policy.renewal_date);

  const rows: { label: string; value: string | null }[] = [
    { label: 'Insurer', value: policy.insurer },
    { label: 'Policy #', value: policy.policy_number },
    { label: 'Covers', value: coversName ?? 'Whole family' },
    { label: 'Premium', value: policy.premium_amount != null ? `${fmtMoney(policy.premium_amount)} / ${frequencyMeta(policy.premium_frequency).label.toLowerCase()} (${fmtMoney(annual)}/yr)` : null },
    { label: 'Coverage', value: policy.coverage_amount != null ? fmtMoney(policy.coverage_amount) : null },
    { label: 'Deductible', value: policy.deductible != null ? fmtMoney(policy.deductible) : null },
    { label: 'Effective', value: policy.effective_date ? fmtDate(policy.effective_date) : null },
    { label: 'Renews', value: policy.renewal_date ? fmtDate(policy.renewal_date) : null },
  ];

  return (
    <Modal open title={`${meta.label} insurance`} onClose={onClose}>
      <div className="space-y-5">
        <div className="flex items-center gap-4">
          <span className="grid h-16 w-16 shrink-0 place-items-center rounded-2xl bg-brand/10 text-4xl">{meta.emoji}</span>
          <div className="min-w-0">
            <p className="font-semibold">{policy.insurer}</p>
            {policy.renewal_date && u !== 'upcoming' && (
              <span className={cn('mt-1 inline-flex rounded-full border px-2 py-0.5 text-xs', URGENCY_STYLE[u])}>
                {u === 'lapsed' ? 'Lapsed' : 'Renewing soon'} · {fmtDate(policy.renewal_date)}
              </span>
            )}
          </div>
        </div>

        <dl className="divide-y divide-border rounded-xl border border-border">
          {rows.filter((r) => r.value).map((r) => (
            <div key={r.label} className="flex items-center justify-between px-3 py-2 text-sm">
              <dt className="text-muted">{r.label}</dt>
              <dd className="text-right font-medium">{r.value}</dd>
            </div>
          ))}
        </dl>

        {(policy.agent_name || policy.agent_phone || policy.claim_phone) && (
          <div className="space-y-2">
            {(policy.agent_name || policy.agent_phone) && (
              <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm">
                <ShieldCheck className="h-4 w-4 text-brand-text" />
                <span>{policy.agent_name || 'Agent'}</span>
                {policy.agent_phone && <a href={`tel:${policy.agent_phone}`} className="ml-auto inline-flex items-center gap-1 text-brand-text"><Phone className="h-3.5 w-3.5" /> {policy.agent_phone}</a>}
              </div>
            )}
            {policy.claim_phone && (
              <div className="flex items-center gap-2 rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm">
                <AlertTriangle className="h-4 w-4 text-amber-300" />
                <span>Claims</span>
                <a href={`tel:${policy.claim_phone}`} className="ml-auto inline-flex items-center gap-1 text-brand-text"><Phone className="h-3.5 w-3.5" /> {policy.claim_phone}</a>
              </div>
            )}
          </div>
        )}

        {policy.notes && <p className="rounded-xl border border-border bg-surface/40 px-3 py-2 text-sm text-muted">{policy.notes}</p>}

        <div className="flex justify-between border-t border-border pt-3">
          <Button variant="ghost" onClick={onRemove} className="text-rose-400 hover:text-rose-300"><Trash2 className="h-4 w-4" /> Remove</Button>
          <Button variant="ghost" onClick={onClose}><X className="h-4 w-4" /> Close</Button>
        </div>
      </div>
    </Modal>
  );
}
