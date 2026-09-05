'use client';

// "Bubaly has a question" — the card a run shows while it is `awaiting_context`
// (§36: one question, answered in place, and the SAME run continues).
//
// The answer goes through the run's `answer` control, which appends it to the
// request's clarifications and re-plans the same request, so the page the
// person is on is the page the work happens on. If the planner comes back
// with one more question, it replaces this one; if it comes back with an
// answer instead of a plan, the answer is shown here.
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { MessageCircleQuestion, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';
import { answerRunAction } from '@/app/(app)/dashboard/concierge/run-actions';
import { runPagePath } from '@/lib/ai/chat-request';

export function ClarificationCard({
  runId,
  question,
  answered,
  canAnswer,
}: {
  runId: string;
  question: string;
  /** Earlier questions on this request, oldest first, so the thread reads in order. */
  answered: { question: string; answer: string }[];
  canAnswer: boolean;
}) {
  const router = useRouter();
  const { success, error: toastError } = useToast();
  const [current, setCurrent] = useState(question);
  const [reply, setReply] = useState('');
  const [answerText, setAnswerText] = useState<string | null>(null);
  const [busy, startTransition] = useTransition();

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = reply.trim();
    if (!text || busy) return;
    startTransition(async () => {
      const res = await answerRunAction(runId, text);
      if (!res.ok) {
        toastError(res.error);
        return;
      }
      setReply('');
      const out = res.data;
      if (out.outcome === 'clarification' && out.question) {
        setCurrent(out.question);
      } else if (out.outcome === 'answer') {
        setAnswerText(out.summary);
      } else {
        success(out.summary || 'Got it — Bubaly is on it.');
      }
      if (out.runId && out.runId !== runId) {
        router.push(runPagePath(out.runId));
        return;
      }
      router.refresh();
    });
  };

  return (
    <section aria-labelledby={`clarify-${runId}`} className="rounded-2xl border border-warning/30 bg-warning/5 p-4">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-warning/15 text-warning">
          <MessageCircleQuestion className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          {answered.length > 0 && (
            <dl className="mb-3 space-y-1.5 text-xs text-muted">
              {answered.map((qa, i) => (
                <div key={`${i}-${qa.question}`}>
                  <dt className="font-medium">{qa.question}</dt>
                  <dd className="text-fg/80">— {qa.answer}</dd>
                </div>
              ))}
            </dl>
          )}
          <h2 id={`clarify-${runId}`} className="text-sm font-semibold text-fg">{current}</h2>
          {answerText ? (
            <p className="mt-2 text-sm text-fg/85">{answerText}</p>
          ) : canAnswer ? (
            <form onSubmit={submit} className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Input
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Type your answer"
                aria-label="Your answer"
                maxLength={1000}
                autoFocus
                disabled={busy}
                className="flex-1"
              />
              <Button type="submit" size="md" className="coarse:min-h-11 sm:shrink-0" loading={busy} disabled={busy || !reply.trim()}>
                {!busy && <Send className="h-4 w-4" aria-hidden />} Answer
              </Button>
            </form>
          ) : (
            <p className="mt-2 text-xs text-muted">Waiting for the person who asked, or a parent, to answer.</p>
          )}
        </div>
      </div>
    </section>
  );
}
