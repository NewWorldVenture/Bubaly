'use client';

import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Wand2, RefreshCw } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { Button } from '@/components/ui/button';

type Msg = { role: 'user' | 'assistant'; content: string };

const QUICK = [
  'Build a day-by-day itinerary for this trip',
  'Suggest family-friendly restaurants near our hotel',
  'What rainy-day activities do you recommend?',
  'Help us stay within budget',
];

export function TripConcierge({ vacationId }: { vacationId: string }) {
  const { familyId } = useApp();
  const { success, error: toastError } = useToast();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const sb = createClient();
      const { data: convo } = await sb.from('vacation_ai_conversations').select('id').eq('family_id', familyId).eq('vacation_id', vacationId).order('updated_at', { ascending: false }).limit(1).maybeSingle();
      if (convo) {
        setConversationId(convo.id);
        const { data: msgs } = await sb.from('vacation_ai_messages').select('role, content').eq('conversation_id', convo.id).order('created_at', { ascending: true });
        setMessages((msgs ?? []).filter((m) => m.role === 'user' || m.role === 'assistant') as Msg[]);
      }
    })();
  }, [familyId, vacationId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  async function send(text: string) {
    if (!text.trim() || busy) return;
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setInput('');
    try {
      const res = await fetch('/api/vacations/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'concierge', vacationId, conversationId, message: text }) });
      const data = await res.json();
      if (!res.ok) { toastError(data.error || 'Failed'); setMessages((m) => m.slice(0, -1)); }
      else { setConversationId(data.conversationId); setMessages((m) => [...m, { role: 'assistant', content: data.reply }]); }
    } catch { toastError('Network error'); setMessages((m) => m.slice(0, -1)); }
    setBusy(false);
  }

  async function autoBuild() {
    setBuilding(true);
    try {
      const res = await fetch('/api/vacations/ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'build', vacationId }) });
      const data = await res.json();
      if (!res.ok) toastError(data.error || 'Build failed');
      else success(`Added ${data.added.activities} activities, ${data.added.items} itinerary items, ${data.added.budget} budget lines, ${data.added.packing} packing items`);
    } catch { toastError('Network error'); }
    setBuilding(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold"><Sparkles className="h-5 w-5 text-brand-text" /> AI Vacation Concierge</h2>
        <Button size="sm" variant="secondary" onClick={autoBuild} loading={building}><Wand2 className="h-4 w-4" /> Auto-build trip</Button>
      </div>

      <div className="rounded-2xl border border-border bg-surface/40 p-4">
        {messages.length === 0 ? (
          <div className="py-6 text-center">
            <Sparkles className="mx-auto h-8 w-8 text-brand-text/60" />
            <p className="mt-2 text-sm text-muted">Your personal travel agent. Ask anything about this trip, or tap a prompt below.</p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {QUICK.map((q) => <button key={q} onClick={() => send(q)} className="rounded-xl border border-border bg-elevated/40 p-3 text-left text-sm hover:border-brand/40">{q}</button>)}
            </div>
          </div>
        ) : (
          <div className="max-h-[55vh] space-y-3 overflow-y-auto">
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-sm ${m.role === 'user' ? 'bg-brand text-brand-fg' : 'bg-elevated text-fg'}`}>{m.content}</div>
              </div>
            ))}
            {busy && <div className="flex justify-start"><div className="rounded-2xl bg-elevated px-3.5 py-2.5 text-sm text-muted"><RefreshCw className="inline h-3.5 w-3.5 animate-spin" /> Thinking…</div></div>}
            <div ref={endRef} />
          </div>
        )}
      </div>

      <form onSubmit={(e) => { e.preventDefault(); send(input); }} className="flex items-center gap-2">
        <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask your concierge…" disabled={busy}
          className="h-11 flex-1 rounded-xl border border-border bg-surface/60 px-4 text-sm focus-ring" />
        <Button type="submit" size="icon" loading={busy} disabled={!input.trim()}><Send className="h-4 w-4" /></Button>
      </form>
    </div>
  );
}
