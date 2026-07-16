'use client';

import { useState, useRef, useEffect } from 'react';
import {
  Sparkles, Send, Plus, Plane, UtensilsCrossed, Heart, Zap,
  PartyPopper, MapPin, Calendar, CheckCircle2, Clock,
  ChevronRight, Trash2, ArrowLeft, DollarSign, CalendarPlus, Check, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/app/app-context';
import { useRealtimeQuery } from '@/lib/hooks/use-realtime-query';
import { createClient } from '@/lib/supabase/client';
import { describeDbError } from '@/lib/supabase/errors';
import { useToast } from '@/components/ui/toast';
import { Modal } from '@/components/ui/modal';
import { Input, Field, Select, Textarea } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/app/page-header';
import { SkeletonList, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import { PlanWriteBacks } from '@/components/concierge/plan-write-backs';
import { AutopilotPanel } from '@/components/concierge/autopilot-panel';
import { planAcceptedAction } from '@/app/(app)/dashboard/concierge/actions';
import type { Tables } from '@/lib/database.types';

type Plan = Tables<'concierge_plans'>;

type ChatMessage = { role: 'user' | 'assistant'; content: string };

const KIND_CONFIG: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string; color: string; prompt: string }> = {
  getaway:     { icon: Plane,           label: 'Weekend Getaway',    color: 'bg-blue-500/15 text-blue-400',    prompt: 'Help me plan a weekend getaway for my family. Ask about budget, dates, preferences, and number of people.' },
  restaurant:  { icon: UtensilsCrossed, label: 'Book a Restaurant',  color: 'bg-amber-500/15 text-amber-400',  prompt: 'Help me find and book a restaurant for a family dinner. Ask about cuisine, occasion, number of guests, and budget.' },
  date_night:  { icon: Heart,           label: 'Date Night',         color: 'bg-pink-500/15 text-pink-400',    prompt: 'Help me plan a special date night. Ask about budget, location preferences, and what kind of experience we want.' },
  activity:    { icon: Zap,             label: 'Family Activity',     color: 'bg-green-500/15 text-green-400',  prompt: 'Suggest a fun family activity. Ask about age ranges, interests, budget, and whether we prefer indoor or outdoor.' },
  party:       { icon: PartyPopper,     label: 'Plan a Party',        color: 'bg-violet-500/15 text-violet-400', prompt: 'Help me plan a family party or celebration. Ask about the occasion, number of guests, budget, and venue preference.' },
  travel:      { icon: MapPin,          label: 'Vacation Planning',   color: 'bg-cyan-500/15 text-cyan-400',    prompt: 'Help me plan a family vacation. Ask about destination preferences, travel dates, budget, and activities we enjoy.' },
  general:     { icon: Sparkles,        label: 'Ask Anything',        color: 'bg-brand/15 text-brand-text',          prompt: 'I\'m your personal family concierge. What can I help you plan or arrange today?' },
};

const STATUS_STYLES: Record<string, string> = {
  idea:      'bg-surface text-muted border border-border',
  planning:  'bg-blue-500/15 text-blue-400 border border-blue-500/30',
  booked:    'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  confirmed: 'bg-green-500/15 text-green-400 border border-green-500/30',
  completed: 'bg-green-500/15 text-green-400 border border-green-500/30',
  cancelled: 'bg-red-500/15 text-red-400 border border-red-500/30',
};

function fmtDate(d: string | null) {
  if (!d) return null;
  return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtCents(cents: number | null) {
  if (!cents) return null;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}

// ─── Main Module ──────────────────────────────────────────────────────────────
export function ConciergeModule() {
  const { familyId, userId, selfMember, family } = useApp();
  const { success, error: toastError } = useToast();
  const [activeKind, setActiveKind] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<Plan | null>(null);
  const [showAddPlan, setShowAddPlan] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data: plans, loading: plansLoading, error: plansError, refresh: refreshPlans } = useRealtimeQuery<Plan>({
    table: 'concierge_plans', familyId, deps: [familyId],
    fetcher: async (supabase) => supabase.from('concierge_plans').select('*').eq('family_id', familyId).order('created_at', { ascending: false }),
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Start a new chat with a specific kind
  function startChat(kind: string) {
    const cfg = KIND_CONFIG[kind] ?? KIND_CONFIG.general;
    setActiveKind(kind);
    setMessages([{ role: 'assistant', content: cfg.prompt }]);
    setInput('');
  }

  async function sendMessage() {
    if (!input.trim() || sending) return;
    const userMsg: ChatMessage = { role: 'user', content: input.trim() };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput('');
    setSending(true);

    try {
      const res = await fetch('/api/ai/assist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: nextMessages.map(m => ({ role: m.role, content: m.content })),
          systemPrompt: `You are a luxury family concierge AI for the ${family?.name ?? 'family'} household. You help families plan memorable experiences, make reservations, coordinate schedules, and arrange special moments. Be warm, enthusiastic, and practical. Ask one clarifying question at a time when you need a key detail (budget, dates, party size). When you have enough information, suggest specific options with helpful tips, and offer to save the plan. Keep responses concise and actionable.`,
          maxTokens: 700,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'AI error');
      const assistantMsg: ChatMessage = { role: 'assistant', content: data.message ?? 'I couldn\'t generate a response.' };
      setMessages(prev => [...prev, assistantMsg]);
    } catch {
      toastError('Could not reach the concierge AI. Please try again.');
    } finally {
      setSending(false);
    }
  }

  async function savePlanFromChat() {
    if (!activeKind || messages.length < 2) return;
    const lastAi = [...messages].reverse().find(m => m.role === 'assistant');
    const supabase = createClient();
    const { error } = await supabase.from('concierge_plans').insert({
      family_id: familyId, created_by: userId,
      title: KIND_CONFIG[activeKind]?.label ?? 'New Plan',
      kind: activeKind,
      description: messages.find(m => m.role === 'user')?.content?.slice(0, 200),
      ai_suggestion: lastAi?.content?.slice(0, 500),
      status: 'planning',
    });
    if (error) { toastError(describeDbError(error)); return; }
    success('Plan saved!');
    void refreshPlans();
    setActiveKind(null);
    setMessages([]);
  }

  async function deletePlan(plan: Plan) {
    const supabase = createClient();
    const { error } = await supabase.from('concierge_plans').delete().eq('id', plan.id);
    if (error) { toastError(describeDbError(error)); return; }
    if (selectedPlan?.id === plan.id) setSelectedPlan(null);
    void refreshPlans();
  }

  const name = selfMember?.display_name?.split(' ')[0] ?? 'there';
  const activePlans  = plans.filter(p => !['completed', 'cancelled'].includes(p.status));
  const pastPlans    = plans.filter(p => ['completed', 'cancelled'].includes(p.status));

  return plansLoading ? <SkeletonList /> : plansError ? <ErrorState message="Could not load concierge plans. Refresh and try again." onRetry={refreshPlans} /> : (
    <div className="module-with-sidebar">
      {/* ── Main column ── */}
      <div className="module-main">
        <div className="module-page">
          {activeKind ? (
            /* ── Chat view ── */
            <div className="flex flex-col" style={{ height: 'calc(100vh - 140px)' }}>
              <div className="flex items-center gap-3 mb-4">
                <button onClick={() => { setActiveKind(null); setMessages([]); }}
                  className="rounded-lg p-1.5 hover:bg-surface/60 transition text-muted hover:text-fg">
                  <ArrowLeft className="h-5 w-5" />
                </button>
                <div className={cn('grid h-9 w-9 place-items-center rounded-xl flex-shrink-0', KIND_CONFIG[activeKind]?.color)}>
                  {(() => { const Ic = KIND_CONFIG[activeKind]?.icon ?? Sparkles; return <Ic className="h-4 w-4" />; })()}
                </div>
                <div>
                  <p className="font-bold text-sm">{KIND_CONFIG[activeKind]?.label}</p>
                  <p className="text-[10px] text-muted">AI Concierge</p>
                </div>
                <div className="ml-auto flex gap-2">
                  {messages.length >= 3 && (
                    <button onClick={savePlanFromChat}
                      className="flex items-center gap-1.5 rounded-lg bg-brand/10 px-3 py-1.5 text-xs font-semibold text-brand-text hover:bg-brand/20 transition">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Save Plan
                    </button>
                  )}
                </div>
              </div>

              {/* Chat messages */}
              <div className="flex-1 overflow-y-auto space-y-4 pr-1">
                {messages.map((msg, i) => (
                  <div key={i} className={cn('flex', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                    {msg.role === 'assistant' && (
                      <div className="mr-2 mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand/20">
                        <Sparkles className="h-3.5 w-3.5 text-brand-text" />
                      </div>
                    )}
                    <div className={cn(
                      'max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed',
                      msg.role === 'user'
                        ? 'rounded-tr-sm bg-brand text-white'
                        : 'rounded-tl-sm border border-border bg-surface/60',
                    )}>
                      {msg.content}
                    </div>
                  </div>
                ))}
                {sending && (
                  <div className="flex justify-start">
                    <div className="mr-2 mt-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-brand/20">
                      <Sparkles className="h-3.5 w-3.5 text-brand-text animate-pulse" />
                    </div>
                    <div className="flex items-center gap-1 rounded-2xl rounded-tl-sm border border-border bg-surface/60 px-4 py-3">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="h-1.5 w-1.5 rounded-full bg-muted animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>

              {/* Input bar */}
              <div className="mt-4 flex items-end gap-2">
                <textarea
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
                  placeholder="Tell me what you'd like to plan…"
                  rows={2}
                  className="flex-1 resize-none rounded-2xl border border-border bg-surface/60 px-4 py-3 text-sm placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-brand/30"
                />
                <button onClick={() => void sendMessage()} disabled={!input.trim() || sending}
                  className={cn('flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl transition',
                    input.trim() && !sending ? 'bg-brand text-white hover:bg-brand/90' : 'bg-surface text-muted')}>
                  <Send className="h-4 w-4" />
                </button>
              </div>
            </div>
          ) : (
            /* ── Home view ── */
            <>
              {/* Hero */}
              <div className="mb-6 overflow-hidden rounded-2xl border border-brand/20 bg-gradient-to-br from-brand/10 via-violet-500/5 to-transparent p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="mb-2 flex items-center gap-2">
                      <div className="grid h-10 w-10 place-items-center rounded-xl bg-brand/20">
                        <Sparkles className="h-5 w-5 text-brand-text" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-brand-text uppercase tracking-wide">AI Concierge</p>
                        <h1 className="text-xl font-bold">Life. Simplified.</h1>
                      </div>
                    </div>
                    <p className="text-sm text-muted max-w-sm">
                      Your personal family concierge — plan getaways, book restaurants, coordinate date nights, and discover family activities.
                    </p>
                  </div>
                </div>

                {/* Quick action grid */}
                <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {Object.entries(KIND_CONFIG).filter(([k]) => k !== 'general').map(([kind, cfg]) => (
                    <button key={kind} onClick={() => startChat(kind)}
                      className="flex items-center gap-2.5 rounded-xl border border-border/60 bg-surface/60 px-3 py-2.5 text-left transition hover:bg-surface hover:border-brand/30">
                      <div className={cn('grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg', cfg.color)}>
                        <cfg.icon className="h-4 w-4" />
                      </div>
                      <span className="text-xs font-semibold">{cfg.label}</span>
                    </button>
                  ))}
                  <button onClick={() => startChat('general')}
                    className="flex items-center gap-2.5 rounded-xl border border-brand/30 bg-brand/5 px-3 py-2.5 text-left transition hover:bg-brand/10">
                    <div className="grid h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-brand/20">
                      <Sparkles className="h-4 w-4 text-brand-text" />
                    </div>
                    <span className="text-xs font-semibold text-brand-text">Ask Anything</span>
                  </button>
                </div>
              </div>

              {/* Active plans */}
              {activePlans.length > 0 && (
                <div className="mb-6">
                  <div className="mb-3 flex items-center justify-between">
                    <h2 className="text-sm font-semibold">Active Plans</h2>
                    <button onClick={() => setShowAddPlan(true)}
                      className="flex items-center gap-1 text-xs font-semibold text-brand-text hover:underline">
                      <Plus className="h-3.5 w-3.5" /> Add
                    </button>
                  </div>
                  <div className="space-y-2.5">
                    {activePlans.map(plan => {
                      const cfg = KIND_CONFIG[plan.kind] ?? KIND_CONFIG.general;
                      return (
                        <button key={plan.id} onClick={() => setSelectedPlan(plan)}
                          className="w-full flex items-center gap-3 rounded-2xl border border-border bg-surface/40 px-4 py-3 text-left transition hover:bg-surface/60">
                          <div className={cn('grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl', cfg.color)}>
                            <cfg.icon className="h-4.5 w-4.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-semibold">{plan.title}</div>
                            <div className="mt-0.5 flex items-center gap-2">
                              <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-semibold capitalize', STATUS_STYLES[plan.status])}>{plan.status}</span>
                              {plan.planned_for && <span className="text-[11px] text-muted">{fmtDate(plan.planned_for)}</span>}
                              {plan.budget_cents && <span className="text-[11px] text-muted">{fmtCents(plan.budget_cents)}</span>}
                            </div>
                          </div>
                          <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Empty state */}
              {plans.length === 0 && !plansLoading && (
                <div className="flex flex-col items-center py-10 text-center">
                  <div className="mb-3 grid h-14 w-14 place-items-center rounded-full bg-brand/10">
                    <Sparkles className="h-6 w-6 text-brand-text opacity-60" />
                  </div>
                  <p className="text-sm font-semibold">No plans yet</p>
                  <p className="mt-1 text-xs text-muted">Start with one of the quick actions above.</p>
                </div>
              )}

              {/* Past plans */}
              {pastPlans.length > 0 && (
                <div>
                  <h2 className="mb-3 text-sm font-semibold text-muted">Past Plans</h2>
                  <div className="space-y-1.5">
                    {pastPlans.slice(0, 5).map(plan => {
                      const cfg = KIND_CONFIG[plan.kind] ?? KIND_CONFIG.general;
                      return (
                        <div key={plan.id} className="flex items-center gap-3 rounded-xl border border-border/60 bg-surface/20 px-4 py-2.5">
                          <div className={cn('grid h-7 w-7 flex-shrink-0 place-items-center rounded-lg', cfg.color)}>
                            <cfg.icon className="h-3.5 w-3.5" />
                          </div>
                          <span className="flex-1 truncate text-sm text-muted">{plan.title}</span>
                          <span className={cn('rounded-md px-1.5 py-0.5 text-[10px] font-semibold capitalize', STATUS_STYLES[plan.status])}>{plan.status}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Autopilot — mobile mount (the desktop mount lives in the sidebar). */}
              <AutopilotPanel className="lg:hidden" />
            </>
          )}
        </div>
      </div>

      {/* ── Sidebar ── */}
      <div className="module-sidebar hidden lg:flex lg:flex-col gap-4">
        {selectedPlan ? (
          <PlanDetail plan={selectedPlan} familyId={familyId} userId={userId} onClose={() => setSelectedPlan(null)} onDelete={deletePlan} onRefresh={refreshPlans} />
        ) : (
          <>
            <AutopilotPanel />
            <div className="sidebar-card">
              <p className="mb-3 text-sm font-semibold">Your Plans</p>
              <div className="space-y-1.5">
                {plans.slice(0, 6).map(p => {
                  const cfg = KIND_CONFIG[p.kind] ?? KIND_CONFIG.general;
                  return (
                    <button key={p.id} onClick={() => setSelectedPlan(p)}
                      className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-surface/60 transition">
                      <div className={cn('grid h-6 w-6 flex-shrink-0 place-items-center rounded-md', cfg.color)}>
                        <cfg.icon className="h-3 w-3" />
                      </div>
                      <span className="flex-1 truncate text-xs">{p.title}</span>
                      <span className={cn('text-[10px] font-semibold capitalize', p.status === 'completed' ? 'text-green-400' : 'text-muted')}>{p.status}</span>
                    </button>
                  );
                })}
                {plans.length === 0 && <p className="text-xs text-muted">No saved plans yet.</p>}
              </div>
              <button onClick={() => setShowAddPlan(true)}
                className="mt-3 flex w-full items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted hover:bg-surface/60 transition">
                <Plus className="h-3.5 w-3.5" /> Add plan manually
              </button>
            </div>

            <div className="sidebar-card">
              <p className="mb-3 text-sm font-semibold">Inspiration</p>
              <div className="space-y-2">
                {[
                  { emoji: '🏖️', text: 'Plan a beach trip this summer' },
                  { emoji: '🍕', text: 'Find a new family pizza spot' },
                  { emoji: '🎭', text: 'Book a show or event nearby' },
                  { emoji: '🌲', text: 'Camping or hiking weekend' },
                  { emoji: '💑', text: 'Surprise date night ideas' },
                ].map((tip, i) => (
                  <button key={i} onClick={() => { setActiveKind('general'); setMessages([{ role: 'assistant', content: `I'd love to help with that! Tell me more about "${tip.text}" — what's your timeline and budget?` }]); setInput(tip.text); }}
                    className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-surface/60 transition">
                    <span className="text-base">{tip.emoji}</span>
                    <span className="text-muted">{tip.text}</span>
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>

      {showAddPlan && (
        <AddPlanModal familyId={familyId} userId={userId}
          onClose={() => setShowAddPlan(false)} onSaved={() => { setShowAddPlan(false); void refreshPlans(); }} />
      )}
    </div>
  );
}

// ─── Plan Detail ──────────────────────────────────────────────────────────────
function PlanDetail({ plan, onClose, onDelete, onRefresh }: {
  plan: Plan; familyId: string; userId: string; onClose: () => void; onDelete: (p: Plan) => void; onRefresh: () => void;
}) {
  const { success, error: toastError } = useToast();
  const [editStatus, setEditStatus] = useState(plan.status);
  const cfg = KIND_CONFIG[plan.kind] ?? KIND_CONFIG.general;

  async function updateStatus(status: string) {
    const prev = editStatus;
    setEditStatus(status);
    const supabase = createClient();
    const { error } = await supabase.from('concierge_plans').update({ status }).eq('id', plan.id);
    if (error) { toastError(describeDbError(error)); return; }
    onRefresh();
    // The autonomous execution loop: accepting a plan (→ booked/confirmed) lets
    // Bubaly execute its write-backs per the family's autopilot dial — done
    // instantly, queued for approval, or left manual. Audited either way.
    try {
      const res = await planAcceptedAction(plan.id, prev, status);
      if (res.ok && res.summary) {
        success(res.mode === 'auto' ? res.summary : `Queued for approval — check the Autopilot panel`);
      }
    } catch { /* the loop is best-effort; the status change already saved */ }
  }

  return (
    <div className="sidebar-card space-y-4">
      <div className="flex items-center gap-2">
        <button onClick={onClose} aria-label="Back" className="text-muted hover:text-fg"><ArrowLeft className="h-4 w-4" /></button>
        <div className={cn('grid h-8 w-8 flex-shrink-0 place-items-center rounded-lg', cfg.color)}>
          <cfg.icon className="h-3.5 w-3.5" />
        </div>
        <p className="flex-1 truncate text-sm font-bold">{plan.title}</p>
        <button onClick={() => onDelete(plan)} className="text-muted hover:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>

      <div className="space-y-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">Status</p>
          <select value={editStatus} onChange={e => void updateStatus(e.target.value)}
            className="w-full rounded-lg border border-border bg-surface/60 px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-brand/30">
            {['idea', 'planning', 'booked', 'confirmed', 'completed', 'cancelled'].map(s => (
              <option key={s} value={s} className="capitalize">{s}</option>
            ))}
          </select>
        </div>

        {plan.planned_for && (
          <div className="flex items-center gap-2 text-xs">
            <Calendar className="h-3.5 w-3.5 text-muted" />
            <span>{fmtDate(plan.planned_for)}</span>
          </div>
        )}
        {/* Deeper write-back: materialize the plan across calendar / reminder / task. */}
        <PlanWriteBacks planId={plan.id} plan={{ title: plan.title, planned_for: plan.planned_for, budget_cents: plan.budget_cents, location: plan.location }} />
        {plan.location && (
          <div className="flex items-center gap-2 text-xs">
            <MapPin className="h-3.5 w-3.5 text-muted" />
            <span>{plan.location}</span>
          </div>
        )}
        {plan.budget_cents && (
          <div className="flex items-center gap-2 text-xs">
            <DollarSign className="h-3.5 w-3.5 text-muted" />
            <span>{fmtCents(plan.budget_cents)}</span>
          </div>
        )}

        {plan.description && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted mb-1">Notes</p>
            <p className="text-xs text-muted leading-relaxed">{plan.description}</p>
          </div>
        )}

        {plan.ai_suggestion && (
          <div className="rounded-xl border border-brand/20 bg-brand/5 p-3">
            <div className="flex items-center gap-1.5 mb-1">
              <Sparkles className="h-3 w-3 text-brand-text" />
              <span className="text-[10px] font-semibold text-brand-text uppercase tracking-wide">AI Suggestion</span>
            </div>
            <p className="text-xs text-muted leading-relaxed">{plan.ai_suggestion}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Add Plan Modal ───────────────────────────────────────────────────────────
function AddPlanModal({ familyId, userId, onClose, onSaved }: {
  familyId: string; userId: string; onClose: () => void; onSaved: () => void;
}) {
  const { error: toastError } = useToast();
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (loading) return;
    const form = new FormData(e.currentTarget);
    const title = String(form.get('title') ?? '').trim();
    const kind = String(form.get('kind') ?? 'general');
    const description = String(form.get('description') ?? '').trim() || null;
    const status = String(form.get('status') ?? 'idea');
    const planned_for = String(form.get('planned_for') ?? '') || null;
    const location = String(form.get('location') ?? '').trim() || null;
    const budgetStr = String(form.get('budget') ?? '').trim();
    const budget_cents = budgetStr ? Math.round(parseFloat(budgetStr) * 100) : null;

    if (!title) return toastError('Add a plan title');

    setLoading(true);
    const supabase = createClient();
    const { error } = await supabase.from('concierge_plans').insert({
      family_id: familyId, created_by: userId,
      title, kind, description, status, planned_for, location, budget_cents,
    });
    setLoading(false);
    if (error) return toastError(describeDbError(error));
    onSaved();
  }

  return (
    <Modal open title="Add Plan" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Title" required>
          {id => <Input id={id} name="title" autoFocus placeholder="Weekend in the mountains" />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Type">
            {id => (
              <Select id={id} name="kind">
                {Object.entries(KIND_CONFIG).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </Select>
            )}
          </Field>
          <Field label="Status">
            {id => (
              <Select id={id} name="status">
                {['idea', 'planning', 'booked', 'confirmed'].map(s => <option key={s} value={s} className="capitalize">{s}</option>)}
              </Select>
            )}
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date">
            {id => <Input id={id} name="planned_for" type="date" />}
          </Field>
          <Field label="Budget ($)">
            {id => <Input id={id} name="budget" type="number" min="0" step="10" placeholder="500" />}
          </Field>
        </div>
        <Field label="Location">
          {id => <Input id={id} name="location" placeholder="City, venue, or destination" />}
        </Field>
        <Field label="Notes">
          {id => <Textarea id={id} name="description" rows={3} placeholder="Any details, ideas, or requirements…" />}
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" loading={loading}>{loading ? 'Saving…' : 'Add Plan'}</Button>
        </div>
      </form>
    </Modal>
  );
}
