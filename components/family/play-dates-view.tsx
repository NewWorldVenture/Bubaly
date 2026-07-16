'use client';

import { useMemo, useState } from 'react';
import { Heart, Plus, Trash2, MapPin, Clock, Phone, Users } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Avatar } from '@/components/ui/avatar';
import { ErrorState, SkeletonList, EmptyState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';
import { splitPlayDates, PLAY_DATE_STATUS, fmtDateTime } from '@/lib/family/safety';

type PlayDate = Tables<'play_dates'>;

const STATUS_FLOW: Record<string, string> = { planned: 'confirmed', confirmed: 'completed' };

export function PlayDatesView() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);

  const { data: rows, loading, error, refresh } = useRealtimeQuery<PlayDate>({
    table: 'play_dates', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('play_dates').select('*').eq('family_id', familyId).order('starts_at', { ascending: true }),
  });

  const { upcoming, past } = useMemo(() => splitPlayDates(rows ?? []), [rows]);
  const [form, setForm] = useState(false);

  async function setStatus(pd: PlayDate, status: string) {
    const { error } = await createClient().from('play_dates').update({ status }).eq('id', pd.id);
    if (error) toastError(error.message); else success('Updated');
  }
  async function remove(id: string) {
    if (!confirm('Delete this play date?')) return;
    const { error } = await createClient().from('play_dates').delete().eq('id', id);
    if (error) toastError(error.message); else success('Deleted');
  }

  const Card = ({ pd }: { pd: PlayDate }) => {
    const kid = pd.member_id ? memberById.get(pd.member_id) : null;
    const meta = PLAY_DATE_STATUS[pd.status] ?? PLAY_DATE_STATUS.planned;
    const next = STATUS_FLOW[pd.status];
    return (
      <div className="group rounded-2xl border border-border bg-surface/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            {kid ? <Avatar name={kid.display_name} color={kid.color} size={40} /> : <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-pink-500/15 text-pink-300"><Heart className="h-5 w-5" /></span>}
            <div className="min-w-0">
              <p className="truncate font-semibold">{pd.title}</p>
              {pd.with_kids && <p className="truncate text-xs text-muted">with {pd.with_kids}</p>}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span className="inline-flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {fmtDateTime(pd.starts_at)}</span>
                {pd.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" /> {pd.location}</span>}
                {pd.contact_phone && <a href={`tel:${pd.contact_phone}`} className="inline-flex items-center gap-1 text-brand-text"><Phone className="h-3.5 w-3.5" /> {pd.contact_name || pd.contact_phone}</a>}
              </div>
            </div>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold', meta.tint)}>{meta.label}</span>
        </div>
        {pd.notes && <p className="mt-2 text-sm text-muted">{pd.notes}</p>}
        <div className="mt-3 flex items-center gap-2">
          {next && <Button size="sm" variant="outline" onClick={() => setStatus(pd, next)}>Mark {PLAY_DATE_STATUS[next].label.toLowerCase()}</Button>}
          {pd.status !== 'cancelled' && pd.status !== 'completed' && <Button size="sm" variant="ghost" onClick={() => setStatus(pd, 'cancelled')}>Cancel</Button>}
          <button onClick={() => remove(pd.id)} className="ml-auto rounded-lg p-1.5 text-muted/50 transition hover:text-danger" aria-label="Delete"><Trash2 className="h-4 w-4" /></button>
        </div>
      </div>
    );
  };

  return (
    <div className="module-page">
      <PageHeader title="Play Dates" description="Schedule and track the kids' play dates."
        action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> Schedule play date</Button>} />

      {loading ? <SkeletonList /> : error ? <ErrorState message="Could not load play dates. Refresh and try again." onRetry={refresh} /> : (rows ?? []).length === 0 ? (
        <EmptyState icon={Heart} title="No play dates yet" description="Schedule a play date to keep the kids' social calendar organized."
          action={<Button onClick={() => setForm(true)}><Plus className="h-4 w-4" /> Schedule play date</Button>} />
      ) : (
        <div className="space-y-6">
          <section>
            <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">Upcoming</h2>
            {upcoming.length === 0 ? <p className="rounded-2xl border border-dashed border-border bg-surface/30 px-4 py-8 text-center text-sm text-muted">Nothing coming up â€” schedule one!</p>
              : <div className="grid gap-3 sm:grid-cols-2">{upcoming.map((pd) => <Card key={pd.id} pd={pd} />)}</div>}
          </section>
          {past.length > 0 && (
            <section>
              <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">Past</h2>
              <div className="grid gap-3 sm:grid-cols-2">{past.map((pd) => <Card key={pd.id} pd={pd} />)}</div>
            </section>
          )}
        </div>
      )}

      {form && <PlayDateModal members={members} familyId={familyId} userId={userId} onClose={() => setForm(false)} />}
    </div>
  );
}

function PlayDateModal({ members, familyId, userId, onClose }: { members: Tables<'family_members'>[]; familyId: string; userId: string; onClose: () => void }) {
  const { success, error: toastError } = useToast();
  const [saving, setSaving] = useState(false);
  const [v, setV] = useState({ title: '', member_id: '', with_kids: '', location: '', starts_at: '', contact_name: '', contact_phone: '', notes: '' });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!v.title.trim() || !v.starts_at) return toastError('Add a title and date/time');
    setSaving(true);
    const { error } = await createClient().from('play_dates').insert({
      family_id: familyId, title: v.title.trim(), member_id: v.member_id || null,
      with_kids: v.with_kids.trim() || null, location: v.location.trim() || null,
      starts_at: new Date(v.starts_at).toISOString(), contact_name: v.contact_name.trim() || null,
      contact_phone: v.contact_phone.trim() || null, notes: v.notes.trim() || null, created_by: userId,
    });
    setSaving(false);
    if (error) return toastError(error.message);
    success('Play date scheduled');
    onClose();
  }

  return (
    <Modal open onClose={onClose} title="Schedule Play Date">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Title">{(id) => <Input id={id} value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} placeholder="Playdate at the park" required autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Child">{(id) => <Select id={id} value={v.member_id} onChange={(e) => setV({ ...v, member_id: e.target.value })}><option value="">â€”</option>{members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}</Select>}</Field>
          <Field label="When">{(id) => <Input id={id} type="datetime-local" value={v.starts_at} onChange={(e) => setV({ ...v, starts_at: e.target.value })} required />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="With" hint="Friends">{(id) => <Input id={id} value={v.with_kids} onChange={(e) => setV({ ...v, with_kids: e.target.value })} placeholder="Emma & Liam" />}</Field>
          <Field label="Location" hint="Optional">{(id) => <Input id={id} value={v.location} onChange={(e) => setV({ ...v, location: e.target.value })} placeholder="Riverside Park" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Contact name" hint="Optional">{(id) => <Input id={id} value={v.contact_name} onChange={(e) => setV({ ...v, contact_name: e.target.value })} placeholder="Sarah's mom" />}</Field>
          <Field label="Contact phone" hint="Optional">{(id) => <Input id={id} value={v.contact_phone} onChange={(e) => setV({ ...v, contact_phone: e.target.value })} placeholder="(555) 123-4567" />}</Field>
        </div>
        <Field label="Notes" hint="Optional">{(id) => <Textarea id={id} value={v.notes} onChange={(e) => setV({ ...v, notes: e.target.value })} rows={2} placeholder="Bring sunscreen and a snack." />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={saving} disabled={!v.title.trim() || !v.starts_at}>Schedule</Button>
        </div>
      </form>
    </Modal>
  );
}

