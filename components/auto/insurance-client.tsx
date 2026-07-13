'use client';

import { useState, useTransition } from 'react';
import {
  ShieldCheck, Plus, Phone, Pencil, Trash2, ChevronDown, ChevronUp, AlertTriangle,
} from 'lucide-react';
import { savePolicyAction, deletePolicyAction } from '@/app/(app)/dashboard/auto/actions';
import { renewalStatus, vehicleLabel } from '@/lib/auto/renewals';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { EmptyState } from '@/components/ui/states';

type Policy = Tables<'auto_insurance_policies'>;
type Vehicle = Tables<'vehicles'>;

export function InsuranceClient({ policies, vehicles }: { policies: Policy[]; vehicles: Vehicle[] }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Policy | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const vName = (id: string | null) => { const v = vehicles.find((x) => x.id === id); return v ? vehicleLabel(v) : null; };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold">Auto insurance</h2>
          <p className="text-xs text-muted">Full policy details plus a one-tap emergency card for claims and roadside.</p>
        </div>
        <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> Add policy</Button>
      </div>

      {policies.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No policies yet" description="Add your auto policy so claim and roadside numbers are one tap away in an emergency." action={<Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="h-4 w-4" /> Add policy</Button>} />
      ) : (
        <div className="space-y-3">
          {policies.map((p) => {
            const s = renewalStatus(p.expires_on);
            const isOpen = expanded === p.id;
            return (
              <Card key={p.id}>
                {/* Quick emergency card */}
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{p.provider ?? 'Insurer'} {!p.is_active && <Badge tone="neutral">inactive</Badge>}</p>
                    <p className="text-xs text-muted">{p.policy_number ? `Policy #${p.policy_number}` : '—'}{vName(p.vehicle_id) ? ` · ${vName(p.vehicle_id)}` : ''}</p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </div>
                {p.coverage_summary && <p className="mt-2 text-sm">{p.coverage_summary}</p>}
                {p.liability_limits && <p className="text-xs text-muted">Liability {p.liability_limits}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  {p.claims_phone && <a href={`tel:${p.claims_phone}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-white"><Phone className="h-3.5 w-3.5" /> File a claim</a>}
                  {p.roadside_phone && <a href={`tel:${p.roadside_phone}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium hover:bg-elevated"><Phone className="h-3.5 w-3.5" /> Roadside</a>}
                  {p.agent_phone && <a href={`tel:${p.agent_phone}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-medium hover:bg-elevated"><Phone className="h-3.5 w-3.5" /> {p.agent_name ?? 'Agent'}</a>}
                </div>

                {/* Full policy (expandable) */}
                <button onClick={() => setExpanded(isOpen ? null : p.id)} className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-brand-text">
                  {isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />} {isOpen ? 'Hide' : 'Full policy details'}
                </button>
                {isOpen && (
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 rounded-xl border border-border bg-elevated/40 p-3 text-xs sm:grid-cols-3">
                    {([
                      ['NAIC', p.naic], ['Effective', p.effective_on], ['Expires', p.expires_on],
                      ['Premium', p.premium != null ? `$${Number(p.premium).toLocaleString()}${p.premium_period ? `/${p.premium_period}` : ''}` : null],
                      ['Collision deductible', p.deductible_collision != null ? `$${p.deductible_collision}` : null],
                      ['Comprehensive deductible', p.deductible_comprehensive != null ? `$${p.deductible_comprehensive}` : null],
                    ] as [string, string | null][]).filter(([, v]) => v).map(([k, v]) => (
                      <div key={k}><dt className="text-muted">{k}</dt><dd className="font-medium">{v}</dd></div>
                    ))}
                    {p.notes && <div className="col-span-full"><dt className="text-muted">Notes</dt><dd>{p.notes}</dd></div>}
                  </dl>
                )}

                <div className="mt-3 flex items-center gap-3 border-t border-border/50 pt-2 text-xs">
                  <button onClick={() => { setEditing(p); setOpen(true); }} className="inline-flex items-center gap-1 text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                  <button onClick={() => start(async () => { await deletePolicyAction(p.id); })} className="inline-flex items-center gap-1 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <p className="inline-flex items-start gap-1 text-[11px] text-muted"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> Stored privately for your family only. Keep your policy doc handy for claims.</p>

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Edit policy' : 'Add policy'}>
        <form action={(fd) => start(async () => { await savePolicyAction(fd); setOpen(false); })} className="space-y-3">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider"><Input name="provider" defaultValue={editing?.provider ?? ''} placeholder="GEICO" /></Field>
            <Field label="Policy number"><Input name="policy_number" defaultValue={editing?.policy_number ?? ''} /></Field>
          </div>
          <Field label="Vehicle"><Select name="vehicle_id" defaultValue={editing?.vehicle_id ?? ''}><option value="">— all / none —</option>{vehicles.map((v) => <option key={v.id} value={v.id}>{vehicleLabel(v)}</option>)}</Select></Field>
          <Field label="Coverage summary"><Textarea name="coverage_summary" rows={2} defaultValue={editing?.coverage_summary ?? ''} placeholder="Full coverage, $500 deductible…" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Liability limits"><Input name="liability_limits" defaultValue={editing?.liability_limits ?? ''} placeholder="100/300/100" /></Field>
            <Field label="NAIC"><Input name="naic" defaultValue={editing?.naic ?? ''} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Collision deductible"><Input type="number" name="deductible_collision" defaultValue={editing?.deductible_collision ?? ''} /></Field>
            <Field label="Comprehensive deductible"><Input type="number" name="deductible_comprehensive" defaultValue={editing?.deductible_comprehensive ?? ''} /></Field>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Claims phone"><Input name="claims_phone" defaultValue={editing?.claims_phone ?? ''} /></Field>
            <Field label="Roadside phone"><Input name="roadside_phone" defaultValue={editing?.roadside_phone ?? ''} /></Field>
            <Field label="Agent phone"><Input name="agent_phone" defaultValue={editing?.agent_phone ?? ''} /></Field>
          </div>
          <Field label="Agent name"><Input name="agent_name" defaultValue={editing?.agent_name ?? ''} /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Effective"><Input type="date" name="effective_on" defaultValue={editing?.effective_on ?? ''} /></Field>
            <Field label="Expires"><Input type="date" name="expires_on" defaultValue={editing?.expires_on ?? ''} /></Field>
            <Field label="Premium"><Input type="number" name="premium" defaultValue={editing?.premium ?? ''} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Billing"><Select name="premium_period" defaultValue={editing?.premium_period ?? '6_month'}><option value="monthly">Monthly</option><option value="6_month">6-month</option><option value="annual">Annual</option></Select></Field>
            <label className="mt-6 flex items-center gap-2 text-sm"><input type="checkbox" name="is_active" defaultChecked={editing?.is_active ?? true} /> Active policy</label>
          </div>
          <Field label="Notes"><Textarea name="notes" rows={2} defaultValue={editing?.notes ?? ''} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={pending}>{editing ? 'Save' : 'Add policy'}</Button></div>
        </form>
      </Modal>
    </div>
  );
}
