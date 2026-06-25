'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils/cn';

export function SubscribeForm({ className, inputClass, buttonClass }: {
  className?: string;
  inputClass?: string;
  buttonClass?: string;
}) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus('loading');
    try {
      const res = await fetch('/api/blog/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus('error');
        setMessage(data.error ?? 'Something went wrong.');
        return;
      }
      setStatus('success');
      setMessage(data.message ?? 'Thanks for subscribing!');
      setEmail('');
    } catch {
      setStatus('error');
      setMessage('Something went wrong. Please try again.');
    }
  }

  if (status === 'success') {
    return <p className={cn('text-sm font-medium text-emerald-400', className)}>{message}</p>;
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      <div className="flex gap-3">
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Enter your email"
          className={cn(
            'min-w-0 flex-1 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-sm outline-none placeholder:text-white/35 focus:border-violet-400/50',
            inputClass,
          )}
        />
        <button
          type="submit"
          disabled={status === 'loading'}
          className={cn(
            'rounded-xl bg-gradient-to-r from-blue-500 to-violet-600 px-5 py-2.5 text-sm font-bold shadow-glow disabled:opacity-60',
            buttonClass,
          )}
        >
          {status === 'loading' ? 'Sending…' : 'Subscribe'}
        </button>
      </div>
      {status === 'error' && <p className="mt-2 text-xs text-rose-400">{message}</p>}
    </form>
  );
}
