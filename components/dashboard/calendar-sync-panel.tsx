'use client';

import { useState } from 'react';
import { RefreshCw, Link2, Trash2, Plus, Check, AlertCircle } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils/cn';
import { addCalendarFeed, syncCalendarFeed, removeCalendarFeed } from '@/app/(app)/dashboard/sync/feeds/actions';
import { CALENDAR_PROVIDERS, getCalendarProvider, type CalendarProvider } from '@/lib/calendar/providers';
import type { Tables } from '@/lib/database.types';

type CalendarFeed = Tables<'calendar_feeds'>;

export function CalendarSyncPanel() {
  const { familyId } = useApp();
  const { success, error: toastError } = useToast();
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState<string | null>(null);

  const provider = providerId ? getCalendarProvider(providerId) : null;

  function pick(p: CalendarProvider) {
    setProviderId(p.id);
    setName((prev) => prev || (p.id === 'ics' ? '' : p.label));
  }
  function closeModal() { setOpen(false); setProviderId(null); setUrl(''); setName(''); }

  // Feeds now persist in Supabase — they sync across every device and
  // auto-refresh nightly via cron, instead of living in this browser only.
  const { data: feeds, loading } = useRealtimeQuery<CalendarFeed>({
    table: 'calendar_feeds', familyId, deps: [familyId],
    fetcher: (sb) => sb.from('calendar_feeds').select('*').eq('family_id', familyId).order('created_at'),
  });

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setAdding(true);
    const res = await addCalendarFeed({ name, url });
    setAdding(false);
    if (!res.ok) { toastError(res.error); return; }
    success(res.imported != null ? `Added — ${res.imported} events imported` : 'Calendar added');
    closeModal();
  }

  async function sync(feed: CalendarFeed) {
    setSyncing(feed.id);
    const res = await syncCalendarFeed(feed.id);
    setSyncing(null);
    if (!res.ok) { toastError(res.error); return; }
    success(`Synced — ${res.imported ?? 0} events`);
  }

  async function remove(feed: CalendarFeed) {
    if (!confirm(`Remove "${feed.name}" and its imported events?`)) return;
    const res = await removeCalendarFeed(feed.id);
    if (!res.ok) { toastError(res.error); return; }
    success('Calendar removed');
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Calendar Sync</h3>
          <p className="text-xs text-muted">Subscribe to Google, Apple, Outlook, or any public ICS feed — synced across your devices and refreshed nightly.</p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Add Calendar
        </Button>
      </div>

      {loading ? (
        <div className="rounded-xl border border-border p-6 text-center text-sm text-muted">Loading calendars…</div>
      ) : (feeds ?? []).length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-border p-6 text-center">
          <Link2 className="mx-auto h-8 w-8 text-muted/40" />
          <p className="mt-2 text-sm text-muted">No calendars subscribed yet.</p>
          <button onClick={() => setOpen(true)} className="mt-1 text-xs font-semibold text-brand-text hover:underline">
            Subscribe to your first calendar
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {(feeds ?? []).map((feed) => {
            const isSyncing = syncing === feed.id;
            return (
              <div key={feed.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-4 py-3">
                <Link2 className="h-4 w-4 text-muted shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm font-semibold">{feed.name}</p>
                  <p className="truncate text-xs text-muted">{feed.url}</p>
                  {feed.last_status === 'error' && feed.last_error ? (
                    <p className="text-[10px] text-danger mt-0.5"><AlertCircle className="inline h-2.5 w-2.5" /> {feed.last_error}</p>
                  ) : feed.last_synced_at ? (
                    <p className="text-[10px] text-success mt-0.5">
                      <Check className="inline h-2.5 w-2.5" /> {feed.event_count} events · synced {new Date(feed.last_synced_at).toLocaleDateString()}
                    </p>
                  ) : (
                    <p className="text-[10px] text-muted mt-0.5">Not synced yet</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" disabled={isSyncing} onClick={() => sync(feed)}>
                    <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
                    {isSyncing ? 'Syncing…' : 'Sync'}
                  </Button>
                  <button onClick={() => remove(feed)} className="rounded p-1.5 text-muted hover:text-danger transition">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <Modal open onClose={closeModal} title={provider ? `Connect ${provider.label}` : 'Connect a calendar'}>
          {!provider ? (
            <div>
              <p className="mb-3 text-sm text-muted">Pick where your events live — we&apos;ll show you exactly how to connect it.</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {CALENDAR_PROVIDERS.map((p) => (
                  <button key={p.id} type="button" onClick={() => pick(p)}
                    className="flex flex-col items-center gap-1.5 rounded-xl border border-border p-3 text-center text-xs transition hover:border-brand/50 hover:bg-elevated">
                    <span className={cn('grid h-10 w-10 place-items-center rounded-full text-xl', p.accent)}>{p.icon}</span>
                    <span className="font-semibold leading-tight">{p.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <form onSubmit={add} className="space-y-4">
              <button type="button" onClick={() => setProviderId(null)} className="text-xs font-semibold text-muted hover:text-fg">← All calendars</button>

              {provider.connect === 'oauth' && provider.connectUrl && (
                <a href={provider.connectUrl}
                  className="flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand/90">
                  <Check className="h-4 w-4" /> Connect {provider.label} — two-way
                </a>
              )}

              <div className="rounded-xl border border-border bg-surface/40 p-3">
                <p className="mb-1.5 text-xs font-semibold">{provider.connect === 'oauth' ? 'Prefer read-only? Paste a link:' : 'How to find your link'}</p>
                <ol className="list-inside list-decimal space-y-1 text-xs text-muted">
                  {provider.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              </div>

              <Field label="Calendar name">
                {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work, School, Soccer…" />}
              </Field>
              <Field label="ICS / webcal URL" required>
                {(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} placeholder={provider.placeholder} autoFocus />}
              </Field>
              <p className="text-xs text-muted">Events import into your Bubaly calendar and refresh nightly. <strong className="text-fg">webcal://</strong> links work too.</p>
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={closeModal} disabled={adding}>Cancel</Button>
                <Button type="submit" disabled={adding}>{adding ? 'Adding…' : 'Add & Sync Now'}</Button>
              </div>
            </form>
          )}
        </Modal>
      )}
    </div>
  );
}
