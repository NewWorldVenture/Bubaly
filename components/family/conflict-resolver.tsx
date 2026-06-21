'use client';

import { useState, useTransition } from 'react';
import {
  CalendarClock, Sparkles, Wand2, Check, X, Loader2, MapPin, User, ArrowRight,
} from 'lucide-react';
import { rescheduleEventAction } from '@/app/(app)/dashboard/conflicts/actions';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/states';

export type EventView = { id: string; title: string; whenLabel: string; location: string | null; assignee: string | null };
export type QuickFixView = { eventId: string; label: string; startsAtIso: string; endsAtIso: string; newWhenLabel: string };
export type AiEvent = { title: string; starts_at: string; ends_at: string | null; location: string | null };
export type ConflictView = {
  key: string;
  a: EventView;
  b: EventView;
  overlapLabel: string;
  quickFix: QuickFixView | null;
  aiPayload: { a: AiEvent; b: AiEvent };
};

function EventLine({ e }: { e: EventView }) {
  return (
    <div className="rounded-xl border border-border bg-elevated/50 p-3">
      <p className="text-sm font-semibold">{e.title}</p>
      <p className="mt-0.5 text-xs text-muted">{e.whenLabel}</p>
      <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted">
        {e.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" /> {e.location}</span>}
        {e.assignee && <span className="inline-flex items-center gap-1"><User className="h-3 w-3" /> {e.assignee}</span>}
      </div>
    </div>
  );
}

export function ConflictResolver({ conflicts }: { conflicts: ConflictView[] }) {
  const [resolved, setResolved] = useState<Set<string>>(new Set());
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const visible = conflicts.filter((c) => !resolved.has(c.key) && !dismissed.has(c.key));

  if (conflicts.length === 0) {
    return (
      <EmptyState
        icon={Check}
        title="No schedule conflicts"
        description="Nothing on the calendar overlaps in the next two weeks. Nicely run."
      />
    );
  }
  if (visible.length === 0) {
    return (
      <EmptyState
        icon={Check}
        title="All conflicts handled"
        description="You've resolved or dismissed every detected conflict. New ones will appear here automatically."
      />
    );
  }

  return (
    <div className="space-y-4">
      {visible.map((c) => (
        <ConflictCard
          key={c.key}
          conflict={c}
          onResolved={() => setResolved((s) => new Set(s).add(c.key))}
          onDismiss={() => setDismissed((s) => new Set(s).add(c.key))}
        />
      ))}
    </div>
  );
}

function ConflictCard({
  conflict, onResolved, onDismiss,
}: {
  conflict: ConflictView; onResolved: () => void; onDismiss: () => void;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState('');
  const [ideas, setIdeas] = useState<string[] | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');

  function applyQuickFix() {
    if (!conflict.quickFix) return;
    setError('');
    const qf = conflict.quickFix;
    start(async () => {
      const r = await rescheduleEventAction(qf.eventId, qf.startsAtIso, qf.endsAtIso);
      if (r.ok) onResolved();
      else setError(r.error ?? 'Could not reschedule.');
    });
  }

  async function askAi() {
    setAiBusy(true);
    setAiError('');
    try {
      const res = await fetch('/api/ai/resolve-conflict', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(conflict.aiPayload),
      });
      const data = await res.json();
      if (!res.ok) setAiError(data.error ?? 'AI request failed.');
      else setIdeas(data.ideas ?? []);
    } catch {
      setAiError('Network error contacting AI.');
    } finally {
      setAiBusy(false);
    }
  }

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <span className="inline-flex items-center gap-2 text-sm font-semibold">
          <CalendarClock className="h-4 w-4 text-danger" /> Schedule conflict
        </span>
        <Badge tone="danger">{conflict.overlapLabel}</Badge>
      </div>

      <div className="grid items-center gap-2 sm:grid-cols-[1fr_auto_1fr]">
        <EventLine e={conflict.a} />
        <div className="hidden justify-center sm:flex"><ArrowRight className="h-4 w-4 text-muted" /></div>
        <EventLine e={conflict.b} />
      </div>

      {/* Quick fix (deterministic) */}
      {conflict.quickFix && (
        <div className="mt-3 rounded-xl border border-brand/30 bg-brand/5 p-3">
          <p className="text-xs font-medium text-brand">Quick fix</p>
          <p className="mt-0.5 text-sm">{conflict.quickFix.label} — new time {conflict.quickFix.newWhenLabel}.</p>
          <button
            onClick={applyQuickFix}
            disabled={pending}
            className="mt-2 inline-flex h-9 items-center gap-2 rounded-lg bg-brand px-3 text-sm font-medium text-brand-fg disabled:opacity-60"
          >
            {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Apply &amp; reschedule
          </button>
          {error && <p className="mt-1 text-xs text-danger">{error}</p>}
        </div>
      )}

      {/* AI ideas */}
      <div className="mt-3">
        {ideas ? (
          <div className="rounded-xl border border-border p-3">
            <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-accent"><Sparkles className="h-3.5 w-3.5" /> AI ideas</p>
            <ul className="space-y-1 text-sm">
              {ideas.length === 0 ? <li className="text-muted">No suggestions returned.</li> : ideas.map((idea, i) => (
                <li key={i} className="flex items-start gap-2"><Wand2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent" /> {idea}</li>
              ))}
            </ul>
          </div>
        ) : (
          <button
            onClick={askAi}
            disabled={aiBusy}
            className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium hover:bg-elevated disabled:opacity-60"
          >
            {aiBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-accent" />} Ask AI for ideas
          </button>
        )}
        {aiError && <p className="mt-1 text-xs text-danger">{aiError}</p>}
      </div>

      <div className="mt-3 flex justify-end">
        <button onClick={onDismiss} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg">
          <X className="h-3.5 w-3.5" /> Dismiss
        </button>
      </div>
    </Card>
  );
}
