'use client';

import { useRef, useState } from 'react';
import { Camera, Check, X, Sparkles, ImageIcon, CalendarPlus } from 'lucide-react';
import Link from 'next/link';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';

type ProposedEvent = {
  title: string; starts_at: string; ends_at: string | null; all_day: boolean;
  location: string | null; description: string | null; category: string; summary: string;
};

const MAX_BYTES = 5 * 1024 * 1024;

function readAsBase64(file: File): Promise<{ data: string; mediaType: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve({ data: result.slice(comma + 1), mediaType: file.type });
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}

export function ScanModule() {
  const { success, error: toastError } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [events, setEvents] = useState<ProposedEvent[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  async function onFile(file: File | null) {
    if (!file) return;
    if (file.size > MAX_BYTES) { toastError('File is too large (5 MB max).'); return; }
    setEvents(null);
    setFileName(file.name);
    setPreview(file.type.startsWith('image/') ? URL.createObjectURL(file) : null);
    setScanning(true);
    try {
      const { data, mediaType } = await readAsBase64(file);
      const res = await fetch('/api/ai/flyer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, mediaType }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not read that flyer.'); return; }
      const found: ProposedEvent[] = json.events ?? [];
      setEvents(found);
      setSelected(new Set(found.map((_, i) => i)));
      if (found.length === 0) toastError('No events found on that flyer.');
    } catch {
      toastError('Something went wrong reading the file.');
    } finally {
      setScanning(false);
    }
  }

  function toggle(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  }

  async function addSelected() {
    if (!events || selected.size === 0 || adding) return;
    const confirm = events.filter((_, i) => selected.has(i));
    setAdding(true);
    try {
      const res = await fetch('/api/ai/flyer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not add events.'); return; }
      success(`Added ${json.created} event${json.created === 1 ? '' : 's'} to your calendar.`);
      setEvents(null); setSelected(new Set()); setPreview(null); setFileName(null);
    } catch {
      toastError('Network error. Please try again.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="module-page mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Scan Flyer → Calendar"
        description="Snap a photo of a school flyer, sports schedule, or invitation — or upload a PDF — and AI adds the events to your family calendar."
      />

      <input
        ref={fileRef}
        type="file"
        accept="image/*,application/pdf"
        capture="environment"
        className="hidden"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />

      <div
        onClick={() => !scanning && fileRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => { e.preventDefault(); if (!scanning) onFile(e.dataTransfer.files?.[0] ?? null); }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-border bg-surface/40 p-10 text-center transition hover:border-brand/50',
          scanning && 'pointer-events-none opacity-70',
        )}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={fileName ?? 'flyer'} className="mb-4 max-h-56 rounded-xl object-contain" />
        ) : (
          <div className="mb-4 grid h-16 w-16 place-items-center rounded-2xl bg-brand/15">
            <Camera className="h-8 w-8 text-brand" />
          </div>
        )}
        {scanning ? (
          <p className="flex items-center gap-2 text-sm font-semibold text-brand">
            <Sparkles className="h-4 w-4 animate-pulse" /> Reading flyer…
          </p>
        ) : (
          <>
            <p className="text-sm font-semibold">{fileName ?? 'Take a photo or upload a flyer'}</p>
            <p className="mt-1 text-xs text-muted/60">JPG, PNG, WebP, or PDF up to 5 MB</p>
          </>
        )}
      </div>

      {events && events.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center gap-2">
            <CalendarPlus className="h-4 w-4 text-brand" />
            <h2 className="font-semibold">Found {events.length} event{events.length === 1 ? '' : 's'}</h2>
            <span className="ml-auto text-xs text-muted">{selected.size} selected</span>
          </div>
          <ul className="space-y-2">
            {events.map((e, i) => (
              <li key={i}>
                <button
                  onClick={() => toggle(i)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left text-sm transition',
                    selected.has(i) ? 'border-brand/50 bg-brand/10' : 'border-border bg-surface/30 opacity-60',
                  )}
                >
                  <span className={cn(
                    'mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md border',
                    selected.has(i) ? 'border-brand bg-brand text-white' : 'border-border',
                  )}>
                    {selected.has(i) ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5 opacity-40" />}
                  </span>
                  <span className="min-w-0">
                    <span className="block">{e.summary}</span>
                    {e.description && <span className="mt-0.5 block text-xs text-muted">{e.description}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setEvents(null); setSelected(new Set()); }}>Discard</Button>
            <Button onClick={addSelected} loading={adding} disabled={selected.size === 0}>
              Add {selected.size} to calendar
            </Button>
          </div>
        </div>
      )}

      {!events && !scanning && (
        <div className="flex items-start gap-3 rounded-2xl border border-border bg-surface/30 p-5 text-sm text-muted">
          <ImageIcon className="h-5 w-5 shrink-0" />
          <span>
            Works great with school newsletters, picture-day notices, team schedules, and birthday invites.
            Prefer to type? Use the <Link href="/dashboard/inbox" className="text-brand hover:underline">Magic Import Inbox</Link>.
          </span>
        </div>
      )}
    </div>
  );
}
