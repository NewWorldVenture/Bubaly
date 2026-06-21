'use client';

import { useState, useTransition } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { submitResponseAction } from './actions';

type Props = {
  slug: string;
  question: string;
  scaleMin: number;
  scaleMax: number;
  lowLabel: string | null;
  highLabel: string | null;
  followUp: string | null;
  thankYou: string | null;
};

export function SurveyForm(p: Props) {
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [email, setEmail] = useState('');
  const [pending, start] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const scale = Array.from({ length: p.scaleMax - p.scaleMin + 1 }, (_, i) => p.scaleMin + i);

  function submit() {
    if (score === null) { setError('Please choose a rating.'); return; }
    setError('');
    start(async () => {
      const r = await submitResponseAction({ slug: p.slug, score, comment, email });
      if (r.ok) setDone(true); else setError(r.error ?? 'Something went wrong.');
    });
  }

  if (done) {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-success/10 text-success">
          <CheckCircle2 className="h-7 w-7" />
        </div>
        <h2 className="text-xl font-semibold">{p.thankYou || 'Thank you!'}</h2>
        <p className="mt-1 text-sm text-muted">Your feedback has been recorded.</p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold leading-snug">{p.question}</h1>

      <div>
        <div className="flex flex-wrap gap-2">
          {scale.map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setScore(v)}
              aria-pressed={score === v}
              className={`h-11 min-w-[2.75rem] flex-1 rounded-xl border text-sm font-semibold transition ${
                score === v ? 'border-brand bg-brand text-brand-fg' : 'border-border bg-surface/60 hover:border-brand/40'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
        {(p.lowLabel || p.highLabel) && (
          <div className="mt-1.5 flex justify-between text-[11px] text-muted">
            <span>{p.lowLabel}</span><span>{p.highLabel}</span>
          </div>
        )}
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-medium">{p.followUp || 'Anything you’d like to add?'}</label>
        <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={3}
          className="w-full rounded-xl border border-border bg-surface/60 px-3 py-2 text-sm focus-ring" placeholder="Optional" />
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-medium">Email (optional)</label>
        <input value={email} onChange={(e) => setEmail(e.target.value)} type="email"
          className="h-11 w-full rounded-xl border border-border bg-surface/60 px-3 text-sm focus-ring" placeholder="you@example.com" />
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <button onClick={submit} disabled={pending}
        className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand text-sm font-semibold text-brand-fg disabled:opacity-60">
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null} Submit feedback
      </button>
    </div>
  );
}
