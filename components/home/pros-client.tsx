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
import { useTranslations } from '@/components/i18n/locale-provider';

type Contractor = Tables<'home_contractors'>;
const tradeLabel = (v: string | null) => TRADES.find((t) => t.value === v)?.label ?? v ?? '';

export function ProsClient({ contractors, initialTrade }: { contractors: Contractor[]; initialTrade: string }) {
  const tr = useTranslations();
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
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{tr('prosClient.findAPro')}</h1>
          <p className="text-sm text-muted">{tr('prosClient.getAiHiringGuidanceThenSave')}</p>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> {tr('prosClient.saveAContractor')}</Button>
      </div>

      {/* AI sourcing */}
      <Card>
        <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold"><Sparkles className="h-4 w-4 text-brand-text" /> {tr('prosClient.aiHiringGuidance')}</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={tr('prosClient.trade')}>
            <Select value={trade} onChange={(e) => setTrade(e.target.value)}>
              {TRADES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </Select>
          </Field>
          <Field label={tr('prosClient.jobOptional')}><Input value={job} onChange={(e) => setJob(e.target.value)} placeholder={tr('prosClient.replaceWaterHeater')} /></Field>
          <Field label={tr('prosClient.areaOptional')}><Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder={tr('prosClient.cityOrZip')} /></Field>
        </div>
        <Button onClick={runFindPro} loading={aiBusy}><Sparkles className="h-4 w-4" /> {tr('prosClient.getGuidance')}</Button>
        {aiError && <p className="mt-2 text-sm text-danger">{aiError}</p>}
        {ai && (
          <div className="mt-3 space-y-2">
            <p className="whitespace-pre-wrap rounded-lg border border-border bg-elevated p-3 text-sm">{ai.text}</p>
            <a href={ai.searchUrl} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg">
              <Search className="h-4 w-4" /> {tr('prosClient.searchLocalPros')} <ExternalLink className="h-3.5 w-3.5" />
            </a>
            <p className="text-[11px] text-muted">We don&apos;t have live local listings, so we never invent businesses — this opens a real search you control. Save the ones you pick below.</p>
          </div>
        )}
      </Card>

      {/* Saved contractors */}
      {contractors.length === 0 ? (
        <EmptyState icon={Users} title={tr('prosClient.noSavedContractors')} description="Save your trusted pros so they're one tap away next time something breaks." />
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
                {c.phone && <a href={`tel:${c.phone}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-2.5 text-xs font-medium text-brand-fg"><Phone className="h-3.5 w-3.5" />{' '}{tr('prosClient.call')}</a>}
                {c.email && <a href={`mailto:${c.email}`} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs hover:bg-elevated"><Mail className="h-3.5 w-3.5" />{' '}{tr('prosClient.email')}</a>}
                {c.website && <a href={c.website} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-2.5 text-xs hover:bg-elevated"><Globe className="h-3.5 w-3.5" />{' '}{tr('prosClient.site')}</a>}
                <button onClick={() => start(async () => { await deleteContractorAction(c.id); })} className="ml-auto inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs text-muted hover:text-danger"><Trash2 className="h-3.5 w-3.5" /></button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={tr('prosClient.saveAContractor')}>
        <form action={(fd) => start(async () => { await saveContractorAction(fd); setOpen(false); })} className="space-y-3">
          <Field label={tr('prosClient.name')}><Input name="name" required placeholder={tr('prosClient.acmeHeatingAir')} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('prosClient.trade')}>
              <Select name="trade" defaultValue={trade}>{TRADES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</Select>
            </Field>
            <Field label={tr('prosClient.company')}><Input name="company" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('prosClient.phone')}><Input name="phone" /></Field>
            <Field label={tr('prosClient.email')}><Input name="email" /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr('prosClient.website')}><Input name="website" placeholder="https://" /></Field>
            <Field label={tr('prosClient.rating15')}><Input type="number" name="rating" min="1" max="5" /></Field>
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_preferred" /> {tr('prosClient.preferredPro')}</label>
          <Field label={tr('prosClient.notes')}><Textarea name="notes" rows={2} /></Field>
          <div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={() => setOpen(false)}>{tr('prosClient.cancel')}</Button><Button type="submit" loading={pending}>{tr('prosClient.save')}</Button></div>
        </form>
      </Modal>
    </div>
  );
}
