'use client';

import { useState, useTransition } from 'react';
import {
  Shield, Plus, Phone, ExternalLink, Mail, Pencil, Trash2, FileText, Loader2,
} from 'lucide-react';
import { saveWarrantyAction, deleteWarrantyAction } from '@/app/(app)/dashboard/home/actions';
import { warrantyStatus } from '@/lib/home/maintenance';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { EmptyState } from '@/components/ui/states';

type Warranty = Tables<'home_warranties'>;
type Asset = Tables<'home_assets'>;

const TYPE_LABELS: Record<string, string> = {
  manufacturer: 'Manufacturer', extended: 'Extended', home_warranty: 'Home Warranty', service_plan: 'Service Plan',
};

export function WarrantiesClient({ warranties, assets }: { warranties: Warranty[]; assets: Asset[] }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Warranty | null>(null);
  const [pending, start] = useTransition();

  const assetName = (id: string | null) => assets.find((a) => a.id === id)?.name ?? null;
  const active = warranties.filter((w) => warrantyStatus(w.expires_on).active).length;
  const expiringSoon = warranties.filter((w) => {
    const s = warrantyStatus(w.expires_on);
    return s.active && s.daysLeft !== null && s.daysLeft <= 45;
  }).length;
  const expired = warranties.length - active;

  function openNew() { setEditing(null); setOpen(true); }
  function openEdit(w: Warranty) { setEditing(w); setOpen(true); }

  function submit(fd: FormData) {
    start(async () => { await saveWarrantyAction(fd); setOpen(false); });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Warranties</h1>
          <p className="text-sm text-muted">Every warranty in one place — coverage, policy numbers, and one-tap claims.</p>
        </div>
        <Button onClick={openNew}><Plus className="h-4 w-4" /> Add warranty</Button>
      </div>

      <div className="grid-stats">
        <div className="stat-card"><div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-success/10 text-success"><Shield className="h-5 w-5" /></div><div><p className="text-xl font-bold leading-none">{active}</p><p className="mt-1 text-xs text-muted">Active</p></div></div>
        <div className="stat-card"><div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-warning/10 text-warning"><Shield className="h-5 w-5" /></div><div><p className="text-xl font-bold leading-none">{expiringSoon}</p><p className="mt-1 text-xs text-muted">Expiring ≤45d</p></div></div>
        <div className="stat-card"><div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-danger/10 text-danger"><Shield className="h-5 w-5" /></div><div><p className="text-xl font-bold leading-none">{expired}</p><p className="mt-1 text-xs text-muted">Expired</p></div></div>
      </div>

      {warranties.length === 0 ? (
        <EmptyState icon={Shield} title="No warranties yet" description="Add your first warranty so it's always a click away when something breaks." action={<Button onClick={openNew}><Plus className="h-4 w-4" /> Add warranty</Button>} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {warranties.map((w) => {
            const s = warrantyStatus(w.expires_on);
            const linked = assetName(w.asset_id);
            return (
              <Card key={w.id}>
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div>
                    <p className="font-semibold">{w.name}</p>
                    <p className="text-xs text-muted">{w.provider ?? '—'}{linked ? ` · ${linked}` : ''}</p>
                  </div>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </div>
                <div className="flex flex-wrap gap-1.5 text-xs">
                  <Badge tone="neutral">{TYPE_LABELS[w.warranty_type] ?? w.warranty_type}</Badge>
                  {w.policy_number && <Badge tone="brand">#{w.policy_number}</Badge>}
                  {w.cost != null && <Badge tone="neutral">${Number(w.cost).toLocaleString()}{w.premium_period && w.premium_period !== 'one_time' ? `/${w.premium_period}` : ''}</Badge>}
                </div>
                {w.coverage && <p className="mt-2 text-sm text-muted">{w.coverage}</p>}

                {/* One-tap claim row */}
                <div className="mt-3 flex flex-wrap gap-2">
                  {w.claim_phone && <a href={`tel:${w.claim_phone}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-xs font-medium text-brand-fg"><Phone className="h-3.5 w-3.5" /> Call to claim</a>}
                  {w.claim_url && <a href={w.claim_url} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-elevated"><ExternalLink className="h-3.5 w-3.5" /> File claim</a>}
                  {w.claim_email && <a href={`mailto:${w.claim_email}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs font-medium hover:bg-elevated"><Mail className="h-3.5 w-3.5" /> Email</a>}
                  {w.document_id && <span className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-muted"><FileText className="h-3.5 w-3.5" /> Doc attached</span>}
                </div>

                <div className="mt-3 flex items-center gap-3 border-t border-border/50 pt-2 text-xs">
                  <button onClick={() => openEdit(w)} className="inline-flex items-center gap-1 text-muted hover:text-fg"><Pencil className="h-3.5 w-3.5" /> Edit</button>
                  <button onClick={() => start(async () => { await deleteWarrantyAction(w.id); })} className="inline-flex items-center gap-1 text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /> Delete</button>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Edit warranty' : 'Add warranty'}>
        <form action={submit} className="space-y-3">
          {editing && <input type="hidden" name="id" value={editing.id} />}
          <Field label="Name"><Input name="name" required defaultValue={editing?.name ?? ''} placeholder="LG Fridge extended warranty" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Provider"><Input name="provider" defaultValue={editing?.provider ?? ''} placeholder="LG / Asurion" /></Field>
            <Field label="Type">
              <Select name="warranty_type" defaultValue={editing?.warranty_type ?? 'manufacturer'}>
                <option value="manufacturer">Manufacturer</option>
                <option value="extended">Extended</option>
                <option value="home_warranty">Home Warranty</option>
                <option value="service_plan">Service Plan</option>
              </Select>
            </Field>
          </div>
          <Field label="Linked asset">
            <Select name="asset_id" defaultValue={editing?.asset_id ?? ''}>
              <option value="">— none —</option>
              {assets.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Policy number"><Input name="policy_number" defaultValue={editing?.policy_number ?? ''} /></Field>
            <Field label="Status">
              <Select name="status" defaultValue={editing?.status ?? 'active'}>
                <option value="active">Active</option>
                <option value="expired">Expired</option>
                <option value="claimed">Claimed</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Starts"><Input type="date" name="starts_on" defaultValue={editing?.starts_on ?? ''} /></Field>
            <Field label="Expires"><Input type="date" name="expires_on" defaultValue={editing?.expires_on ?? ''} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Cost"><Input type="number" step="0.01" name="cost" defaultValue={editing?.cost ?? ''} /></Field>
            <Field label="Billing">
              <Select name="premium_period" defaultValue={editing?.premium_period ?? 'one_time'}>
                <option value="one_time">One-time</option>
                <option value="monthly">Monthly</option>
                <option value="annual">Annual</option>
              </Select>
            </Field>
          </div>
          <Field label="Coverage"><Textarea name="coverage" rows={2} defaultValue={editing?.coverage ?? ''} placeholder="What's covered, deductibles…" /></Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="Claim phone"><Input name="claim_phone" defaultValue={editing?.claim_phone ?? ''} /></Field>
            <Field label="Claim URL"><Input name="claim_url" defaultValue={editing?.claim_url ?? ''} /></Field>
            <Field label="Claim email"><Input name="claim_email" defaultValue={editing?.claim_email ?? ''} /></Field>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" loading={pending}>{editing ? 'Save' : 'Add warranty'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
