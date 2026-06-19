'use client';

import { useMemo, useState, useEffect } from 'react';
import { Calendar, Plus, MapPin, Trash2, RefreshCw } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Modal } from '@/components/ui/modal';
import { Input, Textarea, Field, Select } from '@/components/ui/input';
import { LoadingBlock, EmptyState, ErrorState } from '@/components/ui/states';
import { fmtTime, fmtDate } from '@/lib/utils/format';
import { eventSchema, fieldErrors } from '@/lib/validation';
import type { Tables } from '@/lib/database.types';

type Event = Tables<'calendar_events'>;
const CATEGORIES = ['general', 'school', 'sports', 'appointment', 'medication', 'maintenance', 'birthday', 'holiday', 'other'] as const;

export function CalendarModule() {
  const { familyId, userId } = useApp();
  const [open, setOpen] = useState(false);
  const [gcalConnected, setGcalConnected] = useState<boolean | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { success, error: toastError } = useToast();

  useEffect(() => {
    fetch('/api/google/calendar/sync')
      .then((r) => r.json())
      .then((d: { connected: boolean }) => setGcalConnected(d.connected))
      .catch(() => setGcalConnected(false));

    // Show toast if returning from Google OAuth
    const params = new URLSearchParams(window.location.search);
    if (params.get('gcal') === 'connected') {
      success('Google Calendar connected!');
      window.history.replaceState({}, '', window.location.pathname);
    } else if (params.get('gcal') === 'error') {
      toastError('Google Calendar connection failed. Try again.');
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  async function syncGoogleCalendar() {
    setSyncing(true);
    try {
      const res = await fetch('/api/google/calendar/sync', { method: 'POST' });
      const json = await res.json() as { synced?: number; error?: string };
      if (json.error) throw new Error(json.error);
      success(`Synced ${json.synced} event${json.synced !== 1 ? 's' : ''} from Google Calendar`);
      void refresh();
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  }

  const { data, loading, error, refresh } = useRealtimeQuery<Event>({
    table: 'calendar_events',
    familyId,
    deps: [familyId],
    fetcher: (supabase) =>
      supabase.from('calendar_events').select('*').eq('family_id', familyId)
        .gte('starts_at', new Date(Date.now() - 86400000).toISOString())
        .order('starts_at', { ascending: true }),
  });

  const grouped = useMemo(() => {
    const map = new Map<string, Event[]>();
    for (const e of data) {
      const key = e.starts_at.slice(0, 10);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(e);
    }
    return [...map.entries()];
  }, [data]);

  async function remove(id: string) {
    const supabase = createClient();
    const { error } = await supabase.from('calendar_events').delete().eq('id', id);
    if (error) return toastError(error.message);
    success('Event removed');
    void refresh();
  }

  if (loading) return <LoadingBlock />;
  if (error) return <ErrorState message={error} onRetry={refresh} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Calendar"
        description="Everything your family has coming up."
        action={
          <div className="flex items-center gap-2">
            {gcalConnected === false && (
              <a href="/api/google/calendar/auth" className="flex items-center gap-1.5 rounded-xl border border-border bg-surface/60 px-3 py-2 text-xs font-medium hover:bg-elevated transition">
                <svg width="14" height="14" viewBox="0 0 18 18" fill="none"><path d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/><path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/><path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/><path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 6.29C4.672 4.163 6.656 3.58 9 3.58Z" fill="#EA4335"/></svg>
                Connect Google Calendar
              </a>
            )}
            {gcalConnected && (
              <Button variant="ghost" size="sm" onClick={syncGoogleCalendar} disabled={syncing} className="gap-1.5">
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Syncing…' : 'Sync Google'}
              </Button>
            )}
            <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add event</Button>
          </div>
        }
      />

      {grouped.length === 0 ? (
        <EmptyState icon={Calendar} title="No upcoming events" description="Add your first event to get the family on the same page."
          action={<Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" /> Add event</Button>} />
      ) : (
        <div className="space-y-5">
          {grouped.map(([day, events]) => (
            <div key={day}>
              <h2 className="mb-2 text-sm font-semibold text-muted">{fmtDate(day, 'EEEE, MMMM d')}</h2>
              <Card className="p-3">
                <ul className="divide-y divide-border">
                  {events.map((e) => (
                    <li key={e.id} className="flex items-center gap-3 py-2.5">
                      <div className="w-20 shrink-0 text-sm font-medium text-muted">{e.all_day ? 'All day' : fmtTime(e.starts_at)}</div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">{e.title}</p>
                        {e.location && <p className="flex items-center gap-1 truncate text-xs text-muted"><MapPin className="h-3 w-3" />{e.location}</p>}
                      </div>
                      <Badge tone="neutral">{e.category}</Badge>
                      <button onClick={() => remove(e.id)} className="rounded-lg p-2 text-muted hover:text-danger" aria-label="Delete event">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ))}
        </div>
      )}

      {open && <NewEventModal familyId={familyId} userId={userId} onClose={() => setOpen(false)} onCreated={() => { setOpen(false); void refresh(); }} />}
    </div>
  );
}

function NewEventModal({ familyId, userId, onClose, onCreated }: {
  familyId: string; userId: string; onClose: () => void; onCreated: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrors({});
    const form = new FormData(e.currentTarget);
    const startRaw = String(form.get('starts_at') ?? '');
    const endRaw = String(form.get('ends_at') ?? '');
    const input = {
      title: String(form.get('title') ?? ''),
      starts_at: startRaw,
      ends_at: endRaw || null,
      category: String(form.get('category') ?? 'general'),
      location: String(form.get('location') ?? '') || null,
      description: String(form.get('description') ?? '') || null,
    };
    const parsed = eventSchema.safeParse(input);
    if (!parsed.success) { setErrors(fieldErrors(parsed.error)); return; }

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('calendar_events').insert({
      family_id: familyId, created_by: userId,
      title: parsed.data.title,
      starts_at: new Date(startRaw).toISOString(),
      ends_at: endRaw ? new Date(endRaw).toISOString() : null,
      category: parsed.data.category,
      location: parsed.data.location ?? null,
      description: parsed.data.description ?? null,
      all_day: form.get('all_day') === 'on',
    });
    setLoading(false);
    if (error) return toastError(error.message);
    success('Event added');
    onCreated();
  }

  return (
    <Modal open onClose={onClose} title="Add event">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title" error={errors.title} required>{(id) => <Input id={id} name="title" placeholder="Soccer practice" autoFocus />}</Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Starts" error={errors.starts_at} required>{(id) => <Input id={id} name="starts_at" type="datetime-local" />}</Field>
          <Field label="Ends">{(id) => <Input id={id} name="ends_at" type="datetime-local" />}</Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            {(id) => <Select id={id} name="category" defaultValue="general">{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select>}
          </Field>
          <Field label="Location">{(id) => <Input id={id} name="location" placeholder="Field 3" />}</Field>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="all_day" className="h-4 w-4 rounded border-border" /> All day
        </label>
        <Field label="Notes">{(id) => <Textarea id={id} name="description" placeholder="Anything to remember?" />}</Field>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>Add event</Button>
        </div>
      </form>
    </Modal>
  );
}
