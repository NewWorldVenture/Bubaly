'use client';

import { useEffect, useRef, useState } from 'react';
import { Sparkles, Send, Plus, Trash2 } from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/ui/toast';
import { PageHeader } from '@/components/app/page-header';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LoadingBlock, EmptyState } from '@/components/ui/states';
import { fmtRelative } from '@/lib/utils/format';
import { cn } from '@/lib/utils/cn';
import type { Tables } from '@/lib/database.types';

type Conversation = Tables<'ai_conversations'>;
type Message = Tables<'ai_messages'>;

export function AssistantModule() {
  const { familyId, userId } = useApp();
  const { error: toastError } = useToast();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConv, setActiveConv] = useState<Conversation | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadConversations();
  }, [familyId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadConversations() {
    const supabase = createClient();
    const { data } = await supabase.from('ai_conversations').select('*')
      .eq('family_id', familyId).order('updated_at', { ascending: false }).limit(20);
    setConversations(data ?? []);
    setLoadingConvs(false);
  }

  async function loadMessages(conv: Conversation) {
    setActiveConv(conv);
    setLoadingMsgs(true);
    const supabase = createClient();
    const { data } = await supabase.from('ai_messages').select('*')
      .eq('conversation_id', conv.id).order('created_at', { ascending: true });
    setMessages(data ?? []);
    setLoadingMsgs(false);
  }

  async function newConversation() {
    const supabase = createClient();
    const { data, error } = await supabase.from('ai_conversations').insert({
      family_id: familyId,
      user_id: userId,
      title: 'New conversation',
      provider: 'anthropic',
      model: process.env.NEXT_PUBLIC_AI_MODEL ?? 'claude-sonnet-4-6',
    }).select().single();
    if (error || !data) return toastError(error?.message ?? 'Could not start conversation');
    setConversations((prev) => [data, ...prev]);
    setActiveConv(data);
    setMessages([]);
  }

  async function deleteConversation(id: string) {
    const supabase = createClient();
    await supabase.from('ai_conversations').delete().eq('id', id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConv?.id === id) { setActiveConv(null); setMessages([]); }
  }

  async function sendMessage() {
    if (!input.trim() || !activeConv || sending) return;
    const userMessage = input.trim();
    setInput('');
    setSending(true);

    // Optimistically add user message
    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      family_id: familyId,
      conversation_id: activeConv.id,
      role: 'user',
      content: userMessage,
      tool_calls: null,
      tool_results: null,
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimistic]);

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: activeConv.id, message: userMessage }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? 'Failed');

      // Update conversation title if this is the first message
      if (messages.length === 0) {
        const title = userMessage.slice(0, 60);
        await createClient().from('ai_conversations').update({ title }).eq('id', activeConv.id);
        setConversations((prev) => prev.map((c) => c.id === activeConv.id ? { ...c, title } : c));
      }

      // Reload actual messages from DB
      const supabase = createClient();
      const { data } = await supabase.from('ai_messages').select('*')
        .eq('conversation_id', activeConv.id).order('created_at', { ascending: true });
      setMessages(data ?? []);
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Something went wrong');
      setMessages((prev) => prev.filter((m) => m.id !== optimistic.id));
    } finally {
      setSending(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  }

  const STARTERS = [
    'Summarize what\'s happening this week',
    'Suggest 5 quick dinners for the week',
    'What chores are still open?',
    'Help me plan a family game night',
  ];

  if (loadingConvs) return <LoadingBlock />;

  return (
    <div className="flex h-[calc(100vh-8rem)] gap-4">
      {/* Sidebar */}
      <div className="hidden w-60 shrink-0 flex-col gap-2 lg:flex">
        <Button onClick={newConversation} className="w-full"><Plus className="h-4 w-4" /> New chat</Button>
        <div className="flex-1 space-y-1 overflow-y-auto">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={cn(
                'group flex items-center gap-2 rounded-xl px-3 py-2 text-sm cursor-pointer hover:bg-elevated transition',
                activeConv?.id === c.id && 'bg-brand/10 text-brand',
              )}
              onClick={() => loadMessages(c)}
            >
              <Sparkles className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 truncate">{c.title}</span>
              <button
                onClick={(e) => { e.stopPropagation(); void deleteConversation(c.id); }}
                className="hidden rounded p-0.5 hover:text-danger group-hover:block"
                aria-label="Delete"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex flex-1 flex-col">
        {!activeConv ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-6">
            <div className="text-center">
              <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand/10">
                <Sparkles className="h-8 w-8 text-brand" />
              </div>
              <h2 className="text-xl font-bold">Your family assistant</h2>
              <p className="mt-1 text-sm text-muted">Ask anything about your family's schedule, meals, chores, and more.</p>
            </div>
            <div className="grid w-full max-w-md gap-2">
              {STARTERS.map((s) => (
                <button
                  key={s}
                  onClick={async () => { await newConversation(); setInput(s); }}
                  className="rounded-xl border border-border bg-surface/60 px-4 py-2.5 text-left text-sm hover:bg-elevated transition"
                >
                  {s}
                </button>
              ))}
            </div>
            <Button onClick={newConversation}><Plus className="h-4 w-4" /> Start a conversation</Button>
          </div>
        ) : (
          <Card className="flex flex-1 flex-col overflow-hidden p-0">
            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {loadingMsgs ? (
                <LoadingBlock />
              ) : messages.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <p className="text-sm text-muted">Send a message to get started.</p>
                </div>
              ) : (
                messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => (
                  <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                    {m.role === 'assistant' && (
                      <div className="mr-2 mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-brand/10">
                        <Sparkles className="h-4 w-4 text-brand" />
                      </div>
                    )}
                    <div
                      className={cn(
                        'max-w-[75%] rounded-2xl px-4 py-2.5 text-sm',
                        m.role === 'user'
                          ? 'bg-brand text-white rounded-br-sm'
                          : 'bg-surface/80 border border-border rounded-bl-sm',
                      )}
                    >
                      <p className="whitespace-pre-wrap">{m.content}</p>
                    </div>
                  </div>
                ))
              )}
              {sending && (
                <div className="flex justify-start">
                  <div className="mr-2 mt-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-xl bg-brand/10">
                    <Sparkles className="h-4 w-4 text-brand" />
                  </div>
                  <div className="rounded-2xl rounded-bl-sm border border-border bg-surface/80 px-4 py-3">
                    <div className="flex gap-1">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="h-1.5 w-1.5 rounded-full bg-muted animate-pulse" style={{ animationDelay: `${i * 150}ms` }} />
                      ))}
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>

            {/* Input */}
            <div className="border-t border-border p-3">
              <div className="flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={handleKey}
                  placeholder="Ask your family assistant…"
                  rows={1}
                  className="flex-1 resize-none rounded-xl border border-border bg-surface/60 px-4 py-2.5 text-sm placeholder:text-muted focus-ring transition"
                  style={{ maxHeight: '120px' }}
                />
                <Button onClick={() => void sendMessage()} loading={sending} disabled={!input.trim()}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
              <p className="mt-1.5 text-center text-xs text-muted">Press Enter to send · Shift+Enter for new line</p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
