'use client';

import { useState } from 'react';
import { Trophy, Plus, Trash2, MapPin } from 'lucide-react';
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
import { fmtDate, fmtTime } from '@/lib/utils/format';
import type { Tables } from '@/lib/database.types';

type SportsEvent = Tables<'sports_events'>;

export function SportsModule() {
  const { familyId, userId, members } = useApp();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);

  const { data, loading, error, refresh } = useRealtimeQuery<SportsEvent>({
    table: 'sports_events',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('sports_events').select('*').eq('family_id', familyId)
        .gte('starts_at', new Date(Date.now() - 86400000 * 7).toISOString())
        .order('starts_at', { ascending: true }),
  });

  const grouped = new Map<string, SportsEvent[]>();
  for (const e of data) {
    const key = e.starts_at.slice(0, 10);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(e);
  }

  const memberById = new Map(members.map((m) => [m.id, m]));

  async function remove(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('sports_events').delete().eq('id', id);
    if (error) return toastError(error.message);
    success('Event removed');
    void refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sports & Activities"
        description="Practices, games, and tournaments for the whole team."
        action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add event</Button>}
      />

      {grouped.size === 0 ? (
        <EmptyState icon={Trophy} title="No sports events" description="Add practices and games to keep everyone on schedule."
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
                            {e.sport && <span>{e.sport}</span>}
                            {e.team && <span>· {e.team}</span>}
                            {e.location && <span className="flex items-center gap-1"><MapPin className="h-3 w-3" />{e.location}</span>}
                            {m && (
                              <span className="flex items-center gap-1">
                                <Avatar name={m.display_name} color={m.color} size={16} />
                                {m.display_name.split(' ')[0]}
                              </span>
                            )}
                          </div>
                        </div>
                        <Badge tone="accent">{e.event_type ?? 'practice'}</Badge>
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
        <NewSportsEventModal
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

function NewSportsEventModal({ familyId, userId, members, onClose, onCreated }: {
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
    if (!form.get('starts_at')) return toastError('Start time is required');
    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('sports_events').insert({
      family_id: familyId,
      created_by: userId,
      title,
      sport: String(form.get('sport') ?? '').trim() || null,
      team: String(form.get('team') ?? '').trim() || null,
      event_type: String(form.get('event_type') ?? 'practice'),
      location: String(form.get('location') ?? '').trim() || null,
      starts_at: new Date(String(form.get('starts_at'))).toISOString(),
      ends_at: form.get('ends_at') ? new Date(String(form.get('ends_at'))).toISOString() : null,
      member_id: String(form.get('member_id') ?? '') || null,
      recurrence: 'none',
    });
    setLoading(false);
    if (error) return toastError(error.message);
    success('Event added');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title="Add sports event">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Event title" required>
          {(id) => <Input id={id} name="title" placeholder="Soccer practice" autoFocus />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Sport">
            {(id) => <Input id={id} name="sport" placeholder="Soccer" />}
          </Field>
          <Field label="Team">
            {(id) => <Input id={id} name="team" placeholder="Red Hawks" />}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            {(id) => (
              <Select id={id} name="event_type" defaultValue="practice">
                <option value="practice">Practice</option>
                <option value="game">Game</option>
                <option value="tournament">Tournament</option>
                <option value="tryout">Tryout</option>
              </Select>
            )}
          </Field>
          <Field label="Location">
            {(id) => <Input id={id} name="location" placeholder="Field 3" />}
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
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add event</Button>
        </div>
      </form>
    </Modal>
  );
}
