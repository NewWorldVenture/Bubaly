'use client';

import { useState, useTransition } from 'react';
import {
  Users, Sparkles, Loader2, Plus, Phone, Mail, Globe, Trash2, Star, ExternalLink, Search,
} from 'lucide-react';
import { saveContractorAction, deleteContractorAction } from '@/app/(app)/dashboard/home/actions';
import { TRADES } from '@/lib/home/maintenance';
import type { Tables } from '@/lib/database.types';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Select, Textarea } from '@/components/ui/input';
import { Field } from '@/components/home/field';
import { EmptyState } from '@/components/ui/states';

type Contractor = Tables<'home_contractors'>;
const tradeLabel = (v: string | null) => TRADES.find((t) => t.value === v)?.label ?? v ?? '';

export function ProsClient({ contractors, initialTrade }: { contractors: Contractor[]; initialTrade: string }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  // AI find-a-pro
  const [trade, setTrade] = useState(initialTrade || 'hvac');
  const [job, setJob] = useState('');
  const [location, setLocation] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [ai, setAi] = useState<{ text: string; searchUrl: string } | null>(null);

  async function runFindPro() {
    setAiBusy(true); setAiError(''); setAi(null);
    try {
      const res = await fetch('/api/ai/home/find-pro', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ trade, job, location }),
      });
      const data = await res.json();
      if (!res.ok) setAiError(data.error ?? 'Request failed.');
      else setAi({ text: data.text, searchUrl: data.searchUrl });
    } catch { setAiError('Network error.'); }
    finally { setAiBusy(false); }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">Find a Pro</h1>
          <p className="text-sm text-muted">Get AI hiring guidance, then save the contractors you trust for one-tap calling.</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Save a contractor</Button>
      </div>

      {/* AI sourcing */}
      <Card>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> AI hiring guidance</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Trade">
            <Select value={trade} onChange={(e) => setTrade(e.target.value)}>
              {TRADES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </Field>
          <Field label="Job (optional)"><Input value={job} onChange={(e) => setJob(e.target.value)} placeholder="Replace water heater" /></Field>
          <Field label="Area (optional)"><Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="City or ZIP" /></Field>
        </div>
        <Button onClick={runFindPro} loading={aiBusy}><Sparkles className="h-4 w-4" /> Get guidance</Button>
        {aiError && <p className="mt-2 text-sm text-danger">{aiError}</p>}
        {ai && (
          <div className="mt-3 space-y-2">
            <p className="whitespace-pre-wrap rounded-lg border border-border bg-elevated p-3 text-sm">{ai.text}</p>
            <a href={ai.searchUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg">
              <Search className="h-4 w-4" /> Search local pros <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <p className="text-[11px] text-muted">We don&apos;t have live local listings, so we never invent businesses — this opens a real search you control. Save the ones you pick below.</p>
          </div>
        )}
      </Card>

      {/* Saved contractors */}
      {contractors.length === 0 ? (
        <EmptyState icon={Users} title="No saved contractors" description="Save your trusted pros so they're one tap away next time something breaks." />
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {contractors.map((c) => (
            <Card key={c.id}>
              <div className="mb-1 flex items-start justify-between gap-2">
                <div>
                  <p className="font-semibold">{c.name} {c.is_preferred && <Star className="inline h-3.5 w-3.5 text-warning" />}</p>
                  <p className="text-xs text-muted">{c.company ?? ''}{c.company && c.trade ? ' · ' : ''}{tradeLabel(c.trade)}</p>
                </div>
                {c.rating != null && <Badge tone="brand">{c.rating}★</Badge>}
              </div>
              {c.notes && <p className="text-sm text-muted">{c.notes}</p>}
              <div className="mt-3 flex flex-wrap gap-2">
                {c.phone && <a href={`tel:${c.phone}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-xs font-medium text-brand-fg"><Phone className="h-3.5 w-3.5" /> Call</a>}
                {c.email && <a href={`mailto:${c.email}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs hover:bg-elevated"><Mail className="h-3.5 w-3.5" /> Email</a>}
                {c.website && <a href={c.website} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs hover:bg-elevated"><Globe className="h-3.5 w-3.5" /> Site</a>}
                <button onClick={() => start(async () => { await deleteContractorAction(c.id); })} className="ml-auto inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="Save a contractor">
        <form action={(fd) => start(async () => { await saveContractorAction(fd); setOpen(false); })} className="space-y-3">
          <Field label="Name"><Input name="name" required placeholder="Acme Heating & Air" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Trade">
              <Select name="trade" defaultValue={trade}>{TRADES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select>
            </Field>
            <Field label="Company"><Input name="company" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone"><Input name="phone" /></Field>
            <Field label="Email"><Input name="email" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Website"><Input name="website" placeholder="https://" /></Field>
            <Field label="Rating (1–5)"><Input type="number" name="rating" min="1" max="5" /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_preferred" /> Preferred pro</label>
          <Field label="Notes"><Textarea name="notes" rows={2} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" loading={pending}>Save</Button></div>
        </form>
      </Modal>
    </div>
  );
}
