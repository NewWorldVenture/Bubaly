'use client';

import { useMemo, useState } from 'react';
import {
  HeartHandshake, Plus, Pencil, Trash2, Phone, Home as HomeIcon, PhoneCall,
  UtensilsCrossed, Pill, Stethoscope, AlertTriangle, StickyNote, Clock, Heart,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { LoadingBlock, ErrorState, EmptyState } from '@/components/ui/states';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';
import {
  sortByRecent, hoursSinceLastContact, isContactOverdue, averageWellbeing,
  groupByDay, entriesInLastDays, CARE_LOG_TYPE_LABELS,
  type CareEntryLike, type CareLogType,
} from '@/lib/care/log';
import type { Tables } from '@/lib/database.types';

type CareEntry = Tables<'care_log'>;

const TYPE_ICON: Record<CareLogType, typeof Phone> = {
  check_in: PhoneCall, visit: HomeIcon, call: Phone, meal: UtensilsCrossed,
  medication: Pill, appointment: Stethoscope, incident: AlertTriangle, note: StickyNote,
};
const TYPE_ACCENT: Record<CareLogType, string> = {
  check_in: 'text-sky-400', visit: 'text-violet-400', call: 'text-emerald-400', meal: 'text-amber-400',
  medication: 'text-rose-400', appointment: 'text-blue-400', incident: 'text-rose-500', note: 'text-muted',
};

function nowLocalInput(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const blank = { id: '', log_type: 'check_in' as CareLogType, occurred_at: '', wellbeing: '', note: '' };

export function CareModule() {
  const { familyId, userId, members, selfMember } = useApp();
  const { success, error: toastError } = useToast();

  const [recipientId, setRecipientId] = useState<string>(members[0]?.id ?? '');
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);

  const { data: entries, loading, error } = useRealtimeQuery<CareEntry>({
    table: 'care_log', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('care_log').select('*').eq('family_id', familyId).order('occurred_at', { ascending: false }),
  });

  const memberName = (id: string | null) => members.find((m) => m.id === id)?.display_name ?? null;
  const now = useMemo(() => new Date(), []);

  const recipientEntries = useMemo(
    () => (entries ?? []).filter((e) => e.member_id === recipientId),
    [entries, recipientId],
  );
  const entryLikes = useMemo<CareEntryLike[]>(
    () => recipientEntries.map((e) => ({ id: e.id, occurred_at: e.occurred_at, wellbeing: e.wellbeing, log_type: e.log_type })),
    [recipientEntries],
  );

  const hrsSince = hoursSinceLastContact(entryLikes, now);
  const overdue = isContactOverdue(entryLikes, now, 24);
  const avgWellbeing = averageWellbeing(entryLikes);
  const weekCount = entriesInLastDays(entryLikes, now, 7);
  const grouped = useMemo(() => groupByDay(recipientEntries), [recipientEntries]);
  const entryById = useMemo(() => new Map(recipientEntries.map((e) => [e.id, e])), [recipientEntries]);

  function openNew(type: CareLogType = 'check_in') {
    setForm({ ...blank, log_type: type, occurred_at: nowLocalInput() });
    setModalOpen(true);
  }
  function openEdit(e: CareEntry) {
    setForm({ id: e.id, log_type: e.log_type, occurred_at: toLocalInput(e.occurred_at), wellbeing: e.wellbeing != null ? String(e.wellbeing) : '', note: e.note ?? '' });
    setModalOpen(true);
  }

  async function save(ev: React.FormEvent) {
    ev.preventDefault();
    if (!recipientId) { toastError('Pick who the care is for'); return; }
    setSaving(true);
    const sb = createClient();
    const fields = {
      member_id: recipientId,
      log_type: form.log_type,
      occurred_at: form.occurred_at ? new Date(form.occurred_at).toISOString() : new Date().toISOString(),
      wellbeing: form.wellbeing ? Number(form.wellbeing) : null,
      note: form.note.trim() || null,
    };
    const { error: err } = form.id
      ? await sb.from('care_log').update(fields).eq('id', form.id)
      : await sb.from('care_log').insert({ ...fields, family_id: familyId, logged_by: selfMember?.id ?? null, created_by: userId });
    setSaving(false);
    if (err) { toastError(err.message); return; }
    success(form.id ? 'Entry updated' : 'Care logged');
    setModalOpen(false);
  }

  async function quickLog(type: CareLogType) {
    if (!recipientId) { toastError('Pick who the care is for'); return; }
    const sb = createClient();
    const { error: err } = await sb.from('care_log').insert({
      family_id: familyId, member_id: recipientId, log_type: type,
      occurred_at: new Date().toISOString(), logged_by: selfMember?.id ?? null, created_by: userId,
    });
    if (err) { toastError(err.message); return; }
    success(`${CARE_LOG_TYPE_LABELS[type]} logged`);
  }

  async function remove(e: CareEntry) {
    if (!confirm('Delete this care entry?')) return;
    const sb = createClient();
    const { error: err } = await sb.from('care_log').delete().eq('id', e.id);
    if (err) { toastError(err.message); return; }
    success('Entry deleted');
  }

  const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const fmtDay = (key: string) => new Date(`${key}T00:00:00`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const sinceLabel = hrsSince == null ? 'No contact logged' : hrsSince < 1 ? 'Just now' : hrsSince < 24 ? `${hrsSince}h ago` : `${Math.floor(hrsSince / 24)}d ago`;

  if (loading) return <LoadingBlock label="Loading care log…" />;
  if (error) return <ErrorState message={typeof error === 'string' ? error : 'Failed to load care log'} />;

  return (
    <div>
      <PageHeader
        title="Care Log"
        description="Coordinate care for a loved one — log check-ins, track well-being, and see who's been in touch."
        action={<Button onClick={() => openNew()} className="gap-1.5"><Plus className="h-4 w-4" /> Log care</Button>}
      />

      {/* Recipient selector */}
      <div className="flex flex-wrap items-center gap-2 mb-5">
        <span className="text-sm text-muted">Caring for:</span>
        {members.map((m) => (
          <button key={m.id} onClick={() => setRecipientId(m.id)}
            className={cn('inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition',
              recipientId === m.id ? 'bg-brand text-white border-brand' : 'bg-surface/50 text-muted border-border hover:text-fg')}>
            <Avatar name={m.display_name} size={18} />{m.display_name}
          </button>
        ))}
      </div>

      {!recipientId ? (
        <EmptyState icon={HeartHandshake} title="Add a family member" description="Add family members to start coordinating their care." />
      ) : (
        <>
          {/* Status cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
            <div className={cn('rounded-2xl border p-5', overdue ? 'bg-amber-500/5 border-amber-500/30' : 'bg-surface/50 border-border')}>
              <div className="flex items-center gap-2 text-xs text-muted uppercase tracking-wider mb-1.5">
                <Clock className="h-4 w-4" /> Last contact
              </div>
              <div className={cn('text-2xl font-bold', overdue ? 'text-amber-400' : 'text-fg')}>{sinceLabel}</div>
              {overdue && <div className="text-xs text-amber-400 mt-1">Check in soon</div>}
            </div>
            <div className="rounded-2xl bg-surface/50 border border-border p-5">
              <div className="flex items-center gap-2 text-xs text-muted uppercase tracking-wider mb-1.5">
                <Heart className="h-4 w-4" /> Well-being
              </div>
              <div className="text-2xl font-bold text-fg">{avgWellbeing == null ? '—' : `${avgWellbeing}/5`}</div>
              <div className="text-xs text-muted mt-1">Average rated</div>
            </div>
            <div className="rounded-2xl bg-surface/50 border border-border p-5">
              <div className="flex items-center gap-2 text-xs text-muted uppercase tracking-wider mb-1.5">
                <HeartHandshake className="h-4 w-4" /> This week
              </div>
              <div className="text-2xl font-bold text-fg">{weekCount}</div>
              <div className="text-xs text-muted mt-1">Care touchpoints</div>
            </div>
          </div>

          {/* Quick log */}
          <div className="flex flex-wrap gap-1.5 mb-6">
            {(['check_in', 'call', 'visit', 'meal', 'medication', 'incident'] as CareLogType[]).map((type) => {
              const Icon = TYPE_ICON[type];
              return (
                <button key={type} onClick={() => quickLog(type)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium bg-surface/50 border border-border text-fg/80 hover:text-fg hover:border-brand/40 transition">
                  <Icon className={cn('h-4 w-4', TYPE_ACCENT[type])} /> {CARE_LOG_TYPE_LABELS[type]}
                </button>
              );
            })}
          </div>

          {/* Timeline */}
          {recipientEntries.length === 0 ? (
            <EmptyState icon={HeartHandshake} title={`No care logged for ${memberName(recipientId)}`}
              description="Use the quick-log buttons above or “Log care” to record the first check-in."
              action={<Button onClick={() => openNew()} className="gap-1.5"><Plus className="h-4 w-4" /> Log care</Button>} />
          ) : (
            <div className="space-y-6">
              {grouped.map(([day, dayEntries]) => (
                <div key={day}>
                  <h2 className="text-sm font-semibold text-fg mb-2.5">{fmtDay(day)}</h2>
                  <div className="relative pl-5">
                    <div className="absolute left-1.5 top-2 bottom-2 w-px bg-elevated" />
                    <div className="space-y-4">
                      {sortByRecent(dayEntries.map((e) => ({ id: e.id, occurred_at: e.occurred_at, wellbeing: e.wellbeing, log_type: e.log_type }))).map((row) => {
                        const e = entryById.get(row.id)!;
                        const Icon = TYPE_ICON[e.log_type];
                        return (
                          <div key={e.id} className="flex gap-3 items-start group">
                            <div className="relative -left-[1.4rem] mt-0.5 flex-shrink-0">
                              <div className={cn('w-7 h-7 rounded-full bg-surface border border-border flex items-center justify-center', TYPE_ACCENT[e.log_type])}>
                                <Icon className="h-3.5 w-3.5" />
                              </div>
                            </div>
                            <div className="flex-1 min-w-0 flex items-start justify-between gap-3 pb-1">
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-fg flex items-center gap-2 flex-wrap">
                                  {CARE_LOG_TYPE_LABELS[e.log_type]}
                                  <span className="text-xs text-muted font-normal">{fmtTime(e.occurred_at)}</span>
                                  {e.wellbeing != null && (
                                    <span className="inline-flex items-center gap-0.5 text-xs text-rose-300">
                                      <Heart className="h-3 w-3 fill-current" />{e.wellbeing}/5
                                    </span>
                                  )}
                                </div>
                                {e.note && <div className="text-sm text-fg/80 mt-0.5">{e.note}</div>}
                                {e.logged_by && <div className="text-xs text-muted mt-0.5">by {memberName(e.logged_by)}</div>}
                              </div>
                              <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 transition">
                                <button onClick={() => openEdit(e)} aria-label="Edit" className="p-1.5 rounded-lg text-muted hover:text-fg hover:bg-elevated"><Pencil className="h-4 w-4" /></button>
                                <button onClick={() => remove(e)} aria-label="Delete" className="p-1.5 rounded-lg text-muted hover:text-rose-400 hover:bg-elevated"><Trash2 className="h-4 w-4" /></button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Modal */}
      <Modal open={modalOpen} onClose={() => setModalOpen(false)} title={form.id ? 'Edit care entry' : `Log care${recipientId ? ` · ${memberName(recipientId)}` : ''}`}>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              {(id) => (
                <Select id={id} value={form.log_type} onChange={(e) => setForm((f) => ({ ...f, log_type: e.target.value as CareLogType }))}>
                  {(Object.keys(CARE_LOG_TYPE_LABELS) as CareLogType[]).map((t) => <option key={t} value={t}>{CARE_LOG_TYPE_LABELS[t]}</option>)}
                </Select>
              )}
            </Field>
            <Field label="When">
              {(id) => <Input id={id} type="datetime-local" value={form.occurred_at} onChange={(e) => setForm((f) => ({ ...f, occurred_at: e.target.value }))} />}
            </Field>
          </div>
          <Field label="Well-being (1–5)" hint="Optional — how were they doing?">
            {(id) => (
              <Select id={id} value={form.wellbeing} onChange={(e) => setForm((f) => ({ ...f, wellbeing: e.target.value }))}>
                <option value="">Not rated</option>
                <option value="5">5 — Great</option>
                <option value="4">4 — Good</option>
                <option value="3">3 — Okay</option>
                <option value="2">2 — Poor</option>
                <option value="1">1 — Concerning</option>
              </Select>
            )}
          </Field>
          <Field label="Notes">
            {(id) => <Textarea id={id} value={form.note} onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} placeholder="How are they? Anything to follow up on?" />}
          </Field>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => setModalOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : form.id ? 'Save changes' : 'Log care'}</Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
