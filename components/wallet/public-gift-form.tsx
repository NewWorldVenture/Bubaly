'use client';

// Public gift form (no auth) — a relative picks an amount, adds a note, and
// submits a pending gift the family approves later. Friendly + frictionless.
import { useState } from 'react';
import { Gift, Check, Sparkles, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { formatCents } from '@/lib/wallet/ledger';
import { submitGiftPledgeAction } from '@/app/gift/actions';

export function PublicGiftForm({ token, suggestedCents, childName }: {
  token: string; suggestedCents: number[]; childName: string;
}) {
  const [amount, setAmount] = useState<number | null>(suggestedCents[0] ?? null);
  const [custom, setCustom] = useState('');
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI Gift Assistant state.
  const [assisting, setAssisting] = useState(false);
  const [ideas, setIdeas] = useState<string[]>([]);
  const [aiAmounts, setAiAmounts] = useState<number[]>([]);

  const effectiveCents = custom ? Math.round(Number(custom) * 100) : amount;

  async function getIdeas() {
    if (assisting) return;
    setAssisting(true);
    setError(null);
    try {
      const res = await fetch('/api/ai/gift', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, relationship: name.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Could not get ideas right now.'); return; }
      setIdeas(data.messages ?? []);
      setAiAmounts(data.amountsCents ?? []);
    } catch {
      setError('Could not get ideas right now.');
    } finally {
      setAssisting(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Please enter your name.');
    if (!effectiveCents || effectiveCents <= 0) return setError('Pick or enter an amount.');
    setLoading(true);
    const res = await submitGiftPledgeAction({ token, giverName: name, amountCents: effectiveCents, message });
    setLoading(false);
    if (!res.ok) return setError(res.error ?? 'Could not send your gift.');
    setDone(true);
  }

  if (done) {
    return (
      <div className="flex w-full flex-col items-center gap-3 rounded-2xl border border-emerald-500/30 bg-emerald-500/5 p-8 text-center">
        <div className="grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15"><Check className="h-7 w-7 text-emerald-400" /></div>
        <p className="text-lg font-bold">Thank you! 🎉</p>
        <p className="text-sm text-muted">Your {effectiveCents ? formatCents(effectiveCents) : ''} gift to {childName} was sent. The family will add it to their wallet.</p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="w-full space-y-4 rounded-2xl border border-border bg-surface/40 p-5">
      <div>
        <label className="mb-1.5 block text-sm font-medium">Choose an amount</label>
        <div className="grid grid-cols-3 gap-2">
          {suggestedCents.map((c) => (
            <button key={c} type="button" onClick={() => { setAmount(c); setCustom(''); }}
              className={cn('rounded-xl border-2 py-3 text-sm font-bold transition',
                amount === c && !custom ? 'border-brand bg-brand/10 text-brand-text' : 'border-border hover:border-brand/40')}>
              {formatCents(c)}
            </button>
          ))}
        </div>
        <input type="number" min="1" max="1000" step="1" inputMode="decimal" value={custom}
          onChange={(e) => { setCustom(e.target.value); setAmount(null); }}
          placeholder="Or enter a custom amount"
          className="mt-2 h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm" />
      </div>

      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name (e.g. Grandma)"
        className="h-10 w-full rounded-lg border border-border bg-bg px-3 text-sm" />

      {aiAmounts.length > 0 && (
        <div className="rounded-xl border border-brand/20 bg-brand/5 p-2.5">
          <p className="mb-1.5 text-[11px] font-medium text-brand-text">Suggested amounts</p>
          <div className="flex flex-wrap gap-2">
            {aiAmounts.map((c) => (
              <button key={c} type="button" onClick={() => { setAmount(c); setCustom(''); }}
                className={cn('rounded-lg border px-3 py-1.5 text-sm font-semibold transition',
                  amount === c && !custom ? 'border-brand bg-brand/10 text-brand-text' : 'border-border hover:border-brand/40')}>
                {formatCents(c)}
              </button>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label className="text-sm font-medium">Add a message (optional)</label>
          <button type="button" onClick={getIdeas} disabled={assisting}
            className="inline-flex items-center gap-1 text-xs font-medium text-brand-text hover:underline disabled:opacity-60">
            {assisting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            Help me write something
          </button>
        </div>
        <textarea value={message} onChange={(e) => setMessage(e.target.value)} placeholder={`Write a note for ${childName}…`}
          className="min-h-[70px] w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm" />
        {ideas.length > 0 && (
          <div className="mt-2 space-y-1.5">
            {ideas.map((idea, i) => (
              <button key={i} type="button" onClick={() => setMessage(idea)}
                className="block w-full rounded-lg border border-border bg-bg/60 px-3 py-2 text-left text-xs text-muted transition hover:border-brand/40 hover:text-fg">
                “{idea}”
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <p className="text-sm text-danger">{error}</p>}

      <button type="submit" disabled={loading}
        className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-50 transition">
        <Gift className="h-4 w-4" /> {loading ? 'Sending…' : `Send gift to ${childName}`}
      </button>
      <p className="text-center text-[11px] text-muted">No charge is made now — the family confirms the gift.</p>
    </form>
  );
}
