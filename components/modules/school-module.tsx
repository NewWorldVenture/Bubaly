'use client';

import { useState } from 'react';
import { GraduationCap, Plus, Trash2, MapPin } from 'lucide-react';
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
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtDate, fmtTime } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';

type SchoolEvent = Tables<'school_events'>;

const EVENT_TYPES = ['general', 'holiday', 'field_trip', 'parent_meeting', 'exam', 'concert', 'sport', 'graduation'];

export function SchoolModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);

  const { data, loading, error, refresh } = useRealtimeQuery<SchoolEvent>({
    table: 'school_events',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('school_events').select('*').eq('family_id', familyId)
        .gte('starts_at', new Date(Date.now() - 86400000 * 7).toISOString())
        .order('starts_at', { ascending: true }),
  });

  const grouped = new Map<string, SchoolEvent[]>();
  for (const e of data) {
    const key = e.starts_at.slice(0, 10);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(e);
  }

  async function remove(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('school_events').delete().eq('id', id);
    if (error) return toastError(error.message);
    success('Event removed');
    void refresh();
  }

  const memberById = new Map(members.map((m) => [m.id, m]));

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="School"
        description="School events, holidays, and parent meetings in one place."
        action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add event</Button>}
      />

      {grouped.size === 0 ? (
        <EmptyState icon={GraduationCap} title="No school events" description="Add school events to keep everyone informed."
          action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add event</Button>} />
      ) : (
        <div className="space-y-5">
          {[...grouped.entries()].map(([day, events]) => (
            <div key={day}>
              <h2 className="mb-2 text-sm font-semibold text-muted">{fmtDate(day, 'EEEE, MMMM d')}</h2>
              <Card className="p-3">
                <ul className="divide-y divide-border">
                  {events.map((e) => {
                    const m = e.member_id ? memberById.get(e.member_id) : null;
                    return (
                      <li key={e.id} className="flex items-center gap-3 py-2.5">
                        <div className="w-20 shrink-0 text-sm font-medium text-muted">{fmtTime(e.starts_at)}</div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{e.title}</p>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                            {e.school_name && <span>{e.school_name}</span>}
                            {m && (
                              <span className="flex items-center gap-1">
                                <Avatar name={m.display_name} color={m.color} size={16} />
                                {m.display_name.split(' ')[0]}
                              </span>
                            )}
                          </div>
                        </div>
                        <Badge tone="neutral">{e.event_type ?? 'general'}</Badge>
                        <button onClick={() => remove(e.id)} className="rounded-lg p-2 text-muted hover:text-danger" aria-label="Delete">
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
        <NewSchoolEventModal
          familyId={familyId}
          userId={userId}
          members={members}
          onClose={() => setOpen(false)}
          onCreated={() => { setOpen(false); void refresh(); }}
        />
      )}
    </div>
  );
}

function NewSchoolEventModal({ familyId, userId, members, onClose, onCreated }: {
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
    const memberId = String(form.get('member_id') ?? '');
    const { error } = await supabase.from('school_events').insert({
      family_id: familyId,
      created_by: userId,
      title,
      school_name: String(form.get('school_name') ?? '').trim() || null,
      event_type: String(form.get('event_type') ?? 'general'),
      starts_at: new Date(String(form.get('starts_at'))).toISOString(),
      ends_at: form.get('ends_at') ? new Date(String(form.get('ends_at'))).toISOString() : null,
      notes: String(form.get('notes') ?? '').trim() || null,
      member_id: memberId || null,
    });
    setLoading(false);
    if (error) return toastError(error.message);
    success('Event added');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title="Add school event">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Event title" required>
          {(id) => <Input id={id} name="title" placeholder="Parent-teacher night" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="School">
            {(id) => <Input id={id} name="school_name" placeholder="Lincoln Elementary" />}
          </Field>
          <Field label="Type">
            {(id) => (
              <Select id={id} name="event_type" defaultValue="general">
                {EVENT_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Start" required>
            {(id) => <Input id={id} name="starts_at" type="datetime-local" required />}
          </Field>
          <Field label="End">
            {(id) => <Input id={id} name="ends_at" type="datetime-local" />}
          </Field>
        </div>
        <Field label="For">
          {(id) => (
            <Select id={id} name="member_id" defaultValue="">
              <option value="">Whole family</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.display_name}</option>)}
            </Select>
          )}
        </Field>
        <Field label="Notes">
          {(id) => <Textarea id={id} name="notes" placeholder="Any extra details…" />}
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add event</Button>
        </div>
      </form>
    </Modal>
  );
}
