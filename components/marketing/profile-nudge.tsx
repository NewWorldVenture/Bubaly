'use client';

// Progressive-profiling card: asks ONE question at a time (role → priority →
// household → kids → interests), saving each answer to the contact profile and
// advancing to the next. Choice questions save on tap; multi-select saves on
// confirm. Dismissible for the session; renders nothing once complete/hidden.
import { useEffect, useState, useTransition } from 'react';
import { Sparkles, X, Check, ArrowRight } from 'lucide-react';
import {
  nextQuestion, profileCompleteness, type KnownProfile, type ProfileQuestion,
} from '@/lib/marketing/progressive-profile';
import {
  getProfileStateAction, saveProfileAnswerAction, skipProfileFieldAction,
} from '@/app/(app)/dashboard/settings/profile-actions';
import { cn } from '@/lib/utils/cn';

export function ProfileNudge() {
  const [loaded, setLoaded] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [known, setKnown] = useState<KnownProfile>({});
  const [skipped, setSkipped] = useState<string[]>([]);
  const [multi, setMulti] = useState<string[]>([]);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let alive = true;
    getProfileStateAction()
      .then((s) => { if (alive) { setKnown(s.known); setSkipped(s.skipped); } })
      .catch(() => { /* best-effort */ })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  const q = nextQuestion(known, skipped);

  // Nothing to ask, still loading, or dismissed → render nothing.
  if (!loaded || hidden || !q) return null;

  const save = (value: string | string[]) => {
    startTransition(async () => {
      const s = await saveProfileAnswerAction(q.field, value);
      setKnown(s.known); setSkipped(s.skipped); setMulti([]);
    });
  };
  const skip = () => {
    startTransition(async () => {
      const s = await skipProfileFieldAction(q.field);
      setKnown(s.known); setSkipped(s.skipped); setMulti([]);
    });
  };

  const pct = Math.round(profileCompleteness(known) * 100);

  return (
    <section className="rounded-2xl border border-brand/25 bg-brand/[0.05] p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/12 text-brand-text ring-1 ring-brand/25">
            <Sparkles className="h-4 w-4" />
          </span>
          <div>
            <p className="text-sm font-bold">Personalize Bubaly</p>
            <p className="text-[11px] text-muted">One quick question — helps us tailor your experience.</p>
          </div>
        </div>
        <button onClick={() => setHidden(true)} aria-label="Dismiss for now" className="rounded-lg p-1.5 text-muted transition hover:bg-elevated hover:text-fg">
          <X className="h-4 w-4" />
        </button>
      </div>

      <Question q={q} pending={pending} multi={multi} setMulti={setMulti} onChoose={save} onSkip={skip} />

      {pct > 0 && (
        <div className="mt-3 flex items-center gap-2">
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border">
            <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="text-[10px] font-semibold text-muted">{pct}%</span>
        </div>
      )}
    </section>
  );
}

function Question({
  q, pending, multi, setMulti, onChoose, onSkip,
}: {
  q: ProfileQuestion;
  pending: boolean;
  multi: string[];
  setMulti: (v: string[]) => void;
  onChoose: (v: string | string[]) => void;
  onSkip: () => void;
}) {
  const toggleMulti = (v: string) =>
    setMulti(multi.includes(v) ? multi.filter((x) => x !== v) : [...multi, v]);

  return (
    <div className="mt-3">
      <p className="text-sm font-semibold">{q.prompt}</p>
      {q.help && <p className="mt-0.5 text-xs text-muted">{q.help}</p>}

      <div className="mt-3 flex flex-wrap gap-2">
        {q.options.map((o) => {
          const active = q.kind === 'multi' && multi.includes(o.value);
          return (
            <button
              key={o.value}
              disabled={pending}
              onClick={() => (q.kind === 'multi' ? toggleMulti(o.value) : onChoose(o.value))}
              className={cn(
                'inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-xs font-semibold transition disabled:opacity-60',
                active ? 'border-brand bg-brand/15 text-brand-text' : 'border-border text-fg hover:bg-elevated',
              )}
            >
              {active && <Check className="h-3 w-3" />}
              {o.label}
            </button>
          );
        })}
      </div>

      <div className="mt-3 flex items-center gap-2">
        {q.kind === 'multi' && (
          <button
            disabled={pending || multi.length === 0}
            onClick={() => onChoose(multi)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-brand px-3 text-xs font-bold text-brand-fg transition hover:opacity-90 disabled:opacity-50"
          >
            Save <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          disabled={pending}
          onClick={onSkip}
          className="inline-flex h-8 items-center rounded-lg px-3 text-xs font-semibold text-muted transition hover:text-fg disabled:opacity-60"
        >
          Skip
        </button>
      </div>
    </div>
  );
}
