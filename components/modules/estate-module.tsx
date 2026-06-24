'use client';

import { useMemo, useState } from 'react';
import {
  Plus, Trash2, Sparkles,
  ChevronRight, Phone, Mail, FileText, Laptop,
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
import {
  DOCUMENT_TYPES, REVIEW_STATUSES, docTypeMeta,
  reviewUrgency, upcomingReviews, documentGaps,
  estateSummary, fmtDate, type ReviewUrgency,
} from '@/lib/estate/planning';

type Doc = Tables<'estate_documents'>;
type DigitalAccount = Tables<'estate_digital_accounts'>;

const URGENCY_STYLE: Record<ReviewUrgency, string> = {
  overdue: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  due_soon: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  upcoming: 'border-border bg-surface/50 text-muted',
  none: 'border-border bg-surface/50 text-muted',
};

const STATUS_STYLE: Record<string, string> = {
  current: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  needs_review: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
  expired: 'bg-rose-500/10 text-rose-400 border-rose-500/30',
  draft: 'bg-blue-500/10 text-blue-400 border-blue-500/30',
};

export function EstateModule() {
  const { familyId, userId } = useApp();
  const { success, error: toastError } = useToast();

  const documents = useRealtimeQuery<Doc>({
    table: 'estate_documents', familyId,
    fetcher: (s) => s.from('estate_documents').select('*').eq('family_id', familyId).eq('is_active', true).order('document_type'),
    deps: [familyId],
  });

  const digitalAccounts = useRealtimeQuery<DigitalAccount>({
    table: 'estate_digital_accounts', familyId,
    fetcher: (s) => s.from('estate_digital_accounts').select('*').eq('family_id', familyId).eq('is_active', true).order('account_name'),
    deps: [familyId],
  });

  const [addDocOpen, setAddDocOpen] = useState(false);
  const [addDigitalOpen, setAddDigitalOpen] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<Doc | null>(null);
  const [selectedDigital, setSelectedDigital] = useState<DigitalAccount | null>(null);
  const [tab, setTab] = useState<'documents' | 'digital'>('documents');

  const summary = useMemo(() => {
    if (!documents.data) return null;
    return estateSummary(documents.data);
  }, [documents.data]);

  const reviews = useMemo(() => {
    if (!documents.data) return [];
    return upcomingReviews(documents.data);
  }, [documents.data]);

  const gaps = useMemo(() => {
    if (!documents.data) return [];
    return documentGaps(documents.data);
  }, [documents.data]);

  if (documents.loading) return <LoadingBlock />;

  return (
    <div className="space-y-6">
      <PageHeader title="Estate & Legacy Vault" />

      {/* Summary card */}
      {summary && (
        <div className="rounded-xl border border-border bg-surface/60 p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{summary.count} document{summary.count !== 1 ? 's' : ''} on file</span>
          </div>
          <p className="text-sm font-medium">{summary.text}</p>
        </div>
      )}

      {/* AI awareness panel */}
      {(gaps.length > 0 || reviews.some((r) => r.urgency === 'overdue' || r.urgency === 'due_soon')) && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 space-y-3">
          <div className="flex items-center gap-2 text-amber-400">
            <Sparkles className="w-4 h-4" />
            <span className="text-sm font-semibold">Estate planning awareness</span>
          </div>
          {gaps.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted">Essential documents missing:</p>
              <div className="flex flex-wrap gap-1.5">
                {gaps.map((g) => {
                  const m = docTypeMeta(g);
                  return (
                    <span key={g} className="text-xs px-2 py-0.5 rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-300">
                      {m.emoji} {m.label}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
          {reviews.filter((r) => r.urgency === 'overdue' || r.urgency === 'due_soon').length > 0 && (
            <div className="space-y-1">
              <p className="text-xs text-muted">Needs attention:</p>
              {reviews.filter((r) => r.urgency === 'overdue' || r.urgency === 'due_soon').map((r) => (
                <div key={r.id} className={cn('text-xs px-2 py-1 rounded border', URGENCY_STYLE[r.urgency])}>
                  {docTypeMeta(r.documentType).emoji} {r.title} — {r.urgency === 'overdue' ? `${Math.abs(r.daysUntil)}d overdue` : `review in ${r.daysUntil}d`}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tab selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setTab('documents')}
          className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
            tab === 'documents' ? 'bg-primary text-primary-foreground' : 'bg-surface/60 text-muted hover:text-foreground')}
        >
          <FileText className="w-3.5 h-3.5 inline mr-1" /> Documents
        </button>
        <button
          onClick={() => setTab('digital')}
          className={cn('px-3 py-1.5 rounded-lg text-sm font-medium transition-colors',
            tab === 'digital' ? 'bg-primary text-primary-foreground' : 'bg-surface/60 text-muted hover:text-foreground')}
        >
          <Laptop className="w-3.5 h-3.5 inline mr-1" /> Digital Legacy
        </button>
      </div>

      {/* Documents tab */}
      {tab === 'documents' && (
        <>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAddDocOpen(true)}><Plus className="w-4 h-4 mr-1" /> Add Document</Button>
          </div>
          {(!documents.data || documents.data.length === 0) ? (
            <EmptyState title="No estate documents" description="Add your important estate planning documents to keep them organized and reviewed." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {documents.data.map((d) => {
                const meta = docTypeMeta(d.document_type);
                const urg = reviewUrgency(d.next_review);
                return (
                  <button key={d.id} onClick={() => setSelectedDoc(d)}
                    className="text-left rounded-xl border border-border bg-surface/60 p-4 hover:border-primary/40 transition-colors">
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-xl">{meta.emoji}</span>
                        <div>
                          <p className="text-sm font-semibold">{d.title || meta.label}</p>
                          <p className="text-xs text-muted">{meta.label}{d.holder_name ? ` · ${d.holder_name}` : ''}</p>
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-muted" />
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <span className={cn('text-xs px-2 py-0.5 rounded-full border', STATUS_STYLE[d.review_status] || STATUS_STYLE.draft)}>
                        {REVIEW_STATUSES.find((s) => s.value === d.review_status)?.label || d.review_status}
                      </span>
                      {d.next_review && urg !== 'none' && (
                        <span className={cn('text-xs px-2 py-0.5 rounded-full border', URGENCY_STYLE[urg])}>
                          {urg === 'overdue' ? 'Overdue' : `Review ${fmtDate(d.next_review)}`}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Digital Legacy tab */}
      {tab === 'digital' && (
        <>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAddDigitalOpen(true)}><Plus className="w-4 h-4 mr-1" /> Add Account</Button>
          </div>
          {(!digitalAccounts.data || digitalAccounts.data.length === 0) ? (
            <EmptyState title="No digital accounts" description="Track your digital accounts so your family knows where to find them." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {digitalAccounts.data.map((a) => (
                <button key={a.id} onClick={() => setSelectedDigital(a)}
                  className="text-left rounded-xl border border-border bg-surface/60 p-4 hover:border-primary/40 transition-colors">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-semibold">{a.account_name}</p>
                      <p className="text-xs text-muted">{a.provider}{a.account_type ? ` · ${a.account_type}` : ''}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-muted" />
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    {a.has_2fa && <span className="text-xs px-2 py-0.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">2FA</span>}
                    {a.legacy_contact_name && <span className="text-xs text-muted">Legacy: {a.legacy_contact_name}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {/* Add document modal */}
      {addDocOpen && (
        <AddDocumentModal familyId={familyId} userId={userId}
          onClose={() => setAddDocOpen(false)}
          onSuccess={() => { setAddDocOpen(false); success('Document added'); }} />
      )}

      {/* Add digital account modal */}
      {addDigitalOpen && (
        <AddDigitalAccountModal familyId={familyId} userId={userId}
          onClose={() => setAddDigitalOpen(false)}
          onSuccess={() => { setAddDigitalOpen(false); success('Account added'); }} />
      )}

      {/* Document detail modal */}
      {selectedDoc && (
        <DocumentDetailModal doc={selectedDoc} familyId={familyId}
          onClose={() => setSelectedDoc(null)}
          onDelete={() => { setSelectedDoc(null); success('Document removed'); }} />
      )}

      {/* Digital account detail modal */}
      {selectedDigital && (
        <DigitalAccountDetailModal account={selectedDigital}
          familyId={familyId}
          onClose={() => setSelectedDigital(null)}
          onDelete={() => { setSelectedDigital(null); success('Account removed'); }} />
      )}
    </div>
  );
}

/* ── Add Document Modal ──────────────────────────────────────────────── */

function AddDocumentModal({ familyId, userId, onClose, onSuccess }: {
  familyId: string; userId: string; onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const fd = new FormData(e.currentTarget);
    const { error } = await createClient().from('estate_documents').insert({
      family_id: familyId,
      created_by: userId,
      document_type: String(fd.get('document_type') ?? 'other') as Doc['document_type'],
      title: String(fd.get('title') ?? ''),
      description: String(fd.get('description') ?? ''),
      holder_name: String(fd.get('holder_name') ?? ''),
      review_status: String(fd.get('review_status') ?? 'current') as Doc['review_status'],
      effective_date: String(fd.get('effective_date') ?? '') || null,
      expiration_date: String(fd.get('expiration_date') ?? '') || null,
      next_review: String(fd.get('next_review') ?? '') || null,
      attorney_name: String(fd.get('attorney_name') ?? ''),
      attorney_phone: String(fd.get('attorney_phone') ?? ''),
      attorney_email: String(fd.get('attorney_email') ?? ''),
      notes: String(fd.get('notes') ?? ''),
    });
    setSaving(false);
    if (error) { toastError(error.message); return; }
    onSuccess();
  }

  return (
    <Modal open onClose={onClose} title="Add Estate Document">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Document Type">{(id) =>
          <Select id={id} name="document_type" defaultValue="will">
            {DOCUMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.emoji} {t.label}</option>)}
          </Select>
        }</Field>
        <Field label="Title" required>{(id) => <Input id={id} name="title" autoFocus />}</Field>
        <Field label="Holder Name">{(id) => <Input id={id} name="holder_name" placeholder="Who this document is for" />}</Field>
        <Field label="Description">{(id) => <Textarea id={id} name="description" rows={2} />}</Field>
        <Field label="Status">{(id) =>
          <Select id={id} name="review_status" defaultValue="current">
            {REVIEW_STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </Select>
        }</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Effective Date">{(id) => <Input id={id} name="effective_date" type="date" />}</Field>
          <Field label="Expiration Date">{(id) => <Input id={id} name="expiration_date" type="date" />}</Field>
        </div>
        <Field label="Next Review Date">{(id) => <Input id={id} name="next_review" type="date" />}</Field>
        <Field label="Attorney Name">{(id) => <Input id={id} name="attorney_name" />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Attorney Phone">{(id) => <Input id={id} name="attorney_phone" type="tel" />}</Field>
          <Field label="Attorney Email">{(id) => <Input id={id} name="attorney_email" type="email" />}</Field>
        </div>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Add Digital Account Modal ───────────────────────────────────────── */

function AddDigitalAccountModal({ familyId, userId, onClose, onSuccess }: {
  familyId: string; userId: string; onClose: () => void; onSuccess: () => void;
}) {
  const { error: toastError } = useToast();
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSaving(true);
    const fd = new FormData(e.currentTarget);
    const { error } = await createClient().from('estate_digital_accounts').insert({
      family_id: familyId,
      created_by: userId,
      account_name: String(fd.get('account_name') ?? ''),
      provider: String(fd.get('provider') ?? ''),
      account_type: String(fd.get('account_type') ?? ''),
      username: String(fd.get('username') ?? ''),
      legacy_contact_name: String(fd.get('legacy_contact_name') ?? ''),
      legacy_contact_email: String(fd.get('legacy_contact_email') ?? ''),
      instructions: String(fd.get('instructions') ?? ''),
      has_2fa: fd.get('has_2fa') === 'on',
      notes: String(fd.get('notes') ?? ''),
    });
    setSaving(false);
    if (error) { toastError(error.message); return; }
    onSuccess();
  }

  return (
    <Modal open onClose={onClose} title="Add Digital Account">
      <form onSubmit={handleSubmit} className="space-y-4">
        <Field label="Account Name" required>{(id) => <Input id={id} name="account_name" autoFocus placeholder="e.g., Gmail, iCloud, Facebook" />}</Field>
        <Field label="Provider">{(id) => <Input id={id} name="provider" placeholder="Google, Apple, Meta..." />}</Field>
        <Field label="Account Type">{(id) => <Input id={id} name="account_type" placeholder="Email, Social, Financial..." />}</Field>
        <Field label="Username / Email">{(id) => <Input id={id} name="username" />}</Field>
        <Field label="Legacy Contact Name">{(id) => <Input id={id} name="legacy_contact_name" placeholder="Who should inherit access" />}</Field>
        <Field label="Legacy Contact Email">{(id) => <Input id={id} name="legacy_contact_email" type="email" />}</Field>
        <Field label="Access Instructions">{(id) => <Textarea id={id} name="instructions" rows={3} placeholder="How to access this account if needed" />}</Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="has_2fa" className="rounded border-border" />
          This account has two-factor authentication
        </label>
        <Field label="Notes">{(id) => <Textarea id={id} name="notes" rows={2} />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving}>Save</Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Document Detail Modal ───────────────────────────────────────────── */

function DocumentDetailModal({ doc, familyId, onClose, onDelete }: {
  doc: Doc; familyId: string; onClose: () => void; onDelete: () => void;
}) {
  const { error: toastError } = useToast();
  const meta = docTypeMeta(doc.document_type);

  async function handleDelete() {
    const { error } = await createClient().from('estate_documents').update({ is_active: false }).eq('id', doc.id);
    if (error) { toastError(error.message); return; }
    onDelete();
  }

  const rows: [string, string][] = [
    ['Type', `${meta.emoji} ${meta.label}`],
    ['Holder', doc.holder_name || '—'],
    ['Status', REVIEW_STATUSES.find((s) => s.value === doc.review_status)?.label || doc.review_status],
    ['Effective', fmtDate(doc.effective_date)],
    ['Expires', fmtDate(doc.expiration_date)],
    ['Last Reviewed', fmtDate(doc.last_reviewed)],
    ['Next Review', fmtDate(doc.next_review)],
  ];

  return (
    <Modal open onClose={onClose} title={doc.title || meta.label}>
      <div className="space-y-4">
        {doc.description && <p className="text-sm text-muted">{doc.description}</p>}

        <div className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted">{k}</span>
              <span className="font-medium">{v}</span>
            </div>
          ))}
        </div>

        {(doc.attorney_name || doc.attorney_phone || doc.attorney_email) && (
          <div className="rounded-lg border border-border bg-surface/40 p-3 space-y-1">
            <p className="text-xs text-muted font-semibold uppercase tracking-wide">Attorney / Advisor</p>
            {doc.attorney_name && <p className="text-sm font-medium">{doc.attorney_name}</p>}
            {doc.attorney_phone && (
              <a href={`tel:${doc.attorney_phone}`} className="flex items-center gap-1 text-sm text-primary hover:underline">
                <Phone className="w-3.5 h-3.5" /> {doc.attorney_phone}
              </a>
            )}
            {doc.attorney_email && (
              <a href={`mailto:${doc.attorney_email}`} className="flex items-center gap-1 text-sm text-primary hover:underline">
                <Mail className="w-3.5 h-3.5" /> {doc.attorney_email}
              </a>
            )}
          </div>
        )}

        {doc.notes && (
          <div className="rounded-lg border border-border bg-surface/40 p-3">
            <p className="text-xs text-muted mb-1">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{doc.notes}</p>
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

/* ── Digital Account Detail Modal ────────────────────────────────────── */

function DigitalAccountDetailModal({ account, familyId, onClose, onDelete }: {
  account: DigitalAccount; familyId: string; onClose: () => void; onDelete: () => void;
}) {
  const { error: toastError } = useToast();

  async function handleDelete() {
    const { error } = await createClient().from('estate_digital_accounts').update({ is_active: false }).eq('id', account.id);
    if (error) { toastError(error.message); return; }
    onDelete();
  }

  const rows: [string, string][] = [
    ['Provider', account.provider || '—'],
    ['Type', account.account_type || '—'],
    ['Username', account.username || '—'],
    ['2FA Enabled', account.has_2fa ? 'Yes' : 'No'],
    ['Legacy Contact', account.legacy_contact_name || '—'],
  ];

  return (
    <Modal open onClose={onClose} title={account.account_name}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          {rows.map(([k, v]) => (
            <div key={k} className="flex justify-between text-sm">
              <span className="text-muted">{k}</span>
              <span className="font-medium">{v}</span>
            </div>
          ))}
        </div>

        {account.legacy_contact_email && (
          <a href={`mailto:${account.legacy_contact_email}`} className="flex items-center gap-1 text-sm text-primary hover:underline">
            <Mail className="w-3.5 h-3.5" /> {account.legacy_contact_email}
          </a>
        )}

        {account.instructions && (
          <div className="rounded-lg border border-border bg-surface/40 p-3">
            <p className="text-xs text-muted mb-1">Access Instructions</p>
            <p className="text-sm whitespace-pre-wrap">{account.instructions}</p>
          </div>
        )}

        {account.notes && (
          <div className="rounded-lg border border-border bg-surface/40 p-3">
            <p className="text-xs text-muted mb-1">Notes</p>
            <p className="text-sm whitespace-pre-wrap">{account.notes}</p>
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
