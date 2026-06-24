'use client';

import { useState } from 'react';
import { Sparkles, Loader2 } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/input';
import { cn } from '@/lib/utils/cn';
import { INSIGHT_META, type InsightKind } from '@/lib/ai/insights';

type Props = {
  kind: InsightKind;
  /** Extra params for kinds that need context (e.g. { eventId } or { conversationId }). */
  params?: Record<string, unknown>;
  /** Button label override. Defaults to the kind's label. */
  label?: string;
  /** Button styling. Defaults to a compact secondary button. */
  className?: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline';
  size?: 'sm' | 'md';
  /** Render just the sparkle icon (for tight toolbars). */
  iconOnly?: boolean;
};

/**
 * Reusable per-module "AI Assist" affordance. Opens a modal, optionally takes a
 * focusing question, then calls the grounded /api/ai/insights route for this kind
 * and renders the answer. All data is fetched server-side from Supabase under RLS.
 */
export function AiInsight({ kind, params, label, className, variant = 'secondary', size = 'sm', iconOnly }: Props) {
  const meta = INSIGHT_META[kind];
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');

  async function run() {
    setLoading(true);
    setError('');
    setAnswer('');
    try {
      const res = await fetch('/api/ai/insights', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, params: params ?? {}, question: question.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json.error || 'AI is unavailable right now.'); return; }
      setAnswer(json.text || '');
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  function openModal() {
    setOpen(true);
    setAnswer('');
    setError('');
    setQuestion('');
    if (!meta.allowQuestion) void run();
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={openModal}
        className={cn('gap-1.5', className)}
        aria-label={meta.label}
      >
        <Sparkles className="h-4 w-4" />
        {!iconOnly && (label ?? meta.label)}
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title={meta.title} description={meta.blurb}>
        <div className="space-y-4">
          {meta.allowQuestion && (
            <Field label="Focus (optional)">
              {(id) => (
                <Textarea
                  id={id}
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Anything specific you want the assistant to focus on?"
                  className="min-h-[4.5rem]"
                />
              )}
            </Field>
          )}

          <Button onClick={run} disabled={loading} loading={loading} className="w-full">
            {loading ? <><Loader2 className="h-4 w-4 animate-spin" /> Thinking…</> : <><Sparkles className="h-4 w-4" /> {answer ? 'Regenerate' : 'Generate'}</>}
          </Button>

          {error && <p className="rounded-xl border border-danger/30 bg-danger/10 p-3 text-xs text-danger">{error}</p>}

          {answer && (
            <div className="max-h-[24rem] overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-surface/40 p-4 text-sm leading-6 text-fg">
              {answer}
            </div>
          )}
          {!answer && !error && !loading && (
            <p className="text-center text-xs text-muted">Grounded in your family&rsquo;s own data. Suggestions only — you decide what to act on.</p>
          )}
        </div>
      </Modal>
    </>
  );
}
