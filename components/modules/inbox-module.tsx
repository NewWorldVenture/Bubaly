'use client';

import { useState } from 'react';
import { Sparkles, Wand2, Check, X, Inbox as InboxIcon, ArrowRight } from 'lucide-react';
import { useToast } from '@/components/ui/toast';
import { Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { cn } from '@/lib/utils/cn';

type Item = { name: string; args: Record<string, unknown>; summary: string };

const EXAMPLES = [
  "Picture day is next Friday — wear school colors. Order forms due Wednesday.",
  "Soccer practice moved to Tuesdays 5–6:30pm at Lincoln Park starting next week.",
  "We're out of milk, eggs, and paper towels. Dinner Thursday: tacos.",
  "Dentist for Emma on the 14th at 9am. Remind me to renew car insurance by month end.",
];

export function InboxModule() {
  const { success, error: toastError } = useToast();
  const [text, setText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [note, setNote] = useState<string | null>(null);

  async function organize() {
    if (!text.trim() || parsing) return;
    setParsing(true);
    setItems(null);
    setNote(null);
    try {
      const res = await fetch('/api/ai/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not process that.'); return; }
      const found: Item[] = json.items ?? [];
      setItems(found);
      setSelected(new Set(found.map((_, i) => i)));
      setNote(found.length === 0 ? (json.note ?? 'No actionable items found in that text.') : null);
    } catch {
      toastError('Network error. Please try again.');
    } finally {
      setParsing(false);
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
    if (!items || selected.size === 0 || adding) return;
    const confirm = items.filter((_, i) => selected.has(i));
    setAdding(true);
    try {
      const res = await fetch('/api/ai/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm }),
      });
      const json = await res.json();
      if (!res.ok) { toastError(json.error ?? 'Could not add items.'); return; }
      const failed = (json.results ?? []).filter((r: { ok: boolean }) => !r.ok);
      if (json.created > 0) success(`Added ${json.created} item${json.created === 1 ? '' : 's'} to your family.`);
      if (failed.length > 0) toastError(`${failed.length} item${failed.length === 1 ? '' : 's'} couldn’t be added.`);
      // Clear the workspace on success.
      setItems(null);
      setSelected(new Set());
      setText('');
    } catch {
      toastError('Network error. Please try again.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="module-page mx-auto max-w-3xl space-y-5">
      <PageHeader
        title="Magic Import Inbox"
        description="Paste anything — a forwarded email, a text, a school notice — and AI turns it into calendar events, chores, reminders, groceries, and meals."
      />

      <div className="rounded-2xl border border-border bg-surface/40 p-5">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste a forwarded email, text message, school flyer text, or just type what's on your mind…"
          className="min-h-[140px] w-full"
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <p className="text-xs text-muted">{text.length}/8000</p>
          <Button onClick={organize} loading={parsing} disabled={!text.trim()}>
            <Wand2 className="h-4 w-4" /> {parsing ? 'Organizing…' : 'Organize with AI'}
          </Button>
        </div>
      </div>

      {!items && !parsing && (
        <div className="rounded-2xl border border-border bg-surface/30 p-5">
          <p className="mb-3 text-sm font-semibold text-muted">Try an example</p>
          <div className="grid gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setText(ex)}
                className="group flex items-center justify-between gap-3 rounded-xl border border-border bg-surface/40 px-4 py-2.5 text-left text-sm transition hover:border-brand/40 hover:bg-surface/60"
              >
                <span className="text-fg/80">{ex}</span>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted opacity-0 transition group-hover:opacity-100" />
              </button>
            ))}
          </div>
        </div>
      )}

      {note && (
        <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface/30 p-5 text-sm text-muted">
          <InboxIcon className="h-5 w-5 shrink-0" /> {note}
        </div>
      )}

      {items && items.length > 0 && (
        <div className="rounded-2xl border border-border bg-surface/40 p-5">
          <div className="mb-4 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand" />
            <h2 className="font-semibold">Found {items.length} item{items.length === 1 ? '' : 's'}</h2>
            <span className="ml-auto text-xs text-muted">{selected.size} selected</span>
          </div>
          <ul className="space-y-2">
            {items.map((item, i) => (
              <li key={i}>
                <button
                  onClick={() => toggle(i)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-xl border px-4 py-3 text-left text-sm transition',
                    selected.has(i) ? 'border-brand/50 bg-brand/10' : 'border-border bg-surface/30 opacity-60',
                  )}
                >
                  <span className={cn(
                    'grid h-5 w-5 shrink-0 place-items-center rounded-md border',
                    selected.has(i) ? 'border-brand bg-brand text-white' : 'border-border',
                  )}>
                    {selected.has(i) ? <Check className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5 opacity-40" />}
                  </span>
                  <span>{item.summary}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => { setItems(null); setSelected(new Set()); }}>Discard</Button>
            <Button onClick={addSelected} loading={adding} disabled={selected.size === 0}>
              Add {selected.size} item{selected.size === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
