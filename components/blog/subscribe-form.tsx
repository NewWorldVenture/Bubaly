'use client';

// Blog subscribe form — a real opt-in wired to /api/blog/subscribe
// (Supabase blog_subscribers underneath), replacing the previous dead inputs.
// Two layouts: "card" (sidebar) and "inline" (footer CTA row). Inline
// success/error states, a hidden honeypot field, and no toast dependency so
// it works anywhere in the public marketing tree.
import { useState } from 'react';
import { CheckCircle2, Loader2, Mail } from 'lucide-react';
import { getAnonymousId } from '@/lib/marketing/visitor';
import { cn } from '@/lib/utils/cn';

type Props = { source: string; variant?: 'card' | 'inline'; className?: string };

export function SubscribeForm({ source, variant = 'card', className }: Props) {
  const [email, setEmail] = useState('');
  const [website, setWebsite] = useState(''); // honeypot — humans never see it
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (state === 'busy') return;
    setState('busy');
    setMessage('');
    try {
      const res = await fetch('/api/blog/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, source, website, visitorId: getAnonymousId() }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; already?: boolean; error?: string };
      if (res.ok && data.ok) {
        setState('done');
        setMessage(data.already ? 'You’re already on the list — welcome back!' : 'You’re in! New articles will land in your inbox.');
        setEmail('');
      } else {
        setState('error');
        setMessage(data.error ?? 'Something went wrong — try again in a moment.');
      }
    } catch {
      setState('error');
      setMessage('Something went wrong — try again in a moment.');
    }
  }

  if (state === 'done') {
    return (
      <div className={cn(
        'flex items-center gap-2.5 rounded-xl border border-emerald-400/25 bg-emerald-500/10 px-4 py-3 text-sm font-semibold text-emerald-300',
        className,
      )} role="status">
        <CheckCircle2 className="h-5 w-5 shrink-0" /> {message}
      </div>
    );
  }

  const input = (
    <input
      type="email"
      required
      value={email}
      onChange={(e) => { setEmail(e.target.value); if (state === 'error') setState('idle'); }}
      placeholder="Enter your email"
      aria-label="Email address"
      className={cn(
        'rounded-xl border border-white/10 bg-white/[0.04] px-4 text-sm outline-none placeholder:text-white/35 focus:border-violet-400/50',
        variant === 'card' ? 'w-full py-2.5' : 'min-w-0 flex-1 py-3',
      )}
    />
  );

  const honeypot = (
    <input
      type="text"
      name="website"
      value={website}
      onChange={(e) => setWebsite(e.target.value)}
      tabIndex={-1}
      autoComplete="off"
      aria-hidden="true"
      className="absolute -left-[9999px] h-0 w-0 opacity-0"
    />
  );

  const button = (
    <button
      type="submit"
      disabled={state === 'busy'}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 text-sm font-bold shadow-glow transition hover:opacity-95 disabled:opacity-60',
        variant === 'card' ? 'mt-3 w-full py-2.5' : 'shrink-0 px-5 py-3',
      )}
    >
      {state === 'busy' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Mail className="h-4 w-4" />} Subscribe
    </button>
  );

  return (
    <form onSubmit={submit} className={cn(variant === 'inline' && 'flex w-full max-w-md gap-3', className)}>
      {honeypot}
      {input}
      {button}
      {state === 'error' && (
        <p className={cn('text-xs font-semibold text-rose-300', variant === 'card' ? 'mt-2' : 'mt-1 w-full')} role="alert">
          {message}
        </p>
      )}
    </form>
  );
}
