// lib/reasoning/engine.ts — the ONE Family Reasoning Engine (R7). The strategy's
// #2 moat layer: instead of ~8 engines each answering part of "what's going on with
// this family", a single core answers the six questions every surface can consume:
//   1. What matters most right now?
//   2. What's likely being forgotten?
//   3. What should we decide next?
//   4. What can Bubaly just handle?
//   5. Who needs help this week?
//   6. What's the next best move?
// It CONSOLIDATES the existing pure engines by composition — the FOI orchestrator,
// the graph reasoning insights (R2), the hard signals (R10), and next-best-actions —
// into one report. Pure + deterministic + DOM-free; the server assembles the parts,
// this decides the answers. Every surface calls answerFamilyQuestions() and nothing
// else.

import type { OrchestratorReport, QuestionId } from '@/lib/operating-index/orchestrator';
import type { ReasoningInsight } from '@/lib/reasoning/insights';

export type ReasoningQuestionId =
  | 'matters_most' | 'forgotten' | 'decide_next' | 'auto_complete' | 'who_needs_help' | 'what_next';

export interface ReasoningItem {
  title: string;
  detail?: string;
  href?: string;
  weight: number;   // 0..100 — drives ranking within an answer
}

export interface ReasoningAnswer {
  id: ReasoningQuestionId;
  question: string;
  status: 'clear' | 'attention';
  headline: string;
  items: ReasoningItem[];
}

export interface ReasoningReport {
  answers: ReasoningAnswer[];
  allClear: boolean;
  generatedAt: string;
}

/** A hard signal (family_signals / R10) reduced to what the engine needs. */
export interface ReasoningSignal {
  kind: string;
  title: string;
  detail?: string | null;
  score: number;
  href?: string | null;
}

/** A next-best action (opportunities / next-actions) reduced for the engine. */
export interface ReasoningNextAction {
  title: string;
  detail?: string | null;
  href?: string | null;
  priority: number;   // higher = sooner
}

export interface ReasoningEngineInput {
  orchestrator?: OrchestratorReport | null;
  insights?: ReasoningInsight[];
  signals?: ReasoningSignal[];
  nextActions?: ReasoningNextAction[];
}

const QUESTION_TEXT: Record<ReasoningQuestionId, string> = {
  matters_most: 'What matters most right now?',
  forgotten: 'What’s likely being forgotten?',
  decide_next: 'What should we decide next?',
  auto_complete: 'What can Bubaly just handle?',
  who_needs_help: 'Who needs help this week?',
  what_next: 'What’s the next best move?',
};

const SEVERITY_WEIGHT: Record<ReasoningInsight['severity'], number> = { action: 72, attention: 52, info: 32 };

function orchAnswer(report: OrchestratorReport | null | undefined, id: QuestionId) {
  return report?.answers.find((a) => a.id === id);
}

function orchItems(report: OrchestratorReport | null | undefined, id: QuestionId, weight: number): ReasoningItem[] {
  const a = orchAnswer(report, id);
  if (!a || a.status === 'clear') return [];
  return a.items.map((it) => ({ title: it.label, href: it.href, weight }));
}

function dedupeTop(items: ReasoningItem[], max: number): ReasoningItem[] {
  const seen = new Set<string>();
  const out: ReasoningItem[] = [];
  for (const it of [...items].sort((a, b) => b.weight - a.weight)) {
    const key = it.title.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
    if (out.length >= max) break;
  }
  return out;
}

function answer(id: ReasoningQuestionId, items: ReasoningItem[], clearHeadline: string, attentionHeadline: (n: number) => string): ReasoningAnswer {
  const ranked = dedupeTop(items, 4);
  return {
    id, question: QUESTION_TEXT[id],
    status: ranked.length > 0 ? 'attention' : 'clear',
    headline: ranked.length > 0 ? attentionHeadline(ranked.length) : clearHeadline,
    items: ranked,
  };
}

/**
 * Answer the six family questions from the composed inputs. Any missing input just
 * means that source contributes nothing — an empty family reads as genuinely calm,
 * never as an error.
 */
export function answerFamilyQuestions(input: ReasoningEngineInput, now: Date = new Date()): ReasoningReport {
  const { orchestrator = null, insights = [], signals = [], nextActions = [] } = input;

  const signalItem = (s: ReasoningSignal, base = 0): ReasoningItem =>
    ({ title: s.title, detail: s.detail ?? undefined, href: s.href ?? undefined, weight: Math.max(base, s.score) });
  const insightItem = (i: ReasoningInsight): ReasoningItem =>
    ({ title: i.title, detail: i.detail, href: i.href, weight: SEVERITY_WEIGHT[i.severity] });

  // 1. Matters most — the highest-signal things across every source.
  const mattersMost = answer('matters_most', [
    ...orchItems(orchestrator, 'go_wrong', 80),
    ...signals.filter((s) => s.score >= 60).map((s) => signalItem(s)),
    ...insights.filter((i) => i.severity !== 'info').map(insightItem),
  ], 'Nothing urgent — you’re in good shape.', (n) => `${n} thing${n === 1 ? '' : 's'} deserve your attention.`);

  // 2. Forgotten — missing info + the reminders that keep getting ignored.
  const forgotten = answer('forgotten', [
    ...orchItems(orchestrator, 'missing_info', 58),
    ...signals.filter((s) => s.kind === 'ignored_reminder').map((s) => signalItem(s, 55)),
  ], 'Nothing’s slipping through the cracks.', (n) => `${n} thing${n === 1 ? '' : 's'} may be getting forgotten.`);

  // 3. Decide next — open decisions.
  const decideNext = answer('decide_next',
    orchItems(orchestrator, 'decide_next', 60),
    'No open decisions right now.', (n) => `${n} decision${n === 1 ? '' : 's'} waiting on the family.`);

  // 4. Auto-complete — reversible, high-confidence actions Bubaly can take.
  const autoComplete = answer('auto_complete',
    orchItems(orchestrator, 'auto_today', 60),
    'Nothing to auto-handle today.', (n) => `Bubaly can handle ${n} thing${n === 1 ? '' : 's'} for you.`);

  // 5. Who needs help — overloaded members + stress windows.
  const whoNeedsHelp = answer('who_needs_help', [
    ...orchItems(orchestrator, 'overloaded', 62),
    ...signals.filter((s) => s.kind === 'stress_window').map((s) => signalItem(s, 50)),
  ], 'Everyone’s load looks balanced.', () => 'Someone’s stretched thin this week.');

  // 6. What next — the ranked next best actions.
  const whatNext = answer('what_next',
    nextActions.map((a) => ({ title: a.title, detail: a.detail ?? undefined, href: a.href ?? undefined, weight: a.priority })),
    'You’re all caught up.', (n) => `${n} good next move${n === 1 ? '' : 's'}.`);

  const answers = [mattersMost, forgotten, decideNext, autoComplete, whoNeedsHelp, whatNext];
  return {
    answers,
    allClear: answers.every((a) => a.status === 'clear'),
    generatedAt: now.toISOString(),
  };
}

/** Compact summary persisted to reasoning_snapshots.report. */
export function reasoningSummary(report: ReasoningReport): Record<string, unknown> {
  return {
    allClear: report.allClear,
    answers: report.answers.map((a) => ({ id: a.id, status: a.status, headline: a.headline, count: a.items.length })),
  };
}
