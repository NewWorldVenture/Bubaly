'use client';

// The result pane (§54 centre): every card the conversation produced, newest
// turn first, each group headed by the request that produced it. Approvals
// are decided here, runs are followed from here, and a card the chat thread
// points at is scrolled into view and highlighted.
//
// Nothing in this pane is a chat bubble. If a turn produced no card, it
// simply has no group here — the text answer lives in the thread.
import { useEffect, useMemo, useRef } from 'react';
import { LayoutList } from 'lucide-react';
import { CardSkeleton, ResultCardView } from '@/components/ai/cards';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { cn } from '@/lib/utils/cn';
import type { ResultCard } from '@/lib/ai/result-cards';

/** The subset of the module's message shape the pane needs. */
export type ConversationMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  cards?: ResultCard[];
};

export type TurnGroup = {
  /** The assistant message the cards belong to. */
  messageId: string;
  /** What the person asked, for the group heading. */
  prompt: string | null;
  cards: { id: string; card: ResultCard }[];
};

/** A stable id for a card within its message, so highlights and keys survive re-renders. */
export function cardId(messageId: string, index: number): string {
  return `${messageId}:${index}`;
}

/**
 * Group cards by the assistant turn that produced them, newest first, each
 * with the user prompt that preceded it. Pure, so the module and tests share it.
 */
export function groupTurnCards(messages: ConversationMessage[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  let lastPrompt: string | null = null;
  for (const m of messages) {
    if (m.role === 'user') { lastPrompt = m.content; continue; }
    if (!m.cards || m.cards.length === 0) continue;
    groups.push({ messageId: m.id, prompt: lastPrompt, cards: m.cards.map((card, i) => ({ id: cardId(m.id, i), card })) });
  }
  return groups.reverse();
}

export type ResultPaneProps = {
  messages: ConversationMessage[];
  /** True while a reply is streaming; shows a placeholder until the first card lands. */
  streaming?: boolean;
  compact?: boolean;
  canDecide: boolean;
  onAsk?: (text: string) => void;
  /** The card to scroll to and highlight (from a chip in the thread). */
  highlightId?: string | null;
  error?: string | null;
  onRetry?: () => void;
  className?: string;
};

export function ResultPane({ messages, streaming = false, compact = false, canDecide, onAsk, highlightId, error, onRetry, className }: ResultPaneProps) {
  const groups = useMemo(() => groupTurnCards(messages), [messages]);
  const latestId = messages.length ? messages[messages.length - 1].id : null;
  const latestHasCards = groups.some((g) => g.messageId === latestId);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!highlightId || !root.current) return;
    const el = root.current.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(highlightId)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightId]);

  if (error) return <ErrorState message={error} onRetry={onRetry} />;

  if (groups.length === 0 && !streaming) {
    return (
      <EmptyState
        icon={LayoutList}
        title="Nothing planned yet"
        description="Ask Bubaly to plan dinners, sort out the weekend, check the budget or get a trip ready — the results show up here."
      />
    );
  }

  return (
    <div ref={root} className={cn('space-y-6', className)}>
      {streaming && !latestHasCards && <CardSkeleton compact={compact} />}
      {groups.map((group) => (
        <section key={group.messageId} aria-label={group.prompt ?? 'Results'} className="space-y-3">
          {group.prompt && (
            <p className="truncate text-xs font-semibold uppercase tracking-wide text-muted" title={group.prompt}>
              {group.prompt}
            </p>
          )}
          {group.cards.map(({ id, card }) => (
            <div
              key={id}
              data-card-id={id}
              className={cn('rounded-2xl transition', highlightId === id && 'ring-2 ring-brand/60 ring-offset-2 ring-offset-bg')}
            >
              <ResultCardView card={card} compact={compact} canDecide={canDecide} onAsk={onAsk} />
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
