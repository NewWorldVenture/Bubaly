'use client';

import { useState } from 'react';
import { RefreshCw, Link2, Trash2, Plus, Check, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Field } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils/cn';

const PROVIDER_PRESETS = [
  {
    name: 'Google Calendar',
    icon: '🗓️',
    hint: 'Settings → "Secret address in iCal format" in Google Calendar',
  },
  {
    name: 'Apple Calendar',
    icon: '🍎',
    hint: 'File → Export, or share a public calendar ICS link',
  },
  {
    name: 'Outlook / Microsoft 365',
    icon: '📅',
    hint: 'Calendar → Share → Publish online → ICS link',
  },
  {
    name: 'Other ICS feed',
    icon: '🔗',
    hint: 'Any public .ics URL (webcal:// will be converted automatically)',
  },
];

interface SyncFeed {
  id: string; name: string; url: string; lastSynced?: string; count?: number;
}

// Stored in localStorage since we haven't added a DB table for it yet
function useFeeds() {
  const [feeds, setFeeds] = useState<SyncFeed[]>(() => {
    try { return JSON.parse(localStorage.getItem('cal_sync_feeds') ?? '[]'); }
    catch { return []; }
  });

  function save(f: SyncFeed[]) {
    setFeeds(f);
    localStorage.setItem('cal_sync_feeds', JSON.stringify(f));
  }

  function addFeed(feed: SyncFeed) { save([...feeds, feed]); }
  function removeFeed(id: string) { save(feeds.filter((f) => f.id !== id)); }
  function updateFeed(id: string, patch: Partial<SyncFeed>) {
    save(feeds.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  }

  return { feeds, addFeed, removeFeed, updateFeed };
}

export function CalendarSyncPanel() {
  const { feeds, addFeed, removeFeed, updateFeed } = useFeeds();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [syncing, setSyncing] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, { count: number; error?: string }>>({});

  async function sync(feed: SyncFeed) {
    setSyncing(feed.id);
    try {
      const icsUrl = feed.url.replace(/^webcal:\/\//, 'https://');
      const res = await fetch('/api/calendar/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ icsUrl, label: feed.name }),
      });
      const data = await res.json() as { imported?: number; error?: string };
      if (data.error) {
        setResult((r) => ({ ...r, [feed.id]: { count: 0, error: data.error } }));
      } else {
        const count = data.imported ?? 0;
        setResult((r) => ({ ...r, [feed.id]: { count } }));
        updateFeed(feed.id, { lastSynced: new Date().toISOString(), count });
      }
    } catch (e: unknown) {
      setResult((r) => ({ ...r, [feed.id]: { count: 0, error: String(e) } }));
    } finally {
      setSyncing(null);
    }
  }

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    const feed: SyncFeed = {
      id: crypto.randomUUID(),
      name: name.trim() || 'Calendar Feed',
      url: url.trim(),
    };
    addFeed(feed);
    setOpen(false);
    setUrl(''); setName('');
    await sync(feed);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Calendar Sync</h3>
          <p className="text-xs text-muted">Import events from Google, Apple, Outlook, or any ICS feed.</p>
        </div>
        <Button size="sm" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Add Calendar
        </Button>
      </div>

      {feeds.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-border p-6 text-center">
          <Link2 className="mx-auto h-8 w-8 text-muted/40" />
          <p className="mt-2 text-sm text-muted">No calendars connected yet.</p>
          <button onClick={() => setOpen(true)} className="mt-1 text-xs font-semibold text-brand hover:underline">
            Connect your first calendar
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {feeds.map((feed) => {
            const isSyncing = syncing === feed.id;
            const res = result[feed.id];
            return (
              <div key={feed.id} className="flex items-center gap-3 rounded-xl border border-border bg-surface/40 px-4 py-3">
                <Link2 className="h-4 w-4 text-muted shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="truncate text-sm font-semibold">{feed.name}</p>
                  <p className="truncate text-xs text-muted">{feed.url.slice(0, 60)}…</p>
                  {res && !res.error && (
                    <p className="text-[10px] text-success mt-0.5">
                      <Check className="inline h-2.5 w-2.5" /> {res.count} events imported
                    </p>
                  )}
                  {res?.error && (
                    <p className="text-[10px] text-danger mt-0.5">
                      <AlertCircle className="inline h-2.5 w-2.5" /> {res.error}
                    </p>
                  )}
                  {feed.lastSynced && !res && (
                    <p className="text-[10px] text-muted">Last synced: {new Date(feed.lastSynced).toLocaleDateString()}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button variant="ghost" size="sm" disabled={isSyncing} onClick={() => sync(feed)}>
                    <RefreshCw className={cn('h-3.5 w-3.5', isSyncing && 'animate-spin')} />
                    {isSyncing ? 'Syncing…' : 'Sync'}
                  </Button>
                  <button onClick={() => removeFeed(feed.id)}
                    className="rounded p-1.5 text-muted hover:text-danger transition">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {open && (
        <Modal open onClose={() => setOpen(false)} title="Add Calendar Feed">
          <form onSubmit={add} className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-medium">Quick start</label>
              <div className="grid grid-cols-2 gap-2">
                {PROVIDER_PRESETS.map((p) => (
                  <button key={p.name} type="button"
                    onClick={() => setName(p.name)}
                    className={cn('flex items-center gap-2 rounded-xl border p-2.5 text-left text-xs transition hover:bg-elevated',
                      name === p.name ? 'border-brand/60 bg-brand/10' : 'border-border')}>
                    <span className="text-2xl">{p.icon}</span>
                    <div>
                      <p className="font-semibold">{p.name}</p>
                      <p className="text-muted line-clamp-2">{p.hint}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
            <Field label="Calendar name">
              {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} placeholder="Work, School, Soccer…" />}
            </Field>
            <Field label="ICS / webcal URL" required>
              {(id) => (
                <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://calendar.google.com/calendar/ical/…/basic.ics"
                  autoFocus />
              )}
            </Field>
            <p className="text-xs text-muted">
              Events will be imported into your FamilyOS calendar. Sync manually any time.
              <strong className="text-fg"> webcal://</strong> URLs are supported.
            </p>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit">Add & Sync Now</Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
