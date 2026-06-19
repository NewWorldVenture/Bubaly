'use client';

import { useState } from 'react';
import { FolderLock, Plus, Trash2, FileText, AlertTriangle } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar } from '@/components/ui/avatar';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select } from '@/components/ui/input';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';

type Document = Tables<'documents'>;

const CATEGORIES = ['id', 'medical', 'financial', 'insurance', 'school', 'legal', 'vehicle', 'property', 'other'];

function isExpiringSoon(date: string | null): boolean {
  if (!date) return false;
  return new Date(date) <= new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
}

export function DocumentsModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);

  const { data, loading, error, refresh } = useRealtimeQuery<Document>({
    table: 'documents',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('documents').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  const memberById = new Map(members.map((m) => [m.id, m]));

  const grouped = new Map<string, Document[]>();
  for (const d of data) {
    const cat = d.category ?? 'other';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(d);
  }

  async function remove(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('documents').delete().eq('id', id);
    if (error) return toastError(error.message);
    success('Document removed');
    void refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  const expiring = data.filter((d) => isExpiringSoon(d.expires_at));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Documents"
        description="Passports, insurance cards, school records — all in one secure place."
        action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add document</Button>}
      />

      {expiring.length > 0 && (
        <Card className="border-warning/40 bg-warning/5">
          <div className="mb-3 flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            <h2 className="text-base font-semibold text-warning">Expiring soon</h2>
          </div>
          <ul className="space-y-2">
            {expiring.map((d) => (
              <li key={d.id} className="flex items-center gap-3 text-sm">
                <FileText className="h-4 w-4 text-muted" />
                <span className="flex-1 font-medium">{d.title}</span>
                <Badge tone="warning">{fmtDate(d.expires_at)}</Badge>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {data.length === 0 ? (
        <EmptyState icon={FolderLock} title="No documents yet" description="Add passports, insurance cards, and other important documents."
          action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add document</Button>} />
      ) : (
        <div className="space-y-6">
          {[...grouped.entries()].map(([cat, docs]) => (
            <div key={cat}>
              <h2 className="mb-2 text-sm font-semibold capitalize text-muted">{cat}</h2>
              <Card className="p-3">
                <ul className="divide-y divide-border">
                  {docs.map((d) => {
                    const m = d.member_id ? memberById.get(d.member_id) : null;
                    const expiring = isExpiringSoon(d.expires_at);
                    return (
                      <li key={d.id} className="flex items-center gap-3 py-2.5">
                        <FileText className="h-5 w-5 shrink-0 text-muted" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{d.title}</p>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                            {m && (
                              <span className="flex items-center gap-1">
                                <Avatar name={m.display_name} color={m.color} size={14} />
                                {m.display_name.split(' ')[0]}
                              </span>
                            )}
                            {d.expires_at && (
                              <span className={expiring ? 'text-warning' : ''}>
                                Expires {fmtDate(d.expires_at)}
                              </span>
                            )}
                          </div>
                        </div>
                        <button onClick={() => remove(d.id)} className="rounded-lg p-2 text-muted hover:text-danger" aria-label="Delete">
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Card>
            </div>
          ))}
        </div>
      )}

      {open && (
        <NewDocumentModal familyId={familyId} userId={userId} members={members}
          onClose={() => setOpen(false)} onCreated={() => { setOpen(false); void refresh(); }} />
      )}
    </div>
  );
}

function NewDocumentModal({ familyId, userId, members, onClose, onCreated }: {
  familyId: string; userId: string; members: Tables<'family_members'>[];
  onClose: () => void; onCreated: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    if (!title) return toastError('Title is required');
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('documents').insert({
      family_id: familyId, created_by: userId, title,
      category: String(form.get('category') ?? 'other'),
      storage_path: `families/${familyId}/docs/${Date.now()}_${title.replace(/\s+/g, '_')}`,
      expires_at: String(form.get('expires_at') ?? '') || null,
      member_id: String(form.get('member_id') ?? '') || null,
    });
    setLoading(false);
    if (error) return toastError(error.message);
    success('Document added');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title="Add document">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Document name" required>
          {(id) => <Input id={id} name="title" placeholder="John's Passport" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            {(id) => (
              <Select id={id} name="category" defaultValue="other">
                {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            )}
          </Field>
          <Field label="For">
            {(id) => (
              <Select id={id} name="member_id" defaultValue="">
                <option value="">Whole family</option>
                {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <Field label="Expiry date (optional)">{(id) => <Input id={id} name="expires_at" type="date" />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add document</Button>
        </div>
      </form>
    </Modal>
  );
}
